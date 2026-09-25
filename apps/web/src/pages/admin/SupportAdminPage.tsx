import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';
import {
  ADMIN_CASE_PAGE_SIZE,
  adminCaseQueueResponseSchema,
  adminCaseResponseSchema,
  adminSupportCaseDetailResponseSchema,
  adminSupportCaseMessageSchema,
  adminSupportCaseSchema,
  caseAgeFilterSchema,
  SUPPORT_CASE_KIND_LABELS,
  SUPPORT_CASE_RESOLUTION_LABELS,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REFERENCE_MAX_LENGTH,
  SUPPORT_RULES,
  supportCaseKindSchema,
  supportCaseStatusSchema,
  uuidSchema,
  type AdminBillingPeriod,
  type AdminCaseUpdateRequest,
  type AdminSupportCase,
  type AdminSupportCaseDetailResponse,
  type AdminSupportCaseMessage,
  type SupportCaseKind,
  type SupportCasePriority,
  type SupportCaseResolution,
  type SupportCaseStatus,
  supportPolicyResponseSchema,
  type SupportPolicyContract,
} from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import {
  CASE_AGE_FILTER_KEYS,
  caseUpdateProblems,
  SUPPORT_CASE_KINDS,
  SUPPORT_CASE_PRIORITIES,
  SUPPORT_CASE_RESOLUTIONS,
  SUPPORT_CASE_STATUSES,
  type CaseAgeFilter,
  type CaseUpdateProblem,
  REFUND_WINDOW_DAYS_MAX,
  REFUND_WINDOW_DAYS_MIN,
  RESPONSE_TARGET_HOURS_MAX,
  RESPONSE_TARGET_HOURS_MIN,
  supportPolicyProblems,
} from '@pencillift/domain/ops';
import { ErrorState, Loading } from '../../components/states.tsx';
import { useApiQuery, useSession } from '../../lib/session.tsx';
import {
  AdminAccessDenied,
  adminErrorMessage,
  AdminFeedback,
  AdminPage,
  ageText,
  buttonRow,
  cellStyle,
  channelLabel,
  FieldError,
  formatUtc,
  formatUtcDate,
  isAccessDenied,
  numberCellStyle,
  Pill,
  sectionStyle,
  shortId,
  smallMutedStyle,
  TableScroll,
  tableStyle,
  textareaStyle,
  toApiError,
  useAdminAction,
  useLastGood,
  type Tone,
} from './components/admin-ui.tsx';

/**
 * Owner-staff support queue (product decision: complaints, refund requests, billing issues, bugs,
 * safety questions and other cases from families). Queue with filters and keyset paging, a case
 * with its thread, internal notes visibly marked and never sent to the family, assign / status /
 * priority / resolution controls, and for refund requests the family's billing periods with the
 * store's refund path and whatever the provider has reported. Store refunds are issued by the
 * store, never here; a Stripe refund is issued in the Stripe dashboard and recorded by reference.
 * Every action confirms in the page. Requires an owner-admin MFA session (API-enforced).
 */
export default function SupportAdminPage() {
  return (
    <AdminPage title="Support queue">
      <SupportConsole />
    </AdminPage>
  );
}

// ---------------------------------------------------------------------------------------------
// URL state: filters and the open case live in the query string so rows and the overview link
// ---------------------------------------------------------------------------------------------

interface Filters {
  readonly scope: 'open' | 'all';
  readonly status: SupportCaseStatus | null;
  readonly kind: SupportCaseKind | null;
  readonly age: CaseAgeFilter | null;
}

function readFilters(params: URLSearchParams): Filters {
  const status = supportCaseStatusSchema.safeParse(params.get('status'));
  const kind = supportCaseKindSchema.safeParse(params.get('kind'));
  const age = caseAgeFilterSchema.safeParse(params.get('age'));
  return {
    scope: params.get('scope') === 'all' ? 'all' : 'open',
    status: status.success ? status.data : null,
    kind: kind.success ? kind.data : null,
    age: age.success ? age.data : null,
  };
}

function filterParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.scope === 'all') params.set('scope', 'all');
  if (filters.status) params.set('status', filters.status);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.age) params.set('age', filters.age);
  return params;
}

/** The API query for a filter set (scope always explicit so the request reads unambiguously). */
function queueQuery(filters: Filters): string {
  const params = filterParams(filters);
  params.set('scope', filters.scope);
  return params.toString();
}

function SupportConsole() {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const selected = params.get('case');
  // Bumped after every mutation so the queue and the open case reload from the server.
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  const hrefFor = (next: Filters, caseId: string | null): string => {
    const query = filterParams(next);
    if (caseId !== null) query.set('case', caseId);
    const text = query.toString();
    return text === '' ? '/admin/support' : `/admin/support?${text}`;
  };

  if (selected !== null) {
    return (
      <CaseDetail
        id={selected}
        version={version}
        onChanged={changed}
        backHref={hrefFor(filters, null)}
      />
    );
  }
  return (
    <>
      <QueueFilters
        filters={filters}
        onChange={(next) => {
          setParams(filterParams(next));
        }}
      />
      <Queue filters={filters} version={version} caseHref={(id) => hrefFor(filters, id)} />
      <PolicyForm />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Support policy (PUT /v1/admin/settings/support-policy; Owner action #32)
// ---------------------------------------------------------------------------------------------

/** "48" -> 48; null unless a whole number. */
function parseWhole(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  return Number(trimmed);
}

function PolicyForm() {
  const { api } = useSession();
  const headingId = useId();
  const fieldBase = useId();
  const [saved, setSaved] = useState(0);
  const query = useApiQuery(
    (a) => a.get('/v1/admin/settings/support-policy', supportPolicyResponseSchema),
    [saved],
  );
  const data = useLastGood(query);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [partial, setPartial] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, feedback, run } = useAdminAction();

  const valueFor = (field: string, current: number): string => edits[field] ?? String(current);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!data) return;
    const problems: Record<string, string> = {};
    const window = parseWhole(valueFor('refundWindowDays', data.policy.refundWindowDays));
    if (window === null) problems['refundWindowDays'] = 'Enter a whole number of days.';
    const targets: Record<string, number> = {};
    for (const kind of SUPPORT_CASE_KINDS) {
      const hours = parseWhole(valueFor(kind, data.policy.responseTargetHours[kind]));
      if (hours === null) problems[kind] = 'Enter a whole number of hours.';
      else targets[kind] = hours;
    }
    const candidate = {
      refundWindowDays: window ?? 0,
      responseTargetHours: targets,
      partialRefunds: partial ?? data.policy.partialRefunds,
    };
    if (Object.keys(problems).length === 0) {
      // Same rule set as the API (domain), so a refusal is explained before the request.
      for (const p of supportPolicyProblems(candidate)) {
        const field = p.field.replace('responseTargetHours.', '');
        problems[field] = `This ${p.problem}.`;
      }
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    await run('save-policy', async () => {
      await api.send(
        'PUT',
        '/v1/admin/settings/support-policy',
        { policy: candidate as SupportPolicyContract },
        supportPolicyResponseSchema,
      );
      setEdits({});
      setPartial(null);
      setSaved((v) => v + 1);
      return 'Support policy saved. Parents see the refund window on their support page.';
    });
  };

  const numberField = (field: string, label: string, current: number, hint: string) => {
    const id = `${fieldBase}-${field}`;
    return (
      <div key={field} style={{ display: 'grid', gap: 4 }}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          inputMode="numeric"
          value={valueFor(field, current)}
          onChange={(e) => setEdits((prev) => ({ ...prev, [field]: e.target.value }))}
          aria-describedby={`${id}-hint`}
          aria-invalid={errors[field] ? true : undefined}
          style={{ maxWidth: 120 }}
        />
        <span id={`${id}-hint`} style={smallMutedStyle}>
          {hint}
        </span>
        <FieldError id={`${id}-error`} message={errors[field]} />
      </div>
    );
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Support policy</h2>
      <p>
        The refund window parents see on their support page and your response-time target per case
        kind (measured from when a case is opened). Store refunds are still issued by the stores; a
        Stripe refund is issued in the Stripe dashboard and recorded on the case.
      </p>
      {data === null && query.status === 'loading' ? <Loading label="Loading the policy…" /> : null}
      {query.status === 'error' && data === null ? (
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {data !== null ? (
        <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={headingId}>
          {data.usedDefault ? (
            <p style={smallMutedStyle}>No policy has been saved yet; the defaults below apply.</p>
          ) : (
            <p style={smallMutedStyle}>
              Last saved {data.updatedAt ? formatUtc(data.updatedAt) : '—'}
              {data.updatedBy ? ` by ${shortId(data.updatedBy)}` : ''}.
            </p>
          )}
          <div style={{ display: 'grid', gap: 12 }}>
            {numberField(
              'refundWindowDays',
              'Refund window (days)',
              data.policy.refundWindowDays,
              `${REFUND_WINDOW_DAYS_MIN} to ${REFUND_WINDOW_DAYS_MAX} days after a charge.`,
            )}
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ fontWeight: 700 }}>Response target (hours) per case kind</legend>
              <div style={{ display: 'grid', gap: 12 }}>
                {SUPPORT_CASE_KINDS.map((kind) =>
                  numberField(
                    kind,
                    SUPPORT_CASE_KIND_LABELS[kind],
                    data.policy.responseTargetHours[kind],
                    `${RESPONSE_TARGET_HOURS_MIN} to ${RESPONSE_TARGET_HOURS_MAX} hours.`,
                  ),
                )}
              </div>
            </fieldset>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={partial ?? data.policy.partialRefunds}
                onChange={(e) => setPartial(e.target.checked)}
              />
              Partial refunds may be granted
            </label>
          </div>
          <div style={buttonRow}>
            <button type="submit" className="primary" disabled={busy !== null}>
              {busy === 'save-policy' ? 'Saving…' : 'Save policy'}
            </button>
          </div>
          <AdminFeedback feedback={feedback} rules={SUPPORT_RULE_MESSAGES} />
        </form>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

const STATUS_TONE: Readonly<Record<SupportCaseStatus, Tone>> = {
  open: 'attention',
  in_progress: 'neutral',
  waiting_on_parent: 'neutral',
  resolved: 'success',
  closed: 'neutral',
};

/** Staff wording for statuses (the family sees SUPPORT_CASE_STATUS_LABELS, e.g. "Waiting on you"). */
const STAFF_STATUS_LABEL: Readonly<Record<SupportCaseStatus, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_on_parent: 'Waiting on the family',
  resolved: 'Resolved',
  closed: 'Closed',
};

const AGE_FILTER_LABEL: Readonly<Record<CaseAgeFilter, string>> = {
  over_24h: 'Older than 24 hours',
  over_72h: 'Older than 72 hours',
  over_7d: 'Older than 7 days',
};

const SETTLEMENT_LABEL: Readonly<Record<AdminBillingPeriod['settlement'], string>> = {
  pending: 'Pending',
  settled: 'Settled',
  failed: 'Failed',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
  chargeback: 'Chargeback',
};

/** Rule codes from the support routes, in staff-facing words (same rules as the domain check). */
export const SUPPORT_RULE_MESSAGES: Readonly<Record<string, string>> = {
  [SUPPORT_RULES.resolutionRequired]: 'Choose a resolution before resolving the case.',
  [SUPPORT_RULES.resolutionNeedsClosedOutStatus]:
    'A resolution belongs to a resolved or closed case. To reopen, clear the resolution as well.',
  [SUPPORT_RULES.referenceRequired]:
    'Record the Stripe refund reference from the Stripe dashboard before choosing “Refunded (web billing)”.',
  [SUPPORT_RULES.referenceWithoutResolution]: 'A refund reference needs a resolution.',
  [SUPPORT_RULES.assigneeNotStaff]:
    'That user id is not an active staff member (admin_users), so the case was not assigned.',
  [SUPPORT_RULES.caseClosed]: 'The case is closed.',
};

const PROBLEM_TEXT: Readonly<Record<CaseUpdateProblem, string>> = {
  RESOLUTION_REQUIRED: SUPPORT_RULE_MESSAGES[SUPPORT_RULES.resolutionRequired]!,
  RESOLUTION_NEEDS_CLOSED_OUT_STATUS:
    SUPPORT_RULE_MESSAGES[SUPPORT_RULES.resolutionNeedsClosedOutStatus]!,
  REFERENCE_REQUIRED: SUPPORT_RULE_MESSAGES[SUPPORT_RULES.referenceRequired]!,
  REFERENCE_WITHOUT_RESOLUTION: SUPPORT_RULE_MESSAGES[SUPPORT_RULES.referenceWithoutResolution]!,
};

const adminMessageResponseSchema = z.strictObject({
  message: adminSupportCaseMessageSchema,
  case: adminSupportCaseSchema,
});

const MESSAGE_REMINDER =
  'Never include a child’s name, homework text or answers. Cases are about the family’s account, plan and the app.';

function StatusPill({ status }: { status: SupportCaseStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STAFF_STATUS_LABEL[status]}</Pill>;
}

// ---------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------

function QueueFilters({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  const scopeId = useId();
  const statusId = useId();
  const kindId = useId();
  const ageId = useId();
  return (
    <form
      aria-label="Queue filters"
      onSubmit={(e) => e.preventDefault()}
      style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px', alignItems: 'end' }}
    >
      <div>
        <label htmlFor={scopeId}>Show</label>
        <select
          id={scopeId}
          value={filters.scope}
          onChange={(e) =>
            onChange({ ...filters, scope: e.target.value === 'all' ? 'all' : 'open' })
          }
        >
          <option value="open">Open queue (not resolved or closed)</option>
          <option value="all">All cases</option>
        </select>
      </div>
      <div>
        <label htmlFor={statusId}>Status</label>
        <select
          id={statusId}
          value={filters.status ?? ''}
          onChange={(e) => {
            const parsed = supportCaseStatusSchema.safeParse(e.target.value);
            onChange({ ...filters, status: parsed.success ? parsed.data : null });
          }}
        >
          <option value="">Any status</option>
          {SUPPORT_CASE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STAFF_STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={kindId}>Kind</label>
        <select
          id={kindId}
          value={filters.kind ?? ''}
          onChange={(e) => {
            const parsed = supportCaseKindSchema.safeParse(e.target.value);
            onChange({ ...filters, kind: parsed.success ? parsed.data : null });
          }}
        >
          <option value="">Any kind</option>
          {SUPPORT_CASE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {SUPPORT_CASE_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ageId}>Age</label>
        <select
          id={ageId}
          value={filters.age ?? ''}
          onChange={(e) => {
            const parsed = caseAgeFilterSchema.safeParse(e.target.value);
            onChange({ ...filters, age: parsed.success ? parsed.data : null });
          }}
        >
          <option value="">Any age</option>
          {CASE_AGE_FILTER_KEYS.map((age) => (
            <option key={age} value={age}>
              {AGE_FILTER_LABEL[age]}
            </option>
          ))}
        </select>
      </div>
    </form>
  );
}

function describeFilters(filters: Filters): string {
  const parts = [filters.scope === 'all' ? 'all cases' : 'the open queue'];
  if (filters.status) parts.push(`status ${STAFF_STATUS_LABEL[filters.status].toLowerCase()}`);
  if (filters.kind) parts.push(`kind ${SUPPORT_CASE_KIND_LABELS[filters.kind].toLowerCase()}`);
  if (filters.age) parts.push(AGE_FILTER_LABEL[filters.age].toLowerCase());
  return parts.join(', ');
}

function Queue({
  filters,
  version,
  caseHref,
}: {
  filters: Filters;
  version: number;
  caseHref: (id: string) => string;
}) {
  const { api } = useSession();
  const headingId = useId();
  const key = queueQuery(filters);
  const first = useApiQuery(
    (a) => a.get(`/v1/admin/support/cases?${key}`, adminCaseQueueResponseSchema),
    [key, version],
  );
  // Pages after the first, valid only for the filters and version they were loaded for.
  const [more, setMore] = useState<{
    key: string;
    version: number;
    cases: AdminSupportCase[];
    nextCursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  if (first.status === 'loading') return <Loading label="Loading the queue…" />;
  if (first.status === 'error') {
    return isAccessDenied(first.error) ? (
      <AdminAccessDenied />
    ) : (
      <ErrorState message={adminErrorMessage(first.error)} onRetry={first.reload} />
    );
  }
  const extra = more !== null && more.key === key && more.version === version ? more : null;
  const cases = [...first.data.cases, ...(extra?.cases ?? [])];
  const nextCursor = extra ? extra.nextCursor : first.data.nextCursor;

  const loadMore = async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get(
        `/v1/admin/support/cases?${key}&after=${encodeURIComponent(nextCursor)}`,
        adminCaseQueueResponseSchema,
      );
      setMore({
        key,
        version,
        cases: [...(extra?.cases ?? []), ...page.cases],
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      setMoreError(adminErrorMessage(toApiError(error)));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Cases</h2>
      <p>
        {cases.length === 0
          ? `No cases match ${describeFilters(filters)}.`
          : `${cases.length} case${cases.length === 1 ? '' : 's'} shown for ${describeFilters(filters)}, oldest first${nextCursor ? ' (more available)' : ''}.`}
      </p>
      {cases.length > 0 ? (
        <TableScroll label="Support cases table">
          <table style={tableStyle} aria-labelledby={headingId}>
            <thead>
              <tr>
                <th style={cellStyle} scope="col">
                  Opened
                </th>
                <th style={cellStyle} scope="col">
                  Kind
                </th>
                <th style={cellStyle} scope="col">
                  Subject
                </th>
                <th style={cellStyle} scope="col">
                  Status
                </th>
                <th style={cellStyle} scope="col">
                  Priority
                </th>
                <th style={cellStyle} scope="col">
                  Assignee
                </th>
                <th style={numberCellStyle} scope="col">
                  Messages
                </th>
                <th style={cellStyle} scope="col">
                  Family
                </th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td style={cellStyle}>
                    <span style={{ whiteSpace: 'nowrap' }}>{ageText(c.ageHours)} ago</span>
                    <br />
                    <span style={smallMutedStyle}>{formatUtc(c.createdAt)}</span>
                  </td>
                  <td style={cellStyle}>{SUPPORT_CASE_KIND_LABELS[c.kind]}</td>
                  <th style={{ ...cellStyle, fontWeight: 600 }} scope="row">
                    <Link to={caseHref(c.id)}>{c.subject}</Link>
                  </th>
                  <td style={cellStyle}>
                    <StatusPill status={c.status} />
                  </td>
                  <td style={cellStyle}>
                    {c.priority === 'high' ? <Pill tone="attention">High</Pill> : 'Normal'}
                  </td>
                  <td style={cellStyle}>
                    {c.assigneeUserId ? (
                      <code title={c.assigneeUserId}>{shortId(c.assigneeUserId)}</code>
                    ) : (
                      'Unassigned'
                    )}
                  </td>
                  <td style={numberCellStyle}>{c.messageCount}</td>
                  <td style={cellStyle}>
                    <code title={c.familyId}>{shortId(c.familyId)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
      {moreError ? <ErrorState message={moreError} /> : null}
      {nextCursor !== null ? (
        <div style={buttonRow}>
          <button
            type="button"
            className="btn secondary"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading…' : `Load the next ${ADMIN_CASE_PAGE_SIZE}`}
          </button>
        </div>
      ) : cases.length > 0 ? (
        <p style={smallMutedStyle}>End of the list.</p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Case detail
// ---------------------------------------------------------------------------------------------

function CaseDetail({
  id,
  version,
  onChanged,
  backHref,
}: {
  id: string;
  version: number;
  onChanged: () => void;
  backHref: string;
}) {
  const query = useApiQuery(
    (a) =>
      a.get(
        `/v1/admin/support/cases/${encodeURIComponent(id)}`,
        adminSupportCaseDetailResponseSchema,
      ),
    [id, version],
  );
  const data = useLastGood(query);
  const back = (
    <p>
      <Link to={backHref}>← Back to the queue</Link>
    </p>
  );
  if (data === null) {
    if (query.status === 'error') {
      return isAccessDenied(query.error) ? (
        <AdminAccessDenied />
      ) : (
        <>
          {back}
          <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
        </>
      );
    }
    return (
      <>
        {back}
        <Loading label="Loading the case…" />
      </>
    );
  }
  const c = data.case;
  return (
    <div aria-busy={query.status === 'loading'}>
      {back}
      <section className="card" style={sectionStyle} aria-label="Case">
        <h2 style={{ marginTop: 0 }}>{c.subject}</h2>
        <p style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Pill>{SUPPORT_CASE_KIND_LABELS[c.kind]}</Pill>
          <StatusPill status={c.status} />
          {c.priority === 'high' ? <Pill tone="attention">High priority</Pill> : null}
          {c.resolution ? (
            <Pill tone="success">{SUPPORT_CASE_RESOLUTION_LABELS[c.resolution]}</Pill>
          ) : null}
        </p>
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }}>
          <dt>Opened</dt>
          <dd style={{ margin: 0 }}>
            {formatUtc(c.createdAt)} ({ageText(c.ageHours)} ago) by the{' '}
            {c.openedByKind === 'parent' ? 'family' : 'staff'}
          </dd>
          <dt>Family</dt>
          <dd style={{ margin: 0 }}>
            {data.family.displayName} · time zone {data.family.timezone} · joined{' '}
            {formatUtcDate(data.family.createdAt)} · <code>{data.family.id}</code>
            {data.family.deletedAt ? (
              <>
                {' '}
                <Pill tone="attention">Family deleted {formatUtcDate(data.family.deletedAt)}</Pill>
              </>
            ) : null}
          </dd>
          <dt>Assignee</dt>
          <dd style={{ margin: 0 }}>
            {c.assigneeUserId ? <code>{c.assigneeUserId}</code> : 'Unassigned'}
          </dd>
          {c.resolution ? (
            <>
              <dt>Resolution</dt>
              <dd style={{ margin: 0 }}>
                {SUPPORT_CASE_RESOLUTION_LABELS[c.resolution]}
                {c.resolutionReference ? (
                  <>
                    {' '}
                    · reference <code>{c.resolutionReference}</code>
                  </>
                ) : null}
                {c.resolvedAt ? ` · ${formatUtc(c.resolvedAt)}` : ''}
              </dd>
            </>
          ) : null}
          <dt>Case id</dt>
          <dd style={{ margin: 0 }}>
            <code>{c.id}</code>
          </dd>
        </dl>
        <h3>Message from the family</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p>
      </section>
      <Thread messages={data.messages} />
      <ReplyForm caseId={c.id} closed={c.status === 'closed'} onDone={onChanged} />
      <UpdateForm key={c.updatedAt} current={c} onDone={onChanged} />
      <BillingSection detail={data} />
    </div>
  );
}

function Thread({ messages }: { messages: readonly AdminSupportCaseMessage[] }) {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Thread</h2>
      {messages.length === 0 ? (
        <p>No replies or notes yet.</p>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {messages.map((m) => (
            <li
              key={m.id}
              style={{
                borderLeft: `4px solid ${m.internal ? 'var(--gold)' : m.authorKind === 'parent' ? 'var(--muted)' : 'var(--teal)'}`,
                padding: '4px 0 4px 12px',
                marginBottom: 12,
              }}
            >
              <p style={{ margin: 0, ...smallMutedStyle }}>
                <strong style={{ color: 'var(--navy)' }}>
                  {m.authorKind === 'parent' ? 'Family' : 'Staff'}
                </strong>
                {m.authorUserId ? (
                  <>
                    {' '}
                    <code title={m.authorUserId}>{shortId(m.authorUserId)}</code>
                  </>
                ) : null}{' '}
                · {formatUtc(m.createdAt)}
                {m.internal ? (
                  <>
                    {' '}
                    <Pill tone="attention">Internal note — not shown to the family</Pill>
                  </>
                ) : null}
              </p>
              <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{m.body}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ReplyForm({
  caseId,
  closed,
  onDone,
}: {
  caseId: string;
  closed: boolean;
  onDone: () => void;
}) {
  const { api } = useSession();
  const headingId = useId();
  const messageId = useId();
  const internalId = useId();
  const [message, setMessage] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, feedback, run } = useAdminAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (text === '') {
      setError('Write a message first.');
      return;
    }
    if (text.length > SUPPORT_MESSAGE_MAX_LENGTH) {
      setError(`Keep it under ${SUPPORT_MESSAGE_MAX_LENGTH} characters.`);
      return;
    }
    setError(null);
    const wasInternal = internal;
    await run('reply', async () => {
      await api.send(
        'POST',
        `/v1/admin/support/cases/${encodeURIComponent(caseId)}/messages`,
        { message: text, internal: wasInternal },
        adminMessageResponseSchema,
      );
      setMessage('');
      onDone();
      return wasInternal
        ? 'Internal note saved. The family never sees it.'
        : 'Reply sent to the family.';
    });
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Reply or add a note</h2>
      {closed ? (
        <p className="notice">
          The case is closed: the family can no longer reply. Staff can still add a note or a reply
          here.
        </p>
      ) : null}
      <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={headingId}>
        <label htmlFor={messageId}>Message</label>
        <textarea
          id={messageId}
          style={textareaStyle}
          value={message}
          maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
          aria-describedby={`${messageId}-hint${error ? ` ${messageId}-error` : ''}`}
          onChange={(e) => {
            setMessage(e.target.value);
            setError(null);
          }}
        />
        <p id={`${messageId}-hint`} style={{ ...smallMutedStyle, margin: '4px 0 0' }}>
          {MESSAGE_REMINDER} {message.length}/{SUPPORT_MESSAGE_MAX_LENGTH}
        </p>
        <FieldError id={`${messageId}-error`} message={error} />
        <label htmlFor={internalId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id={internalId}
            type="checkbox"
            checked={internal}
            onChange={(e) => setInternal(e.target.checked)}
            style={{ width: 'auto', minHeight: 0 }}
          />
          Internal note (staff only — never shown to the family)
        </label>
        <div style={buttonRow}>
          <button
            type="submit"
            className={internal ? 'btn secondary' : 'btn'}
            disabled={busy !== null}
          >
            {busy === 'reply'
              ? 'Sending…'
              : internal
                ? 'Save internal note'
                : 'Send reply to the family'}
          </button>
        </div>
      </form>
      <AdminFeedback feedback={feedback} rules={SUPPORT_RULE_MESSAGES} />
    </section>
  );
}

function UpdateForm({ current, onDone }: { current: AdminSupportCase; onDone: () => void }) {
  const { api } = useSession();
  const headingId = useId();
  const statusId = useId();
  const priorityId = useId();
  const resolutionId = useId();
  const referenceId = useId();
  const assigneeId = useId();
  const [status, setStatus] = useState<SupportCaseStatus>(current.status);
  const [priority, setPriority] = useState<SupportCasePriority>(current.priority);
  const [resolution, setResolution] = useState<SupportCaseResolution | ''>(
    current.resolution ?? '',
  );
  const [reference, setReference] = useState(current.resolutionReference ?? '');
  const [assignee, setAssignee] = useState(current.assigneeUserId ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);
  const { busy, feedback, run } = useAdminAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setAssigneeError(null);
    const body: AdminCaseUpdateRequest = {};
    if (status !== current.status) body.status = status;
    if (priority !== current.priority) body.priority = priority;
    const nextResolution = resolution === '' ? null : resolution;
    if (nextResolution !== current.resolution) body.resolution = nextResolution;
    const nextReference = reference.trim() === '' ? null : reference.trim();
    if (nextReference !== current.resolutionReference) body.resolutionReference = nextReference;
    const nextAssignee = assignee.trim() === '' ? null : assignee.trim();
    if (nextAssignee !== current.assigneeUserId) {
      if (nextAssignee !== null && !uuidSchema.safeParse(nextAssignee).success) {
        setAssigneeError(
          'Enter the staff member’s user id (a UUID), or leave it empty to unassign.',
        );
        return;
      }
      body.assigneeUserId = nextAssignee;
    }
    if (Object.keys(body).length === 0) {
      setFormError('Nothing to change.');
      return;
    }
    // The same rules the API applies, checked here first so a bad combination never round-trips.
    const [problem] = caseUpdateProblems(
      {
        status: current.status,
        resolution: current.resolution,
        resolutionReference: current.resolutionReference,
      },
      {
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.resolution === undefined ? {} : { resolution: body.resolution }),
        ...(body.resolutionReference === undefined
          ? {}
          : { resolutionReference: body.resolutionReference }),
      },
    );
    if (problem !== undefined) {
      setFormError(PROBLEM_TEXT[problem]);
      return;
    }
    await run('update', async () => {
      const result = await api.send(
        'PATCH',
        `/v1/admin/support/cases/${encodeURIComponent(current.id)}`,
        body,
        adminCaseResponseSchema,
      );
      onDone();
      const outcome = result.case.resolution
        ? `${STAFF_STATUS_LABEL[result.case.status]}, ${SUPPORT_CASE_RESOLUTION_LABELS[result.case.resolution]}`
        : STAFF_STATUS_LABEL[result.case.status];
      return `Case updated: ${outcome}${result.case.assigneeUserId ? `, assigned to ${shortId(result.case.assigneeUserId)}` : ', unassigned'}.`;
    });
  };

  const needsReference = resolution === 'stripe_refund_issued';
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Assign, status and resolution</h2>
      <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={headingId}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '0 16px',
          }}
        >
          <div>
            <label htmlFor={statusId}>Status</label>
            <select
              id={statusId}
              value={status}
              onChange={(e) => {
                const parsed = supportCaseStatusSchema.safeParse(e.target.value);
                if (parsed.success) setStatus(parsed.data);
                setFormError(null);
              }}
            >
              {SUPPORT_CASE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STAFF_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={priorityId}>Priority</label>
            <select
              id={priorityId}
              value={priority}
              onChange={(e) => {
                setPriority(e.target.value === 'high' ? 'high' : 'normal');
                setFormError(null);
              }}
            >
              {SUPPORT_CASE_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p === 'high' ? 'High' : 'Normal'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={resolutionId}>Resolution</label>
            <select
              id={resolutionId}
              value={resolution}
              onChange={(e) => {
                const value = e.target.value;
                setResolution(
                  (SUPPORT_CASE_RESOLUTIONS as readonly string[]).includes(value)
                    ? (value as SupportCaseResolution)
                    : '',
                );
                setFormError(null);
              }}
            >
              <option value="">No resolution yet</option>
              {SUPPORT_CASE_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {SUPPORT_CASE_RESOLUTION_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={referenceId}>
              Stripe refund reference {needsReference ? '(required)' : '(web billing only)'}
            </label>
            <input
              id={referenceId}
              type="text"
              value={reference}
              maxLength={SUPPORT_REFERENCE_MAX_LENGTH}
              placeholder="re_… from the Stripe dashboard"
              onChange={(e) => {
                setReference(e.target.value);
                setFormError(null);
              }}
            />
          </div>
          <div>
            <label htmlFor={assigneeId}>Assignee (staff user id)</label>
            <input
              id={assigneeId}
              type="text"
              value={assignee}
              placeholder="Empty = unassigned"
              aria-describedby={assigneeError ? `${assigneeId}-error` : undefined}
              onChange={(e) => {
                setAssignee(e.target.value);
                setAssigneeError(null);
                setFormError(null);
              }}
            />
            <FieldError id={`${assigneeId}-error`} message={assigneeError} />
          </div>
        </div>
        <p style={{ ...smallMutedStyle, margin: '8px 0 0' }}>
          Resolved needs a resolution; a resolution belongs to a resolved or closed case; “Refunded
          by the store” means the store issued it; “Refunded (web billing)” needs the Stripe
          reference. Only changed fields are sent.
        </p>
        <FieldError id={`${headingId}-error`} message={formError} />
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'update' ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
      <AdminFeedback feedback={feedback} rules={SUPPORT_RULE_MESSAGES} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Billing periods and refunds
// ---------------------------------------------------------------------------------------------

function BillingSection({ detail }: { detail: AdminSupportCaseDetailResponse }) {
  const headingId = useId();
  const isRefund = detail.case.kind === 'refund_request';
  const linked = detail.billingPeriods.find((p) => p.linkedToCase) ?? null;
  const stripeInvolved =
    linked?.channel === 'stripe' ||
    (linked === null && isRefund && detail.billingPeriods.some((p) => p.channel === 'stripe'));
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Billing periods and refunds</h2>
      <p className="notice">
        App Store, Google Play and Amazon Appstore refunds are issued by the store, never by
        PencilLift. A web-billing refund is issued in the Stripe dashboard and recorded on the case
        by its reference. Refund amounts below are what the provider reported (webhooks and
        reconciliation), never typed by staff.
      </p>
      {isRefund ? (
        linked ? (
          <p>
            <strong>Refund request for the {channelLabel(linked.channel)} period</strong>{' '}
            <code>{linked.providerPeriodId}</code> ({formatUtcDate(linked.periodStart)} –{' '}
            {formatUtcDate(linked.periodEnd)}, charged {formatUsd(linked.chargedAmountCents)}).{' '}
            {linked.refundedCents > 0 ? (
              <span style={{ color: 'var(--success)', fontWeight: 700 }}>
                The provider reports {formatUsd(linked.refundedCents)} refunded (
                {SETTLEMENT_LABEL[linked.settlement].toLowerCase()}).
              </span>
            ) : (
              <span>
                The provider has not reported a refund on this period yet (settlement{' '}
                {SETTLEMENT_LABEL[linked.settlement].toLowerCase()}).
              </span>
            )}
          </p>
        ) : (
          <p>
            <strong>Refund request without a billing period.</strong> The family did not name a
            charge; ask which period they mean, or pick it from the list below when replying.
          </p>
        )
      ) : null}
      {detail.refundPath ? (
        <p>
          <strong>Refund path:</strong> {detail.refundPath}
        </p>
      ) : null}
      {stripeInvolved && !detail.stripeRefundFromCase ? (
        <p>
          <strong>Stripe:</strong> this build’s Stripe client exposes no refund call, so nothing
          here can refund a web-billing charge. Refund it in the Stripe dashboard, then record the
          refund reference above with the resolution “Refunded (web billing)”.
        </p>
      ) : null}
      {detail.billingPeriods.length === 0 ? (
        <p>This family has no billing periods: no purchase has been recorded.</p>
      ) : (
        <TableScroll label="Billing periods table">
          <table style={tableStyle} aria-label="Billing periods">
            <thead>
              <tr>
                <th style={cellStyle} scope="col">
                  Channel
                </th>
                <th style={cellStyle} scope="col">
                  Provider period
                </th>
                <th style={cellStyle} scope="col">
                  Period (UTC)
                </th>
                <th style={numberCellStyle} scope="col">
                  Slots
                </th>
                <th style={numberCellStyle} scope="col">
                  Charged
                </th>
                <th style={numberCellStyle} scope="col">
                  Refunded (provider)
                </th>
                <th style={cellStyle} scope="col">
                  Settlement
                </th>
                <th style={cellStyle} scope="col">
                  This case
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.billingPeriods.map((p) => (
                <tr key={p.id}>
                  <td style={cellStyle}>{channelLabel(p.channel)}</td>
                  <td style={cellStyle}>
                    <code>{p.providerPeriodId}</code>
                    <br />
                    <span style={smallMutedStyle}>{p.kind.replace(/_/g, ' ')}</span>
                  </td>
                  <td style={cellStyle}>
                    {formatUtcDate(p.periodStart)} – {formatUtcDate(p.periodEnd)}
                  </td>
                  <td style={numberCellStyle}>{p.paidSlots}</td>
                  <td style={numberCellStyle}>
                    {formatUsd(p.chargedAmountCents)}
                    {p.discountCents > 0 ? (
                      <>
                        <br />
                        <span style={smallMutedStyle}>
                          after {formatUsd(p.discountCents)} discount
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td style={numberCellStyle}>{formatUsd(p.refundedCents)}</td>
                  <td style={cellStyle}>
                    {SETTLEMENT_LABEL[p.settlement]}
                    {p.settledAt ? (
                      <>
                        <br />
                        <span style={smallMutedStyle}>{formatUtcDate(p.settledAt)}</span>
                      </>
                    ) : null}
                  </td>
                  <td style={cellStyle}>
                    {p.linkedToCase ? <Pill tone="attention">Named</Pill> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {detail.pendingRefunds.length > 0 ? (
        <>
          <h3>Refunds reported before their charge</h3>
          <TableScroll label="Pending refunds table">
            <table style={tableStyle} aria-label="Pending refunds">
              <thead>
                <tr>
                  <th style={cellStyle} scope="col">
                    Channel
                  </th>
                  <th style={cellStyle} scope="col">
                    Provider period
                  </th>
                  <th style={cellStyle} scope="col">
                    Kind
                  </th>
                  <th style={numberCellStyle} scope="col">
                    Amount
                  </th>
                  <th style={cellStyle} scope="col">
                    Reported
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.pendingRefunds.map((r) => (
                  <tr key={`${r.channel}:${r.providerPeriodId}:${r.createdAt}`}>
                    <td style={cellStyle}>{channelLabel(r.channel)}</td>
                    <td style={cellStyle}>
                      <code>{r.providerPeriodId}</code>
                    </td>
                    <td style={cellStyle}>{r.kind.replace(/_/g, ' ')}</td>
                    <td style={numberCellStyle}>
                      {r.refundedCents === null ? 'not stated' : formatUsd(r.refundedCents)}
                    </td>
                    <td style={cellStyle}>{formatUtc(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      ) : null}
      <p style={smallMutedStyle}>
        Source: public.billing_periods (refunded_cents, settlement) and public.pending_refunds for
        this family; newest first, up to 100 rows.
      </p>
    </section>
  );
}
