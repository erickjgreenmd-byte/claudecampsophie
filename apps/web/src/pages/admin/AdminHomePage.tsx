import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  overviewResponseSchema,
  SUPPORT_CASE_KIND_LABELS,
  supportCaseKindSchema,
  type AttentionItem,
  type OverviewResponse,
  type RevenueResponse,
} from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import { DELETION_OVERDUE_AFTER_DAYS, FAILED_JOBS_WINDOW_DAYS } from '@pencillift/domain/ops';
import { ErrorState, Loading } from '../../components/states.tsx';
import { useApiQuery } from '../../lib/session.tsx';
import {
  AdminAccessDenied,
  adminErrorMessage,
  AdminPage,
  ageText,
  cellStyle,
  formatUtc,
  isAccessDenied,
  monthLabel,
  numberCellStyle,
  Pill,
  Provenance,
  readinessResponseSchema,
  sectionStyle,
  smallMutedStyle,
  StatGrid,
  StatTile,
  TableScroll,
  tableStyle,
} from './components/admin-ui.tsx';
import { MoreThisMonth, SubscriptionsSection } from './components/overview-sections.tsx';
import { RevenueChart } from './components/RevenueChart.tsx';

/**
 * Owner-admin home (spec P14 owner admin: provider health; P17 administration; AC_UX_02): the
 * company overview. A summary strip of what the owner must watch, the attention list (every rule,
 * zero counts included), revenue for the last six months, subscriptions, the month's other
 * numbers and, last, the API's production readiness checks with every blocked item visible.
 * Every number names its source table and definition; nothing is rounded up. Requires an
 * owner-admin MFA session (enforced by the API).
 */
export default function AdminHomePage() {
  return (
    <AdminPage title="Owner admin">
      <Overview />
    </AdminPage>
  );
}

function Overview() {
  const query = useApiQuery((api) => api.get('/v1/admin/overview', overviewResponseSchema), []);
  if (query.status === 'loading') return <Loading label="Loading the company overview…" />;
  if (query.status === 'error') {
    if (isAccessDenied(query.error)) return <AdminAccessDenied />;
    return (
      <>
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
        <Consoles />
        <Readiness />
      </>
    );
  }
  const data = query.data;
  return (
    <>
      <p style={smallMutedStyle}>
        As of {formatUtc(data.asOf)}. “This month” means {monthLabel(data.month)} (UTC).
      </p>
      <SummaryStrip data={data} />
      <AttentionList items={data.attention} />
      <RevenueSection revenue={data.revenue} month={data.month} />
      <SubscriptionsSection subscriptions={data.subscriptions} />
      <MoreThisMonth data={data} />
      <Consoles />
      <Readiness />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------------------------------------

function oldestOf(items: readonly AttentionItem[]): number | null {
  const ages = items.map((i) => i.oldestAgeHours).filter((a): a is number => a !== null);
  return ages.length === 0 ? null : Math.max(...ages);
}

function SummaryStrip({ data }: { data: OverviewResponse }) {
  const thisMonth = data.revenue.months.find((m) => m.month === data.month);
  const cases = data.attention.filter((i) => i.kind === 'support_cases_open');
  const openCases = cases.reduce((sum, i) => sum + i.count, 0);
  const safety = data.attention.filter((i) => i.kind === 'safety_reports_open');
  const openSafety = safety.reduce((sum, i) => sum + i.count, 0);
  const ai = data.aiSpend;
  const aiOver = ai.percentOfCap === null || ai.percentOfCap >= 80;
  return (
    <StatGrid label="Company summary">
      <StatTile
        label="Families"
        value={data.families.total.value.toLocaleString('en-US')}
        detail={`${data.families.newThisMonth.value.toLocaleString('en-US')} new in ${monthLabel(data.month)}`}
        source={data.families.total.source}
        definition={`${data.families.total.definition} New: ${data.families.newThisMonth.definition}`}
      />
      <StatTile
        label="Active subscriptions"
        value={data.subscriptions.active.value.toLocaleString('en-US')}
        detail={`${data.subscriptions.subscribedFamilies.value.toLocaleString('en-US')} families · ${data.families.activeChildrenWithPaidSlots.value.toLocaleString('en-US')} children on paid slots`}
        source={data.subscriptions.active.source}
        definition={`${data.subscriptions.active.definition} Children on paid slots: ${data.families.activeChildrenWithPaidSlots.definition}`}
        to="/admin/revenue"
      />
      <StatTile
        label="Net revenue this month"
        value={formatUsd(thisMonth?.totals.netCents ?? 0)}
        detail={
          thisMonth
            ? `gross ${formatUsd(thisMonth.totals.grossChargedCents)} · refunds ${formatUsd(thisMonth.totals.refundedCents)} · store fees ${formatUsd(thisMonth.totals.storeFeeCents)} (estimate)`
            : 'No charged billing periods this month'
        }
        source={data.revenue.source}
        definition={data.revenue.definition}
        to="/admin/revenue"
      />
      <StatTile
        label="AI spend vs cap"
        value={formatUsd(ai.spentCents)}
        detail={
          ai.budgetCents === null
            ? 'No cap set for this month — readiness blocks that'
            : `${ai.percentOfCap ?? 0}% of the ${formatUsd(ai.budgetCents)} cap`
        }
        source={ai.source}
        definition={ai.definition}
        tone={aiOver ? 'attention' : 'neutral'}
      />
      <StatTile
        label="Open support cases"
        value={openCases.toLocaleString('en-US')}
        detail={openCases > 0 ? `oldest ${ageText(oldestOf(cases))}` : 'None open'}
        source={cases[0]?.source ?? 'public.support_cases'}
        definition={cases[0]?.definition ?? 'Cases not resolved or closed.'}
        tone={openCases > 0 ? 'attention' : 'neutral'}
        to="/admin/support"
      />
      <StatTile
        label="Open safety flags"
        value={openSafety.toLocaleString('en-US')}
        detail={openSafety > 0 ? `oldest ${ageText(oldestOf(safety))}` : 'None open'}
        source={safety[0]?.source ?? 'public.safety_reports'}
        definition={safety[0]?.definition ?? 'Reports open or escalated.'}
        tone={openSafety > 0 ? 'attention' : 'neutral'}
      />
    </StatGrid>
  );
}

// ---------------------------------------------------------------------------------------------
// Attention list
// ---------------------------------------------------------------------------------------------

function kindLabel(key: string | null): string {
  const parsed = supportCaseKindSchema.safeParse(key);
  return parsed.success ? SUPPORT_CASE_KIND_LABELS[parsed.data] : (key ?? 'any kind');
}

function attentionLabel(item: AttentionItem): string {
  switch (item.kind) {
    case 'jobs_failed':
      return `Jobs failed (final or dead-letter) in the last ${FAILED_JOBS_WINDOW_DAYS} days`;
    case 'billing_events_failed':
      return 'Billing provider events that failed';
    case 'safety_reports_open':
      return 'Child safety reports open or escalated';
    case 'deletions_overdue':
      return `Deletion requests older than ${DELETION_OVERDUE_AFTER_DAYS} days not completed`;
    case 'support_cases_open':
      return `Open support cases: ${kindLabel(item.key)}`;
    case 'readiness_blocked':
      return 'Production readiness checks blocked';
  }
}

/** Where a person acts on the row. Rules without an owner console say so instead of linking. */
function attentionTarget(item: AttentionItem): ReactNode {
  switch (item.kind) {
    case 'jobs_failed':
      return 'No job console in this build: inspect public.jobs and the Worker logs (Deployment runbook).';
    case 'billing_events_failed':
      // No console lists provider events; a failed event is re-opened by the webhook lease and can
      // be inspected in the table (Deployment runbook). The revenue page shows only settled periods.
      return 'No provider-event console in this build: inspect public.billing_provider_events (Deployment runbook); failed events are retried by the webhook lease.';
    case 'safety_reports_open':
      return 'Parents review their child’s reports on their Privacy & data page; no owner console shows a report’s content.';
    case 'deletions_overdue':
      return 'The deletion job completes requests (Deployment runbook); no owner console shows a family’s data.';
    case 'support_cases_open':
      return (
        <Link to={`/admin/support?kind=${encodeURIComponent(item.key ?? '')}`}>Support queue</Link>
      );
    case 'readiness_blocked':
      return <a href="#readiness">Readiness checks (below)</a>;
  }
}

function orderedAttention(items: readonly AttentionItem[]): AttentionItem[] {
  const live = items
    .filter((i) => i.count > 0)
    .sort((a, b) => (b.oldestAgeHours ?? 0) - (a.oldestAgeHours ?? 0));
  const quiet = items.filter((i) => i.count === 0);
  return [...live, ...quiet];
}

function AttentionList({ items }: { items: readonly AttentionItem[] }) {
  const headingId = useId();
  const live = items.filter((i) => i.count > 0).length;
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Needs attention</h2>
      <p>
        {live === 0
          ? 'Nothing needs a person right now. Every rule below is checked on each load and shows its count, zero included.'
          : `${live} of ${items.length} rules have items waiting; the oldest are first.`}
      </p>
      {items.length === 0 ? (
        <p>The API reported no attention rules.</p>
      ) : (
        <TableScroll label="Attention table">
          <table style={tableStyle} aria-labelledby={headingId}>
            <thead>
              <tr>
                <th style={cellStyle} scope="col">
                  What
                </th>
                <th style={numberCellStyle} scope="col">
                  Count
                </th>
                <th style={cellStyle} scope="col">
                  Oldest
                </th>
                <th style={cellStyle} scope="col">
                  Where to act
                </th>
                <th style={cellStyle} scope="col">
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {orderedAttention(items).map((item) => (
                <tr key={`${item.kind}:${item.key ?? ''}`}>
                  <th style={{ ...cellStyle, fontWeight: 600 }} scope="row">
                    {attentionLabel(item)}
                  </th>
                  <td style={numberCellStyle}>
                    {item.count > 0 ? (
                      <Pill tone="attention">{item.count.toLocaleString('en-US')}</Pill>
                    ) : (
                      <Pill>None</Pill>
                    )}
                  </td>
                  <td style={cellStyle}>
                    {item.oldestAt === null
                      ? '—'
                      : `${ageText(item.oldestAgeHours)} (${formatUtc(item.oldestAt)})`}
                  </td>
                  <td style={cellStyle}>{attentionTarget(item)}</td>
                  <td style={cellStyle}>
                    <Provenance source={item.source} definition={item.definition} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Revenue (last 6 months)
// ---------------------------------------------------------------------------------------------

function RevenueSection({ revenue, month }: { revenue: RevenueResponse; month: string }) {
  const headingId = useId();
  const any = revenue.months.some(
    (m) => m.totals.grossChargedCents !== 0 || m.totals.refundedCents !== 0,
  );
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Revenue, last {revenue.months.length} months</h2>
      {any ? (
        <>
          <RevenueChart
            title={`Net revenue by month, ${revenue.months.length} months to ${monthLabel(month)} (estimate after store fees)`}
            bars={revenue.months.map((m) => ({ month: m.month, netCents: m.totals.netCents }))}
          />
          <TableScroll label="Revenue by month table">
            <table style={tableStyle} aria-label="Revenue by month">
              <thead>
                <tr>
                  <th style={cellStyle} scope="col">
                    Month
                  </th>
                  <th style={numberCellStyle} scope="col">
                    Gross charged
                  </th>
                  <th style={numberCellStyle} scope="col">
                    Refunds
                  </th>
                  <th style={numberCellStyle} scope="col">
                    Store fees (estimate)
                  </th>
                  <th style={numberCellStyle} scope="col">
                    Net
                  </th>
                </tr>
              </thead>
              <tbody>
                {revenue.months.map((m) => (
                  <tr key={m.month}>
                    <th style={cellStyle} scope="row">
                      {monthLabel(m.month)}
                    </th>
                    <td style={numberCellStyle}>{formatUsd(m.totals.grossChargedCents)}</td>
                    <td style={numberCellStyle}>{formatUsd(m.totals.refundedCents)}</td>
                    <td style={numberCellStyle}>{formatUsd(m.totals.storeFeeCents)}</td>
                    <td style={{ ...numberCellStyle, fontWeight: 700 }}>
                      {formatUsd(m.totals.netCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      ) : (
        <p>
          No charged billing periods in the last {revenue.months.length} months, so there is no
          revenue to chart yet.
        </p>
      )}
      <p style={{ margin: '8px 0 0' }}>
        <Link to="/admin/revenue">Channel breakdown, subscriptions and fee rates</Link>
      </p>
      <ul style={{ ...smallMutedStyle, paddingLeft: 20 }}>
        {revenue.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <Provenance source={revenue.source} definition={revenue.definition} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Production readiness (unchanged rules: nothing other than "ready" is shown as a pass)
// ---------------------------------------------------------------------------------------------

const CHECK_LABEL: Readonly<Record<string, string>> = {
  consent_provider: 'Parental consent provider',
  billing_provider: 'Subscription billing (RevenueCat)',
  ai_provider: 'AI provider (OpenAI)',
  zdr_evidence: 'Zero data retention approval',
  parent_jwt_keys: 'Parent sign-in keys',
  cors: 'Allowed web origins (CORS)',
  web_billing_provider: 'Web billing (Stripe, optional)',
  catalog_data: 'Catalog data (no fixtures or fakes)',
  database_environment: 'Database marked production',
  storage_provider: 'Homework photo storage (Supabase)',
  email_provider: 'Email provider',
  ai_spend_budget: 'AI spend cap for this month',
  safety_templates: 'Child safety messages and escalation (approval)',
  ai_moderation: 'AI moderation (provider)',
};

function Readiness() {
  const headingId = useId();
  const query = useApiQuery((api) => api.get('/v1/admin/readiness', readinessResponseSchema), []);

  if (query.status === 'loading') return <Loading label="Loading readiness…" />;
  if (query.status === 'error') {
    return isAccessDenied(query.error) ? (
      <AdminAccessDenied />
    ) : (
      <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
    );
  }
  const { checks, environment } = query.data;
  const blocked = checks.filter((c) => c.status !== 'ready').length;
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId} id="readiness">
      <h2 id={headingId}>Production readiness</h2>
      <p>
        Environment: <strong>{environment}</strong>.{' '}
        {blocked > 0
          ? `${blocked} of ${checks.length} checks are blocked — PencilLift is not ready to serve real families here.`
          : `All ${checks.length} checks are ready.`}
      </p>
      <TableScroll label="Readiness table">
        <table style={tableStyle} aria-labelledby={headingId}>
          <thead>
            <tr>
              <th style={cellStyle} scope="col">
                Check
              </th>
              <th style={cellStyle} scope="col">
                Status
              </th>
              <th style={cellStyle} scope="col">
                What it needs
              </th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const ready = c.status === 'ready';
              return (
                <tr key={c.check}>
                  <th style={cellStyle} scope="row">
                    {CHECK_LABEL[c.check] ?? c.check}
                  </th>
                  <td
                    style={{
                      ...cellStyle,
                      color: ready ? 'var(--success)' : 'var(--danger)',
                      fontWeight: 700,
                    }}
                  >
                    {ready
                      ? '✓ Ready'
                      : `✗ ${c.status === 'blocked' ? 'Blocked' : `Not ready (${c.status})`}`}
                  </td>
                  <td style={cellStyle}>{c.detail}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
      <p style={{ color: 'var(--muted)' }}>
        A development mock never counts as ready. Blocked items need the owner’s real accounts, keys
        or evidence; see the owner actions list.
      </p>
    </section>
  );
}

function Consoles() {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Consoles</h2>
      <ul>
        <li>
          <Link to="/admin/support">Support</Link> — the family support queue: complaints, refund
          requests, billing issues, bugs and questions, with replies and internal notes.
        </li>
        <li>
          <Link to="/admin/revenue">Subscriptions and revenue</Link> — months by channel with
          estimated store fees, subscriptions by channel, slots and status, fee-rate settings.
        </li>
        <li>
          <Link to="/admin/promotions">Promotions</Link> — monthly templates, generation, campaign
          caps, store offer mappings and codes.
        </li>
        <li>
          <Link to="/admin/schools">Schools and payouts</Link> — schools, aggregate monthly reports,
          accruals and payout batches.
        </li>
        <li>
          <Link to="/admin/monetization">Monetization</Link> — ads, sponsorships and affiliate
          controls.
        </li>
      </ul>
    </section>
  );
}
