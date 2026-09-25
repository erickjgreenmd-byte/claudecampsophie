import { Hono } from 'hono';
import { ACCOUNT_CLOSE_RULES, closeAccountRequestSchema } from '@pencillift/contracts';
import { readJson } from '../app.ts';
import type { Tx } from '../db.ts';
import { ApiError } from '../errors.ts';
import { assertRecentUnlock, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import type { AuthAdminProvider } from '../providers/index.ts';

/**
 * Account closure (Apple 5.1.1(v); Google Play account deletion): POST /v1/account/close removes
 * the parent's own sign-in, not only the family's data (privacy.ts). Parent token plus a recent PIN
 * unlock (server-checked) and an explicit confirmation flag in a strict body.
 *
 * - A family OWNER must already have asked for the family's deletion (scope family): the family
 *   is tombstoned, child devices are signed out and the purge is queued. The sign-in itself closes
 *   only after that purge has completed, through the durable `account_close` job (payload: the user
 *   id only), so nothing that the purge still needs disappears first. Answer: 202 `pending`.
 * - A GUARDIAN is removed from the family at once (the same retirements as the owner removing
 *   them, guardians.ts) and their sign-in is closed inline. Answer: 200 `closed`, or 202 `pending`
 *   when the auth service could not be reached (the queued job retries; the token stops working
 *   the moment the user is closed).
 * - An adult without a family closes their sign-in at once.
 * Every answer says `signOut: true`; the device clears its parent session through its normal
 * sign-out path. Audit rows carry ids only; the log carries the outcome only.
 */
export function accountRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/account/close', requireParent, async (c) => {
    const { deps, parent } = c.var;
    await readJson(c, closeAccountRequestSchema);
    const authAdmin = deps.providers.authAdmin;
    if (!authAdmin) throw new ApiError('NOT_CONFIGURED', 'Account closure is not configured');
    await assertRecentUnlock(c);
    const now = deps.clock();
    const userId = parent.userId;

    // Service role because a tombstoned family is invisible under RLS; scoped to the verified caller.
    // A family-scope deletion releases memberships at request time (migration 0840, DB-R1-02), so
    // a membership the deletion itself released still counts here while that deletion is open: the
    // owner's sign-in closes only once the purge has finished (the job defers with PURGE_PENDING).
    const memberships = await deps.db.asService(
      (tx) => tx<
        {
          family_id: string;
          role: 'owner' | 'guardian';
          status: string;
          deleted_at: Date | null;
        }[]
      >`
        select m.family_id, m.role, m.status, f.deleted_at
          from public.family_memberships m
          join public.families f on f.id = m.family_id
         where m.user_id = ${userId}
           and (m.status = 'active'
                or (f.deleted_at is not null and m.revoked_at >= f.deletion_requested_at
                    and exists (
                      select 1 from public.deletion_requests d
                       where d.family_id = f.id and d.scope = 'family'
                         and d.status in ('requested', 'processing'))))
         order by m.accepted_at, m.id`,
    );
    // A live family the caller owns comes first: after deleting one family a parent may start
    // another (DB-R1-02), and that live family must block the closure, not the tombstoned one.
    const owned =
      memberships.find((m) => m.role === 'owner' && m.deleted_at === null) ??
      memberships.find((m) => m.role === 'owner') ??
      null;
    if (owned) {
      const requested = await deps.db.asService(
        (tx) => tx<{ id: string }[]>`
          select id from public.deletion_requests
           where family_id = ${owned.family_id} and scope = 'family'
             and status in ('requested', 'processing', 'completed')
           limit 1`,
      );
      if (requested.length === 0 || owned.deleted_at === null) {
        throw new ApiError(
          'CONFLICT',
          'Delete your whole family account first; your sign-in closes once that deletion has finished',
          { rule: ACCOUNT_CLOSE_RULES.familyDeletionRequired },
        );
      }
    }

    await deps.db.asService(async (tx) => {
      // Only a still-active guardian membership is removed here; one the deletion released is
      // already revoked.
      for (const m of memberships.filter((x) => x.role === 'guardian' && x.status === 'active')) {
        await removeGuardian(tx, m.family_id, userId, now);
      }
      await enqueueClose(tx, userId, now);
      await tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
        values (${memberships[0]?.family_id ?? null}, ${userId}, 'parent', 'account.close_requested',
                'auth_user', ${userId},
                ${JSON.stringify({ role: owned ? 'owner' : memberships.length > 0 ? 'guardian' : 'none' })}::text::jsonb)`;
    });

    if (owned) {
      deps.log({ level: 'info', event: 'account_close_requested', code: 'AFTER_PURGE' });
      return c.json({ status: 'pending', signOut: true }, 202);
    }
    const closed = await closeNow(authAdmin, deps, userId);
    deps.log({
      level: closed ? 'info' : 'warn',
      event: 'account_close_requested',
      code: closed ? 'CLOSED' : 'QUEUED',
    });
    return c.json({ status: closed ? 'closed' : 'pending', signOut: true }, closed ? 200 : 202);
  });

  return r;
}

/**
 * The guardian's own removal: the same retirements as when the owner removes them (guardians.ts):
 * step-up unlocks, unredeemed pairing codes they created, invitations they sent and consent they
 * started but never completed all die with the membership (AC_ACCESS_09).
 */
async function removeGuardian(tx: Tx, familyId: string, userId: string, now: Date): Promise<void> {
  await tx`
    update public.family_memberships
       set status = 'revoked', revoked_at = ${now}, revoked_by = ${userId}
     where family_id = ${familyId} and user_id = ${userId} and role = 'guardian' and status = 'active'`;
  await tx`
    update private.adult_unlocks set revoked_at = ${now}
     where user_id = ${userId} and revoked_at is null`;
  await tx`
    update private.child_pairing_codes set consumed_at = ${now}
     where family_id = ${familyId} and created_by = ${userId} and consumed_at is null`;
  await tx`
    update public.guardian_invitations set status = 'revoked'
     where family_id = ${familyId} and invited_by = ${userId} and status = 'pending'`;
  await tx`
    update public.consent_records set status = 'withdrawn', withdrawn_at = ${now}
     where family_id = ${familyId} and adult_user_id = ${userId} and status = 'pending'`;
  await tx`
    insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
    values (${familyId}, ${userId}, 'parent', 'guardian.left', 'family_membership', ${userId})`;
}

/**
 * One durable `account_close` job per user (idempotency key account_close:<user>). A job that
 * already ended without closing the user (dead-lettered after the auth service refused it, or
 * cancelled) is not resurrected (terminal rows are immutable, migration 0600): a fresh request
 * queues a versioned successor instead, as the runbook prescribes for retries.
 */
async function enqueueClose(tx: Tx, userId: string, now: Date): Promise<void> {
  const key = `account_close:${userId}`;
  const existing = await tx<{ status: string }[]>`
    select status from public.jobs where idempotency_key = ${key} or idempotency_key like ${key + ':v%'}
     order by created_at desc limit 1`;
  const last = existing[0]?.status;
  if (
    last === 'queued' ||
    last === 'running' ||
    last === 'failed_retryable' ||
    last === 'succeeded'
  ) {
    return;
  }
  const versions = await tx<{ n: number }[]>`
    select count(*)::int as n from public.jobs
     where idempotency_key = ${key} or idempotency_key like ${key + ':v%'}`;
  const n = versions[0]?.n ?? 0;
  await tx`
    insert into public.jobs (kind, idempotency_key, payload, run_after)
    values ('account_close', ${n === 0 ? key : `${key}:v${n + 1}`},
            ${JSON.stringify({ userId })}::text::jsonb, ${now})
    on conflict (idempotency_key) do nothing`;
}

/** Closes the user now; a refusal is logged (code only) and left to the queued job. */
async function closeNow(
  authAdmin: AuthAdminProvider,
  deps: AppEnv['Variables']['deps'],
  userId: string,
): Promise<boolean> {
  try {
    const { outcome } = await authAdmin.closeUser(userId);
    await deps.db.asService(
      (tx) => tx`
        insert into public.audit_events (actor_user_id, actor_kind, action, target_type, target_id, metadata)
        values (${userId}, 'parent', 'account.closed', 'auth_user', ${userId},
                ${JSON.stringify({ provider: authAdmin.name, outcome })}::text::jsonb)`,
    );
    return true;
  } catch (error) {
    deps.log({
      level: 'warn',
      event: 'account_close_deferred',
      code: error instanceof Error ? error.name : 'Error',
    });
    return false;
  }
}
