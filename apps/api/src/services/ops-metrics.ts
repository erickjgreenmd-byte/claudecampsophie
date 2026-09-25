import {
  channelSchema,
  type AttentionItem,
  type OverviewResponse,
  type ReadinessBlocked,
  type RevenueMonth,
  type RevenueResponse,
  type StoreFeeRates,
  type SubscriptionsSummary,
  type SupportPolicyResponse,
} from '@pencillift/contracts';
import { MAX_ACCESS_AFTER_PERIOD_END_MS } from '@pencillift/domain/entitlements';
import {
  DELETION_OVERDUE_AFTER_DAYS,
  DELETION_TARGET_DAYS,
  FAILED_JOBS_WINDOW_DAYS,
  FAILED_JOB_STATUSES,
  OPEN_CASE_STATUSES,
  OPEN_SAFETY_REPORT_STATUSES,
  STRIPE_FEE_NOTE,
  SUPPORT_CASE_KINDS,
  attentionItem,
  channelRevenue,
  churnBasisPoints,
  defaultStoreFeeRate,
  deletionOverdueBefore,
  failedJobsWindowStart,
  percentOfCap,
  rateToBasisPoints,
  recentUtcMonths,
  sumRevenue,
  utcMonthBounds,
  utcMonthKey,
  type AttentionKind,
  supportPolicyFromStored,
  type SupportPolicy,
} from '@pencillift/domain/ops';
import type { Tx } from '../db.ts';
import { REVENUE_CURRENCY } from './billing-sync.ts';

/**
 * Database reads behind the owner's company overview (spec: the owner watches the company on one
 * screen). Every loader runs inside a service-role transaction opened by a handler that has
 * already verified an MFA owner admin; every query takes the request clock as a parameter (never
 * now()); every figure carries the table it came from and how it was counted. Aggregates only:
 * nothing here returns a child, a question or a family list.
 */

/** The billing channels, read from the contract at run time (never hardcoded here). */
export const CHANNELS: readonly string[] = channelSchema.options;
type Channel = (typeof channelSchema.options)[number];

export const STORE_FEE_RATES_KEY = 'store_fee_rates';

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const int = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export interface StoreFeeRatesRow {
  readonly rates: StoreFeeRates;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

function rateFrom(value: unknown, channel: string): number {
  const stored =
    typeof value === 'object' && value !== null && channel in value
      ? (value as Record<string, unknown>)[channel]
      : undefined;
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 && stored <= 1
    ? stored
    : defaultStoreFeeRate(channel);
}

/** The configured fee fraction per channel; a channel the stored row lacks takes the default. */
export async function loadStoreFeeRates(tx: Tx): Promise<StoreFeeRatesRow> {
  const [row] = await tx<{ value: unknown; updated_at: Date; updated_by: string | null }[]>`
    select value, updated_at, updated_by from public.ops_settings where key = ${STORE_FEE_RATES_KEY}
  `;
  const rates = Object.fromEntries(
    CHANNELS.map((channel) => [channel, rateFrom(row?.value, channel)]),
  ) as StoreFeeRates;
  return { rates, updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null };
}

/** The row's touch trigger stamps updated_at with the database clock (as the monetization switches do). */
export async function saveStoreFeeRates(
  tx: Tx,
  rates: StoreFeeRates,
  userId: string,
): Promise<StoreFeeRatesRow> {
  await tx`
    insert into public.ops_settings (key, value, updated_by)
    values (${STORE_FEE_RATES_KEY}, ${JSON.stringify(rates)}::text::jsonb, ${userId})
    on conflict (key) do update
      set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
  `;
  return loadStoreFeeRates(tx);
}

// ---------------------------------------------------------------------------------------------
// Support policy (public.ops_settings key support_policy; Owner action #32)
// ---------------------------------------------------------------------------------------------

const SUPPORT_POLICY_KEY = 'support_policy';

/** Absent or invalid stored value → the default policy, reported as such. */
export async function loadSupportPolicy(tx: Tx): Promise<SupportPolicyResponse> {
  const [row] = await tx<{ value: unknown; updated_at: Date; updated_by: string | null }[]>`
    select value, updated_at, updated_by from public.ops_settings where key = ${SUPPORT_POLICY_KEY}
  `;
  const { policy, usedDefault } = supportPolicyFromStored(row?.value ?? null);
  return {
    policy,
    usedDefault,
    updatedAt: row && !usedDefault ? row.updated_at.toISOString() : null,
    updatedBy: row && !usedDefault ? row.updated_by : null,
  };
}

export async function saveSupportPolicy(
  tx: Tx,
  policy: SupportPolicy,
  userId: string,
): Promise<SupportPolicyResponse> {
  await tx`
    insert into public.ops_settings (key, value, updated_by)
    values (${SUPPORT_POLICY_KEY}, ${JSON.stringify(policy)}::text::jsonb, ${userId})
    on conflict (key) do update
      set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
  `;
  return loadSupportPolicy(tx);
}

export const STORE_FEE_RATES_NOTES: readonly string[] = [
  'Store fees are an estimate at the configured rate on charged minus refunded amounts, rounded half up to the cent; the store statements are the truth.',
  STRIPE_FEE_NOTE,
];

// ---------------------------------------------------------------------------------------------
// Revenue by month and channel (public.billing_periods)
// ---------------------------------------------------------------------------------------------

const REVENUE_SOURCE = 'public.billing_periods';
const REVENUE_DEFINITION = `Charged periods in ${REVENUE_CURRENCY} (settlement settled, refunded, partially_refunded or chargeback) bucketed by the UTC month of settled_at (period_start when unsettled); gross = charged_amount_cents, refunds = refunded_cents attributed to the month of the charge they reverse (a chargeback counts as a refund of the disputed amount, or of the whole charge when the store reports none), fee = estimate at the channel rate, net = gross − refunds − fee. A period charged in another currency is counted in the notes, never in these sums.`;

/** The revenue note listing periods left out because they were not charged in USD (BILL-R1-5). */
export function foreignCurrencyNote(counts: ReadonlyMap<string, number>): string | null {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const perChannel = CHANNELS.filter((c) => (counts.get(c) ?? 0) > 0)
    .map((c) => `${c} ${counts.get(c)}`)
    .join(', ');
  return `Excluded from every figure above: ${total} billing period${total === 1 ? '' : 's'} not charged in ${REVENUE_CURRENCY} (${perChannel}). The stores are meant to sell in the United States only; see Owner action #38 and the billing.unexpected_currency audit events.`;
}

export async function loadRevenueMonths(
  tx: Tx,
  now: Date,
  monthCount: number,
  rates: StoreFeeRates,
): Promise<RevenueResponse> {
  const months = recentUtcMonths(now, monthCount);
  const start = utcMonthBounds(months[0]!).start;
  const end = utcMonthBounds(months[months.length - 1]!).end;
  const rows = await tx<
    {
      month: string;
      channel: string;
      periods: number;
      gross: string;
      refunds: string;
      foreign_periods: number;
    }[]
  >`
    select to_char(coalesce(settled_at, period_start) at time zone 'UTC', 'YYYY-MM') as month,
           channel,
           count(*) filter (where currency = ${REVENUE_CURRENCY})::int as periods,
           coalesce(sum(charged_amount_cents) filter (where currency = ${REVENUE_CURRENCY}), 0)::text as gross,
           coalesce(sum(refunded_cents) filter (where currency = ${REVENUE_CURRENCY}), 0)::text as refunds,
           count(*) filter (where currency <> ${REVENUE_CURRENCY})::int as foreign_periods
      from public.billing_periods
     where settlement in ('settled', 'refunded', 'partially_refunded', 'chargeback')
       and coalesce(settled_at, period_start) >= ${start}
       and coalesce(settled_at, period_start) < ${end}
     group by 1, 2
  `;
  const foreignByChannel = new Map<string, number>();
  for (const r of rows) {
    if (r.foreign_periods > 0) {
      foreignByChannel.set(r.channel, (foreignByChannel.get(r.channel) ?? 0) + r.foreign_periods);
    }
  }
  const currencyNote = foreignCurrencyNote(foreignByChannel);
  const byCell = new Map(rows.map((r) => [`${r.month}|${r.channel}`, r]));
  const monthBodies: RevenueMonth[] = months.map((month) => {
    const channels = CHANNELS.map((channel) => {
      const cell = byCell.get(`${month}|${channel}`);
      const line = channelRevenue({
        grossChargedCents: int(cell?.gross),
        refundedCents: int(cell?.refunds),
        feeBasisPoints: rateToBasisPoints(rates[channel as Channel]),
      });
      return {
        channel: channel as Channel,
        periods: cell?.periods ?? 0,
        grossChargedCents: line.grossChargedCents,
        refundedCents: line.refundedCents,
        feeRateBasisPoints: line.feeBasisPoints,
        storeFeeCents: line.storeFeeCents,
        netCents: line.netCents,
      };
    });
    return { month, channels, totals: sumRevenue(channels) };
  });
  return {
    asOf: now.toISOString(),
    months: monthBodies,
    feeRates: rates,
    notes: [...STORE_FEE_RATES_NOTES, ...(currencyNote === null ? [] : [currencyNote])],
    source: REVENUE_SOURCE,
    definition: REVENUE_DEFINITION,
  };
}

// ---------------------------------------------------------------------------------------------
// Subscriptions (public.family_entitlements)
// ---------------------------------------------------------------------------------------------

const ENTITLEMENTS = 'public.family_entitlements';
const ACTIVE_DEFINITION = `Ledger rows granting paid access at the request instant: status active or grace_period with period_end less than ${MAX_ACCESS_AFTER_PERIOD_END_MS / 86_400_000} days ago, or cancelled_active before period_end (the domain entitlement rule).`;

export async function loadSubscriptions(tx: Tx, now: Date): Promise<SubscriptionsSummary> {
  const month = utcMonthKey(now);
  const { start, end } = utcMonthBounds(month);
  const accessBoundSeconds = MAX_ACCESS_AFTER_PERIOD_END_MS / 1000;
  const active = await tx<{ channel: string; paid_slots: number; family_id: string }[]>`
    select channel, paid_slots, family_id
      from public.family_entitlements
     where (status in ('active', 'grace_period')
              and period_end is not null
              and period_end + make_interval(secs => ${accessBoundSeconds}) > ${now})
        or (status = 'cancelled_active' and period_end is not null and period_end > ${now})
  `;
  const byStatus = await tx<{ status: string; count: number }[]>`
    select status, count(*)::int as count from public.family_entitlements group by status order by status
  `;
  const [movement] = await tx<
    { new_this_month: number; lapsed_this_month: number; active_at_start: number }[]
  >`
    select (select count(*)::int from public.family_entitlements
             where created_at >= ${start} and created_at < ${end}) as new_this_month,
           (select count(*)::int from public.family_entitlements
             where status in ('expired', 'revoked', 'refunded')
               and period_end >= ${start} and period_end < ${end}) as lapsed_this_month,
           (select count(*)::int from public.family_entitlements
             where created_at < ${start} and period_end >= ${start} and status <> 'pending') as active_at_start
  `;
  const channelCounts = new Map<string, number>(CHANNELS.map((c) => [c, 0]));
  const slotCounts = new Map<number, number>();
  const families = new Set<string>();
  for (const row of active) {
    channelCounts.set(row.channel, (channelCounts.get(row.channel) ?? 0) + 1);
    slotCounts.set(row.paid_slots, (slotCounts.get(row.paid_slots) ?? 0) + 1);
    families.add(row.family_id);
  }
  const lapsed = movement?.lapsed_this_month ?? 0;
  const activeAtStart = movement?.active_at_start ?? 0;
  return {
    asOf: now.toISOString(),
    month,
    active: { value: active.length, source: ENTITLEMENTS, definition: ACTIVE_DEFINITION },
    subscribedFamilies: {
      value: families.size,
      source: ENTITLEMENTS,
      definition: 'Distinct family_id among the active rows above.',
    },
    byChannel: CHANNELS.map((channel) => ({
      channel: channel as Channel,
      count: channelCounts.get(channel) ?? 0,
    })),
    byPaidSlots: [...slotCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([paidSlots, count]) => ({ paidSlots, count })),
    byStatus: byStatus.map((r) => ({
      status: r.status as SubscriptionsSummary['byStatus'][number]['status'],
      count: r.count,
    })),
    newThisMonth: {
      value: movement?.new_this_month ?? 0,
      source: ENTITLEMENTS,
      definition: `Rows first recorded (created_at) in ${month} UTC.`,
    },
    lapsedThisMonth: {
      value: lapsed,
      source: ENTITLEMENTS,
      definition: `Rows now expired, revoked or refunded whose provider period_end falls in ${month} UTC.`,
    },
    activeAtMonthStart: {
      value: activeAtStart,
      source: ENTITLEMENTS,
      definition: `Rows recorded before ${month} whose provider period had not ended at the start of the month (status not pending).`,
    },
    churn: {
      basisPoints: churnBasisPoints(lapsed, activeAtStart),
      source: ENTITLEMENTS,
      definition:
        'lapsedThisMonth ÷ activeAtMonthStart in basis points, rounded down; null when nothing was active at the start of the month.',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

export const OVERVIEW_REVENUE_MONTHS = 6;

interface CountRow {
  count: number;
  oldest: Date | null;
}

export async function loadOverview(
  tx: Tx,
  now: Date,
  blockedReadiness: readonly ReadinessBlocked[],
): Promise<OverviewResponse> {
  const month = utcMonthKey(now);
  const { start, end } = utcMonthBounds(month);
  const { rates } = await loadStoreFeeRates(tx);

  const [families] = await tx<
    { total: number; new_this_month: number; children_with_slots: number }[]
  >`
    select (select count(*)::int from public.families where deleted_at is null) as total,
           (select count(*)::int from public.families
             where deleted_at is null and created_at >= ${start} and created_at < ${end}) as new_this_month,
           (select count(*)::int from public.child_slot_assignments a
              join public.child_profiles p on p.id = a.child_id and p.family_id = a.family_id
             where a.released_at is null and p.status = 'active') as children_with_slots
  `;

  const subscriptions = await loadSubscriptions(tx, now);
  const revenue = await loadRevenueMonths(tx, now, OVERVIEW_REVENUE_MONTHS, rates);

  const promoStates = await tx<{ state: string; count: number }[]>`
    select state, count(*)::int as count from public.promo_redemptions group by state order by state
  `;
  const [promoMonth] = await tx<{ count: number }[]>`
    select count(*)::int as count from public.promo_redemptions
     where created_at >= ${start} and created_at < ${end}
  `;

  const [contributions] = await tx<{ accrued: string; adjusted: string; paid: string }[]>`
    select coalesce((select sum(amount_cents) from public.donation_accruals), 0)::text as accrued,
           coalesce((select sum(amount_cents) from public.donation_adjustments), 0)::text as adjusted,
           coalesce((select sum(total_cents) from public.donation_payout_batches where status = 'paid'), 0)::text as paid
  `;

  const [recognized] = await tx<{ entries: string; adjustments: string }[]>`
    select coalesce((select sum(amount_cents) from public.revenue_entries
                      where category = 'recognized' and period_month = ${month}), 0)::text as entries,
           coalesce((select sum(j.amount_cents) from public.revenue_adjustments j
                       join public.revenue_entries e on e.id = j.entry_id
                      where e.category = 'recognized' and e.period_month = ${month}), 0)::text as adjustments
  `;

  const [spend] = await tx<{ spent: string; budget: string | null }[]>`
    select coalesce((select sum(cost_micros) from public.ai_usage_events
                      where created_at >= ${start} and created_at < ${end}), 0)::text as spent,
           (select budget_micros::text from public.spend_budgets
             where scope = 'global' and period_key = ${month}) as budget
  `;

  const [jobs] = await tx<CountRow[]>`
    select count(*)::int as count, min(updated_at) as oldest from public.jobs
     where status = any(${[...FAILED_JOB_STATUSES]}) and updated_at >= ${failedJobsWindowStart(now)}
  `;
  const [billingEvents] = await tx<CountRow[]>`
    select count(*)::int as count, min(received_at) as oldest from public.billing_provider_events
     where status = 'failed'
  `;
  const [safety] = await tx<CountRow[]>`
    select count(*)::int as count, min(created_at) as oldest from public.safety_reports
     where status = any(${[...OPEN_SAFETY_REPORT_STATUSES]})
  `;
  const [deletions] = await tx<CountRow[]>`
    select count(*)::int as count, min(requested_at) as oldest from public.deletion_requests
     where status in ('requested', 'processing') and requested_at <= ${deletionOverdueBefore(now)}
  `;
  const caseRows = await tx<(CountRow & { kind: string })[]>`
    select kind, count(*)::int as count, min(created_at) as oldest from public.support_cases
     where status = any(${[...OPEN_CASE_STATUSES]})
     group by kind
  `;
  const casesByKind = new Map(caseRows.map((r) => [r.kind, r]));

  const item = (
    kind: AttentionKind,
    row: CountRow | undefined,
    source: string,
    definition: string,
    key: string | null = null,
  ): AttentionItem => {
    const built = attentionItem(kind, row?.count ?? 0, row?.oldest ?? null, now, key);
    return {
      kind: built.kind,
      key: built.key,
      count: built.count,
      oldestAt: iso(built.oldestAt),
      oldestAgeHours: built.oldestAgeHours,
      source,
      definition,
    };
  };

  const spentMicros = BigInt(spend?.spent ?? '0');
  const budgetMicros =
    spend?.budget === null || spend?.budget === undefined ? null : BigInt(spend.budget);

  return {
    asOf: now.toISOString(),
    month,
    families: {
      total: {
        value: families?.total ?? 0,
        source: 'public.families',
        definition: 'Families without a deletion tombstone (deleted_at is null).',
      },
      newThisMonth: {
        value: families?.new_this_month ?? 0,
        source: 'public.families',
        definition: `Families created in ${month} UTC and not deleted.`,
      },
      activeChildrenWithPaidSlots: {
        value: families?.children_with_slots ?? 0,
        source: 'public.child_slot_assignments',
        definition: 'Open slot assignments (released_at is null) whose child profile is active.',
      },
    },
    subscriptions,
    revenue,
    promoRedemptions: {
      byState: promoStates.map((r) => ({
        state: r.state as OverviewResponse['promoRedemptions']['byState'][number]['state'],
        count: r.count,
      })),
      thisMonth: {
        value: promoMonth?.count ?? 0,
        source: 'public.promo_redemptions',
        definition: `Redemptions created in ${month} UTC, any state.`,
      },
      source: 'public.promo_redemptions',
      definition: 'Every redemption row by its current state (all time).',
    },
    schoolContributions: {
      accruedCents: {
        cents: int(contributions?.accrued) + int(contributions?.adjusted),
        source: 'public.donation_accruals + public.donation_adjustments',
        definition:
          'Sum of accrued $1 contributions plus signed adjustments (refunds and chargebacks reverse an accrual), all time, whether or not paid out.',
      },
      paidOutCents: {
        cents: int(contributions?.paid),
        source: 'public.donation_payout_batches',
        definition:
          'Sum of total_cents over batches with status paid (a recorded transfer reference).',
      },
    },
    monetization: {
      recognizedThisMonthCents: {
        cents: int(recognized?.entries) + int(recognized?.adjustments),
        source: 'public.revenue_entries + public.revenue_adjustments',
        definition: `P16 entries with category recognized for period_month ${month}, plus their signed adjustments.`,
      },
    },
    aiSpend: {
      month,
      spentMicros: spentMicros.toString(),
      budgetMicros: budgetMicros === null ? null : budgetMicros.toString(),
      spentCents: Number(spentMicros / 10_000n),
      budgetCents: budgetMicros === null ? null : Number(budgetMicros / 10_000n),
      percentOfCap: percentOfCap(spentMicros, budgetMicros),
      source: 'public.ai_usage_events, public.spend_budgets',
      definition: `Sum of cost_micros for events created in ${month} UTC against the global budget row for ${month} (none set means no cap; readiness blocks that).`,
    },
    attention: [
      item(
        'jobs_failed',
        jobs,
        'public.jobs',
        `Jobs in status failed_final or dead_letter last updated within ${FAILED_JOBS_WINDOW_DAYS} days.`,
      ),
      item(
        'billing_events_failed',
        billingEvents,
        'public.billing_provider_events',
        'Provider events (RevenueCat, Stripe) whose processing failed, all time.',
      ),
      item(
        'safety_reports_open',
        safety,
        'public.safety_reports',
        'Reports in status open or escalated (oldest by created_at).',
      ),
      item(
        'deletions_overdue',
        deletions,
        'public.deletion_requests',
        `Requests still requested or processing ${DELETION_OVERDUE_AFTER_DAYS}+ days after requested_at (the target is ${DELETION_TARGET_DAYS} days).`,
      ),
      ...SUPPORT_CASE_KINDS.map((kind) =>
        item(
          'support_cases_open',
          casesByKind.get(kind),
          'public.support_cases',
          `Cases of kind ${kind} in status open, in_progress or waiting_on_parent (oldest by created_at).`,
          kind,
        ),
      ),
      item(
        'readiness_blocked',
        { count: blockedReadiness.length, oldest: null },
        '/v1/admin/readiness',
        'Production readiness checks reporting blocked (no timestamps: configuration, not a queue).',
      ),
    ],
    readiness: {
      blocked: [...blockedReadiness],
      source: '/v1/admin/readiness',
      definition: 'The readiness report’s blocked checks, computed the same way as that route.',
    },
  };
}
