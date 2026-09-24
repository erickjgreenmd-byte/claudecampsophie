import { useId, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { listAdminSchoolsResponseSchema, schoolAdminSchema } from '@pencillift/contracts';
import { ErrorState, Loading } from '../../components/states.tsx';
import { useApiQuery, useSession } from '../../lib/session.tsx';
import {
  AdminAccessDenied,
  adminErrorMessage,
  AdminFeedback,
  AdminPage,
  buttonRow,
  cellStyle,
  FieldError,
  isAccessDenied,
  sectionStyle,
  TableScroll,
  tableStyle,
  useAdminAction,
  useLastGood,
  utcMonthOf,
} from './components/admin-ui.tsx';
import { PayoutsPanel } from './components/PayoutsPanel.tsx';
import { SchoolReport } from './components/SchoolReport.tsx';

type AdminSchool = z.infer<typeof schoolAdminSchema>;

/**
 * Owner console for schools, aggregate monthly reports and donation payouts (spec P17 "School
 * attribution and donation ledger"; AC_PROMO_10/13, AC_UX_02). Only aggregates are shown — never
 * family, student or payment details. Live transfers stay disabled until real recipient details
 * exist. Requires an owner-admin MFA session (enforced by the API).
 */
export default function SchoolsAdminPage() {
  return (
    <AdminPage title="Schools and payouts">
      <SchoolsConsole />
    </AdminPage>
  );
}

const STATUS_LABEL: Record<AdminSchool['status'], string> = {
  pending_verification: 'Pending verification',
  active: 'Active',
  inactive: 'Inactive',
};

function place(s: AdminSchool): string {
  return [s.city, s.region].filter((x): x is string => Boolean(x)).join(', ') || '—';
}

function SchoolsConsole() {
  const headingId = useId();
  const [version, setVersion] = useState(0);
  const query = useApiQuery(
    (api) => api.get('/v1/admin/schools', listAdminSchoolsResponseSchema),
    [version],
  );
  const data = useLastGood(query);
  const [openId, setOpenId] = useState<string | null>(null);
  // Decision: reports and payout preparation default to the current UTC calendar month.
  const [month] = useState(() => utcMonthOf(new Date()));

  if (query.status === 'error' && isAccessDenied(query.error)) return <AdminAccessDenied />;
  if (data === null) {
    return query.status === 'error' ? (
      <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
    ) : (
      <Loading label="Loading schools…" />
    );
  }
  const open = data.schools.find((s) => s.id === openId) ?? null;

  return (
    <>
      <p className="notice">
        <strong>Live transfers are disabled until real recipient details exist.</strong> Accrued
        contributions are what PencilLift owes; they are not payments. Schools only ever see
        authorized aggregate figures, never family, student or payment details.
      </p>
      {query.status === 'error' ? (
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      <section className="card" style={sectionStyle} aria-labelledby={headingId}>
        <h2 id={headingId}>Schools</h2>
        {data.schools.length === 0 ? (
          <p>No schools yet. Add one below.</p>
        ) : (
          <TableScroll label="Schools table">
            <table style={tableStyle} aria-labelledby={headingId}>
              <thead>
                <tr>
                  <th style={cellStyle}>School</th>
                  <th style={cellStyle}>Location</th>
                  <th style={cellStyle}>Status</th>
                  <th style={cellStyle}>Payout recipient</th>
                  <th style={cellStyle}>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.schools.map((s) => (
                  <tr key={s.id}>
                    <td style={cellStyle}>{s.name}</td>
                    <td style={cellStyle}>{place(s)}</td>
                    <td style={cellStyle}>{STATUS_LABEL[s.status]}</td>
                    <td style={cellStyle}>
                      {s.recipientVerified ? 'Recipient verified' : 'Recipient not verified'}
                    </td>
                    <td style={cellStyle}>
                      <button
                        type="button"
                        className="btn secondary"
                        aria-label={`Open ${s.name}`}
                        aria-expanded={openId === s.id}
                        onClick={() => setOpenId(openId === s.id ? null : s.id)}
                      >
                        {openId === s.id ? 'Close' : 'Open'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        <p style={{ color: 'var(--muted)' }}>
          New schools start as pending verification and don’t appear in parent search until they are
          active. Open a school to verify its listing and, separately, its payout recipient.
        </p>
      </section>
      {open ? (
        <SchoolPanel
          key={open.id}
          school={open}
          month={month}
          onChanged={() => setVersion((v) => v + 1)}
        />
      ) : null}
      <CreateSchool onCreated={() => setVersion((v) => v + 1)} />
    </>
  );
}

function SchoolPanel({
  school,
  month,
  onChanged,
}: {
  school: AdminSchool;
  month: string;
  onChanged: () => void;
}) {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>{school.name}: report and payouts</h2>
      <VerifySchool school={school} onChanged={onChanged} />
      <SchoolReport schoolId={school.id} initialMonth={month} />
      <PayoutsPanel
        schoolId={school.id}
        recipientVerified={school.recipientVerified}
        initialMonth={month}
      />
    </section>
  );
}

/**
 * Owner verification (P17): a listing becomes visible to parents only when active; a payout
 * recipient is verified separately. The note says where the evidence is kept — never banking data.
 */
function VerifySchool({ school, onChanged }: { school: AdminSchool; onChanged: () => void }) {
  const { api } = useSession();
  const formId = useId();
  const [status, setStatus] = useState<'active' | 'inactive'>(
    school.status === 'active' ? 'active' : 'inactive',
  );
  const [recipient, setRecipient] = useState(school.recipientVerified);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, feedback, run } = useAdminAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = note.trim();
    if (trimmed.length < 3 || trimmed.length > 300) {
      setError('Say where the verification evidence is kept (3 to 300 characters).');
      return;
    }
    setError(null);
    const ok = await run('verify', async () => {
      const updated = await api.send(
        'PATCH',
        `/v1/admin/schools/${school.id}`,
        { status, recipientVerified: recipient, verificationNote: trimmed },
        schoolAdminSchema,
      );
      return `${updated.name} saved: ${STATUS_LABEL[updated.status]}, ${
        updated.recipientVerified ? 'recipient verified' : 'recipient not verified'
      }.`;
    });
    if (ok) {
      setNote('');
      onChanged();
    }
  };

  const id = (f: string) => `${formId}-${f}`;
  return (
    <form aria-labelledby={id('title')} onSubmit={(e) => void submit(e)} noValidate>
      <h3 id={id('title')}>Verification</h3>
      <label htmlFor={id('status')}>Listing</label>
      <select
        id={id('status')}
        value={status}
        onChange={(e) => setStatus(e.target.value === 'active' ? 'active' : 'inactive')}
      >
        <option value="active">Active (parents can choose it)</option>
        <option value="inactive">Inactive (hidden from parents)</option>
      </select>
      <label>
        <input
          type="checkbox"
          checked={recipient}
          onChange={(e) => setRecipient(e.target.checked)}
        />{' '}
        Payout recipient verified out of band
      </label>
      <label htmlFor={id('note')}>Where the evidence is kept</label>
      <input
        id={id('note')}
        value={note}
        maxLength={300}
        aria-describedby={error ? id('note-error') : undefined}
        onChange={(e) => setNote(e.target.value)}
      />
      <FieldError id={id('note-error')} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          Save verification
        </button>
      </div>
      <AdminFeedback feedback={feedback} />
    </form>
  );
}

function CreateSchool({ onCreated }: { onCreated: () => void }) {
  const { api } = useSession();
  const formId = useId();
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [errors, setErrors] = useState<{ name?: string; city?: string; region?: string }>({});
  const { busy, feedback, run } = useAdminAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: { name?: string; city?: string; region?: string } = {};
    const n = name.trim();
    const c = city.trim();
    const r = region.trim();
    if (n.length < 2 || n.length > 160) next.name = 'Enter the school name (2 to 160 characters).';
    if (c.length > 80) next.city = 'Keep the city under 80 characters.';
    if (r.length > 40) next.region = 'Keep the state or region under 40 characters.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const ok = await run('create', async () => {
      const created = await api.send(
        'POST',
        '/v1/admin/schools',
        { name: n, city: c === '' ? null : c, region: r === '' ? null : r },
        schoolAdminSchema,
      );
      return `${created.name} added. It starts as pending verification.`;
    });
    if (ok) {
      setName('');
      setCity('');
      setRegion('');
      onCreated();
    }
  };

  const id = (f: string) => `${formId}-${f}`;
  return (
    <form
      className="card"
      style={sectionStyle}
      aria-labelledby={id('title')}
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h2 id={id('title')}>Add a school</h2>
      <p style={{ margin: 0 }}>
        Use the school’s public name and location only. Never enter banking details here.
      </p>
      <label htmlFor={id('name')}>School name</label>
      <input
        id={id('name')}
        value={name}
        maxLength={160}
        aria-describedby={errors.name ? id('name-error') : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      <FieldError id={id('name-error')} message={errors.name} />
      <label htmlFor={id('city')}>City (optional)</label>
      <input
        id={id('city')}
        value={city}
        maxLength={80}
        aria-describedby={errors.city ? id('city-error') : undefined}
        onChange={(e) => setCity(e.target.value)}
      />
      <FieldError id={id('city-error')} message={errors.city} />
      <label htmlFor={id('region')}>State or region (optional)</label>
      <input
        id={id('region')}
        value={region}
        maxLength={40}
        aria-describedby={errors.region ? id('region-error') : undefined}
        onChange={(e) => setRegion(e.target.value)}
      />
      <FieldError id={id('region-error')} message={errors.region} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          {busy ? 'Adding…' : 'Add school'}
        </button>
      </div>
      <AdminFeedback feedback={feedback} />
    </form>
  );
}
