import { useId, useState } from 'react';
import { schoolMonthReportSchema } from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import { ErrorState, Loading } from '../../../components/states.tsx';
import { useApiQuery } from '../../../lib/session.tsx';
import { adminErrorMessage, monthLabel, MONTH_RE, sectionStyle } from './admin-ui.tsx';

/**
 * Aggregate monthly report for one school (spec P17 school attribution; AC_PROMO_10/13). Counts
 * are distinct verified families and small counts arrive suppressed as "<5" from the database
 * report function; the console shows them exactly as returned.
 */
export function SchoolReport({
  schoolId,
  initialMonth,
}: {
  schoolId: string;
  initialMonth: string;
}) {
  const headingId = useId();
  const monthId = useId();
  const [monthText, setMonthText] = useState(initialMonth);
  const [month, setMonth] = useState(initialMonth);
  const query = useApiQuery(
    (api) =>
      api.get(
        `/v1/admin/schools/${schoolId}/report?month=${encodeURIComponent(month)}`,
        schoolMonthReportSchema,
      ),
    [schoolId, month],
  );

  const report = query.status === 'ready' ? query.data : null;
  const owed =
    report && report.accruedCents !== null && report.paidCents !== null
      ? report.accruedCents - report.paidCents
      : null;

  return (
    <section style={sectionStyle} aria-labelledby={headingId}>
      <h3 id={headingId}>Monthly report — {monthLabel(month)}</h3>
      <label htmlFor={monthId}>Report month</label>
      <input
        id={monthId}
        type="month"
        value={monthText}
        onChange={(e) => {
          setMonthText(e.target.value);
          if (MONTH_RE.test(e.target.value)) setMonth(e.target.value);
        }}
      />
      {query.status === 'loading' ? <Loading label="Loading report…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {report ? (
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }}>
          <dt>Attributed family signups (to date)</dt>
          <dd style={{ margin: 0 }}>{report.attributedSignups}</dd>
          <dt>Donation-eligible families (this month)</dt>
          <dd style={{ margin: 0 }}>{report.donationEligibleFamilies}</dd>
          <dt>Accrued (owed by PencilLift)</dt>
          <dd style={{ margin: 0 }}>
            {report.accruedCents === null ? 'Not available' : formatUsd(report.accruedCents)}
          </dd>
          <dt>Paid to the school</dt>
          <dd style={{ margin: 0 }}>
            {report.paidCents === null ? 'Not available' : formatUsd(report.paidCents)}
          </dd>
          <dt>Still owed</dt>
          <dd style={{ margin: 0 }}>{owed === null ? 'Not available' : formatUsd(owed)}</dd>
        </dl>
      ) : null}
      <p style={{ color: 'var(--muted)' }}>
        Counts are distinct families, not children, guardians or code redemptions. In school-facing
        views, any count below 5 is shown as “&lt;5” (and the matching amounts are withheld) so no
        family can be identified; this owner view receives exact counts. Accrual is $1 per
        full-price family month; a discounted month (any code, 5%–100%) accrues $0. Accrued is not
        paid.
      </p>
      <p className="notice">
        Active, positive-paying and fully discounted family counts are not part of this report yet;
        they need an extended report from the API before they can be shown.
      </p>
    </section>
  );
}
