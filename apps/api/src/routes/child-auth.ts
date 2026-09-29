import { Hono } from 'hono';
import { childPairRequestSchema, childRefreshRequestSchema } from '@pencillift/contracts';
import { readJson } from '../app.ts';
import { acceptsTestProviderConsent } from '../config.ts';
import { issueChildAccessToken } from '../auth/child.ts';
import { normalizePairingCode, pairingCodeHash } from '../auth/pairing.ts';
import type { ChildPrincipal, Tx } from '../db.ts';
import { ApiError, businessRule } from '../errors.ts';
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
import { consentAllowsChildAccess } from '../services/consent.ts';

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

/**
 * A device with no live session left is not connected any more (HUNT4-MOB-4). The parent's device
 * list derives "Connected" from `child_devices.revoked_at` alone, so a session that ended any way
 * except logout or a parent action left the tablet listed as connected for good — with a live
 * "Disconnect" button — while the child was being told to ask a grown-up to connect it again.
 *
 * Only stamped when this device has no OTHER live session. That is defence in depth, not a shared
 * tablet (HUNT5-A-5): /pair always inserts a fresh `child_devices` row, and every path that ends a
 * session for a reason other than the session itself ending — archive (routes/family.ts), consent
 * withdrawal (routes/guardians.ts), deletion (migration 0620) — revokes the device row in the same
 * transaction, so no API path today reaches a device row that has a second live session. The clause
 * is what keeps this stamp from disconnecting a working tablet if one ever does; the two raw-SQL
 * cases in tests/mobile-r2.review.test.ts exercise it directly, since nothing else can.
 */
async function stampDeviceWhenNoLiveSession(tx: Tx, sessionId: string): Promise<void> {
  await tx`
    update public.child_devices d set revoked_at = now()
     where d.id = (select device_id from public.child_sessions where id = ${sessionId})
       and d.revoked_at is null
       and not exists (
         select 1 from public.child_sessions s
          where s.device_id = d.id and s.revoked_at is null and s.expires_at > now()
       )
  `;
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
    // The lifetime as well as the instant (MOB-R2-02): a device with a wrong clock cannot turn a
    // server instant into a lifetime, so it measures expiry from its own clock at receipt.
    accessTokenExpiresInSeconds: deps.config.childAccessTtlSeconds,
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
    const allowTestProvider = acceptsTestProviderConsent(deps.config.environment);

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
      // A code minted before consent was withdrawn must not pair a device (CS-R1-01). Throwing
      // rolls the claim back, so the code stays unredeemed for after consent is given again.
      if (!(await consentAllowsChildAccess(tx, claimed.family_id, { allowTestProvider }))) {
        throw businessRule(
          'CONSENT_REQUIRED',
          'This device can’t connect right now. Ask a grown-up to check PencilLift’s family page.',
        );
      }
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
      /**
       * Withdrawal revokes the session, so this only matters for a session that outlived a consent
       * change made another way; the child sees the same "connect again" answer.
       */
      const consented = async () =>
        consentAllowsChildAccess(tx, row.family_id, {
          allowTestProvider: acceptsTestProviderConsent(deps.config.environment),
        });
      if (row.used_at) {
        // Reuse of a rotated token signals theft: revoke the whole session (spec P3), at once and
        // without any grace window. Rotation is the only way a token becomes used, so a second
        // presentation means two parties hold it. tests/auth.test.ts > 'refresh tokens rotate and
        // reuse revokes the session' is the case that pins this rule.
        //
        // BUG-244 is an ACCEPTED OPEN defect again (owner action #45): this also fires when a
        // rotation's response is lost on the way back to the tablet, so one dropped HTTP response
        // unpairs a child's device and the parent has to mint a new pairing code.
        //
        // Round 5 served that retry — an id per refresh the tablet kept across its own retries, a
        // two-minute window, an unclaimed replacement — and round 6 REMOVED it rather than repairing
        // it again (HUNT6-A-1). What a served recovery cost is what the removal is about: nothing
        // marked the row a recovery had consumed, so one captured request body was served for the
        // whole window, and each serving returned a refresh token of full lifetime carrying no marker
        // at all, which then rotated on down the ordinary path below — no id, no window, no audit
        // row. So the window bounded when a replay could START, not how long it lasted: a captured
        // body bought a self-renewing child session until the tablet's own next refresh, which for a
        // tablet put away is overnight. A logged request body is the realistic capture vector,
        // because logs are read later.
        //
        // What the removal restores is worth stating exactly, since over-claiming a residual is what
        // this reversal is FOR: a captured body is worthless again ONCE THE TOKEN IN IT HAS BEEN
        // ROTATED — the property the recovery sold, and the only one it took away. A body captured
        // BEFORE the device's own request reaches the server still carries a live refresh token, and
        // whoever presents it first wins; that was as true before BUG-244 as it is now and nothing
        // here touches it (the loser of that race then presents a rotated token, so THIS branch ends
        // the session for both — detection, not prevention). Against that bounded gain the
        // feature only avoided an occasional unpairing a parent can undo in one tap, and child
        // privacy is not weakened for that trade.
        //
        // A time window ALONE was rejected before BUG-244 and is still rejected: inside it a
        // replayer looks exactly like the rightful holder, so it would hand out a live child session
        // in the case it exists to help. Anything that reopens this needs to bound what a captured
        // body buys, not just when it may be presented.
        await tx`update public.child_sessions set revoked_at = ${now}, revoke_reason = 'refresh_token_reuse' where id = ${row.session_id} and revoked_at is null`;
        await tx`
          insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
          values (${row.family_id}, 'system', 'child_session.revoked_token_reuse', 'child_session', ${row.session_id})
        `;
        // The session is over, so the parent's list must stop calling the device connected
        // (HUNT4-MOB-4).
        await stampDeviceWhenNoLiveSession(tx, row.session_id);
        return { kind: 'reused' as const };
      }
      if (!row.live) {
        // The session is over (revoked, or simply expired on an unused tablet): the device stops
        // being listed as connected, so the parent sees that a new pairing code is what is needed.
        await stampDeviceWhenNoLiveSession(tx, row.session_id);
        return { kind: 'invalid' as const };
      }
      if (!(await consented())) return { kind: 'invalid' as const };
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
    await deps.db.asService(async (tx) => {
      await tx`update public.child_sessions set revoked_at = now(), revoke_reason = 'logout' where id = ${child.sessionId} and revoked_at is null`;
      // A device that signed itself out is no longer connected (API-AUTH-R2-05).
      await stampDeviceWhenNoLiveSession(tx, child.sessionId);
    });
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
