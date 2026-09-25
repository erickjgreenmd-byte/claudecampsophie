import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  SUPPORT_CASE_KIND_LABELS,
  SUPPORT_CASE_RESOLUTION_LABELS,
  SUPPORT_CASE_STATUS_LABELS,
  SUPPORT_INTAKE_NOTICE,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REFUND_NOTICE,
  SUPPORT_RULES,
  SUPPORT_SUBJECT_MAX_LENGTH,
  supportBillingPeriodsResponseSchema,
  supportCaseKindSchema,
  supportCaseResponseSchema,
  supportCasesResponseSchema,
  type CreateSupportCaseRequest,
  type SupportBillingPeriod,
  type SupportCase,
  type SupportCaseKind,
  type SupportCaseStatus,
  parentSupportPolicyResponseSchema,
  type ParentSupportPolicyResponse,
} from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import { SUPPORT_CASE_KINDS } from '@pencillift/domain/ops';
import { ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession, type QueryState } from '../../lib/session.tsx';
import {
  ActionFeedback,
  buttonRow,
  formatDate,
  formatDateTime,
  sectionStyle,
  useAction,
  useLastGood,
  type ActionFeedbackValue,
} from './SecurityPage.tsx';

/**
 * Parent support (product decision: a family opens a case about its account, plan or the app —
 * complaint, refund request, billing issue, bug, safety question, other — and reads staff
 * replies here). The intake copy asks parents not to include the child's name or homework; the
 * server caps lengths. Store refunds are issued by the store, never by PencilLift: a refund
 * request may name one of the family's own billing periods and shows what the store reports.
 */
export default function SupportPage() {
  return (
    <RequireParent>
      <Support />
    </RequireParent>
  );
}

const STORE_NAME: Readonly<Record<SupportBillingPeriod['channel'], string>> = {
  app_store: 'App Store',
  play_store: 'Google Play',
  stripe: 'Web billing',
  amazon_appstore: 'Amazon Appstore',
};

const SETTLEMENT_TEXT: Readonly<Record<SupportBillingPeriod['settlement'], string>> = {
  pending: 'payment pending',
  settled: 'paid',
  failed: 'payment failed',
  refunded: 'refunded',
  partially_refunded: 'partly refunded',
  chargeback: 'charged back',
};

const RULE_MESSAGES: Readonly<Record<string, string>> = {
  [SUPPORT_RULES.billingPeriodNotFound]:
    'That billing period isn’t one of your family’s. Choose one from the list.',
  [SUPPORT_RULES.caseClosed]: 'This case is closed. Open a new case if you need more help.',
};

function CaseFeedback({ feedback }: { feedback: ActionFeedbackValue | null }) {
  if (feedback?.kind === 'error' && feedback.error.rule && RULE_MESSAGES[feedback.error.rule]) {
    return <ErrorState message={RULE_MESSAGES[feedback.error.rule]!} />;
  }
  return <ActionFeedback feedback={feedback} stepUpAction="Support" />;
}

const STATUS_STYLE: Readonly<Record<SupportCaseStatus, { background: string; color: string }>> = {
  open: { background: 'var(--off-white)', color: 'var(--navy)' },
  in_progress: { background: 'var(--off-white)', color: 'var(--navy)' },
  waiting_on_parent: { background: 'var(--gold)', color: 'var(--navy)' },
  resolved: { background: 'var(--success)', color: 'var(--white)' },
  closed: { background: 'var(--off-white)', color: 'var(--navy)' },
};

function StatusPill({ status }: { status: SupportCaseStatus }) {
  return (
    <span
      style={{
        ...STATUS_STYLE[status],
        display: 'inline-block',
        borderRadius: 999,
        padding: '2px 10px',
        fontSize: '0.85rem',
        fontWeight: 700,
        border: '1px solid color-mix(in srgb, var(--navy) 14%, var(--white))',
      }}
    >
      {SUPPORT_CASE_STATUS_LABELS[status]}
    </span>
  );
}

const textareaStyle = {
  display: 'block',
  width: '100%',
  maxWidth: 640,
  minHeight: 140,
  fontSize: '1rem',
  fontFamily: 'inherit',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--muted)',
  color: 'var(--navy)',
  background: 'var(--white)',
} as const;

const mutedSmall = { color: 'var(--muted)', fontSize: '0.9rem' } as const;

function periodLabel(p: SupportBillingPeriod): string {
  const refund = p.refundedCents > 0 ? ` (refunded ${formatUsd(p.refundedCents)})` : '';
  return `${STORE_NAME[p.channel]} · ${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)} · ${formatUsd(p.chargedCents)}${refund}`;
}

function Support() {
  const [params] = useSearchParams();
  const selected = params.get('case');
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  const cases = useApiQuery(
    (api) => api.get('/v1/support/cases', supportCasesResponseSchema),
    [version],
  );
  const periods = useApiQuery(
    (api) => api.get('/v1/support/billing-periods', supportBillingPeriodsResponseSchema),
    [],
  );
  // The owner's refund window (Owner action #32); shown on refund requests, never a promise.
  const policy = useApiQuery(
    (api) => api.get('/v1/support/policy', parentSupportPolicyResponseSchema),
    [],
  );
  const list = useLastGood(cases);
  return (
    <>
      <h1>Support</h1>
      <p>
        Questions about your account, your plan, a charge or the app? Open a case below and we’ll
        reply on this page. Common answers are on the <Link to="/support">help page</Link>.
      </p>
      <NewCaseForm periods={periods} policy={policy} onCreated={changed} />
      {list === null && cases.status === 'loading' ? <Loading label="Loading your cases…" /> : null}
      {cases.status === 'error' && list === null ? (
        <ErrorState message={cases.error.message} onRetry={cases.reload} />
      ) : null}
      {list !== null ? (
        <div aria-busy={cases.status === 'loading'}>
          <CaseList cases={list.cases} selected={selected} />
          {selected !== null ? (
            <CaseDetail id={selected} version={version} onChanged={changed} />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Open a case
// ---------------------------------------------------------------------------------------------

function NewCaseForm({
  periods,
  policy,
  onCreated,
}: {
  periods: QueryState<{ periods: SupportBillingPeriod[] }>;
  policy: QueryState<ParentSupportPolicyResponse>;
  onCreated: (id: string) => void;
}) {
  const { api } = useSession();
  const headingId = useId();
  const kindId = useId();
  const subjectId = useId();
  const messageId = useId();
  const periodId = useId();
  const [kind, setKind] = useState<SupportCaseKind>('other');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [period, setPeriod] = useState('');
  const [errors, setErrors] = useState<{
    subject: string | undefined;
    message: string | undefined;
  }>({
    subject: undefined,
    message: undefined,
  });
  const { busy, feedback, run } = useAction();
  const refund = kind === 'refund_request';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedSubject = subject.trim();
    const trimmedMessage = message.trim();
    const next: { subject: string | undefined; message: string | undefined } = {
      subject: undefined,
      message: undefined,
    };
    if (trimmedSubject === '') next.subject = 'Give the case a short subject.';
    else if (trimmedSubject.length > SUPPORT_SUBJECT_MAX_LENGTH)
      next.subject = `Keep the subject under ${SUPPORT_SUBJECT_MAX_LENGTH} characters.`;
    if (trimmedMessage === '') next.message = 'Tell us what happened.';
    else if (trimmedMessage.length > SUPPORT_MESSAGE_MAX_LENGTH)
      next.message = `Keep the message under ${SUPPORT_MESSAGE_MAX_LENGTH} characters.`;
    setErrors(next);
    if (next.subject || next.message) return;
    const body: CreateSupportCaseRequest = {
      kind,
      subject: trimmedSubject,
      message: trimmedMessage,
      ...(refund && period !== '' ? { billingPeriodId: period } : {}),
    };
    await run('create', async () => {
      const result = await api.send('POST', '/v1/support/cases', body, supportCaseResponseSchema);
      setSubject('');
      setMessage('');
      setPeriod('');
      onCreated(result.case.id);
      return 'Your case is open. Replies will appear on this page.';
    });
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Open a case</h2>
      <p className="notice">{SUPPORT_INTAKE_NOTICE}</p>
      <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={headingId}>
        <label htmlFor={kindId}>What is it about?</label>
        <select
          id={kindId}
          value={kind}
          onChange={(e) => {
            const parsed = supportCaseKindSchema.safeParse(e.target.value);
            if (parsed.success) setKind(parsed.data);
          }}
        >
          {SUPPORT_CASE_KINDS.map((k) => (
            <option key={k} value={k}>
              {SUPPORT_CASE_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        {refund ? (
          <>
            <p className="notice" style={{ marginTop: 12 }}>
              {SUPPORT_REFUND_NOTICE}
              {policy.status === 'ready' ? ` ${policy.data.refundWindowSentence}` : null}
            </p>
            <label htmlFor={periodId}>Which charge? (optional)</label>
            {periods.status === 'loading' ? (
              <p style={mutedSmall}>Loading your billing periods…</p>
            ) : null}
            {periods.status === 'error' ? (
              <p style={mutedSmall}>
                We couldn’t load your billing periods right now. You can still describe the charge
                below.
              </p>
            ) : null}
            {periods.status === 'ready' ? (
              periods.data.periods.length === 0 ? (
                <p id={periodId} style={mutedSmall}>
                  No purchases are recorded for your family yet. Describe the charge below and we’ll
                  look into it.
                </p>
              ) : (
                <select id={periodId} value={period} onChange={(e) => setPeriod(e.target.value)}>
                  <option value="">Choose a billing period</option>
                  {periods.data.periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {periodLabel(p)}
                    </option>
                  ))}
                </select>
              )
            ) : null}
          </>
        ) : null}
        <label htmlFor={subjectId}>Subject</label>
        <input
          id={subjectId}
          type="text"
          value={subject}
          maxLength={SUPPORT_SUBJECT_MAX_LENGTH}
          aria-describedby={errors.subject ? `${subjectId}-error` : undefined}
          onChange={(e) => {
            setSubject(e.target.value);
            setErrors((prev) => ({ ...prev, subject: undefined }));
          }}
        />
        <FieldError id={`${subjectId}-error`} message={errors.subject} />
        <label htmlFor={messageId}>Message</label>
        <textarea
          id={messageId}
          style={textareaStyle}
          value={message}
          maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
          aria-describedby={`${messageId}-hint${errors.message ? ` ${messageId}-error` : ''}`}
          onChange={(e) => {
            setMessage(e.target.value);
            setErrors((prev) => ({ ...prev, message: undefined }));
          }}
        />
        <p id={`${messageId}-hint`} style={{ ...mutedSmall, margin: '4px 0 0' }}>
          Please don’t include your child’s full name, homework text or answers. {message.length}/
          {SUPPORT_MESSAGE_MAX_LENGTH}
        </p>
        <FieldError id={`${messageId}-error`} message={errors.message} />
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'create' ? 'Sending…' : 'Send to support'}
          </button>
        </div>
      </form>
      <CaseFeedback feedback={feedback} />
    </section>
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
      {message}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// The family's cases
// ---------------------------------------------------------------------------------------------

function CaseList({ cases, selected }: { cases: readonly SupportCase[]; selected: string | null }) {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Your cases</h2>
      {cases.length === 0 ? (
        <p>You haven’t opened a case yet. When you do, it will be listed here with our replies.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {cases.map((c) => (
            <li
              key={c.id}
              style={{
                borderTop: '1px solid color-mix(in srgb, var(--navy) 14%, var(--white))',
                padding: '10px 0',
              }}
            >
              <p style={{ margin: 0 }}>
                <Link
                  to={`?case=${encodeURIComponent(c.id)}`}
                  aria-current={selected === c.id ? 'true' : undefined}
                >
                  {c.subject}
                </Link>{' '}
                <StatusPill status={c.status} />
              </p>
              <p style={{ ...mutedSmall, margin: '4px 0 0' }}>
                {SUPPORT_CASE_KIND_LABELS[c.kind]} · opened {formatDate(c.createdAt)} ·{' '}
                {c.messageCount === 1 ? '1 reply' : `${c.messageCount} replies`}
                {c.resolution ? ` · outcome: ${SUPPORT_CASE_RESOLUTION_LABELS[c.resolution]}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CaseDetail({
  id,
  version,
  onChanged,
}: {
  id: string;
  version: number;
  onChanged: () => void;
}) {
  const headingId = useId();
  const query = useApiQuery(
    (api) => api.get(`/v1/support/cases/${encodeURIComponent(id)}`, supportCaseResponseSchema),
    [id, version],
  );
  const data = useLastGood(query);
  if (data === null) {
    if (query.status === 'error') {
      return (
        <ErrorState
          message={
            query.error.code === 'NOT_FOUND'
              ? 'We couldn’t find that case. Pick one from your list above.'
              : query.error.message
          }
          onRetry={query.reload}
        />
      );
    }
    return <Loading label="Loading the case…" />;
  }
  const c = data.case;
  const period = c.billingPeriod;
  return (
    <section
      className="card"
      style={sectionStyle}
      aria-labelledby={headingId}
      aria-busy={query.status === 'loading'}
    >
      <h2 id={headingId}>{c.subject}</h2>
      <p style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <StatusPill status={c.status} />
        <span style={mutedSmall}>
          {SUPPORT_CASE_KIND_LABELS[c.kind]} · opened {formatDateTime(c.createdAt)}
        </span>
      </p>
      {c.resolution ? (
        <p>
          <strong>Outcome:</strong> {SUPPORT_CASE_RESOLUTION_LABELS[c.resolution]}
          {c.resolvedAt ? ` (${formatDate(c.resolvedAt)})` : ''}
        </p>
      ) : null}
      {period ? (
        <div className="notice">
          <p style={{ margin: 0 }}>
            <strong>Charge in question:</strong> {periodLabel(period)} ·{' '}
            {SETTLEMENT_TEXT[period.settlement]}.
          </p>
          <p style={{ margin: '6px 0 0' }}>
            {period.refundedCents > 0
              ? `The store reports ${formatUsd(period.refundedCents)} refunded on this charge.`
              : 'The store has not reported a refund on this charge yet.'}
          </p>
          {c.kind === 'refund_request' ? (
            <p style={{ margin: '6px 0 0' }}>{SUPPORT_REFUND_NOTICE}</p>
          ) : null}
        </div>
      ) : null}
      <h3>Your message</h3>
      <p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p>
      <h3>Replies</h3>
      {c.messages.length === 0 ? (
        <p>No replies yet. We’ll answer here.</p>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {c.messages.map((m) => (
            <li
              key={m.id}
              style={{
                borderLeft: `4px solid ${m.authorKind === 'admin' ? 'var(--teal)' : 'var(--muted)'}`,
                padding: '4px 0 4px 12px',
                marginBottom: 12,
              }}
            >
              <p style={{ margin: 0, ...mutedSmall }}>
                <strong style={{ color: 'var(--navy)' }}>
                  {m.authorKind === 'admin' ? 'PencilLift support' : 'You'}
                </strong>{' '}
                · {formatDateTime(m.createdAt)}
              </p>
              <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{m.body}</p>
            </li>
          ))}
        </ol>
      )}
      {c.canReply ? (
        <ReplyForm caseId={c.id} onDone={onChanged} />
      ) : (
        <p className="notice">
          This case is closed, so it no longer takes replies. If you need more help, open a new case
          above.
        </p>
      )}
    </section>
  );
}

function ReplyForm({ caseId, onDone }: { caseId: string; onDone: () => void }) {
  const { api } = useSession();
  const messageId = useId();
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const { busy, feedback, run } = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (text === '') {
      setError('Write a reply first.');
      return;
    }
    if (text.length > SUPPORT_MESSAGE_MAX_LENGTH) {
      setError(`Keep the reply under ${SUPPORT_MESSAGE_MAX_LENGTH} characters.`);
      return;
    }
    setError(undefined);
    await run('reply', async () => {
      await api.send(
        'POST',
        `/v1/support/cases/${encodeURIComponent(caseId)}/messages`,
        { message: text },
        supportCaseResponseSchema,
      );
      setMessage('');
      onDone();
      return 'Your reply was added to the case.';
    });
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-label="Reply">
      <label htmlFor={messageId}>Reply</label>
      <textarea
        id={messageId}
        style={textareaStyle}
        value={message}
        maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
        aria-describedby={`${messageId}-hint${error ? ` ${messageId}-error` : ''}`}
        onChange={(e) => {
          setMessage(e.target.value);
          setError(undefined);
        }}
      />
      <p id={`${messageId}-hint`} style={{ ...mutedSmall, margin: '4px 0 0' }}>
        {SUPPORT_INTAKE_NOTICE} {message.length}/{SUPPORT_MESSAGE_MAX_LENGTH}
      </p>
      <FieldError id={`${messageId}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          {busy === 'reply' ? 'Sending…' : 'Send reply'}
        </button>
      </div>
      <CaseFeedback feedback={feedback} />
    </form>
  );
}
