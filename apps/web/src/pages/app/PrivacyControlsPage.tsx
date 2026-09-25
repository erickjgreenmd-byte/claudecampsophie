import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  adultUnlockResponseSchema,
  dataExportResponseSchema,
  dataExportsResponseSchema,
  deletionRequestResponseSchema,
  deletionRequestsResponseSchema,
  privacyFamilyViewSchema,
  PARENT_SAFETY_FLAG_ACTIONS,
  PARENT_SAFETY_FLAG_COPY,
  PRIVACY_RETENTION,
  SAFETY_NOTE_MAX_LENGTH,
  SAFETY_REPORT_CATEGORIES,
  safetyReportResponseSchema,
  safetyReportsResponseSchema,
  STANDARD_EXPORT_KINDS,
  type DataExport,
  type DeletionRequest,
  type ExportKind,
  type ParentReportOutcome,
  type PrivacyFamilyView,
  type ListedSafetyReportCategory,
  type SafetyFlagEmailStatus,
  type SafetyReport,
  type SafetyReportCategory,
  type SafetyReportStatus,
  type StandardExportKind,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { ErrorState, Loading, Notice } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession, type QueryState } from '../../lib/session.tsx';

/**
 * Parent privacy controls (spec P4, P8, P10, P14 "export/delete and help"; AC_ACCESS_10,
 * AC_SECURITY_01, AC_SECURITY_05, AC_UX_02). Request private exports, delete one child's data or the
 * whole family (typed confirmation + server-enforced PIN step-up), read how long information is
 * kept, and follow the family's safety reports.
 *
 * Every control calls the real API; nothing is simulated. Export files are not built yet (no
 * builder job exists), so the page says so and offers no download control.
 */
export default function PrivacyControlsPage() {
  return (
    <RequireParent>
      <PrivacyControls />
    </RequireParent>
  );
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

const EXPORT_KIND_LABELS: Record<ExportKind, string> = {
  family_data: 'All family data',
  progress_pdf: 'Progress summary (PDF)',
  progress_csv: 'Progress data (CSV)',
  review_questions_pdf: 'Thursday review — questions only (PDF)',
  review_answer_key_pdf: 'Thursday review answer key (PDF, parent only)',
};

const EXPORT_STATUS_LABELS: Record<DataExport['status'], string> = {
  queued: 'Requested — waiting to be prepared',
  ready: 'Ready — downloading from the portal isn’t available yet',
  failed: 'Couldn’t be prepared — please request it again',
  expired: 'Expired — request a new copy',
};

const CATEGORY_LABELS: Record<ListedSafetyReportCategory, string> = {
  unsafe_content: 'Unsafe or inappropriate content',
  wrong_or_confusing: 'Wrong or confusing',
  upsetting: 'Something upsetting',
  answer_revealed: 'Showed an answer',
  other: 'Something else',
  // Filed by PencilLift's safety screen only; never offered in the form below.
  severe_risk: PARENT_SAFETY_FLAG_COPY.category,
};

const REPORT_STATUS_LABELS: Record<SafetyReportStatus, string> = {
  open: 'Waiting for review',
  triaged: 'Being reviewed',
  escalated: 'Escalated for urgent review',
  resolved: 'Resolved',
};

/** The recorded delivery of the guardian email a flag sends (never assumed; migration 0790). */
const EMAIL_STATE_COPY: Record<SafetyFlagEmailStatus, string> = {
  sent: PARENT_SAFETY_FLAG_COPY.emailSent,
  not_sent: PARENT_SAFETY_FLAG_COPY.emailNotSent,
  failed: PARENT_SAFETY_FLAG_COPY.emailFailed,
};

const STORE_SUBSCRIPTION_NOTICE =
  'Deleting your PencilLift account does not cancel an App Store or Google Play subscription.';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function errorMessage(error: ApiRequestError): string {
  if (error.code === 'NETWORK')
    return 'You appear to be offline. Check your connection and try again.';
  if (error.code === 'RATE_LIMITED') {
    return 'There have been too many requests. Please wait a little and try again.';
  }
  return error.message;
}

function childName(family: PrivacyFamilyView, childId: string | null): string {
  return family.children.find((c) => c.id === childId)?.nickname ?? 'A removed child profile';
}

const sectionStyle = { marginTop: 16 } as const;
const buttonRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } as const;
const fieldsetStyle = {
  border: '1px solid #d5dde5',
  borderRadius: 12,
  padding: 16,
  marginTop: 16,
} as const;
const legendStyle = { fontWeight: 800, padding: '0 4px' } as const;
const fieldError = { color: 'var(--danger)', margin: '4px 0 0' } as const;

// ---------------------------------------------------------------------------------------------
// Small state helpers
// ---------------------------------------------------------------------------------------------

/** Keeps the last loaded data on screen while a reload is in flight (forms stay mounted). */
function useLastGood<T>(query: QueryState<T>): T | null {
  const [last, setLast] = useState<T | null>(null);
  const ready = query.status === 'ready' ? query.data : null;
  useEffect(() => {
    if (ready !== null) setLast(ready);
  }, [ready]);
  return ready ?? last;
}

type Outcome =
  { kind: 'success'; message: string } | { kind: 'error'; error: ApiRequestError } | null;

function toApiError(error: unknown): ApiRequestError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError('INTERNAL', 'Something went wrong. Please try again.', 0);
}

/** One mutation at a time per form, with its outcome kept for display. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const run = async (action: () => Promise<string>): Promise<boolean> => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome({ kind: 'success', message: await action() });
      return true;
    } catch (error) {
      setOutcome({ kind: 'error', error: toApiError(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, outcome, run, setOutcome };
}

/**
 * Inline step-up (spec P3): the API refused because this session has no recent PIN unlock. The
 * parent enters the PIN here; nothing sensitive is retried automatically — they press the action
 * button again, which is a second, deliberate confirmation.
 */
function StepUpPrompt({ actionLabel }: { actionLabel: string }) {
  const { api } = useSession();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unlockedUntil, setUnlockedUntil] = useState<string | null>(null);
  const pinId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(pin)) {
      setMessage('Enter your 6-digit parent PIN.');
      return;
    }
    const entered = pin;
    setPin('');
    setMessage(null);
    setBusy(true);
    try {
      const result = await api.send(
        'POST',
        '/v1/adult/unlock',
        { method: 'pin', pin: entered },
        adultUnlockResponseSchema,
      );
      setUnlockedUntil(result.unlockedUntil);
    } catch (error) {
      const e = toApiError(error);
      setMessage(
        e.code === 'FORBIDDEN'
          ? 'That PIN is not correct.'
          : e.code === 'NOT_FOUND'
            ? 'Set a parent PIN on the Security page first.'
            : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  if (unlockedUntil) {
    return (
      <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
        {`Unlocked until ${formatTime(unlockedUntil)}. Press “${actionLabel}” again to continue.`}
      </p>
    );
  }
  return (
    <fieldset className="notice" style={{ ...fieldsetStyle, borderColor: 'var(--gold)' }}>
      <legend style={legendStyle}>Enter your parent PIN to continue</legend>
      <p style={{ marginTop: 0 }}>
        This needs a recent PIN unlock, checked by PencilLift’s servers. You can also unlock on the{' '}
        <Link to="/app/security">Security page</Link>.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor={pinId}>Parent PIN</label>
        <input
          id={pinId}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
            setMessage(null);
          }}
        />
        {message ? (
          <p role="alert" style={fieldError}>
            {message}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      </form>
    </fieldset>
  );
}

function ActionOutcome({ outcome, actionLabel }: { outcome: Outcome; actionLabel: string }) {
  if (!outcome) return null;
  if (outcome.kind === 'success') {
    return (
      <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
        {outcome.message}
      </p>
    );
  }
  if (outcome.error.code === 'STEP_UP_REQUIRED') return <StepUpPrompt actionLabel={actionLabel} />;
  return <ErrorState message={errorMessage(outcome.error)} />;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card" style={sectionStyle} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

function PrivacyControls() {
  const familyQuery = useApiQuery((api) => api.get('/v1/family', privacyFamilyViewSchema), []);
  const deletionQuery = useApiQuery(
    (api) => api.get('/v1/deletion', deletionRequestsResponseSchema),
    [],
  );
  const exportsQuery = useApiQuery((api) => api.get('/v1/exports', dataExportsResponseSchema), []);
  const reportsQuery = useApiQuery(
    (api) => api.get('/v1/safety-reports', safetyReportsResponseSchema),
    [],
  );
  const family = useLastGood(familyQuery);
  const deletions = useLastGood(deletionQuery);
  const exportsData = useLastGood(exportsQuery);
  const reports = useLastGood(reportsQuery);

  const reloadAll = () => {
    familyQuery.reload();
    deletionQuery.reload();
    exportsQuery.reload();
    reportsQuery.reload();
  };

  const firstLoad = [
    [familyQuery, family],
    [deletionQuery, deletions],
    [exportsQuery, exportsData],
    [reportsQuery, reports],
  ].some(([query, data]) => (query as QueryState<unknown>).status === 'loading' && data === null);

  const heading = <h1>Privacy, export and deletion</h1>;
  if (firstLoad) {
    return (
      <>
        {heading}
        <Loading label="Loading your privacy controls…" />
      </>
    );
  }

  // A family that is gone (deleted, or never created) is a state, not an error — and it wins over
  // the last good load, so stale controls never stay on screen after a family deletion.
  if (familyQuery.status === 'error' && familyQuery.error.code === 'NOT_FOUND') {
    if (deletionQuery.status === 'loading') return <Loading label="Checking your account…" />;
    const familyDeletion =
      deletions?.requests.find((r) => r.scope === 'family' && r.status !== 'cancelled') ?? null;
    if (familyDeletion) {
      return (
        <>
          {heading}
          <DeletedAccount request={familyDeletion} />
        </>
      );
    }
    return (
      <>
        {heading}
        <Notice>
          There is no family on this account yet. <Link to="/app">Set up your family</Link> to
          manage exports and deletion.
        </Notice>
        <RetentionSection />
      </>
    );
  }
  if (familyQuery.status === 'error' && family === null) {
    return (
      <>
        {heading}
        <ErrorState message={errorMessage(familyQuery.error)} onRetry={reloadAll} />
      </>
    );
  }
  if (family === null) return <Loading />;

  return (
    <>
      {heading}
      <p>
        Ask for a copy of your family’s information, delete a child’s data or your whole account,
        and follow safety reports. Read the <Link to="/privacy">privacy policy</Link> for the full
        details.
      </p>
      <RetentionSection />
      <ExportsSection
        family={family}
        exportsQuery={exportsQuery}
        exportsData={exportsData}
        deletions={deletions?.requests ?? []}
      />
      <DeletionSection
        family={family}
        deletionQuery={deletionQuery}
        deletions={deletions}
        onChanged={reloadAll}
      />
      <SafetyReportsSection family={family} reportsQuery={reportsQuery} reports={reports} />
    </>
  );
}

function DeletedAccount({ request }: { request: DeletionRequest }) {
  return (
    <section className="card" style={sectionStyle} aria-labelledby="deleted-title">
      <h2 id="deleted-title">
        {request.status === 'completed'
          ? 'Your family account has been deleted'
          : 'Your family account is being deleted'}
      </h2>
      <p>
        Processing stopped when the deletion was requested: your children’s devices were signed out
        and queued work was cancelled. Family data can no longer be opened from any device.
      </p>
      <p>
        {request.status === 'completed' && request.completedAt
          ? `Deletion from our active systems finished on ${formatDate(request.completedAt)}.`
          : `Deletion from our active systems completes by ${formatDate(request.completeBy)}.`}
      </p>
      <p>
        Backups expire on a documented schedule (length to be confirmed). We may keep limited
        billing records where the law requires it.
      </p>
      <div className="notice">
        <p style={{ margin: 0 }}>
          <strong>{STORE_SUBSCRIPTION_NOTICE}</strong> To stop being charged, cancel it in the App
          Store or Google Play.
        </p>
      </div>
    </section>
  );
}

function RetentionSection() {
  return (
    <Section id="retention-title" title="How long we keep information">
      <ul>
        <li>
          Raw homework photos are deleted after {PRIVACY_RETENTION.rawScanDays} days by default.
          Deleting a child or your account removes them sooner.
        </li>
        <li>
          Results, practice history, points and rewards are kept while your account is active, until
          you delete that child or your family account.
        </li>
        <li>
          When you ask for deletion, processing stops at once: devices are signed out and queued
          work is cancelled. Deletion from our active systems completes within{' '}
          {PRIVACY_RETENTION.deletionTargetDays} days.
        </li>
        <li>Backups expire on a documented schedule (length to be confirmed).</li>
        <li>
          We may keep limited billing records where the law requires it, plus consent records and a
          security log that uses pseudonymous ids only — never homework or answers.
        </li>
        <li>
          <strong>{STORE_SUBSCRIPTION_NOTICE}</strong> Cancel it in the App Store or Google Play.
        </li>
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

function openDeletionChildIds(deletions: readonly DeletionRequest[]): Set<string> {
  return new Set(
    deletions
      .filter((d) => d.scope === 'child' && (d.status === 'requested' || d.status === 'processing'))
      .map((d) => d.childId)
      .filter((id): id is string => id !== null),
  );
}

function ExportsSection({
  family,
  exportsQuery,
  exportsData,
  deletions,
}: {
  family: PrivacyFamilyView;
  exportsQuery: QueryState<unknown> & { reload: () => void };
  exportsData: { exports: DataExport[] } | null;
  deletions: readonly DeletionRequest[];
}) {
  const { api } = useSession();
  const general = useAction();
  const answerKey = useAction();
  const [kind, setKind] = useState<StandardExportKind | ''>('');
  const [childId, setChildId] = useState('');
  const [keyChildId, setKeyChildId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const kindId = useId();
  const childSelectId = useId();
  const keyChildSelectId = useId();
  const blocked = openDeletionChildIds(deletions);
  const children = family.children.filter((c) => !blocked.has(c.id));

  const requestExport = async (event: FormEvent) => {
    event.preventDefault();
    if (!kind) {
      setFormError('Choose what to export.');
      return;
    }
    if (kind === 'review_questions_pdf' && !childId) {
      setFormError('Choose a child for a review export.');
      return;
    }
    setFormError(null);
    const ok = await general.run(async () => {
      await api.send(
        'POST',
        '/v1/exports',
        childId ? { kind, childId } : { kind },
        dataExportResponseSchema,
      );
      return 'Export requested. It is listed below with its status.';
    });
    if (ok) exportsQuery.reload();
  };

  const requestAnswerKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!keyChildId) {
      setKeyError('Choose a child for the answer key.');
      return;
    }
    setKeyError(null);
    const ok = await answerKey.run(async () => {
      await api.send(
        'POST',
        '/v1/exports/answer-key',
        { childId: keyChildId },
        dataExportResponseSchema,
      );
      return 'Answer key requested. It is listed below with its status.';
    });
    if (ok) exportsQuery.reload();
  };

  return (
    <Section id="exports-title" title="Export your data">
      <p>
        Exports contain private family information, so each request needs a recent parent PIN
        unlock. Children can’t request exports.
      </p>
      <Notice>
        Export files aren’t prepared automatically yet. Your request is saved and its status is
        shown below; there is nothing to download until the export service is switched on.
      </Notice>
      <form onSubmit={(e) => void requestExport(e)} noValidate>
        <label htmlFor={kindId}>What to export</label>
        <select
          id={kindId}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as StandardExportKind | '');
            setFormError(null);
          }}
        >
          <option value="">Choose one</option>
          {STANDARD_EXPORT_KINDS.map((k) => (
            <option key={k} value={k}>
              {EXPORT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <label htmlFor={childSelectId}>Child</label>
        <select
          id={childSelectId}
          value={childId}
          onChange={(e) => {
            setChildId(e.target.value);
            setFormError(null);
          }}
        >
          <option value="">Whole family</option>
          {children.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nickname}
            </option>
          ))}
        </select>
        {formError ? (
          <p role="alert" style={fieldError}>
            {formError}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={general.busy}>
            {general.busy ? 'Requesting…' : 'Request export'}
          </button>
        </div>
      </form>
      <ActionOutcome outcome={general.outcome} actionLabel="Request export" />

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Thursday review answer key (parent only)</legend>
        <p style={{ marginTop: 0 }}>
          Answer keys are requested separately and are never part of the questions-only review your
          child can print.
        </p>
        <form onSubmit={(e) => void requestAnswerKey(e)} noValidate>
          <label htmlFor={keyChildSelectId}>Child for the answer key</label>
          <select
            id={keyChildSelectId}
            value={keyChildId}
            onChange={(e) => {
              setKeyChildId(e.target.value);
              setKeyError(null);
            }}
          >
            <option value="">Choose a child</option>
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nickname}
              </option>
            ))}
          </select>
          {keyError ? (
            <p role="alert" style={fieldError}>
              {keyError}
            </p>
          ) : null}
          <div style={buttonRow}>
            <button type="submit" className="btn secondary" disabled={answerKey.busy}>
              {answerKey.busy ? 'Requesting…' : 'Request answer key'}
            </button>
          </div>
        </form>
        <ActionOutcome outcome={answerKey.outcome} actionLabel="Request answer key" />
      </fieldset>

      <h3>Your exports</h3>
      {exportsQuery.status === 'error' && exportsData === null ? (
        <ErrorState
          message={errorMessage((exportsQuery as { error: ApiRequestError }).error)}
          onRetry={exportsQuery.reload}
        />
      ) : exportsData && exportsData.exports.length > 0 ? (
        <ul aria-label="Your exports">
          {exportsData.exports.map((e) => (
            <li key={e.id}>
              <strong>{EXPORT_KIND_LABELS[e.kind]}</strong>
              {` · ${e.childId ? childName(family, e.childId) : 'Whole family'} · ${EXPORT_STATUS_LABELS[e.status]} · requested ${formatDate(e.createdAt)}`}
            </li>
          ))}
        </ul>
      ) : (
        <p>No exports requested yet.</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------------------------

function deletionStatusText(d: DeletionRequest): string {
  switch (d.status) {
    case 'requested':
      return `Requested: processing has stopped. Deletion completes by ${formatDate(d.completeBy)}.`;
    case 'processing':
      return `Deleting now. Completes by ${formatDate(d.completeBy)}.`;
    case 'completed':
      return `Deleted${d.completedAt ? ` on ${formatDate(d.completedAt)}` : ''}.`;
    case 'cancelled':
      return 'Cancelled.';
  }
}

function DeletionSection({
  family,
  deletionQuery,
  deletions,
  onChanged,
}: {
  family: PrivacyFamilyView;
  deletionQuery: QueryState<unknown> & { reload: () => void };
  deletions: { requests: DeletionRequest[] } | null;
  onChanged: () => void;
}) {
  const requests = deletions?.requests ?? [];
  return (
    <Section id="deletion-title" title="Delete data">
      <p>
        Deleting stops processing immediately and signs out the affected devices. Active data is
        deleted within {PRIVACY_RETENTION.deletionTargetDays} days. This can’t be undone.
      </p>
      <div className="notice">
        <p style={{ margin: 0 }}>
          <strong>{STORE_SUBSCRIPTION_NOTICE}</strong> Cancel it in the App Store or Google Play
          first if you no longer want to be charged.
        </p>
      </div>
      <DeleteChildForm family={family} requests={requests} onChanged={onChanged} />
      <DeleteFamilyForm onChanged={onChanged} />
      <h3>Deletion requests</h3>
      {deletionQuery.status === 'error' && deletions === null ? (
        <ErrorState
          message={errorMessage((deletionQuery as { error: ApiRequestError }).error)}
          onRetry={deletionQuery.reload}
        />
      ) : requests.length > 0 ? (
        <ul aria-label="Deletion requests">
          {requests.map((d) => (
            <li key={d.id}>
              <strong>
                {d.scope === 'family'
                  ? 'Whole family account'
                  : `${childName(family, d.childId)}’s data`}
              </strong>
              {` · ${deletionStatusText(d)}`}
            </li>
          ))}
        </ul>
      ) : (
        <p>No deletion requests.</p>
      )}
    </Section>
  );
}

function DeleteChildForm({
  family,
  requests,
  onChanged,
}: {
  family: PrivacyFamilyView;
  requests: readonly DeletionRequest[];
  onChanged: () => void;
}) {
  const { api } = useSession();
  const action = useAction();
  const [childId, setChildId] = useState('');
  const [typed, setTyped] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const selectId = useId();
  const confirmId = useId();
  const blocked = openDeletionChildIds(requests);
  const children = family.children.filter((c) => !blocked.has(c.id));
  const selected = children.find((c) => c.id === childId) ?? null;
  const buttonLabel = selected ? `Delete ${selected.nickname}’s data` : 'Delete data';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    // Decision: typed confirmation matches the nickname ignoring case and surrounding spaces; the
    // server-side PIN step-up is the security control, this guards against slips.
    if (typed.trim().toLowerCase() !== selected.nickname.trim().toLowerCase()) {
      setConfirmError(`Type ${selected.nickname} exactly to confirm.`);
      return;
    }
    setConfirmError(null);
    const name = selected.nickname;
    const ok = await action.run(async () => {
      const { deletion } = await api.send(
        'POST',
        '/v1/deletion',
        { scope: 'child', childId: selected.id },
        deletionRequestResponseSchema,
      );
      return `Deletion requested. ${name}’s devices are signed out and processing has stopped. Deletion completes by ${formatDate(deletion.completeBy)}.`;
    });
    if (ok) {
      setChildId('');
      setTyped('');
      onChanged();
    }
  };

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>Delete a child’s data</legend>
      <p style={{ marginTop: 0 }}>
        Removes that child’s homework photos, results, practice, points, rewards requests and
        devices. Your other children and your account stay.
      </p>
      {children.length === 0 ? (
        <p>There are no child profiles to delete.</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} noValidate>
          <label htmlFor={selectId}>Child to delete</label>
          <select
            id={selectId}
            value={childId}
            onChange={(e) => {
              setChildId(e.target.value);
              setTyped('');
              setConfirmError(null);
              action.setOutcome(null);
            }}
          >
            <option value="">Choose a child</option>
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nickname}
              </option>
            ))}
          </select>
          {selected ? (
            <>
              <label htmlFor={confirmId}>{`Type ${selected.nickname} to confirm`}</label>
              <input
                id={confirmId}
                autoComplete="off"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setConfirmError(null);
                }}
              />
              {confirmError ? (
                <p role="alert" style={fieldError}>
                  {confirmError}
                </p>
              ) : null}
              <div style={buttonRow}>
                <button
                  type="submit"
                  className="btn"
                  style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
                  disabled={action.busy}
                >
                  {action.busy ? 'Requesting…' : buttonLabel}
                </button>
              </div>
            </>
          ) : null}
        </form>
      )}
      <ActionOutcome outcome={action.outcome} actionLabel={buttonLabel} />
    </fieldset>
  );
}

const FAMILY_CONFIRMATION = 'DELETE';

function DeleteFamilyForm({ onChanged }: { onChanged: () => void }) {
  const { api } = useSession();
  const action = useAction();
  const [typed, setTyped] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmId = useId();
  const buttonLabel = 'Delete our family account';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (typed.trim() !== FAMILY_CONFIRMATION) {
      setConfirmError('Type DELETE in capital letters to confirm.');
      return;
    }
    setConfirmError(null);
    const ok = await action.run(async () => {
      const { deletion } = await api.send(
        'POST',
        '/v1/deletion',
        { scope: 'family' },
        deletionRequestResponseSchema,
      );
      return `Deletion requested. Deletion completes by ${formatDate(deletion.completeBy)}.`;
    });
    if (ok) onChanged();
  };

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>Delete your whole family account</legend>
      <p style={{ marginTop: 0 }}>
        Deletes every child’s data and your family account, and removes access for every guardian.
        Only the family owner can do this.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor={confirmId}>Type DELETE to confirm</label>
        <input
          id={confirmId}
          autoComplete="off"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setConfirmError(null);
          }}
        />
        {confirmError ? (
          <p role="alert" style={fieldError}>
            {confirmError}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button
            type="submit"
            className="btn"
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
            disabled={action.busy}
          >
            {action.busy ? 'Requesting…' : buttonLabel}
          </button>
        </div>
      </form>
      <ActionOutcome outcome={action.outcome} actionLabel={buttonLabel} />
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// Safety reports
// ---------------------------------------------------------------------------------------------

function reporterText(family: PrivacyFamilyView, report: SafetyReport): string {
  switch (report.reporterKind) {
    case 'child':
      return `Reported by ${childName(family, report.childId)}`;
    case 'parent':
      return 'Reported by a parent';
    case 'system':
      return `${PARENT_SAFETY_FLAG_COPY.reporter} · about ${childName(family, report.childId)}`;
  }
}

function SafetyReportsSection({
  family,
  reportsQuery,
  reports,
}: {
  family: PrivacyFamilyView;
  reportsQuery: QueryState<unknown> & { reload: () => void };
  reports: { reports: SafetyReport[] } | null;
}) {
  const { api } = useSession();
  const action = useAction();
  const [category, setCategory] = useState<SafetyReportCategory | ''>('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const categoryId = useId();
  const noteId = useId();
  const noteHintId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!category) {
      setFormError('Choose what happened.');
      return;
    }
    setFormError(null);
    const trimmed = note.trim();
    const ok = await action.run(async () => {
      await api.send(
        'POST',
        '/v1/safety-reports',
        trimmed ? { category, note: trimmed } : { category },
        safetyReportResponseSchema,
      );
      return 'Report saved. You can follow its status below.';
    });
    if (ok) {
      setCategory('');
      setNote('');
      reportsQuery.reload();
    }
  };

  const list = reports?.reports ?? [];
  return (
    <Section id="reports-title" title="Safety reports">
      <p>
        When your child picks one of the “Tell PencilLift” choices in the app, or you send a report
        here, it is saved to PencilLift’s review queue and its status is shown below. The app’s
        “Tell a grown-up” card only encourages your child to talk to someone they trust; it doesn’t
        send anything or alert anyone. Reviewers see the type of report, its status and item
        references — not homework text, your child’s name or your note.
      </p>
      <p>
        PencilLift also adds a report here when its safety check flags one of your child’s answers
        for a grown-up to look at, and emails the guardians on this account so they know to look;
        each flag below says whether that email was sent. For that question, your child’s results
        show a calm message about talking with a grown-up they trust instead of a hint, and
        PencilLift gives no hints on it. Once you have looked into a flag, mark it below; if you are
        sure it was a false alarm, you can have the question checked normally.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor={categoryId}>What happened?</label>
        <select
          id={categoryId}
          value={category}
          onChange={(e) => {
            setCategory(e.target.value as SafetyReportCategory | '');
            setFormError(null);
          }}
        >
          <option value="">Choose one</option>
          {SAFETY_REPORT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <label htmlFor={noteId}>Note (optional)</label>
        <textarea
          id={noteId}
          value={note}
          maxLength={SAFETY_NOTE_MAX_LENGTH}
          rows={3}
          aria-describedby={noteHintId}
          style={{ width: '100%', maxWidth: 420, fontSize: '1rem', padding: 8, borderRadius: 8 }}
          onChange={(e) => setNote(e.target.value)}
        />
        <p id={noteHintId} style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
          Visible to your family’s guardians. Please don’t include your child’s full name.
        </p>
        {formError ? (
          <p role="alert" style={fieldError}>
            {formError}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button type="submit" className="btn secondary" disabled={action.busy}>
            {action.busy ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </form>
      <ActionOutcome outcome={action.outcome} actionLabel="Send report" />

      <h3>Family reports</h3>
      {reportsQuery.status === 'error' && reports === null ? (
        <ErrorState
          message={errorMessage((reportsQuery as { error: ApiRequestError }).error)}
          onRetry={reportsQuery.reload}
        />
      ) : list.length > 0 ? (
        <ul aria-label="Family safety reports">
          {list.map((r) => (
            <ReportItem key={r.id} family={family} report={r} onChanged={reportsQuery.reload} />
          ))}
        </ul>
      ) : (
        <p>No safety reports yet.</p>
      )}
    </Section>
  );
}

/** What a flag row says about itself: the state after a clearing or a guardian's action, else the summary. */
function flagText(report: SafetyReport): string {
  if (report.clearedAsFalseMatch) return PARENT_SAFETY_FLAG_COPY.cleared;
  if (report.parentOutcome === 'addressed') return PARENT_SAFETY_FLAG_COPY.addressed;
  return PARENT_SAFETY_FLAG_COPY.summary;
}

/**
 * One family report. A flag says what the product shows the child, whether the guardian email was
 * sent (the recorded delivery, never assumed) and the hotlines. While a flag or a child's report is
 * unresolved a guardian can act on it (owner decision, 2026-09-25): "I've looked into this" resolves
 * it and changes nothing for the child; "This was a false alarm" (flags only) clears it exactly as a
 * reviewer's clearing does. Both need a recent PIN unlock, checked by the server; a resolved report
 * shows its outcome and offers nothing.
 */
function ReportItem({
  family,
  report,
  onChanged,
}: {
  family: PrivacyFamilyView;
  report: SafetyReport;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const action = useAction();
  const [pending, setPending] = useState<ParentReportOutcome | null>(null);
  const [lastLabel, setLastLabel] = useState<string>(PARENT_SAFETY_FLAG_ACTIONS.addressed.label);
  const isFlag = report.reporterKind === 'system';
  const actionable = report.status !== 'resolved' && report.reporterKind !== 'parent';

  const act = async (outcome: ParentReportOutcome) => {
    const label =
      PARENT_SAFETY_FLAG_ACTIONS[outcome === 'addressed' ? 'addressed' : 'falseMatch'].label;
    setLastLabel(label);
    setPending(outcome);
    const ok = await action.run(async () => {
      await api.send(
        'PATCH',
        `/v1/safety-reports/${report.id}`,
        { outcome },
        safetyReportResponseSchema,
      );
      return outcome === 'addressed'
        ? 'Marked as looked into. Nothing changes for your child.'
        : 'Cleared as a false alarm. The message is removed from your child’s results for that question, and PencilLift is checking it normally.';
    });
    setPending(null);
    if (ok) onChanged();
  };

  return (
    <li>
      <strong>{CATEGORY_LABELS[report.category]}</strong>
      {` · ${reporterText(family, report)} · ${REPORT_STATUS_LABELS[report.status]} · ${formatDate(report.createdAt)}`}
      {report.note ? <div style={{ color: 'var(--muted)' }}>{`“${report.note}”`}</div> : null}
      {isFlag ? (
        <div>
          <p style={{ margin: '4px 0 0' }}>{flagText(report)}</p>
          <p style={{ margin: '4px 0 0' }}>{EMAIL_STATE_COPY[report.emailStatus]}</p>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
            {PARENT_SAFETY_FLAG_COPY.resources}
          </p>
        </div>
      ) : null}
      {report.reporterKind === 'child' ? (
        <div>
          {report.parentOutcome === 'addressed' ? (
            <p style={{ margin: '4px 0 0' }}>{PARENT_SAFETY_FLAG_COPY.childReportAddressed}</p>
          ) : null}
          <p style={{ margin: '4px 0 0' }}>{EMAIL_STATE_COPY[report.emailStatus]}</p>
        </div>
      ) : null}
      {actionable ? (
        <div>
          <div style={buttonRow}>
            <button
              type="button"
              className="btn secondary"
              disabled={action.busy}
              onClick={() => void act('addressed')}
            >
              {pending === 'addressed' ? 'Saving…' : PARENT_SAFETY_FLAG_ACTIONS.addressed.label}
            </button>
            {isFlag ? (
              <button
                type="button"
                className="btn secondary"
                disabled={action.busy}
                onClick={() => void act('false_match')}
              >
                {pending === 'false_match'
                  ? 'Saving…'
                  : PARENT_SAFETY_FLAG_ACTIONS.falseMatch.label}
              </button>
            ) : null}
          </div>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
            {`“${PARENT_SAFETY_FLAG_ACTIONS.addressed.label}”: ${PARENT_SAFETY_FLAG_ACTIONS.addressed.effect}`}
          </p>
          {isFlag ? (
            <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
              {`“${PARENT_SAFETY_FLAG_ACTIONS.falseMatch.label}”: ${PARENT_SAFETY_FLAG_ACTIONS.falseMatch.effect}`}
            </p>
          ) : null}
          <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
            {PARENT_SAFETY_FLAG_COPY.actionsNeedUnlock}
          </p>
          <ActionOutcome outcome={action.outcome} actionLabel={lastLabel} />
        </div>
      ) : null}
    </li>
  );
}
