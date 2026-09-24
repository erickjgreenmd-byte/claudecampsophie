import { addMonths, calendarMonthOf } from '@pencillift/domain';
import type { AppDeps } from '../middleware/context.ts';
import { applySnapshots } from '../services/billing-sync.ts';
import { purgeExpiredServes } from '../services/monetization-retention.ts';
import { runDonationAccrual, runGeneration } from '../services/p17-jobs.ts';

/**
 * Durable scheduled work (spec E4 Scheduling, V2). A Cloudflare Cron Trigger calls `runScheduledTick`
 * every few minutes; every task is idempotent, so overlapping or repeated ticks are harmless. Jobs
 * live in the Postgres job ledger (migration 0600), claimed with SKIP LOCKED so concurrent workers
 * never run the same job, with bounded retries and a dead-letter state. Nothing depends on an
 * in-process timer or on any client staying open.
 */

export type JobDeps = Pick<AppDeps, 'db' | 'config' | 'clock' | 'random' | 'providers' | 'log'>;

export interface JobRow {
  id: string;
  kind: string;
  family_id: string | null;
  child_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (deps: JobDeps, job: JobRow) => Promise<void>;

export const RAW_SCAN_RETENTION_DAYS = 30;
const RESERVATION_TIMEOUT_MINUTES = 30;
const GENERATION_LEAD_DAYS = 5;
const LOCK_MINUTES = 10;

/** Deletion: remove private storage objects first, then purge rows (a retry can never orphan files). */
export const deletionPurgeHandler: JobHandler = async (deps, job) => {
  if (!job.family_id) throw new Error('deletion_purge job without family');
  const childId =
    job.child_id ?? (typeof job.payload.childId === 'string' ? job.payload.childId : null);
  const paths = await deps.db.asService(
    (tx) => tx<{ storage_path: string }[]>`
      select storage_path from public.source_pages
       where family_id = ${job.family_id} and (${childId}::uuid is null or child_id = ${childId}::uuid)
    `,
  );
  if (paths.length > 0) await deps.providers.storage.remove(paths.map((p) => p.storage_path));
  await deps.db.asService(
    (tx) => tx`select app.purge_family_data(${job.family_id}, ${childId}::uuid)`,
  );
};

export const DEFAULT_HANDLERS: Readonly<Record<string, JobHandler>> = {
  deletion_purge: deletionPurgeHandler,
};

export interface TickReport {
  generatedCampaigns: number;
  donationAccruals: number;
  expiredReservations: number;
  retentionPurgedPages: number;
  spendAlerts: number;
  placementServesPurged: number;
  entitlementsReconciled: number;
  inactivity: { notified: number; deleted: number };
  jobs: { succeeded: number; retried: number; deadLettered: number };
}

async function claimJobs(
  deps: JobDeps,
  kinds: readonly string[],
  limit: number,
): Promise<JobRow[]> {
  const now = deps.clock();
  return deps.db.asService(
    (tx) => tx<JobRow[]>`
      update public.jobs set status = 'running', attempts = attempts + 1,
             locked_until = ${new Date(now.getTime() + LOCK_MINUTES * 60_000)}
       where id in (
         select id from public.jobs
          where status in ('queued', 'failed_retryable') and run_after <= ${now} and kind = any(${[...kinds]})
          order by run_after
          for update skip locked
          limit ${limit}
       )
      returning id, kind, family_id, child_id, payload, attempts, max_attempts
    `,
  );
}

export async function runJobs(
  deps: JobDeps,
  handlers: Readonly<Record<string, JobHandler>> = DEFAULT_HANDLERS,
  limit = 25,
): Promise<TickReport['jobs']> {
  const now = deps.clock();
  // Recover jobs whose worker died mid-run (lock expired while still "running").
  await deps.db.asService(
    (tx) => tx`
      update public.jobs set status = case when attempts >= max_attempts then 'dead_letter' else 'failed_retryable' end,
             last_error_code = 'LOCK_EXPIRED', locked_until = null
       where status = 'running' and locked_until < ${now}
    `,
  );
  // Work for a tombstoned family can never run (the job guard would also refuse to start it, and one
  // refused row must not block the whole claim batch). The deletion purge itself is exempt.
  await deps.db.asService(
    (tx) => tx`
      update public.jobs j set status = 'cancelled', locked_until = null, last_error_code = 'FAMILY_DELETED'
        from public.families f
       where f.id = j.family_id and f.deleted_at is not null
         and j.kind <> 'deletion_purge' and j.status in ('queued', 'failed_retryable')
    `,
  );
  const report = { succeeded: 0, retried: 0, deadLettered: 0 };
  for (const job of await claimJobs(deps, Object.keys(handlers), limit)) {
    const handler = handlers[job.kind]!;
    try {
      await handler(deps, job);
      await deps.db.asService(
        (tx) =>
          tx`update public.jobs set status = 'succeeded', locked_until = null where id = ${job.id}`,
      );
      report.succeeded += 1;
    } catch (error) {
      const dead = job.attempts >= job.max_attempts;
      const backoffMs = Math.min(6 * 3600_000, 60_000 * 2 ** (job.attempts - 1));
      await deps.db.asService(
        (tx) => tx`
          update public.jobs set status = ${dead ? 'dead_letter' : 'failed_retryable'}, locked_until = null,
                 run_after = ${new Date(now.getTime() + backoffMs)},
                 last_error_code = ${error instanceof Error ? error.name : 'Error'}
           where id = ${job.id}
        `,
      );
      deps.log({
        level: dead ? 'error' : 'warn',
        event: dead ? 'job_dead_letter' : 'job_retry',
        code: job.kind,
      });
      if (dead) report.deadLettered += 1;
      else report.retried += 1;
    }
  }
  return report;
}

/** Raw scan retention (spec P4: 30 days by default): delete objects, then mark the page deleted. */
export async function purgeExpiredScans(deps: JobDeps): Promise<number> {
  const cutoff = new Date(deps.clock().getTime() - RAW_SCAN_RETENTION_DAYS * 86_400_000);
  const pages = await deps.db.asService(
    (tx) => tx<{ id: string; storage_path: string }[]>`
      select id, storage_path from public.source_pages where deleted_at is null and created_at < ${cutoff} limit 500
    `,
  );
  if (pages.length === 0) return 0;
  await deps.providers.storage.remove(pages.map((p) => p.storage_path));
  await deps.db.asService(
    (tx) =>
      tx`update public.source_pages set deleted_at = ${deps.clock()} where id = any(${pages.map((p) => p.id)})`,
  );
  return pages.length;
}

/** Reserved promo redemptions whose store step never started are released (never provider_pending). */
export async function expireStaleReservations(deps: JobDeps): Promise<number> {
  const cutoff = new Date(deps.clock().getTime() - RESERVATION_TIMEOUT_MINUTES * 60_000);
  const rows = await deps.db.asService(
    (tx) => tx`
      update public.promo_redemptions set state = 'expired'
       where state = 'reserved' and created_at < ${cutoff}
      returning id
    `,
  );
  return rows.length;
}

/**
 * Spend alerts (spec F4): once per threshold (default 50/80/100%) of the owner's monthly AI budget.
 * No budget row means no alerts — the owner's cap is never invented (docs/Owner_Actions.md #9).
 */
export async function recordSpendAlerts(deps: JobDeps): Promise<number[]> {
  const now = deps.clock();
  const periodKey = now.toISOString().slice(0, 7);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return deps.db.asService(async (tx) => {
    const [budget] = await tx<
      {
        id: string;
        budget_micros: string;
        thresholds: number[];
        alerted: number[];
        spent: string;
      }[]
    >`
      select b.id, b.budget_micros::text, b.alert_thresholds_percent as thresholds,
             b.alerted_thresholds_percent as alerted,
             coalesce((select sum(cost_micros) from public.ai_usage_events
                        where created_at >= ${monthStart}), 0)::text as spent
        from public.spend_budgets b
       where b.scope = 'global' and b.period_key = ${periodKey}
       for update
    `;
    if (!budget) return [];
    const spent = BigInt(budget.spent);
    const cap = BigInt(budget.budget_micros);
    const crossed = budget.thresholds
      .filter((t) => !budget.alerted.includes(t) && spent * 100n >= cap * BigInt(t))
      .sort((a, b) => a - b);
    if (crossed.length === 0) return [];
    await tx`
      update public.spend_budgets
         set alerted_thresholds_percent = ${[...budget.alerted, ...crossed]}::smallint[]
       where id = ${budget.id}
    `;
    for (const threshold of crossed) {
      await tx`
        insert into public.audit_events (actor_kind, action, target_type, target_id, metadata)
        values ('system', 'spend.threshold_crossed', 'spend_budget', ${budget.id},
                ${JSON.stringify({ periodKey, thresholdPercent: threshold })}::text::jsonb)
      `;
      deps.log({
        level: threshold >= 100 ? 'error' : 'warn',
        event: 'spend_threshold_crossed',
        code: `P${threshold}`,
      });
    }
    return crossed;
  });
}

/**
 * Entitlement safety net (spec P11): webhooks can be lost, so entitlements that are stale (not
 * fetched for a day) or past their period end are re-fetched from the provider and reconciled.
 */
export async function reconcileStaleEntitlements(deps: JobDeps, limit = 25): Promise<number> {
  const now = deps.clock();
  const staleBefore = new Date(now.getTime() - 86_400_000);
  const families = await deps.db.asService(
    (tx) => tx<{ id: string; billing_ref: string }[]>`
      select f.id, f.billing_ref from public.families f
       where f.deleted_at is null and exists (
         select 1 from public.family_entitlements e
          where e.family_id = f.id and e.status not in ('expired', 'revoked')
            and (e.fetched_at < ${staleBefore} or e.period_end < ${now})
       )
       order by f.id
       limit ${limit}
    `,
  );
  let reconciled = 0;
  for (const family of families) {
    try {
      const snapshots = await deps.providers.subscriptions.fetchSubscriptions(
        family.billing_ref,
        now,
      );
      await deps.db.asService(async (tx) => {
        await tx`select 1 from public.families where id = ${family.id} for update`;
        await applySnapshots(tx, family.id, snapshots, deps.config.billingEnvironment, now);
      });
      reconciled += 1;
    } catch {
      // One provider failure never stops the sweep; the next tick retries this family.
      deps.log({ level: 'warn', event: 'entitlement_reconcile_failed' });
    }
  }
  return reconciled;
}

/**
 * Inactivity retention (spec P4). Disabled unless the owner enabled it. A family with no adult or
 * child activity for `inactivityMonths` gets one notice; if nothing happens for
 * `inactivityNoticeDays` after that, it is tombstoned and purged like a parent deletion. Any activity
 * (a parent request stamps last_seen_at and clears the notice) stops the process.
 */
export async function inactivitySweep(
  deps: JobDeps,
  limit = 50,
): Promise<{ notified: number; deleted: number }> {
  if (!deps.config.flags.inactivityDeletionEnabled) return { notified: 0, deleted: 0 };
  const now = deps.clock();
  const idleBefore = new Date(now);
  idleBefore.setUTCMonth(idleBefore.getUTCMonth() - deps.config.inactivityMonths);
  const noticeBefore = new Date(now.getTime() - deps.config.inactivityNoticeDays * 86_400_000);
  const candidates = await deps.db.asService(
    (tx) => tx<{ id: string; created_by: string; notified_at: Date | null }[]>`
      select f.id, f.created_by, f.inactivity_notified_at as notified_at
        from public.families f
       where f.deleted_at is null
         and greatest(
           f.created_at,
           coalesce((select max(last_seen_at) from public.family_memberships m where m.family_id = f.id), f.created_at),
           coalesce((select max(created_at) from public.assignments a where a.family_id = f.id), f.created_at),
           coalesce((select max(created_at) from public.attempts t where t.family_id = f.id), f.created_at)
         ) < ${idleBefore}
       order by f.id
       limit ${limit}
    `,
  );
  let notified = 0;
  let deleted = 0;
  for (const family of candidates) {
    if (family.notified_at === null) {
      const [contact] = await deps.db.asService(
        (tx) => tx<{ email: string | null; email_verified: boolean }[]>`
          select email, email_verified from app.adult_auth_email(${family.created_by})`,
      );
      await deps.db.asService(async (tx) => {
        await tx`update public.families set inactivity_notified_at = ${now} where id = ${family.id}`;
        await tx`
          insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
          values (${family.id}, 'system', 'retention.inactivity_notice', 'family', ${family.id})`;
      });
      if (contact?.email && contact.email_verified) {
        await deps.providers.email
          .send({
            to: contact.email,
            templateKey: 'inactivity_notice',
            params: { days: String(deps.config.inactivityNoticeDays) },
          })
          .catch(() => deps.log({ level: 'warn', event: 'inactivity_notice_send_failed' }));
      }
      notified += 1;
    } else if (family.notified_at < noticeBefore) {
      await deps.db.asService((tx) => tx`select app.inactivity_delete_family(${family.id})`);
      deleted += 1;
    }
  }
  return { notified, deleted };
}

export async function runScheduledTick(
  deps: JobDeps,
  handlers: Readonly<Record<string, JobHandler>> = DEFAULT_HANDLERS,
): Promise<TickReport> {
  const now = deps.clock();
  const month = calendarMonthOf(now, 'UTC');
  const next = addMonths(month, 1);
  const monthsToGenerate = [month];
  const daysLeft =
    (Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, 1) - now.getTime()) /
    86_400_000;
  if (daysLeft <= GENERATION_LEAD_DAYS) monthsToGenerate.push(next);
  let generatedCampaigns = 0;
  for (const m of monthsToGenerate) {
    generatedCampaigns += (await runGeneration(deps.db, m, deps.random)).created.length;
  }
  const programMonth = calendarMonthOf(now, deps.config.programTimezone);
  let donationAccruals = 0;
  for (const m of [addMonths(programMonth, -1), programMonth]) {
    donationAccruals += (await runDonationAccrual(deps.db, m, deps.config.programTimezone)).accrued;
  }
  const expiredReservations = await expireStaleReservations(deps);
  const retentionPurgedPages = await purgeExpiredScans(deps);
  const spendAlerts = (await recordSpendAlerts(deps)).length;
  // P16.5: short-lived placement anti-duplication state is kept 7 days at most.
  const placementServesPurged = (await purgeExpiredServes(deps.db, now)).deleted;
  const entitlementsReconciled = await reconcileStaleEntitlements(deps);
  // The inactivity scan aggregates activity across tables, so it runs once a day (03:00 UTC tick).
  const inactivity =
    now.getUTCHours() === 3 && now.getUTCMinutes() < 5
      ? await inactivitySweep(deps)
      : { notified: 0, deleted: 0 };
  const jobs = await runJobs(deps, handlers);
  const report = {
    generatedCampaigns,
    donationAccruals,
    expiredReservations,
    retentionPurgedPages,
    spendAlerts,
    placementServesPurged,
    entitlementsReconciled,
    inactivity,
    jobs,
  };
  deps.log({ level: 'info', event: 'scheduled_tick' });
  return report;
}
