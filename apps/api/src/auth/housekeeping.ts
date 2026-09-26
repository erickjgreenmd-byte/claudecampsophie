import type { Db } from '../db.ts';
import { purgeExpiredRateLimitBuckets } from '../middleware/rate-limit.ts';

export interface IdentityHousekeepingResult {
  /** Rate-limit buckets whose window had ended (every client network creates one). */
  readonly rateLimitBuckets: number;
  /** Sign-out records older than the longest Supabase access-token lifetime. */
  readonly endedAuthSessions: number;
  /**
   * Child sessions, their refresh tokens and adult step-ups that ended more than
   * SESSION_ROW_RETENTION_DAYS ago (migration 0850 `app.prune_session_rows`, DB-R1-07).
   */
  readonly endedSessionRows: number;
  /**
   * Pairing codes that stopped being usable more than PAIRING_CODE_RETENTION_DAYS ago, plus spend
   * holds whose expiry passed over a day ago (migration 0860 `app.prune_credential_rows`, DB-R2-08).
   */
  readonly endedCredentialRows: number;
}

/** Ended child sessions, refresh tokens and adult step-ups are kept this long (DB-R1-07). */
export const SESSION_ROW_RETENTION_DAYS = 30;

/**
 * Consumed and expired pairing codes are kept this long (DB-R2-08). A code stops being usable after
 * ten minutes, so this is only a margin: a redemption attempt on a code that just died still finds
 * it, and support can see that a code was issued. The row is a short-code hash, nothing else.
 */
export const PAIRING_CODE_RETENTION_DAYS = 30;

/**
 * Bulk cleanup for the identity/access tables that grow with traffic (migration 0720), for the
 * scheduled tick. The tables do not depend on it to stay bounded: every rate-limit hit and every
 * sign-out already clears a few expired rows. Idempotent and bounded per call.
 *
 * `now` is the tick's clock and ages rate-limit buckets, which the limiter writes with the request
 * clock. Sign-out records are written with the database clock and are aged by it inside the
 * database, so a tick clock running ahead can never purge a record whose token is still usable.
 */
export async function runIdentityHousekeeping(
  db: Db,
  now: Date,
): Promise<IdentityHousekeepingResult> {
  const rateLimitBuckets = await purgeExpiredRateLimitBuckets(db, now);
  const [row] = await db.asService(
    (tx) => tx<{ removed: number }[]>`select app.purge_ended_auth_sessions() as removed`,
  );
  // Aged by the database clock inside the function, like the sign-out records: a live session
  // (and every token of it, which rotation needs to detect reuse) is never touched.
  const [sessions] = await db.asService(
    (tx) => tx<{ removed: number }[]>`
      select app.prune_session_rows(make_interval(days => ${SESSION_ROW_RETENTION_DAYS})) as removed`,
  );
  // Same shape and the same database clock: consumed or expired pairing codes (short-code hashes)
  // and spend holds a dead worker left behind, neither of which any other step deleted (DB-R2-08).
  const [credentials] = await db.asService(
    (tx) => tx<{ removed: number }[]>`
      select app.prune_credential_rows(make_interval(days => ${PAIRING_CODE_RETENTION_DAYS})) as removed`,
  );
  return {
    rateLimitBuckets,
    endedAuthSessions: row?.removed ?? 0,
    endedSessionRows: sessions?.removed ?? 0,
    endedCredentialRows: credentials?.removed ?? 0,
  };
}
