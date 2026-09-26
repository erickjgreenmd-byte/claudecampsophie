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
 * How long after a rotation the tablet's own retry of that refresh is still served (HUNT5-A-1). A
 * client retry horizon, not a grace period: the id below decides WHO may recover, this only bounds
 * how long a consumed token stays recoverable at all. Compared against `used_at`, which the request
 * instant writes, so both sides of the comparison come from one clock (RV-lead-identity-access-8) —
 * `now()` is the database's and would mix two.
 */
const RECOVERY_WINDOW_MS = 2 * 60_000;

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
    const { refreshToken, refreshRequestId } = await readJson(c, childRefreshRequestSchema);
    const refreshHashHex = await sha256Hex(refreshToken);
    const outcome = await deps.db.asService(async (tx) => {
      const [row] = await tx<
        {
          id: string;
          session_id: string;
          used_at: Date | null;
          used_request_id: string | null;
          replaced_by: string | null;
          family_id: string;
          child_id: string;
          live: boolean;
          nickname: string;
        }[]
      >`
        select t.id, t.session_id, t.used_at, t.used_request_id, t.replaced_by,
               s.family_id, s.child_id, c.nickname,
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
        // A rotated token presented again is theft — UNLESS it is the rightful holder retrying the
        // very refresh that rotated it, which BUG-244 is about: the rotation commits before the
        // response goes out, so a response lost on the way back (a client timeout, a network switch,
        // a Worker evicted after commit) left the tablet holding a token the server had marked used,
        // and its next refresh unpaired the device over one dropped HTTP response.
        //
        // A time window ALONE was rejected for this: inside it a replayer looks exactly like the
        // rightful holder, so on its own it would hand out a live child session in the case it
        // exists to help. The request identifies itself instead. Four things must all hold:
        //   1. the request carries an id AND it is the id that consumed this token — a blind replayer
        //      does not know it, and a client that sends none never takes this path at all;
        //   2. the rotation is no older than RECOVERY_WINDOW_MS — a retry follows its own attempt by
        //      seconds, so nothing is lost, while a replay of a body captured from a refresh that
        //      SUCCEEDED is refused: the id alone cannot tell those apart, because a successful
        //      refresh leaves its own consumed token, its id and an unclaimed replacement in exactly
        //      the state this branch looks for, for as long as the tablet does not refresh again
        //      (HUNT5-A-1);
        //   3. the replacement that the lost response carried is still UNCLAIMED — once it has been
        //      used, two parties hold this token's lineage and that is theft whatever id is sent;
        //   4. the session is still live and consent still allows access (checked below, as always).
        // The unclaimed replacement is then retired and a fresh one issued, so a second lost response
        // in a row still recovers — through THIS row, whose id and whose used_at still stand. Only
        // the token hash is stored, so the replacement itself can never be re-served.
        //
        // Residual, stated plainly: inside the window a captured request body (which necessarily
        // carries a refresh token that was live when it was captured) is served once, and the tablet
        // is then unpaired on its next refresh, as a reuse always unpairs it. Every recovery is
        // audited, so that is visible to the family and to ops rather than silent. Outside the
        // window, behaviour is exactly the pre-BUG-244 unpairing.
        const recovering =
          refreshRequestId !== undefined &&
          row.used_request_id === refreshRequestId &&
          now.getTime() - row.used_at.getTime() < RECOVERY_WINDOW_MS &&
          row.replaced_by !== null &&
          row.live;
        if (recovering) {
          const [replacement] = await tx<{ id: string }[]>`
            select id from private.child_refresh_tokens
             where id = ${row.replaced_by} and used_at is null and expires_at > now()
             for update`;
          if (replacement) {
            if (!(await consented())) return { kind: 'invalid' as const };
            await enforceRateLimit(
              deps.rateLimiter,
              `refresh:${row.session_id}`,
              RATE_RULES.childRefreshPerSession,
              now,
            );
            const next = await issueRefreshToken(tx, deps, row.session_id);
            // The retired replacement is the end of its own lineage: it keeps this token's original
            // used_at (so the window is measured from the one rotation the id consumed) and carries
            // NO request id, so it can never satisfy the predicate above in its own right. Only an
            // interceptor of the lost response holds it, and presenting it is theft (HUNT5-A-2).
            await tx`update private.child_refresh_tokens
                        set used_at = ${row.used_at}, replaced_by = ${next.id},
                            used_request_id = null
                      where id = ${replacement.id}`;
            await tx`update private.child_refresh_tokens set replaced_by = ${next.id} where id = ${row.id}`;
            deps.log({
              level: 'info',
              event: 'child_refresh_recovered',
              code: 'LOST_RESPONSE',
            });
            // Serving a rotated token is recorded, not only logged: a replay inside the window is
            // then visible to the family and to ops instead of silent (HUNT5-A-1).
            await tx`
              insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
              values (${row.family_id}, 'system', 'child_session.refresh_recovered', 'child_session', ${row.session_id})
            `;
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
          }
        }
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
      await tx`update private.child_refresh_tokens
                  set used_at = ${now}, replaced_by = ${next.id},
                      used_request_id = ${refreshRequestId ?? null}
                where id = ${row.id}`;
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
