import { useId, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import {
  listPayoutsResponseSchema,
  payoutBatchSchema,
  preparePayoutResponseSchema,
} from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import { ErrorState, Loading } from '../../../components/states.tsx';
import { useApiQuery, useSession } from '../../../lib/session.tsx';
import {
  adminErrorMessage,
  AdminFeedback,
  buttonRow,
  cellStyle,
  ConfirmButton,
  FieldError,
  formatUtc,
  monthLabel,
  MONTH_RE,
  sectionStyle,
  TableScroll,
  tableStyle,
  toApiError,
  useAdminAction,
} from './admin-ui.tsx';

type Payout = z.infer<typeof payoutBatchSchema>;
type PrepareResult = z.infer<typeof preparePayoutResponseSchema>;

const PAYOUT_STATUS_LABEL: Record<Payout['status'], string> = {
  accrued: 'Accrued – awaiting approval',
  approved: 'Approved – awaiting transfer',
  paid: 'Paid',
  failed: 'Failed – not paid',
  adjusted: 'Adjusted',
};

/** Rule codes the payout endpoints can return, in owner-facing words. */
export const PAYOUT_RULES: Readonly<Record<string, string>> = {
  TRANSFERS_DISABLED:
    'Transfers are disabled in this environment until real, verified recipient details exist. Nothing was sent or recorded as paid.',
  RECIPIENT_NOT_VERIFIED:
    'This school’s payout recipient hasn’t been verified, so no payout can be prepared or approved.',
  INVALID_TRANSITION: 'That step isn’t possible for the batch’s current status.',
};

/**
 * Payout batches for one school (spec P17: statuses accrued/approved/paid/failed/adjusted,
 * duplicate-safe preparation, recorded external transfer references). Accrual is not payment.
 */
export function PayoutsPanel({
  schoolId,
  recipientVerified,
  initialMonth,
}: {
  schoolId: string;
  recipientVerified: boolean;
  initialMonth: string;
}) {
  const { api } = useSession();
  const headingId = useId();
  const monthId = useId();
  const [version, setVersion] = useState(0);
  const query = useApiQuery(
    (a) =>
      a.get(
        `/v1/admin/payouts?schoolId=${encodeURIComponent(schoolId)}`,
        listPayoutsResponseSchema,
      ),
    [schoolId, version],
  );
  const [month, setMonth] = useState(initialMonth);
  const [monthError, setMonthError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PrepareResult | null>(null);
  const { busy, feedback, run } = useAdminAction();

  const prepare = async (event: FormEvent) => {
    event.preventDefault();
    if (!MONTH_RE.test(month)) {
      setMonthError('Enter a month as YYYY-MM.');
      return;
    }
    setMonthError(null);
    setPrepared(null);
    await run('prepare', async () => {
      const result = await api.send(
        'POST',
        '/v1/admin/payouts/prepare',
        { schoolId, throughMonth: month },
        preparePayoutResponseSchema,
      );
      setPrepared(result);
      setVersion((v) => v + 1);
      return '';
    });
  };

  return (
    <section style={sectionStyle} aria-labelledby={headingId}>
      <h3 id={headingId}>Payouts</h3>
      <p className="notice">
        <strong>Live transfers are disabled until real recipient details exist.</strong> PencilLift
        never invents school banking details. Recipient:{' '}
        {recipientVerified ? 'verified' : 'not verified'}. Preparing a batch groups accruals; it
        does not move money.
      </p>
      <form onSubmit={(e) => void prepare(e)} noValidate aria-label="Prepare a payout batch">
        <label htmlFor={monthId}>Pay accruals through month</label>
        <input
          id={monthId}
          type="month"
          value={month}
          aria-describedby={monthError ? `${monthId}-error` : undefined}
          onChange={(e) => {
            setMonth(e.target.value);
            setMonthError(null);
          }}
        />
        <FieldError id={`${monthId}-error`} message={monthError} />
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'prepare' ? 'Preparing…' : 'Prepare payout'}
          </button>
        </div>
      </form>
      <AdminFeedback feedback={feedback} rules={PAYOUT_RULES} />
      {prepared?.status === 'carried_forward' ? (
        <div className="notice" role="status">
          <p style={{ margin: 0 }}>
            <strong>Carried forward.</strong> The net balance of {formatUsd(prepared.netCents)}{' '}
            through {monthLabel(month)} is not a positive amount to pay, so it carries forward to a
            later batch. No payout batch was created.
          </p>
        </div>
      ) : null}
      {prepared?.status === 'created' ? (
        <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
          Batch ready: {formatUsd(prepared.payout.totalCents)} ({prepared.payout.batchKey}).
          Preparing again for the same month returns this same batch.
        </p>
      ) : null}
      {query.status === 'loading' ? <Loading label="Loading payouts…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {query.status === 'ready' && query.data.payouts.length === 0 ? (
        <p>No payout batches yet.</p>
      ) : null}
      {query.status === 'ready' && query.data.payouts.length > 0 ? (
        <TableScroll label="Payout batches table">
          <table style={tableStyle} aria-label="Payout batches">
            <thead>
              <tr>
                <th style={cellStyle}>Created</th>
                <th style={cellStyle}>Total</th>
                <th style={cellStyle}>Status</th>
                <th style={cellStyle}>Transfer reference</th>
                <th style={cellStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {query.data.payouts.map((p) => (
                <PayoutRow key={p.id} payout={p} onChanged={() => setVersion((v) => v + 1)} />
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
    </section>
  );
}

function PayoutRow({ payout: p, onChanged }: { payout: Payout; onChanged: () => void }) {
  const { api } = useSession();
  const { busy, feedback, run } = useAdminAction();
  const [recording, setRecording] = useState(false);

  const approve = () =>
    run('approve', async () => {
      await api.send('POST', `/v1/admin/payouts/${p.id}/approve`, undefined, payoutBatchSchema);
      onChanged();
      return 'Approved. Record the transfer once it has actually been sent.';
    });

  return (
    <tr aria-label={`Payout of ${formatUsd(p.totalCents)}, ${PAYOUT_STATUS_LABEL[p.status]}`}>
      <td style={cellStyle}>{formatUtc(p.createdAt)}</td>
      <td style={cellStyle}>{formatUsd(p.totalCents)}</td>
      <td style={cellStyle}>{PAYOUT_STATUS_LABEL[p.status]}</td>
      <td style={cellStyle}>{p.externalTransferRef ?? '—'}</td>
      <td style={cellStyle}>
        {p.status === 'accrued' ? (
          <ConfirmButton
            label="Approve"
            accessibleLabel={`Approve payout of ${formatUsd(p.totalCents)}`}
            disabled={busy !== null}
            prompt={`Approve ${formatUsd(p.totalCents)} for transfer? Approval does not send money.`}
            confirmLabel="Yes, approve"
            onConfirm={approve}
          />
        ) : null}
        {p.status === 'approved' && !recording ? (
          <button
            type="button"
            className="btn secondary"
            aria-label={`Mark paid: payout of ${formatUsd(p.totalCents)}`}
            onClick={() => setRecording(true)}
          >
            Mark paid
          </button>
        ) : null}
        {recording ? (
          <MarkPaidForm
            payout={p}
            onDone={() => {
              setRecording(false);
              onChanged();
            }}
            onCancel={() => setRecording(false)}
          />
        ) : null}
        <AdminFeedback feedback={feedback} rules={PAYOUT_RULES} />
      </td>
    </tr>
  );
}

function MarkPaidForm({
  payout: p,
  onDone,
  onCancel,
}: {
  payout: Payout;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { api } = useSession();
  const inputId = useId();
  const [reference, setReference] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const ref = reference.trim();
    if (ref.length < 3 || ref.length > 200) {
      setFieldError(
        'Enter the transfer reference from the bank or payout provider (3–200 characters).',
      );
      return;
    }
    setFieldError(null);
    setSaving(true);
    setError(null);
    try {
      await api.send(
        'POST',
        `/v1/admin/payouts/${p.id}/mark-paid`,
        { externalTransferRef: ref },
        payoutBatchSchema,
      );
      onDone();
    } catch (e) {
      setError(adminErrorMessage(toApiError(e), PAYOUT_RULES));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-label={`Record transfer for ${formatUsd(p.totalCents)}`}
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <label htmlFor={inputId}>Transfer reference</label>
      <input
        id={inputId}
        value={reference}
        maxLength={200}
        autoComplete="off"
        aria-describedby={fieldError ? `${inputId}-error` : undefined}
        onChange={(e) => {
          setReference(e.target.value);
          setFieldError(null);
        }}
      />
      <FieldError id={`${inputId}-error`} message={fieldError} />
      <p style={{ margin: '4px 0', color: 'var(--muted)' }}>
        Only record a payment that has actually been sent.
      </p>
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : 'Record as paid'}
        </button>
        <button type="button" className="btn secondary" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error ? <ErrorState message={error} /> : null}
    </form>
  );
}
