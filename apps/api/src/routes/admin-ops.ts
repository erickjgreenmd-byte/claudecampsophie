import { Hono, type Context } from 'hono';
import {
  ADMIN_CASE_PAGE_SIZE,
  REFUND_PATH_BY_CHANNEL,
  SUPPORT_RULES,
  adminCaseMessageRequestSchema,
  adminCaseUpdateRequestSchema,
  caseQueueQuerySchema,
  revenueQuerySchema,
  storeFeeRatesUpdateRequestSchema,
  uuidSchema,
  type AdminBillingPeriod,
  type AdminSupportCase,
  type AdminSupportCaseDetailResponse,
  type AdminSupportCaseMessage,
  type StoreFeeRatesResponse,
  supportPolicyUpdateRequestSchema,
} from '@pencillift/contracts';
import {
  OPEN_CASE_STATUSES,
  applyCasePatch,
  caseAgeBucket,
  caseAgeHours,
  caseOpenedAtOrBefore,
  caseUpdateProblems,
  nextResolvedAt,
  type CaseUpdateProblem,
  type SupportCaseStatus,
  supportPolicyProblems,
} from '@pencillift/domain/ops';
import { readJson } from '../app.ts';
import { loadReadinessFacts, productionReadiness } from '../config.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule } from '../errors.ts';
import { requireOwnerAdmin, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import {
  STORE_FEE_RATES_NOTES,
  loadOverview,
  loadRevenueMonths,
  loadStoreFeeRates,
  loadSubscriptions,
  saveStoreFeeRates,
  loadSupportPolicy,
  saveSupportPolicy,
} from '../services/ops-metrics.ts';

type Ctx = Context<AppEnv>;

/**
 * Owner-admin operations (/v1/admin/overview, /revenue, /subscriptions, /support/*, /settings/*).
 * Like the monetization console: every route requires an owner admin with an MFA (aal2) session
 * (requireParent + requireOwnerAdmin), reads and writes run as the service role after that check,
 * and every mutation writes an audit row with ids and statuses only (never a case's text).
 * Refunds for store purchases are issued by the store; a Stripe refund is issued in the Stripe
 * dashboard and recorded here by its reference (the Stripe client exposes no refund call).
 */

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function idParam(c: Ctx): string {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) throw new ApiError('NOT_FOUND', 'Case not found');
  return parsed.data;
}

async function audit(
  tx: Tx,
  c: Ctx,
  action: string,
  targetType: string,
  targetId: string,
  familyId: string | null,
  metadata: object = {},
): Promise<void> {
  await tx`
    insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (${familyId}, ${c.var.parent.userId}, 'admin', ${action}, ${targetType}, ${targetId},
            ${JSON.stringify(metadata)}::text::jsonb)
  `;
}

// ---------------------------------------------------------------------------------------------
// Case rows
// ---------------------------------------------------------------------------------------------

interface AdminCaseRow {
  id: string;
  family_id: string;
  opened_by_user_id: string | null;
  opened_by_kind: AdminSupportCase['openedByKind'];
  kind: AdminSupportCase['kind'];
  status: SupportCaseStatus;
  priority: AdminSupportCase['priority'];
  subject: string;
  body: string;
  channel: AdminSupportCase['billingPeriod'] extends infer P
    ? P extends { channel: infer C }
      ? C | null
      : never
    : never;
  provider_period_id: string | null;
  assignee_user_id: string | null;
  resolution: AdminSupportCase['resolution'];
  resolution_reference: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  message_count: number;
  last_message_at: Date | null;
  cursor_micros: string;
}

const CASE_COLUMNS = `
  c.id, c.family_id, c.opened_by_user_id, c.opened_by_kind, c.kind, c.status, c.priority, c.subject, c.body,
  c.channel, c.provider_period_id, c.assignee_user_id, c.resolution, c.resolution_reference,
  c.created_at, c.updated_at, c.resolved_at,
  (select count(*)::int from public.support_case_messages m where m.case_id = c.id) as message_count,
  (select max(m.created_at) from public.support_case_messages m where m.case_id = c.id) as last_message_at,
  ((extract(epoch from c.created_at) * 1000000)::bigint)::text as cursor_micros`;

function adminCaseBody(r: AdminCaseRow, now: Date): AdminSupportCase {
  const ageHours = caseAgeHours(r.created_at, now);
  return {
    id: r.id,
    familyId: r.family_id,
    openedByKind: r.opened_by_kind,
    openedByUserId: r.opened_by_user_id,
    kind: r.kind,
    status: r.status,
    priority: r.priority,
    subject: r.subject,
    body: r.body,
    billingPeriod:
      r.channel !== null && r.provider_period_id !== null
        ? { channel: r.channel, providerPeriodId: r.provider_period_id }
        : null,
    assigneeUserId: r.assignee_user_id,
    resolution: r.resolution,
    resolutionReference: r.resolution_reference,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    resolvedAt: iso(r.resolved_at),
    ageHours,
    ageBucket: caseAgeBucket(ageHours),
    messageCount: r.message_count,
    lastMessageAt: iso(r.last_message_at),
  };
}

async function loadCase(tx: Tx, id: string, lock = false): Promise<AdminCaseRow> {
  const rows = await tx.unsafe<AdminCaseRow[]>(
    `select ${CASE_COLUMNS} from public.support_cases c where c.id = $1::uuid${lock ? ' for update of c' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Case not found');
  return row;
}

const PROBLEM_MESSAGES: Readonly<Record<CaseUpdateProblem, string>> = {
  RESOLUTION_REQUIRED: 'Choose a resolution before resolving the case',
  RESOLUTION_NEEDS_CLOSED_OUT_STATUS: 'A resolution belongs to a resolved or closed case',
  REFERENCE_REQUIRED: 'Record the Stripe refund reference from the Stripe dashboard',
  REFERENCE_WITHOUT_RESOLUTION: 'A refund reference needs a resolution',
};

/** `<created_at in epoch microseconds>_<id>` of the last case on the previous page. */
const CURSOR_RE = /^([0-9]{1,19})_([0-9a-f-]{36})$/;

/** Largest epoch-microsecond value Postgres can hold in a bigint. */
const INT64_MAX = 9223372036854775807n;
/** No stored row is timestamped this far past the request clock; anything beyond is a bad cursor. */
const CURSOR_AHEAD_MICROS = 10n * 366n * 24n * 3600n * 1_000_000n;

/**
 * Parses the epoch-microseconds half of a keyset cursor with BigInt (API-AUTH-R1-03): a 19-digit
 * value past int64, or one far in the future, would fail the bigint cast or overflow the interval
 * in SQL and surface as a 500; here it is a 400 like any other malformed cursor.
 */
function cursorMicros(digits: string, now: Date): string {
  const micros = BigInt(digits);
  if (micros > INT64_MAX || micros > BigInt(now.getTime()) * 1000n + CURSOR_AHEAD_MICROS) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid request: after');
  }
  return micros.toString();
}

export function adminOpsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  for (const path of ['/overview', '/revenue', '/subscriptions', '/support/*', '/settings/*']) {
    r.use(path, requireParent, requireOwnerAdmin);
  }

  // ------------------------------------------------------------------ company overview
  r.get('/overview', async (c) => {
    const { deps } = c.var;
    const now = deps.clock();
    // Same computation as /v1/admin/readiness: the overview lists what that route would block.
    const facts = await loadReadinessFacts(deps.db, now);
    const blocked = productionReadiness(deps.config, facts)
      .filter((item) => item.status === 'blocked')
      .map((item) => ({ check: item.check, detail: item.detail }));
    const body = await deps.db.asService((tx) => loadOverview(tx, now, blocked));
    return c.json(body);
  });

  r.get('/revenue', async (c) => {
    const { deps } = c.var;
    const query = revenueQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError('VALIDATION_FAILED', 'Invalid request: months');
    const now = deps.clock();
    const body = await deps.db.asService(async (tx) => {
      const { rates } = await loadStoreFeeRates(tx);
      return loadRevenueMonths(tx, now, query.data.months, rates);
    });
    return c.json(body);
  });

  r.get('/subscriptions', async (c) => {
    const { deps } = c.var;
    const now = deps.clock();
    const body = await deps.db.asService((tx) => loadSubscriptions(tx, now));
    return c.json(body);
  });

  // ------------------------------------------------------------------ support queue
  r.get('/support/cases', async (c) => {
    const { deps } = c.var;
    const query = caseQueueQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      const fields = query.error.issues.map((i) => i.path.join('.') || '(query)').slice(0, 5);
      throw new ApiError('VALIDATION_FAILED', `Invalid request: ${fields.join(', ')}`);
    }
    const { scope, status, kind, age, after } = query.data;
    const now = deps.clock();
    const match = after === undefined ? null : CURSOR_RE.exec(after);
    if (after !== undefined && !match)
      throw new ApiError('VALIDATION_FAILED', 'Invalid request: after');
    const cursor = match === null ? null : { micros: cursorMicros(match[1]!, now), id: match[2]! };
    const openedBefore = age === undefined ? null : caseOpenedAtOrBefore(now, age);
    // Keyset pages, oldest first, like the safety queue: no fixed first page hides an old case.
    const rows = await deps.db.asService((tx) =>
      tx.unsafe<AdminCaseRow[]>(
        `select ${CASE_COLUMNS}
           from public.support_cases c
          where ($1::text is null or c.status = $1::text)
            and ($1::text is not null or $2::boolean or c.status = any($3::text[]))
            and ($4::text is null or c.kind = $4::text)
            and ($5::timestamptz is null or c.created_at <= $5::timestamptz)
            and ($6::bigint is null
                 or (c.created_at, c.id) > (timestamptz 'epoch' + $6::bigint * interval '1 microsecond', $7::uuid))
          order by c.created_at asc, c.id asc
          limit ${ADMIN_CASE_PAGE_SIZE + 1}`,
        [
          status ?? null,
          scope === 'all',
          [...OPEN_CASE_STATUSES],
          kind ?? null,
          openedBefore,
          cursor?.micros ?? null,
          cursor?.id ?? null,
        ],
      ),
    );
    const page = rows.slice(0, ADMIN_CASE_PAGE_SIZE);
    const last = page.at(-1);
    const nextCursor =
      rows.length > ADMIN_CASE_PAGE_SIZE && last !== undefined
        ? `${last.cursor_micros}_${last.id}`
        : null;
    return c.json({ cases: page.map((row) => adminCaseBody(row, now)), nextCursor });
  });

  r.get('/support/cases/:id', async (c) => {
    const { deps } = c.var;
    const id = idParam(c);
    const now = deps.clock();
    const body = await deps.db.asService(async (tx): Promise<AdminSupportCaseDetailResponse> => {
      const row = await loadCase(tx, id);
      const messages = await tx<
        {
          id: string;
          author_kind: AdminSupportCaseMessage['authorKind'];
          author_user_id: string | null;
          body: string;
          internal: boolean;
          created_at: Date;
        }[]
      >`
        select id, author_kind, author_user_id, body, internal, created_at
          from public.support_case_messages where case_id = ${id} order by created_at asc, id asc
      `;
      const [family] = await tx<
        {
          id: string;
          display_name: string;
          timezone: string;
          created_at: Date;
          deleted_at: Date | null;
        }[]
      >`select id, display_name, timezone, created_at, deleted_at from public.families where id = ${row.family_id}`;
      if (!family) throw new ApiError('NOT_FOUND', 'Case not found');
      const periods = await tx<
        {
          id: string;
          channel: AdminBillingPeriod['channel'];
          provider_period_id: string;
          kind: AdminBillingPeriod['kind'];
          period_start: Date;
          period_end: Date;
          paid_slots: number;
          regular_amount_cents: number;
          charged_amount_cents: number;
          discount_cents: number;
          settlement: AdminBillingPeriod['settlement'];
          settled_at: Date | null;
          refunded_cents: number;
          currency: string;
        }[]
      >`
        select id, channel, provider_period_id, kind, period_start, period_end, paid_slots, regular_amount_cents,
               charged_amount_cents, discount_cents, settlement, settled_at, refunded_cents, currency
          from public.billing_periods where family_id = ${row.family_id}
         order by period_start desc, id desc limit 100
      `;
      const pending = await tx<
        {
          channel: AdminBillingPeriod['channel'];
          provider_period_id: string;
          kind: 'refund' | 'partial_refund' | 'chargeback';
          refunded_cents: number | null;
          created_at: Date;
        }[]
      >`
        select channel, provider_period_id, kind, refunded_cents, created_at from public.pending_refunds
         where family_id = ${row.family_id} order by created_at desc limit 100
      `;
      return {
        case: adminCaseBody(row, now),
        messages: messages.map((m) => ({
          id: m.id,
          authorKind: m.author_kind,
          authorUserId: m.author_user_id,
          body: m.body,
          internal: m.internal,
          createdAt: m.created_at.toISOString(),
        })),
        family: {
          id: family.id,
          displayName: family.display_name,
          timezone: family.timezone,
          createdAt: family.created_at.toISOString(),
          deletedAt: iso(family.deleted_at),
        },
        billingPeriods: periods.map((p) => ({
          id: p.id,
          channel: p.channel,
          providerPeriodId: p.provider_period_id,
          kind: p.kind,
          periodStart: p.period_start.toISOString(),
          periodEnd: p.period_end.toISOString(),
          paidSlots: p.paid_slots,
          regularAmountCents: p.regular_amount_cents,
          chargedAmountCents: p.charged_amount_cents,
          discountCents: p.discount_cents,
          settlement: p.settlement,
          settledAt: iso(p.settled_at),
          refundedCents: p.refunded_cents,
          currency: p.currency,
          linkedToCase:
            p.channel === row.channel && p.provider_period_id === row.provider_period_id,
        })),
        pendingRefunds: pending.map((p) => ({
          channel: p.channel,
          providerPeriodId: p.provider_period_id,
          kind: p.kind,
          refundedCents: p.refunded_cents,
          createdAt: p.created_at.toISOString(),
        })),
        refundPath:
          row.kind === 'refund_request' && row.channel !== null
            ? REFUND_PATH_BY_CHANNEL[row.channel]
            : null,
        // providers/billing.ts exposes no refund call: Stripe refunds are issued in the dashboard.
        stripeRefundFromCase: false,
      };
    });
    return c.json(body);
  });

  r.post('/support/cases/:id/messages', async (c) => {
    const { deps } = c.var;
    const id = idParam(c);
    const input = await readJson(c, adminCaseMessageRequestSchema);
    const now = deps.clock();
    const body = await deps.db.asService(async (tx) => {
      const row = await loadCase(tx, id, true);
      const [message] = await tx<{ id: string; created_at: Date }[]>`
        insert into public.support_case_messages (case_id, author_kind, author_user_id, body, internal)
        values (${id}, 'admin', ${c.var.parent.userId}, ${input.message}, ${input.internal})
        returning id, created_at
      `;
      await audit(tx, c, 'support.message_added', 'support_case', id, row.family_id, {
        messageId: message!.id,
        internal: input.internal,
      });
      const updated = await loadCase(tx, id);
      const reply: AdminSupportCaseMessage = {
        id: message!.id,
        authorKind: 'admin',
        authorUserId: c.var.parent.userId,
        body: input.message,
        internal: input.internal,
        createdAt: message!.created_at.toISOString(),
      };
      return { message: reply, case: adminCaseBody(updated, now) };
    });
    return c.json(body, 201);
  });

  r.patch('/support/cases/:id', async (c) => {
    const { deps } = c.var;
    const id = idParam(c);
    const input = await readJson(c, adminCaseUpdateRequestSchema);
    const now = deps.clock();
    const body = await deps.db.asService(async (tx) => {
      const current = await loadCase(tx, id, true);
      if (input.assigneeUserId !== undefined && input.assigneeUserId !== null) {
        const [staff] = await tx<{ ok: boolean }[]>`
          select exists (select 1 from public.admin_users
                          where user_id = ${input.assigneeUserId} and revoked_at is null) as ok
        `;
        if (!staff?.ok) {
          throw businessRule(SUPPORT_RULES.assigneeNotStaff, 'Assign a case to a staff member');
        }
      }
      const patch = {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
        ...(input.resolutionReference === undefined
          ? {}
          : { resolutionReference: input.resolutionReference }),
      };
      const facts = {
        status: current.status,
        resolution: current.resolution,
        resolutionReference: current.resolution_reference,
      };
      const [problem] = caseUpdateProblems(facts, patch);
      if (problem !== undefined) throw businessRule(problem, PROBLEM_MESSAGES[problem]);
      const next = applyCasePatch(facts, patch);
      const assignee =
        input.assigneeUserId === undefined ? current.assignee_user_id : input.assigneeUserId;
      const priority = input.priority ?? current.priority;
      const resolvedAt = nextResolvedAt(current.status, next.status, current.resolved_at, now);
      await tx`
        update public.support_cases
           set status = ${next.status}, priority = ${priority}, assignee_user_id = ${assignee},
               resolution = ${next.resolution}, resolution_reference = ${next.resolutionReference},
               resolved_at = ${resolvedAt}
         where id = ${id}
      `;
      // Statuses, ids and the resolution code only: never the subject, body or reference text.
      await audit(tx, c, 'support.case_updated', 'support_case', id, current.family_id, {
        from: {
          status: current.status,
          priority: current.priority,
          assigneeUserId: current.assignee_user_id,
          resolution: current.resolution,
        },
        to: {
          status: next.status,
          priority,
          assigneeUserId: assignee,
          resolution: next.resolution,
        },
      });
      return { case: adminCaseBody(await loadCase(tx, id), now) };
    });
    return c.json(body);
  });

  // ------------------------------------------------------------------ settings
  const ratesBody = (
    row: Awaited<ReturnType<typeof loadStoreFeeRates>>,
  ): StoreFeeRatesResponse => ({
    rates: row.rates,
    updatedAt: iso(row.updatedAt),
    updatedBy: row.updatedBy,
    notes: [...STORE_FEE_RATES_NOTES],
  });

  r.get('/settings/store-fee-rates', async (c) => {
    const row = await c.var.deps.db.asService((tx) => loadStoreFeeRates(tx));
    return c.json(ratesBody(row));
  });

  r.put('/settings/store-fee-rates', async (c) => {
    const { deps } = c.var;
    const input = await readJson(c, storeFeeRatesUpdateRequestSchema);
    const row = await deps.db.asService(async (tx) => {
      const before = await loadStoreFeeRates(tx);
      const saved = await saveStoreFeeRates(tx, input.rates, c.var.parent.userId);
      await audit(tx, c, 'ops.store_fee_rates_updated', 'ops_setting', 'store_fee_rates', null, {
        from: before.rates,
        to: saved.rates,
      });
      return saved;
    });
    return c.json(ratesBody(row));
  });

  r.get('/settings/support-policy', async (c) => {
    const row = await c.var.deps.db.asService((tx) => loadSupportPolicy(tx));
    return c.json(row);
  });

  r.put('/settings/support-policy', async (c) => {
    const { deps } = c.var;
    const input = await readJson(c, supportPolicyUpdateRequestSchema);
    // The schema bounds each field; the domain check is the same rule set the console applies.
    const problems = supportPolicyProblems(input.policy);
    if (problems.length > 0) {
      throw businessRule(
        'SUPPORT_POLICY_INVALID',
        problems.map((p) => `${p.field} ${p.problem}`).join('; '),
      );
    }
    const row = await deps.db.asService(async (tx) => {
      const before = await loadSupportPolicy(tx);
      const saved = await saveSupportPolicy(tx, input.policy, c.var.parent.userId);
      await audit(tx, c, 'ops.support_policy_updated', 'ops_setting', 'support_policy', null, {
        from: before.policy,
        to: saved.policy,
      });
      return saved;
    });
    return c.json(row);
  });

  return r;
}
