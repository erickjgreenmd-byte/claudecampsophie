import { Hono, type Context } from 'hono';
import {
  SUPPORT_RULES,
  createSupportCaseRequestSchema,
  replySupportCaseRequestSchema,
  uuidSchema,
  type SupportBillingPeriod,
  type SupportCase,
  type SupportCaseDetail,
  type SupportCaseMessage,
} from '@pencillift/contracts';
import {
  parentCanReply,
  statusAfterParentReply,
  type SupportCaseKind,
  type SupportCaseResolution,
  type SupportCaseStatus,
} from '@pencillift/domain/ops';
import { readJson } from '../app.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule } from '../errors.ts';
import { currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, type RateRule } from '../middleware/rate-limit.ts';

type Ctx = Context<AppEnv>;

/**
 * Parent-facing support cases (/v1/support/*). Every read and write runs as the parent
 * (`authenticated`) so the row policies of migration 0810 are the second layer: a family sees only
 * its own cases and never a staff internal note; a case is opened as 'parent' in status open; a
 * reply lands only on a case of the family that is not closed. A refund request may name one of
 * the family's own provider billing periods; the store issues the refund, never PencilLift, and
 * the case shows what the provider later reports on that period.
 */

/** Cases a family may open per hour and replies per hour (abuse bound, not a product limit). */
const CASE_OPEN_RULE: RateRule = { limit: 10, windowSeconds: 3600 };
const CASE_REPLY_RULE: RateRule = { limit: 30, windowSeconds: 3600 };

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

interface PeriodRow {
  period_id: string | null;
  channel: SupportBillingPeriod['channel'] | null;
  provider_period_id: string | null;
  period_start: Date | null;
  period_end: Date | null;
  paid_slots: number | null;
  charged_amount_cents: number | null;
  refunded_cents: number | null;
  settlement: SupportBillingPeriod['settlement'] | null;
}

interface CaseRow extends PeriodRow {
  id: string;
  kind: SupportCaseKind;
  status: SupportCaseStatus;
  subject: string;
  body: string;
  resolution: SupportCaseResolution | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  message_count: number;
}

function periodBody(r: PeriodRow): SupportBillingPeriod | null {
  if (
    r.period_id === null ||
    r.channel === null ||
    r.provider_period_id === null ||
    r.period_start === null ||
    r.period_end === null ||
    r.paid_slots === null ||
    r.charged_amount_cents === null ||
    r.refunded_cents === null ||
    r.settlement === null
  ) {
    return null;
  }
  return {
    id: r.period_id,
    channel: r.channel,
    providerPeriodId: r.provider_period_id,
    periodStart: r.period_start.toISOString(),
    periodEnd: r.period_end.toISOString(),
    paidSlots: r.paid_slots,
    chargedCents: r.charged_amount_cents,
    refundedCents: r.refunded_cents,
    settlement: r.settlement,
  };
}

function caseBody(r: CaseRow): SupportCase {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    subject: r.subject,
    body: r.body,
    billingPeriod: periodBody(r),
    resolution: r.resolution,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    resolvedAt: iso(r.resolved_at),
    canReply: parentCanReply(r.status),
    messageCount: r.message_count,
  };
}

/** The family's cases as the parent role sees them (the linked period through its own read policy). */
async function loadCases(tx: Tx, familyId: string, id?: string): Promise<CaseRow[]> {
  return tx<CaseRow[]>`
    select c.id, c.kind, c.status, c.subject, c.body, c.resolution, c.created_at, c.updated_at, c.resolved_at,
           (select count(*)::int from public.support_case_messages m where m.case_id = c.id) as message_count,
           p.id as period_id, p.channel, p.provider_period_id, p.period_start, p.period_end, p.paid_slots,
           p.charged_amount_cents, p.refunded_cents, p.settlement
      from public.support_cases c
      left join public.billing_periods p
        on p.channel = c.channel and p.provider_period_id = c.provider_period_id and p.family_id = c.family_id
     where c.family_id = ${familyId}
       and (${id ?? null}::uuid is null or c.id = ${id ?? null}::uuid)
     order by c.created_at desc, c.id desc
     limit 200
  `;
}

interface MessageRow {
  id: string;
  author_kind: SupportCaseMessage['authorKind'];
  body: string;
  created_at: Date;
}

/** Non-internal messages only: the parent role's read policy excludes staff notes. */
async function loadDetail(tx: Tx, familyId: string, id: string): Promise<SupportCaseDetail> {
  const [row] = await loadCases(tx, familyId, id);
  if (!row) throw new ApiError('NOT_FOUND', 'Case not found');
  const messages = await tx<MessageRow[]>`
    select id, author_kind, body, created_at from public.support_case_messages
     where case_id = ${id} order by created_at asc, id asc
  `;
  return {
    ...caseBody(row),
    messages: messages.map((m) => ({
      id: m.id,
      authorKind: m.author_kind,
      body: m.body,
      createdAt: m.created_at.toISOString(),
    })),
  };
}

function caseId(c: Ctx): string {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) throw new ApiError('NOT_FOUND', 'Case not found');
  return parsed.data;
}

export function supportRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // The family's provider billing periods, for the refund-request picker (empty without a purchase).
  r.get('/support/billing-periods', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const rows = await deps.db.asParent(
      parent,
      (tx) => tx<PeriodRow[]>`
        select id as period_id, channel, provider_period_id, period_start, period_end, paid_slots,
               charged_amount_cents, refunded_cents, settlement
          from public.billing_periods
         where family_id = ${familyId}
         order by period_start desc, id desc
         limit 60
      `,
    );
    return c.json({ periods: rows.map(periodBody).filter((p) => p !== null) });
  });

  r.get('/support/cases', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const rows = await deps.db.asParent(parent, (tx) => loadCases(tx, familyId));
    return c.json({ cases: rows.map(caseBody) });
  });

  r.post('/support/cases', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const input = await readJson(c, createSupportCaseRequestSchema);
    const familyId = await currentFamilyId(c);
    const now = deps.clock();
    await enforceRateLimit(deps.rateLimiter, `support-case:${familyId}`, CASE_OPEN_RULE, now);
    const id = await deps.db.asParent(parent, async (tx) => {
      let channel: string | null = null;
      let providerPeriodId: string | null = null;
      if (input.billingPeriodId !== undefined) {
        // Read as the parent: the member policy makes another family's period simply not exist.
        const [period] = await tx<{ channel: string; provider_period_id: string }[]>`
          select channel, provider_period_id from public.billing_periods
           where id = ${input.billingPeriodId} and family_id = ${familyId}
        `;
        if (!period) {
          throw businessRule(
            SUPPORT_RULES.billingPeriodNotFound,
            'Choose one of your own billing periods',
          );
        }
        channel = period.channel;
        providerPeriodId = period.provider_period_id;
      }
      // Inserted as the parent: the 0810 policy fixes opened_by_kind, author and status.
      const [row] = await tx<{ id: string }[]>`
        insert into public.support_cases
          (family_id, opened_by_user_id, opened_by_kind, kind, subject, body, channel, provider_period_id)
        values (${familyId}, ${parent.userId}, 'parent', ${input.kind}, ${input.subject}, ${input.message},
                ${channel}, ${providerPeriodId})
        returning id
      `;
      return row!.id;
    });
    // Kinds and ids only: never the subject or body.
    await deps.db.asService(
      (tx) => tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
        values (${familyId}, ${parent.userId}, 'parent', 'support.case_opened', 'support_case', ${id},
                ${JSON.stringify({ kind: input.kind, hasBillingPeriod: input.billingPeriodId !== undefined })}::text::jsonb)
      `,
    );
    deps.log({ level: 'info', event: 'support_case_opened', requestId: c.var.requestId });
    const detail = await deps.db.asParent(parent, (tx) => loadDetail(tx, familyId, id));
    return c.json({ case: detail }, 201);
  });

  r.get('/support/cases/:id', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const id = caseId(c);
    const familyId = await currentFamilyId(c);
    const detail = await deps.db.asParent(parent, (tx) => loadDetail(tx, familyId, id));
    return c.json({ case: detail });
  });

  r.post('/support/cases/:id/messages', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const id = caseId(c);
    const input = await readJson(c, replySupportCaseRequestSchema);
    const familyId = await currentFamilyId(c);
    const now = deps.clock();
    await enforceRateLimit(deps.rateLimiter, `support-reply:${familyId}`, CASE_REPLY_RULE, now);
    const status = await deps.db.asParent(parent, async (tx) => {
      const [row] = await tx<{ status: SupportCaseStatus }[]>`
        select status from public.support_cases where id = ${id} and family_id = ${familyId}
      `;
      if (!row) throw new ApiError('NOT_FOUND', 'Case not found');
      if (!parentCanReply(row.status)) {
        throw businessRule(
          SUPPORT_RULES.caseClosed,
          'This case is closed. Open a new case if you need more help.',
        );
      }
      // Inserted as the parent: the policy re-checks the family, the author and that it is not closed.
      await tx`
        insert into public.support_case_messages (case_id, author_kind, author_user_id, body)
        values (${id}, 'parent', ${parent.userId}, ${input.message})
      `;
      return row.status;
    });
    const next = statusAfterParentReply(status);
    await deps.db.asService(async (tx) => {
      if (next !== status) {
        // A reply on a resolved or waiting case puts it back in the staff queue.
        await tx`
          update public.support_cases set status = ${next}, resolved_at = null, resolution = null,
                 resolution_reference = null
           where id = ${id} and family_id = ${familyId} and status = ${status}
        `;
      }
      await tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
        values (${familyId}, ${parent.userId}, 'parent', 'support.reply_added', 'support_case', ${id},
                ${JSON.stringify({ reopened: next !== status })}::text::jsonb)
      `;
    });
    const detail = await deps.db.asParent(parent, (tx) => loadDetail(tx, familyId, id));
    return c.json({ case: detail });
  });

  return r;
}
