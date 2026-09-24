import { Hono } from 'hono';
import { childPairRequestSchema, childRefreshRequestSchema } from '@pencillift/contracts';
import { readJson } from '../app.ts';
import { issueChildAccessToken } from '../auth/child.ts';
import { normalizePairingCode, pairingCodeHash } from '../auth/pairing.ts';
import type { ChildPrincipal, Tx } from '../db.ts';
import { ApiError } from '../errors.ts';
import { requireChild } from '../middleware/auth.ts';
import type { AppDeps, AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, RATE_RULES } from '../middleware/rate-limit.ts';
import { randomToken, sha256Hex, toHex } from '../security/crypto.ts';

async function issueRefreshToken(
  tx: Tx,
  deps: AppDeps,
  sessionId: string,
  now: Date,
): Promise<{ token: string; id: string }> {
  const token = randomToken();
  const hashHex = await sha256Hex(token);
  const expiresAt = new Date(now.getTime() + deps.config.childRefreshTtlSeconds * 1000);
  const [row] = await tx<{ id: string }[]>`
    insert into private.child_refresh_tokens (session_id, token_hash, issued_at, expires_at)
    values (${sessionId}, decode(${hashHex}, 'hex'), ${now}, ${expiresAt}) returning id
  `;
  return { token, id: row!.id };
}

async function tokenResponse(
  deps: AppDeps,
  principal: ChildPrincipal,
  refreshToken: string,
  nickname: string,
  now: Date,
) {
  const access = await issueChildAccessToken(deps.config, principal, now);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    child: { id: principal.childId, nickname },
  };
}

/** Paired child device sessions (spec P3, AC_ACCESS_04/06/08). */
export function childAuthRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/pair', async (c) => {
    const { deps } = c.var;
    const now = deps.clock();
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    await enforceRateLimit(deps.rateLimiter, `pair:${ip}`, RATE_RULES.pairingRedeemPerIp, now);
    const body = await readJson(c, childPairRequestSchema);
    const code = normalizePairingCode(body.code);
    if (!code)
      throw new ApiError('NOT_FOUND', 'That code did not work. Ask a grown-up for a new one.');
    const hashHex = toHex(await pairingCodeHash(deps.config.hashPepper, code));

    const result = await deps.db.asService(async (tx) => {
      // Single use: the conditional update is the atomic claim; a concurrent redeem gets zero rows.
      const [claimed] = await tx<{ family_id: string; child_id: string }[]>`
        update private.child_pairing_codes p
           set consumed_at = ${now}
          from public.child_profiles c, public.families f
         where p.code_hash = decode(${hashHex}, 'hex')
           and p.consumed_at is null
           and p.expires_at > ${now}
           and c.id = p.child_id and c.status = 'active'
           and f.id = p.family_id and f.deleted_at is null
        returning p.family_id, p.child_id
      `;
      if (!claimed) return null;
      const [device] = await tx<{ id: string }[]>`
        insert into public.child_devices (family_id, child_id, label, platform)
        values (${claimed.family_id}, ${claimed.child_id}, ${body.deviceLabel}, ${body.platform}) returning id
      `;
      const sessionExpires = new Date(now.getTime() + deps.config.childRefreshTtlSeconds * 1000);
      const [session] = await tx<{ id: string }[]>`
        insert into public.child_sessions (family_id, child_id, device_id, created_at, expires_at)
        values (${claimed.family_id}, ${claimed.child_id}, ${device!.id}, ${now}, ${sessionExpires}) returning id
      `;
      const refresh = await issueRefreshToken(tx, deps, session!.id, now);
      const [child] = await tx<
        { nickname: string }[]
      >`select nickname from public.child_profiles where id = ${claimed.child_id}`;
      await tx`
        insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
        values (${claimed.family_id}, 'child', 'device.paired', 'child_device', ${device!.id})
      `;
      return {
        principal: {
          kind: 'child',
          childId: claimed.child_id,
          familyId: claimed.family_id,
          sessionId: session!.id,
        } as const,
        refreshToken: refresh.token,
        nickname: child!.nickname,
      };
    });
    if (!result)
      throw new ApiError('NOT_FOUND', 'That code did not work. Ask a grown-up for a new one.');
    return c.json(
      await tokenResponse(deps, result.principal, result.refreshToken, result.nickname, now),
      201,
    );
  });

  r.post('/refresh', async (c) => {
    const { deps } = c.var;
    const now = deps.clock();
    const { refreshToken } = await readJson(c, childRefreshRequestSchema);
    const refreshHashHex = await sha256Hex(refreshToken);
    const outcome = await deps.db.asService(async (tx) => {
      const [row] = await tx<
        {
          id: string;
          session_id: string;
          used_at: Date | null;
          expires_at: Date;
          family_id: string;
          child_id: string;
          live: boolean;
          nickname: string;
        }[]
      >`
        select t.id, t.session_id, t.used_at, t.expires_at, s.family_id, s.child_id, c.nickname,
               (s.revoked_at is null and s.expires_at > ${now} and d.revoked_at is null
                and c.status = 'active' and f.deleted_at is null) as live
          from private.child_refresh_tokens t
          join public.child_sessions s on s.id = t.session_id
          join public.child_devices d on d.id = s.device_id
          join public.child_profiles c on c.id = s.child_id
          join public.families f on f.id = s.family_id
         where t.token_hash = decode(${refreshHashHex}, 'hex')
         for update of t
      `;
      if (!row) return { kind: 'invalid' as const };
      if (row.used_at) {
        // Reuse of a rotated token signals theft: revoke the whole session (spec P3).
        await tx`update public.child_sessions set revoked_at = ${now}, revoke_reason = 'refresh_token_reuse' where id = ${row.session_id} and revoked_at is null`;
        await tx`
          insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
          values (${row.family_id}, 'system', 'child_session.revoked_token_reuse', 'child_session', ${row.session_id})
        `;
        return { kind: 'reused' as const };
      }
      if (!row.live || row.expires_at <= now) return { kind: 'invalid' as const };
      await enforceRateLimit(
        deps.rateLimiter,
        `refresh:${row.session_id}`,
        RATE_RULES.childRefreshPerSession,
        now,
      );
      const next = await issueRefreshToken(tx, deps, row.session_id, now);
      await tx`update private.child_refresh_tokens set used_at = ${now}, replaced_by = ${next.id} where id = ${row.id}`;
      return {
        kind: 'ok' as const,
        principal: {
          kind: 'child',
          childId: row.child_id,
          familyId: row.family_id,
          sessionId: row.session_id,
        } as const,
        refreshToken: next.token,
        nickname: row.nickname,
      };
    });
    if (outcome.kind !== 'ok')
      throw new ApiError('UNAUTHENTICATED', 'Ask a grown-up to connect this device again');
    return c.json(
      await tokenResponse(deps, outcome.principal, outcome.refreshToken, outcome.nickname, now),
    );
  });

  r.post('/logout', requireChild, async (c) => {
    const { deps, child } = c.var;
    await deps.db.asService(
      (tx) =>
        tx`update public.child_sessions set revoked_at = now(), revoke_reason = 'logout' where id = ${child.sessionId} and revoked_at is null`,
    );
    return c.json({ ok: true });
  });

  r.get('/me', requireChild, async (c) => {
    const { deps, child } = c.var;
    // Explicit column allowlist (column grants make select * fail closed; lesson L-003).
    const [row] = await deps.db.asChild(
      child,
      (tx) => tx<{ id: string; nickname: string; grade_level: number; age_band: string }[]>`
        select id, nickname, grade_level, age_band from public.child_profiles
      `,
    );
    if (!row) throw new ApiError('UNAUTHENTICATED', 'Ask a grown-up to connect this device again');
    return c.json({
      id: row.id,
      nickname: row.nickname,
      gradeLevel: row.grade_level,
      ageBand: row.age_band,
    });
  });

  return r;
}
