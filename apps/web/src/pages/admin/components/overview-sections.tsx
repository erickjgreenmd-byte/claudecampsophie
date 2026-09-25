import { useId } from 'react';
import type { OverviewResponse, SubscriptionsSummary } from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import {
  cellStyle,
  channelLabel,
  monthLabel,
  numberCellStyle,
  percentText,
  Provenance,
  sectionStyle,
  TableScroll,
  tableStyle,
} from './admin-ui.tsx';

/**
 * Sections shared by the owner overview (/admin) and the revenue console (/admin/revenue):
 * subscriptions by channel, paid slots and ledger status, and the month's promo, school
 * contribution and P16 lines. Every number carries its source and definition from the API.
 */

const STATUS_LABEL: Readonly<Record<SubscriptionsSummary['byStatus'][number]['status'], string>> = {
  pending: 'Pending (waiting for the store)',
  active: 'Active',
  grace_period: 'Grace period',
  billing_retry: 'Billing retry',
  cancelled_active: 'Cancelled, active until period end',
  expired: 'Expired',
  revoked: 'Revoked',
  refunded: 'Refunded',
};

function count(value: number): string {
  return value.toLocaleString('en-US');
}

export function SubscriptionsSection({
  subscriptions,
  showStatuses = false,
}: {
  subscriptions: SubscriptionsSummary;
  showStatuses?: boolean;
}) {
  const headingId = useId();
  const s = subscriptions;
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Subscriptions</h2>
      <p>
        <strong>{count(s.active.value)}</strong> active across{' '}
        <strong>{count(s.subscribedFamilies.value)}</strong> families. In {monthLabel(s.month)}:{' '}
        {count(s.newThisMonth.value)} new, {count(s.lapsedThisMonth.value)} lapsed,{' '}
        {count(s.activeAtMonthStart.value)} active at the start of the month, churn{' '}
        {percentText(s.churn.basisPoints)}
        {s.churn.basisPoints === null ? ' (no base to divide by)' : ''}.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
        }}
      >
        <TableScroll label="Active subscriptions by channel">
          <table style={tableStyle} aria-label="Active subscriptions by channel">
            <thead>
              <tr>
                <th style={cellStyle} scope="col">
                  Channel
                </th>
                <th style={numberCellStyle} scope="col">
                  Active
                </th>
              </tr>
            </thead>
            <tbody>
              {s.byChannel.map((row) => (
                <tr key={row.channel}>
                  <th style={cellStyle} scope="row">
                    {channelLabel(row.channel)}
                  </th>
                  <td style={numberCellStyle}>{count(row.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <TableScroll label="Active subscriptions by paid slots">
          <table style={tableStyle} aria-label="Active subscriptions by paid slots">
            <thead>
              <tr>
                <th style={cellStyle} scope="col">
                  Paid slots
                </th>
                <th style={numberCellStyle} scope="col">
                  Active
                </th>
              </tr>
            </thead>
            <tbody>
              {s.byPaidSlots.length === 0 ? (
                <tr>
                  <td style={cellStyle} colSpan={2}>
                    No active subscriptions yet.
                  </td>
                </tr>
              ) : (
                s.byPaidSlots.map((row) => (
                  <tr key={row.paidSlots}>
                    <th style={cellStyle} scope="row">
                      {row.paidSlots}
                    </th>
                    <td style={numberCellStyle}>{count(row.count)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableScroll>
        {showStatuses ? (
          <TableScroll label="Subscription rows by status">
            <table style={tableStyle} aria-label="Subscription rows by status">
              <thead>
                <tr>
                  <th style={cellStyle} scope="col">
                    Ledger status
                  </th>
                  <th style={numberCellStyle} scope="col">
                    Rows
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.byStatus.length === 0 ? (
                  <tr>
                    <td style={cellStyle} colSpan={2}>
                      No subscription rows recorded yet.
                    </td>
                  </tr>
                ) : (
                  s.byStatus.map((row) => (
                    <tr key={row.status}>
                      <th style={cellStyle} scope="row">
                        {STATUS_LABEL[row.status]}
                      </th>
                      <td style={numberCellStyle}>{count(row.count)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableScroll>
        ) : null}
      </div>
      <Provenance
        source={s.active.source}
        definition={`${s.active.definition} New: ${s.newThisMonth.definition} Lapsed: ${s.lapsedThisMonth.definition} Churn: ${s.churn.definition}`}
      />
    </section>
  );
}

export function MoreThisMonth({ data }: { data: OverviewResponse }) {
  const headingId = useId();
  const promo = data.promoRedemptions;
  const school = data.schoolContributions;
  const p16 = data.monetization.recognizedThisMonthCents;
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Promotions, schools and sponsorships</h2>
      <TableScroll label="Other company numbers">
        <table style={tableStyle} aria-labelledby={headingId}>
          <thead>
            <tr>
              <th style={cellStyle} scope="col">
                Measure
              </th>
              <th style={numberCellStyle} scope="col">
                Value
              </th>
              <th style={cellStyle} scope="col">
                Source
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th style={cellStyle} scope="row">
                Promo redemptions in {monthLabel(data.month)}
              </th>
              <td style={numberCellStyle}>{count(promo.thisMonth.value)}</td>
              <td style={cellStyle}>
                <Provenance
                  source={promo.thisMonth.source}
                  definition={promo.thisMonth.definition}
                />
              </td>
            </tr>
            <tr>
              <th style={cellStyle} scope="row">
                Promo redemptions by state (all time)
              </th>
              <td style={{ ...cellStyle, textAlign: 'right' }}>
                {promo.byState.length === 0
                  ? 'No redemptions yet'
                  : promo.byState
                      .map((row) => `${row.state.replace(/_/g, ' ')} ${count(row.count)}`)
                      .join(' · ')}
              </td>
              <td style={cellStyle}>
                <Provenance source={promo.source} definition={promo.definition} />
              </td>
            </tr>
            <tr>
              <th style={cellStyle} scope="row">
                School contributions accrued
              </th>
              <td style={numberCellStyle}>{formatUsd(school.accruedCents.cents)}</td>
              <td style={cellStyle}>
                <Provenance
                  source={school.accruedCents.source}
                  definition={school.accruedCents.definition}
                />
              </td>
            </tr>
            <tr>
              <th style={cellStyle} scope="row">
                School contributions paid out
              </th>
              <td style={numberCellStyle}>{formatUsd(school.paidOutCents.cents)}</td>
              <td style={cellStyle}>
                <Provenance
                  source={school.paidOutCents.source}
                  definition={school.paidOutCents.definition}
                />
              </td>
            </tr>
            <tr>
              <th style={cellStyle} scope="row">
                Sponsorship and affiliate revenue recognized in {monthLabel(data.month)} (P16)
              </th>
              <td style={numberCellStyle}>{formatUsd(p16.cents)}</td>
              <td style={cellStyle}>
                <Provenance source={p16.source} definition={p16.definition} />
              </td>
            </tr>
          </tbody>
        </table>
      </TableScroll>
    </section>
  );
}
