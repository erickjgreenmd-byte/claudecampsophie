import { useId } from 'react';
import { Link } from 'react-router';
import { ErrorState, Loading } from '../../components/states.tsx';
import { useApiQuery } from '../../lib/session.tsx';
import {
  AdminAccessDenied,
  adminErrorMessage,
  AdminPage,
  cellStyle,
  isAccessDenied,
  readinessResponseSchema,
  sectionStyle,
  TableScroll,
  tableStyle,
} from './components/admin-ui.tsx';

/**
 * Owner-admin home (spec P14 owner admin: provider health; AC_UX_02). Shows the API's production
 * readiness checks with every blocked item visible — nothing is hidden or rounded up to "ready" —
 * and links to the consoles. Requires an owner-admin MFA session (enforced by the API).
 */
export default function AdminHomePage() {
  return (
    <AdminPage title="Owner admin">
      <Readiness />
      <Consoles />
    </AdminPage>
  );
}

const CHECK_LABEL: Readonly<Record<string, string>> = {
  consent_provider: 'Parental consent provider',
  billing_provider: 'Subscription billing (RevenueCat)',
  ai_provider: 'AI provider (OpenAI)',
  zdr_evidence: 'Zero data retention approval',
  parent_jwt_keys: 'Parent sign-in keys',
  cors: 'Allowed web origins (CORS)',
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
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
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
