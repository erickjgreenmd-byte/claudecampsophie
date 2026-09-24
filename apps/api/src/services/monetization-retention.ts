import { PLACEMENT_SERVE_RETENTION_DAYS } from '@pencillift/domain/monetization';
import type { Db } from '../db.ts';

/**
 * Retention for the short-lived first-party anti-duplication/frequency state (spec P16.5):
 * private.placement_serves rows are deleted 7 days after serving. Aggregate counters are kept;
 * they hold no family, user, child or session identifier. Called by the scheduler tick.
 */
export async function purgeExpiredServes(db: Db, now: Date): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - PLACEMENT_SERVE_RETENTION_DAYS * 24 * 3600 * 1000);
  const rows = await db.asService(
    (tx) => tx<{ n: number }[]>`
      with purged as (
        delete from private.placement_serves where served_at < ${cutoff} returning 1
      )
      select count(*)::int as n from purged
    `,
  );
  return { deleted: rows[0]?.n ?? 0 };
}
