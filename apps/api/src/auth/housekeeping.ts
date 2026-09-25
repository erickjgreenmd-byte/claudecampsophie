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
}

/** Ended child sessions, refresh tokens and adult step-ups are kept this long (DB-R1-07). */
export const SESSION_ROW_RETENTION_DAYS = 30;

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
  return {
    rateLimitBuckets,
    endedAuthSessions: row?.removed ?? 0,
    endedSessionRows: sessions?.removed ?? 0,
  };
}
