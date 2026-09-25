import { useId, useState, type FormEvent } from 'react';
import {
  overviewResponseSchema,
  revenueResponseSchema,
  storeFeeRatesResponseSchema,
  subscriptionsSummarySchema,
  type RevenueResponse,
  type StoreFeeRates,
} from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import { MAX_REPORT_MONTHS } from '@pencillift/domain/ops';
import { ErrorState, Loading } from '../../components/states.tsx';
import { useApiQuery, useSession, type QueryState } from '../../lib/session.tsx';
import {
  AdminAccessDenied,
  adminErrorMessage,
  AdminFeedback,
  AdminPage,
  buttonRow,
  cellStyle,
  CHANNELS,
  channelLabel,
  FieldError,
  formatUtc,
  isAccessDenied,
  monthLabel,
  numberCellStyle,
  Provenance,
  sectionStyle,
  smallMutedStyle,
  TableScroll,
  tableStyle,
  useAdminAction,
  useLastGood,
  type Channel,
} from './components/admin-ui.tsx';
import { MoreThisMonth, SubscriptionsSection } from './components/overview-sections.tsx';
import { RevenueChart } from './components/RevenueChart.tsx';

/**
 * Owner-admin subscriptions and revenue: months × channels (gross charged, provider-reported
 * refunds, store fees at the configured rate, net), subscriptions by channel, paid slots and
 * ledger status, the month's promo / school contribution / P16 lines, and the fee-rate settings
 * (ops_settings). Fees are an estimate; the store statements are the truth. Requires an
 * owner-admin MFA session (API-enforced).
 */
export default function RevenueAdminPage() {
  return (
    <AdminPage title="Subscriptions and revenue">
      <RevenueConsole />
    </AdminPage>
  );
}

const MONTH_CHOICES = [3, 6, 12, 24, MAX_REPORT_MONTHS] as const;

function RevenueConsole() {
  const [months, setMonths] = useState<number>(6);
  const [version, setVersion] = useState(0);
  const revenue = useApiQuery(
    (api) => api.get(`/v1/admin/revenue?months=${months}`, revenueResponseSchema),
    [months, version],
  );
  if (revenue.status === 'error' && isAccessDenied(revenue.error)) return <AdminAccessDenied />;
  return (
    <>
      <RevenueSection query={revenue} months={months} onMonths={setMonths} />
      <FeeRatesForm onSaved={() => setVersion((v) => v + 1)} />
      <SubscriptionsPanel />
      <OtherLines />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Months × channels
// ---------------------------------------------------------------------------------------------

function RevenueSection({
  query,
  months,
  onMonths,
}: {
  query: QueryState<RevenueResponse> & { reload: () => void };
  months: number;
  onMonths: (months: number) => void;
}) {
  const headingId = useId();
  const monthsId = useId();
  const data = useLastGood(query);
  const any =
    data !== null &&
    data.months.some((m) => m.totals.grossChargedCents !== 0 || m.totals.refundedCents !== 0);
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Revenue by month and channel</h2>
      <label htmlFor={monthsId}>Months to show</label>
      <select
        id={monthsId}
        value={months}
        onChange={(e) => onMonths(Number(e.target.value))}
        style={{ maxWidth: 200 }}
      >
        {MONTH_CHOICES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      {data === null && query.status === 'loading' ? <Loading label="Loading revenue…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {data !== null ? (
        <div aria-busy={query.status === 'loading'}>
          <p style={smallMutedStyle}>
            As of {formatUtc(data.asOf)}. Amounts in USD cents summed exactly; the fee is an
            estimate at the configured rate.
          </p>
          {any ? (
            <>
              <RevenueChart
                title={`Net revenue by month, ${data.months.length} months (estimate after store fees)`}
                bars={data.months.map((m) => ({ month: m.month, netCents: m.totals.netCents }))}
              />
              <TableScroll label="Revenue by month and channel table">
                <table style={tableStyle} aria-label="Revenue by month and channel">
                  <thead>
                    <tr>
                      <th style={cellStyle} scope="col">
                        Month
                      </th>
                      <th style={cellStyle} scope="col">
                        Channel
                      </th>
                      <th style={numberCellStyle} scope="col">
                        Periods
                      </th>
                      <th style={numberCellStyle} scope="col">
                        Gross charged
                      </th>
                      <th style={numberCellStyle} scope="col">
                        Refunds
                      </th>
                      <th style={numberCellStyle} scope="col">
                        Fee rate
                      </th>
                      <th style={numberCellStyle} scope="col">
                        Store fee (estimate)
                      </th>
                      <th style={numberCellStyle} scope="col">
                        Net
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.months.map((m) => (
                      <MonthRows key={m.month} month={m} />
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </>
          ) : (
            <p>
              No charged billing periods in the last {data.months.length} months. Every channel
              would read zero, so the table and chart are left out.
            </p>
          )}
          <ul style={{ ...smallMutedStyle, paddingLeft: 20 }}>
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <Provenance source={data.source} definition={data.definition} />
        </div>
      ) : null}
    </section>
  );
}

function MonthRows({ month }: { month: RevenueResponse['months'][number] }) {
  return (
    <>
      {month.channels.map((line, index) => (
        <tr key={line.channel}>
          {index === 0 ? (
            <th style={cellStyle} scope="rowgroup" rowSpan={month.channels.length + 1}>
              {monthLabel(month.month)}
            </th>
          ) : null}
          <td style={cellStyle}>{channelLabel(line.channel)}</td>
          <td style={numberCellStyle}>{line.periods.toLocaleString('en-US')}</td>
          <td style={numberCellStyle}>{formatUsd(line.grossChargedCents)}</td>
          <td style={numberCellStyle}>{formatUsd(line.refundedCents)}</td>
          <td style={numberCellStyle}>{(line.feeRateBasisPoints / 100).toFixed(2)}%</td>
          <td style={numberCellStyle}>{formatUsd(line.storeFeeCents)}</td>
          <td style={numberCellStyle}>{formatUsd(line.netCents)}</td>
        </tr>
      ))}
      <tr style={{ fontWeight: 700 }}>
        <td style={cellStyle}>All channels</td>
        <td style={numberCellStyle}>
          {month.channels.reduce((sum, l) => sum + l.periods, 0).toLocaleString('en-US')}
        </td>
        <td style={numberCellStyle}>{formatUsd(month.totals.grossChargedCents)}</td>
        <td style={numberCellStyle}>{formatUsd(month.totals.refundedCents)}</td>
        <td style={numberCellStyle}>—</td>
        <td style={numberCellStyle}>{formatUsd(month.totals.storeFeeCents)}</td>
        <td style={numberCellStyle}>{formatUsd(month.totals.netCents)}</td>
      </tr>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Fee-rate settings (PUT /v1/admin/settings/store-fee-rates)
// ---------------------------------------------------------------------------------------------

/** 0.3 -> "30", 0.1525 -> "15.25": a percent with at most two decimals, never rounded up. */
export function percentInput(fraction: number): string {
  const basisPoints = Math.floor(fraction * 10_000 + 1e-6);
  const whole = Math.floor(basisPoints / 100);
  const rest = basisPoints % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
}

const PERCENT_RE = /^\d{1,3}(\.\d{1,2})?$/;

/** "30" -> 0.3; null when not a percent from 0 to 100 with at most two decimals. */
export function parsePercent(text: string): number | null {
  const trimmed = text.trim();
  if (!PERCENT_RE.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 100) / 10_000;
}

function FeeRatesForm({ onSaved }: { onSaved: () => void }) {
  const { api } = useSession();
  const headingId = useId();
  const fieldBase = useId();
  const [saved, setSaved] = useState(0);
  const query = useApiQuery(
    (a) => a.get('/v1/admin/settings/store-fee-rates', storeFeeRatesResponseSchema),
    [saved],
  );
  const data = useLastGood(query);
  const [edits, setEdits] = useState<Partial<Record<Channel, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<Channel, string>>>({});
  const { busy, feedback, run } = useAdminAction();

  const valueFor = (channel: Channel): string =>
    edits[channel] ?? (data ? percentInput(data.rates[channel]) : '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!data) return;
    const rates: Partial<Record<Channel, number>> = {};
    const problems: Partial<Record<Channel, string>> = {};
    for (const channel of CHANNELS) {
      const parsed = parsePercent(valueFor(channel));
      if (parsed === null) {
        problems[channel] = 'Enter a percent from 0 to 100 with at most two decimals.';
      } else {
        rates[channel] = parsed;
      }
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    await run('save', async () => {
      await api.send(
        'PUT',
        '/v1/admin/settings/store-fee-rates',
        { rates: rates as StoreFeeRates },
        storeFeeRatesResponseSchema,
      );
      setEdits({});
      setSaved((v) => v + 1);
      onSaved();
      return 'Fee rates saved. The revenue table above uses them.';
    });
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Store fee rates</h2>
      <p>
        The rate applied to charged minus refunded amounts per channel when estimating store fees.
        Default 30% for the app stores and 0% for web billing; Stripe’s per-transaction fee is not
        modelled.
      </p>
      {data === null && query.status === 'loading' ? <Loading label="Loading fee rates…" /> : null}
      {query.status === 'error' && data === null ? (
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {data !== null ? (
        <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={headingId}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '0 16px',
            }}
          >
            {CHANNELS.map((channel) => {
              const id = `${fieldBase}-${channel}`;
              return (
                <div key={channel}>
                  <label htmlFor={id}>{channelLabel(channel)} fee (%)</label>
                  <input
                    id={id}
                    type="text"
                    inputMode="decimal"
                    value={valueFor(channel)}
                    aria-describedby={errors[channel] ? `${id}-error` : undefined}
                    onChange={(e) => {
                      setEdits((prev) => ({ ...prev, [channel]: e.target.value }));
                      setErrors((prev) => ({ ...prev, [channel]: undefined }));
                    }}
                  />
                  <FieldError id={`${id}-error`} message={errors[channel]} />
                </div>
              );
            })}
          </div>
          <div style={buttonRow}>
            <button type="submit" className="btn" disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save fee rates'}
            </button>
          </div>
        </form>
      ) : null}
      <AdminFeedback feedback={feedback} />
      {data !== null ? (
        <p style={smallMutedStyle}>
          {data.updatedAt
            ? `Last changed ${formatUtc(data.updatedAt)}${data.updatedBy ? ` by ${data.updatedBy}` : ''}.`
            : 'Never changed: the defaults apply.'}{' '}
          Source: public.ops_settings (store_fee_rates).
        </p>
      ) : null}
      {data !== null ? (
        <ul style={{ ...smallMutedStyle, paddingLeft: 20 }}>
          {data.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Subscriptions and the month's other lines
// ---------------------------------------------------------------------------------------------

function SubscriptionsPanel() {
  const query = useApiQuery(
    (api) => api.get('/v1/admin/subscriptions', subscriptionsSummarySchema),
    [],
  );
  if (query.status === 'loading') return <Loading label="Loading subscriptions…" />;
  if (query.status === 'error') {
    return <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />;
  }
  return <SubscriptionsSection subscriptions={query.data} showStatuses />;
}

function OtherLines() {
  const query = useApiQuery((api) => api.get('/v1/admin/overview', overviewResponseSchema), []);
  if (query.status === 'loading') return <Loading label="Loading promotions and schools…" />;
  if (query.status === 'error') {
    return <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />;
  }
  return <MoreThisMonth data={query.data} />;
}
