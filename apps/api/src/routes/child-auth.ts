import { Hono } from 'hono';
import { childPairRequestSchema, childRefreshRequestSchema } from '@pencillift/contracts';
import { readJson } from '../app.ts';
import { issueChildAccessToken } from '../auth/child.ts';
import { normalizePairingCode, pairingCodeHash } from '../auth/pairing.ts';
import type { ChildPrincipal, Tx } from '../db.ts';
import { ApiError } from '../errors.ts';
import { requireChild } from '../middleware/auth.ts';
import type { AppDeps, AppEnv } from '../middleware/context.ts';
import {
  clientNetworkKey,
  clientSiteKey,
  enforceRateLimit,
  RATE_RULES,
  rateLimitedError,
} from '../middleware/rate-limit.ts';
import { randomToken, sha256Hex, toHex } from '../security/crypto.ts';

/**
 * Session and refresh-token lifetimes are stored and compared with the database clock: the
 * session is checked by app.current_child_id() (now()), so it must be written with now() too
 * (RV-lead-identity-access-8: one clock per comparison).
 */
async function issueRefreshToken(
  tx: Tx,
  deps: AppDeps,
  sessionId: string,
): Promise<{ token: string; id: string }> {
  const token = randomToken();
  const hashHex = await sha256Hex(token);
  const [row] = await tx<{ id: string }[]>`
    insert into private.child_refresh_tokens (session_id, token_hash, issued_at, expires_at)
    values (${sessionId}, decode(${hashHex}, 'hex'), now(),
            now() + make_interval(secs => ${deps.config.childRefreshTtlSeconds}))
    returning id
  `;
  return { token, id: row!.id };
}

const PAIR_FAILURES_KEY = 'pair-fail:global';

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
    const address = c.req.header('cf-connecting-ip');
    // Every attempt counts per client network (IPv4 address / IPv6 /64).
    await enforceRateLimit(
      deps.rateLimiter,
      `pair:${clientNetworkKey(address)}`,
      RATE_RULES.pairingRedeemPerNetwork,
      now,
    );
    const body = await readJson(c, childPairRequestSchema);
    const code = normalizePairingCode(body.code);
    if (!code)
      throw new ApiError('NOT_FOUND', 'That code did not work. Ask a grown-up for a new one.');
    // A guess reserves its unit of the service-wide failure budget before it runs, so guesses in
    // flight count. A used-up budget pauses only sites that already have a failed or running guess
    // this hour, so spending it cannot stop every other family pairing (RV-lead-identity-access-6).
    const budget = RATE_RULES.pairingRedeemFailuresGlobal;
    const siteKey = `pair-fail:${clientSiteKey(address)}`;
    const reservation = await deps.rateLimiter.reserveShared(
      PAIR_FAILURES_KEY,
      siteKey,
      budget,
      now,
    );
    if (reservation.exhausted) {
      deps.log({ level: 'error', event: 'pairing_failure_budget_exhausted' });
    }
    if (!reservation.allowed) throw rateLimitedError(reservation.retryAfterSeconds);
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
      const [session] = await tx<{ id: string }[]>`
        insert into public.child_sessions (family_id, child_id, device_id, created_at, expires_at)
        values (${claimed.family_id}, ${claimed.child_id}, ${device!.id}, now(),
                now() + make_interval(secs => ${deps.config.childRefreshTtlSeconds}))
        returning id
      `;
      const refresh = await issueRefreshToken(tx, deps, session!.id);
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
    // A failed (or aborted) guess keeps its reserved units.
    if (!result)
      throw new ApiError('NOT_FOUND', 'That code did not work. Ask a grown-up for a new one.');
    // A success is not a failed guess: give both units back. The device is already paired, so a
    // failure here only leaves the budget conservatively spent and must not fail the response.
    try {
      await deps.rateLimiter.release(PAIR_FAILURES_KEY, budget, now);
      await deps.rateLimiter.release(siteKey, budget, now);
    } catch {
      deps.log({ level: 'warn', event: 'pairing_budget_release_failed' });
    }
    return c.json(
      await tokenResponse(deps, result.principal, result.refreshToken, result.nickname, now),
      201,
    );
  });

  r.post('/refresh', async (c) => {
    const { deps } = c.var;
    const now = deps.clock();
    // Per client network before any token lookup (API-AUTH-R1-04); the per-session rule below
    // still bounds one paired device.
    await enforceRateLimit(
      deps.rateLimiter,
      `child-refresh:${clientNetworkKey(c.req.header('cf-connecting-ip'))}`,
      RATE_RULES.childRefreshPerNetwork,
      now,
    );
    const { refreshToken } = await readJson(c, childRefreshRequestSchema);
    const refreshHashHex = await sha256Hex(refreshToken);
    const outcome = await deps.db.asService(async (tx) => {
      const [row] = await tx<
        {
          id: string;
          session_id: string;
          used_at: Date | null;
          family_id: string;
          child_id: string;
          live: boolean;
          nickname: string;
        }[]
      >`
        select t.id, t.session_id, t.used_at, s.family_id, s.child_id, c.nickname,
               (t.expires_at > now() and s.revoked_at is null and s.expires_at > now()
                and d.revoked_at is null and c.status = 'active' and f.deleted_at is null) as live
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
      if (!row.live) return { kind: 'invalid' as const };
      await enforceRateLimit(
        deps.rateLimiter,
        `refresh:${row.session_id}`,
        RATE_RULES.childRefreshPerSession,
        now,
      );
      const next = await issueRefreshToken(tx, deps, row.session_id);
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
