import { Hono, type Context } from 'hono';
import {
  childRewardRequestBodySchema,
  createRewardRequestSchema,
  pointsAdjustmentRequestSchema,
  rewardDecisionRequestSchema,
  updateRewardRequestSchema,
  uuidSchema,
  type ChildReward,
  type ChildRewardRequest,
  type ChildRewardRequestResponse,
  type ChildRewards,
  type ParentRewardRequest,
  type PointsAdjustmentResponse,
  type PointsHistory,
  type PointsLedgerKind,
  type Reward,
  type RewardDecisionResponse,
  type RewardRequestState,
  type RewardsOverview,
} from '@pencillift/contracts';
import { readJson } from '../app.ts';
import type { ChildPrincipal, Tx } from '../db.ts';
import { ApiError, businessRule, isUniqueViolation, pgErrorCode } from '../errors.ts';
import {
  assertRecentUnlock,
  currentFamilyId,
  requireChild,
  requireParent,
} from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, type RateRule } from '../middleware/rate-limit.ts';

/**
 * Rewards and points (spec P9, P16.4; AC_REWARDS_01..05, AC_MON_13, AC_ACCESS_05).
 *
 * Points are a family motivational ledger, not money. Balances change only through the append-only
 * ledger in migration 0400: parents adjust with a reason and a step-up, children reserve points by
 * requesting a reward, and decline/cancel releases them exactly once. There is deliberately no
 * endpoint that awards points (learning awards are a server-side job owned by the learning vertical)
 * and none that ties points to ads, sponsor/affiliate clicks, purchases or referrals (AC_MON_13).
 *
 * Every parent request runs as `authenticated` and every child request as `pl_child`, so RLS and
 * column grants are an independent second layer; no handler here uses the service role for data.
 */

/**
 * Decision: a paired child may request or cancel at most 30 times per hour. Points already bound the
 * damage; the limit stops a stuck button or a script from flooding the parent's request list.
 */
const CHILD_REWARD_ACTION_RULE: RateRule = { limit: 30, windowSeconds: 3600 };
const HISTORY_PAGE_SIZE = 100;
const RECENT_REQUESTS_LIMIT = 20;
const CHILD_REQUESTS_LIMIT = 50;

// ---------------------------------------------------------------------------------------------
// Row shapes and DTO mappers (explicit columns only)
// ---------------------------------------------------------------------------------------------

interface RewardRow {
  id: string;
  title: string;
  point_cost: number;
  instructions: string | null;
  child_id: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ParentRequestRow {
  id: string;
  child_id: string;
  child_nickname: string;
  reward_id: string;
  reward_title: string;
  point_cost: number;
  state: RewardRequestState;
  requested_at: Date;
  decided_at: Date | null;
  fulfilled_at: Date | null;
  cancelled_by: 'child' | 'parent' | null;
}

interface ChildRequestRow {
  id: string;
  reward_id: string;
  reward_title: string | null;
  point_cost: number;
  state: RewardRequestState;
  requested_at: Date;
  decided_at: Date | null;
  fulfilled_at: Date | null;
}

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

function toReward(row: RewardRow): Reward {
  return {
    id: row.id,
    title: row.title,
    pointCost: row.point_cost,
    instructions: row.instructions,
    childId: row.child_id,
    active: row.active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toParentRequest(row: ParentRequestRow): ParentRewardRequest {
  return {
    id: row.id,
    childId: row.child_id,
    childNickname: row.child_nickname,
    rewardId: row.reward_id,
    rewardTitle: row.reward_title,
    pointCost: row.point_cost,
    state: row.state,
    requestedAt: iso(row.requested_at),
    decidedAt: isoOrNull(row.decided_at),
    fulfilledAt: isoOrNull(row.fulfilled_at),
    cancelledBy: row.cancelled_by,
  };
}

/** Child DTO: allowlisted fields only (no family, child, creator, decider or cancel-actor ids). */
function toChildRequest(row: ChildRequestRow): ChildRewardRequest {
  return {
    id: row.id,
    rewardId: row.reward_id,
    rewardTitle: row.reward_title,
    pointCost: row.point_cost,
    state: row.state,
    requestedAt: iso(row.requested_at),
    decidedAt: isoOrNull(row.decided_at),
    fulfilledAt: isoOrNull(row.fulfilled_at),
  };
}

// ---------------------------------------------------------------------------------------------
// Database error mapping (never forwards raw SQL messages)
// ---------------------------------------------------------------------------------------------

function dbMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/** Maps expected outcomes of migration 0400's RPCs/triggers to stable API errors. */
function mapRewardsDbError(error: unknown, caller: 'parent' | 'child'): never {
  const code = pgErrorCode(error);
  const message = dbMessage(error);
  if (code === 'P0001' && message.includes('insufficient points')) {
    throw businessRule(
      'INSUFFICIENT_POINTS',
      caller === 'child'
        ? 'You need a few more points for this one. Keep going!'
        : 'That would take the points balance below zero',
    );
  }
  if (
    code === 'P0001' &&
    (message.includes('invalid reward redemption transition') ||
      message.includes('only pending requests'))
  ) {
    throw businessRule(
      'INVALID_TRANSITION',
      caller === 'child'
        ? 'This request can’t be changed now. A grown-up is already looking at it.'
        : 'This request can’t move to that state from where it is now',
    );
  }
  if (code === 'P0001' && message.includes('request id already used')) {
    throw new ApiError('CONFLICT', 'Please try again');
  }
  if (code === 'P0002') {
    if (message.includes('reward not available'))
      throw new ApiError('NOT_FOUND', 'That reward isn’t available right now');
    if (message.includes('child not found')) throw new ApiError('NOT_FOUND', 'Child not found');
    throw new ApiError('NOT_FOUND', 'Request not found');
  }
  if (code === '42501') {
    // Parent: the step-up expired between our check and the write (RLS / RPC re-check).
    if (caller === 'parent')
      throw new ApiError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue');
    throw new ApiError('UNAUTHENTICATED', 'Ask a grown-up to connect this device again');
  }
  throw error;
}

// ---------------------------------------------------------------------------------------------
// Shared queries
// ---------------------------------------------------------------------------------------------

async function readParentRequest(tx: Tx, requestId: string): Promise<ParentRequestRow | null> {
  const [row] = await tx<ParentRequestRow[]>`
    select r.id, r.child_id, c.nickname as child_nickname, r.reward_id, w.title as reward_title,
           r.point_cost, r.state, r.requested_at, r.decided_at, r.fulfilled_at, r.cancelled_by
      from public.reward_redemptions r
      join public.rewards w on w.id = r.reward_id
      join public.child_profiles c on c.id = r.child_id
     where r.id = ${requestId}`;
  return row ?? null;
}

async function readBalance(tx: Tx, childId: string): Promise<number> {
  const [row] = await tx<{ balance: number }[]>`
    select balance from public.point_balances where child_id = ${childId}`;
  return row?.balance ?? 0;
}

async function readChildRequest(
  tx: Tx,
  child: ChildPrincipal,
  requestId: string,
): Promise<ChildRequestRow | null> {
  // Explicit allowlisted columns (column grants make select * fail closed; lesson L-003).
  const [row] = await tx<ChildRequestRow[]>`
    select r.id, r.reward_id, w.title as reward_title, r.point_cost, r.state,
           r.requested_at, r.decided_at, r.fulfilled_at
      from public.reward_redemptions r
      left join public.rewards w on w.id = r.reward_id
     where r.id = ${requestId} and r.child_id = ${child.childId}`;
  return row ?? null;
}

function paramUuid(c: Context<AppEnv>, name: string, notFound: string): string {
  const parsed = uuidSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new ApiError('NOT_FOUND', notFound);
  return parsed.data;
}

async function audit(
  c: Context<AppEnv>,
  familyId: string,
  action: string,
  targetId: string,
): Promise<void> {
  const { deps, parent } = c.var;
  try {
    // Service role: family and actor come from the verified session, never from the request body.
    await deps.db.asService(
      (tx) => tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
        values (${familyId}, ${parent.userId}, 'parent', ${action}, 'reward', ${targetId})`,
    );
  } catch {
    // Decision: the reward change has already committed; failing the response would invite a
    // duplicate retry. Record the gap (ids/codes only, no payload) for operations instead.
    deps.log({ level: 'error', event: 'audit_write_failed', requestId: c.var.requestId });
  }
}

/** Rewards, redemption requests, point adjustments and history for parents and paired children. */
export function rewardsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Middleware is attached per route (never `use('*')`): this router shares the /v1 prefix with
  // other verticals and must not change their authentication.

  // -------------------------------------------------------------------------------------------
  // Parent
  // -------------------------------------------------------------------------------------------

  r.get('/rewards', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const data = await deps.db.asParent(parent, async (tx) => ({
      rewards: await tx<RewardRow[]>`
        select id, title, point_cost, instructions, child_id, active, created_at, updated_at
          from public.rewards where family_id = ${familyId}
         order by active desc, point_cost, created_at`,
      children: await tx<{ id: string; nickname: string; balance: number }[]>`
        select c.id, c.nickname, coalesce(b.balance, 0) as balance
          from public.child_profiles c
          left join public.point_balances b on b.child_id = c.id
         where c.family_id = ${familyId} and c.status = 'active'
         order by c.created_at, c.id`,
      open: await tx<ParentRequestRow[]>`
        select r.id, r.child_id, c.nickname as child_nickname, r.reward_id, w.title as reward_title,
               r.point_cost, r.state, r.requested_at, r.decided_at, r.fulfilled_at, r.cancelled_by
          from public.reward_redemptions r
          join public.rewards w on w.id = r.reward_id
          join public.child_profiles c on c.id = r.child_id
         where r.family_id = ${familyId} and r.state in ('pending', 'approved')
         order by r.requested_at, r.id`,
      recent: await tx<ParentRequestRow[]>`
        select r.id, r.child_id, c.nickname as child_nickname, r.reward_id, w.title as reward_title,
               r.point_cost, r.state, r.requested_at, r.decided_at, r.fulfilled_at, r.cancelled_by
          from public.reward_redemptions r
          join public.rewards w on w.id = r.reward_id
          join public.child_profiles c on c.id = r.child_id
         where r.family_id = ${familyId} and r.state in ('fulfilled', 'declined', 'cancelled')
         order by r.updated_at desc, r.id
         limit ${RECENT_REQUESTS_LIMIT}`,
    }));
    const body: RewardsOverview = {
      rewards: data.rewards.map(toReward),
      children: data.children.map((ch) => ({
        childId: ch.id,
        nickname: ch.nickname,
        balance: ch.balance,
      })),
      openRequests: data.open.map(toParentRequest),
      recentRequests: data.recent.map(toParentRequest),
    };
    return c.json(body);
  });

  r.post('/rewards', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const body = await readJson(c, createRewardRequestSchema);
    const instructions =
      body.instructions !== undefined && body.instructions.length > 0 ? body.instructions : null;
    let row: RewardRow | null;
    try {
      row = await deps.db.asParent(parent, async (tx) => {
        if (body.childId !== null) {
          // The composite FK would also refuse a foreign child; checking first gives a clean 404.
          const [child] = await tx<{ id: string }[]>`
            select id from public.child_profiles
             where id = ${body.childId} and family_id = ${familyId} and status <> 'archived'`;
          if (!child) return null;
        }
        const [inserted] = await tx<RewardRow[]>`
          insert into public.rewards (family_id, child_id, title, point_cost, instructions, created_by)
          values (${familyId}, ${body.childId}, ${body.title}, ${body.pointCost}, ${instructions}, ${parent.userId})
          returning id, title, point_cost, instructions, child_id, active, created_at, updated_at`;
        return inserted ?? null;
      });
    } catch (error) {
      mapRewardsDbError(error, 'parent');
    }
    if (!row) throw new ApiError('NOT_FOUND', 'Child not found');
    await audit(c, familyId, 'reward.created', row.id);
    return c.json({ reward: toReward(row) }, 201);
  });

  r.patch('/rewards/:id', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const rewardId = paramUuid(c, 'id', 'Reward not found');
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const body = await readJson(c, updateRewardRequestSchema);
    const setInstructions = body.instructions !== undefined;
    const instructions =
      body.instructions !== undefined && body.instructions !== null && body.instructions.length > 0
        ? body.instructions
        : null;
    let row: RewardRow | undefined;
    try {
      [row] = await deps.db.asParent(
        parent,
        (tx) => tx<RewardRow[]>`
          update public.rewards
             set title = coalesce(${body.title ?? null}::text, title),
                 point_cost = coalesce(${body.pointCost ?? null}::integer, point_cost),
                 instructions = case when ${setInstructions}::boolean then ${instructions}::text
                                     else instructions end,
                 active = coalesce(${body.active ?? null}::boolean, active)
           where id = ${rewardId} and family_id = ${familyId}
          returning id, title, point_cost, instructions, child_id, active, created_at, updated_at`,
      );
    } catch (error) {
      mapRewardsDbError(error, 'parent');
    }
    if (!row) throw new ApiError('NOT_FOUND', 'Reward not found');
    await audit(c, familyId, 'reward.updated', row.id);
    return c.json({ reward: toReward(row) });
  });

  r.post('/reward-requests/:id/decision', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const requestId = paramUuid(c, 'id', 'Request not found');
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const { action } = await readJson(c, rewardDecisionRequestSchema);
    let result: RewardDecisionResponse | null;
    try {
      result = await deps.db.asParent(parent, async (tx) => {
        // First layer: the request must belong to the caller's family. The RPC re-checks
        // membership and the step-up inside the database (second layer).
        const [owned] = await tx<{ id: string }[]>`
          select id from public.reward_redemptions
           where id = ${requestId} and family_id = ${familyId}`;
        if (!owned) return null;
        await tx`select id from public.parent_decide_reward(${requestId}, ${action})`;
        const row = await readParentRequest(tx, requestId);
        if (!row) return null;
        return { request: toParentRequest(row), balance: await readBalance(tx, row.child_id) };
      });
    } catch (error) {
      mapRewardsDbError(error, 'parent');
    }
    if (!result) throw new ApiError('NOT_FOUND', 'Request not found');
    return c.json(result);
  });

  r.post('/points/adjustments', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const body = await readJson(c, pointsAdjustmentRequestSchema);
    let result: PointsAdjustmentResponse | null;
    try {
      result = await deps.db.asParent(parent, async (tx) => {
        const [child] = await tx<{ id: string }[]>`
          select id from public.child_profiles
           where id = ${body.childId} and family_id = ${familyId}`;
        if (!child) return null;
        // The RPC appends a reasoned `adjustment` entry keyed by adjustmentId (unique per child),
        // so a retried submit is a no-op and the balance is never edited directly.
        const [entry] = await tx<{ entry_id: string | null }[]>`
          select public.parent_adjust_points(${body.childId}, ${body.points}, ${body.reason}, ${body.adjustmentId}) as entry_id`;
        return {
          childId: body.childId,
          balance: await readBalance(tx, body.childId),
          applied: entry?.entry_id !== null && entry?.entry_id !== undefined,
        };
      });
    } catch (error) {
      mapRewardsDbError(error, 'parent');
    }
    if (!result) throw new ApiError('NOT_FOUND', 'Child not found');
    return c.json(result, result.applied ? 201 : 200);
  });

  r.get('/points/history', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const parsed = uuidSchema.safeParse(c.req.query('childId'));
    if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Choose a child');
    const childId = parsed.data;
    const familyId = await currentFamilyId(c);
    const data = await deps.db.asParent(parent, async (tx) => {
      const [child] = await tx<{ id: string }[]>`
        select id from public.child_profiles where id = ${childId} and family_id = ${familyId}`;
      if (!child) return null;
      const entries = await tx<
        {
          id: string;
          kind: PointsLedgerKind;
          points: number;
          reason: string | null;
          actor_kind: 'system' | 'parent' | 'child';
          redemption_id: string | null;
          reward_title: string | null;
          created_at: Date;
        }[]
      >`
        select l.id, l.kind, l.points, l.reason, l.actor_kind, l.redemption_id,
               w.title as reward_title, l.created_at
          from public.points_ledger l
          left join public.reward_redemptions rr on rr.id = l.redemption_id
          left join public.rewards w on w.id = rr.reward_id
         where l.child_id = ${childId} and l.family_id = ${familyId}
         order by l.id desc
         limit ${HISTORY_PAGE_SIZE + 1}`;
      const [totals] = await tx<
        { awarded: number; adjustments: number; reserved: number; released: number; net: number }[]
      >`
        select coalesce(sum(points) filter (where kind = 'award'), 0)::integer as awarded,
               coalesce(sum(points) filter (where kind = 'adjustment'), 0)::integer as adjustments,
               coalesce(sum(points) filter (where kind = 'redemption_reserve'), 0)::integer as reserved,
               coalesce(sum(points) filter (where kind = 'redemption_release'), 0)::integer as released,
               coalesce(sum(points), 0)::integer as net
          from public.points_ledger
         where child_id = ${childId} and family_id = ${familyId}`;
      return { entries, totals: totals!, balance: await readBalance(tx, childId) };
    });
    if (!data) throw new ApiError('NOT_FOUND', 'Child not found');
    const body: PointsHistory = {
      childId,
      balance: data.balance,
      entries: data.entries.slice(0, HISTORY_PAGE_SIZE).map((e) => ({
        id: String(e.id),
        kind: e.kind,
        points: e.points,
        reason: e.reason,
        actor: e.actor_kind,
        redemptionId: e.redemption_id,
        rewardTitle: e.reward_title,
        createdAt: iso(e.created_at),
      })),
      hasMore: data.entries.length > HISTORY_PAGE_SIZE,
      totals: data.totals,
    };
    return c.json(body);
  });

  // -------------------------------------------------------------------------------------------
  // Child (paired device). Identity comes only from the verified child session.
  // -------------------------------------------------------------------------------------------

  r.get('/child/rewards', requireChild, async (c) => {
    const { deps, child } = c.var;
    const data = await deps.db.asChild(child, async (tx) => ({
      balance: await readBalance(tx, child.childId),
      // RLS already limits rows to active rewards for this child; the filter repeats it explicitly.
      rewards: await tx<
        { id: string; title: string; point_cost: number; instructions: string | null }[]
      >`
        select id, title, point_cost, instructions from public.rewards
         where active and family_id = ${child.familyId}
           and (child_id is null or child_id = ${child.childId})
         order by point_cost, title, id`,
      requests: await tx<ChildRequestRow[]>`
        select r.id, r.reward_id, w.title as reward_title, r.point_cost, r.state,
               r.requested_at, r.decided_at, r.fulfilled_at
          from public.reward_redemptions r
          left join public.rewards w on w.id = r.reward_id
         where r.child_id = ${child.childId}
         order by (r.state in ('pending', 'approved')) desc, r.requested_at desc, r.id
         limit ${CHILD_REQUESTS_LIMIT}`,
    }));
    const body: ChildRewards = {
      balance: data.balance,
      rewards: data.rewards.map((w): ChildReward => ({
        id: w.id,
        title: w.title,
        pointCost: w.point_cost,
        instructions: w.instructions,
      })),
      requests: data.requests.map(toChildRequest),
    };
    return c.json(body);
  });

  r.post('/child/rewards/:rewardId/request', requireChild, async (c) => {
    const { deps, child } = c.var;
    const rewardId = paramUuid(c, 'rewardId', 'That reward isn’t available right now');
    await enforceRateLimit(
      deps.rateLimiter,
      `reward-action:${child.childId}`,
      CHILD_REWARD_ACTION_RULE,
      deps.clock(),
    );
    const { requestId } = await readJson(c, childRewardRequestBodySchema);
    const run = () =>
      deps.db.asChild(child, async (tx): Promise<ChildRewardRequestResponse | null> => {
        // Reserve/debit atomically in the database; the balance CHECK stops concurrent double-spends.
        await tx`select id from public.child_request_reward(${rewardId}, ${requestId})`;
        const row = await readChildRequest(tx, child, requestId);
        if (!row) return null;
        return { request: toChildRequest(row), balance: await readBalance(tx, child.childId) };
      });
    let result: ChildRewardRequestResponse | null;
    try {
      result = await run();
    } catch (error) {
      if (!isUniqueViolation(error)) mapRewardsDbError(error, 'child');
      // Two devices retried the same request id at once: the other insert won, so replaying now
      // returns that request (idempotent) instead of reserving again.
      try {
        result = await run();
      } catch (retryError) {
        mapRewardsDbError(retryError, 'child');
      }
    }
    if (!result) throw new ApiError('NOT_FOUND', 'Request not found');
    return c.json(result, 201);
  });

  r.post('/child/reward-requests/:id/cancel', requireChild, async (c) => {
    const { deps, child } = c.var;
    const requestId = paramUuid(c, 'id', 'Request not found');
    await enforceRateLimit(
      deps.rateLimiter,
      `reward-action:${child.childId}`,
      CHILD_REWARD_ACTION_RULE,
      deps.clock(),
    );
    let result: ChildRewardRequestResponse | null;
    try {
      result = await deps.db.asChild(child, async (tx) => {
        // The RPC only finds requests owned by the session's child; a sibling's id is "not found".
        await tx`select id from public.child_cancel_reward_request(${requestId})`;
        const row = await readChildRequest(tx, child, requestId);
        if (!row) return null;
        return { request: toChildRequest(row), balance: await readBalance(tx, child.childId) };
      });
    } catch (error) {
      mapRewardsDbError(error, 'child');
    }
    if (!result) throw new ApiError('NOT_FOUND', 'Request not found');
    return c.json(result);
  });

  return r;
}
