import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import {
  adReportSchema,
  approvalSchema,
  campaignSchema,
  catalogItemSchema,
  creativeSchema,
  linkCheckResponseSchema,
  monetizationReportSchema,
  monetizationStatusSchema,
  placementRuleSchema,
  revenueImportResponseSchema,
  revenueImportRowSchema,
  sponsorSchema,
  switchSchema,
  type MonetizationReport,
  type approvalInputSchema,
  type campaignInputSchema,
  type catalogInputSchema,
  type monetizationProviderSchema,
  type resourceSubjectSchema,
} from '@pencillift/contracts';
import type { ApiRequestError } from '@pencillift/contracts/client';
import { formatUsd } from '@pencillift/domain';
import { ErrorState, Loading } from '../../components/states.tsx';
import { useApiQuery, useSession } from '../../lib/session.tsx';
import {
  AdminAccessDenied,
  adminErrorMessage,
  AdminFeedback,
  adminOkResponseSchema,
  AdminPage,
  buttonRow,
  cellStyle,
  ConfirmButton,
  FieldError,
  formatUtc,
  isAccessDenied,
  MONTH_RE,
  monthLabel,
  sectionStyle,
  TableScroll,
  tableStyle,
  useAdminAction,
  useLastGood,
  utcMonthOf,
} from './components/admin-ui.tsx';
import { parseDollarsToCents } from './components/admin-money.ts';

/**
 * Owner console for the P16 monetization module (spec P16.2, P16.5; AC_MON_06/09/10/14/15/16/17/18).
 * Every call needs an owner-admin MFA session (the API enforces it). This page states plainly that
 * monetization is off by default and that live Amazon or ad-network activation stays blocked until
 * real approvals exist. It never labels anything live. Creative text is only ever rendered as
 * plain text, and reports show aggregates with small counts suppressed.
 */
export default function MonetizationAdminPage() {
  return (
    <AdminPage title="Monetization">
      <MonetizationConsole />
    </AdminPage>
  );
}

// ---------------------------------------------------------------------------------------------
// Shapes, labels and helpers
// ---------------------------------------------------------------------------------------------

const BASE = '/v1/admin/monetization';

// List envelopes returned by the admin routes (item shapes come from the shared contracts).
const rulesResponseSchema = z.strictObject({ rules: z.array(placementRuleSchema) });
const approvalsResponseSchema = z.strictObject({ approvals: z.array(approvalSchema) });
const sponsorsResponseSchema = z.strictObject({ sponsors: z.array(sponsorSchema) });
const creativesResponseSchema = z.strictObject({ creatives: z.array(creativeSchema) });
const campaignsResponseSchema = z.strictObject({ campaigns: z.array(campaignSchema) });
const catalogResponseSchema = z.strictObject({ items: z.array(catalogItemSchema) });
const adReportsResponseSchema = z.strictObject({ reports: z.array(adReportSchema) });
const adjustmentResponseSchema = z.strictObject({ id: z.uuid(), replayed: z.boolean() });

type MonetizationStatus = z.infer<typeof monetizationStatusSchema>;
type Switch = z.infer<typeof switchSchema>;
type PlacementRule = z.infer<typeof placementRuleSchema>;
type Approval = z.infer<typeof approvalSchema>;
type ApprovalInput = z.infer<typeof approvalInputSchema>;
type Sponsor = z.infer<typeof sponsorSchema>;
type Creative = z.infer<typeof creativeSchema>;
type Campaign = z.infer<typeof campaignSchema>;
type CampaignInput = z.infer<typeof campaignInputSchema>;
type CatalogItem = z.infer<typeof catalogItemSchema>;
type CatalogInput = z.infer<typeof catalogInputSchema>;
type LinkCheck = z.infer<typeof linkCheckResponseSchema>;
type Provider = z.infer<typeof monetizationProviderSchema>;
type Subject = z.infer<typeof resourceSubjectSchema>;
type Platform = Campaign['platforms'][number];
type Placement = Campaign['placement'];
type CampaignAction =
  'submit' | 'approve' | 'reject' | 'activate' | 'pause' | 'resume' | 'end' | 'revise';

/** Rule codes the API returns, in owner-facing words. */
const RULES: Readonly<Record<string, string>> = {
  EVIDENCE_INVALID:
    'Record a reference to the actual policy evidence (a document, ticket or letter). A checkbox, account key or placeholder is not evidence.',
  FIXTURE_EVIDENCE_NOT_ALLOWED:
    'Fixture evidence is a labeled mock for development and tests only. It never counts in production.',
  TAG_INVALID: 'Enter the publisher-level tag exactly as Amazon issued it (for example name-20).',
  TAG_REQUIRED: 'An approved Amazon property needs its publisher-level tag.',
  SELF_REVIEW_NOT_ALLOWED: 'Another owner admin must review this creative.',
  SPONSOR_SUSPENDED: 'This sponsor is suspended. Reactivate it before approving its creatives.',
  CREATIVE_NOT_APPROVED: 'Approve the campaign’s creative version first.',
  CAMPAIGN_ENDED: 'This campaign’s end date has passed.',
  AFFILIATE_PARAMS_PRESENT:
    'Paste the plain product link without a tag or tracking parameters. PencilLift adds only an approved publisher-level tag.',
  DUPLICATE_IMPORT: 'This file was already imported. Nothing was added.',
  DUPLICATE_ENTRY:
    'A row in this file was already imported (same source, reference and category). Nothing was added.',
  ADJUSTMENT_EXCEEDS_ENTRY: 'An adjustment cannot take an entry below zero.',
};

const SWITCH_LABEL: Record<Switch['key'], string> = {
  global: 'Global (all monetization)',
  'provider:sponsor_direct': 'Sponsor cards (direct sponsors)',
  'provider:amazon_associates': 'Amazon Associates links',
  'provider:ad_network': 'Ad network',
};

const PROVIDER_LABEL: Record<Provider, string> = {
  sponsor_direct: 'Direct sponsor',
  amazon_associates: 'Amazon Associates',
  ad_network: 'Ad network',
};
const PROVIDERS = Object.keys(PROVIDER_LABEL) as Provider[];

const PLATFORM_LABEL: Record<Platform, string> = { ios: 'iOS', android: 'Android', web: 'Web' };
const PLATFORMS = Object.keys(PLATFORM_LABEL) as Platform[];

const PLACEMENT_LABEL: Record<Placement, string> = {
  adult_dashboard: 'Parent dashboard',
  resources_browse: 'Parent resource directory',
};
const PLACEMENTS = Object.keys(PLACEMENT_LABEL) as Placement[];

const GATE_REASON: Readonly<Record<string, string>> = {
  GLOBAL_SWITCH_OFF: 'Global switch is off',
  PROVIDER_SWITCH_OFF: 'Provider switch is off',
  NO_NETWORK_ADAPTER: 'No ad network adapter ships in this build',
  NO_APPROVAL: 'No approval recorded for this property',
  APPROVAL_NOT_APPROVED: 'Approval is not approved',
  APPROVAL_EXPIRED: 'Approval has expired',
  APPROVAL_REVIEW_IN_FUTURE: 'Policy review date is in the future',
  EVIDENCE_INVALID: 'Evidence reference is not usable',
  FIXTURE_EVIDENCE_OUTSIDE_TEST: 'Fixture evidence outside development/test',
  TAG_MISSING: 'Publisher tag missing',
  TAG_INVALID: 'Publisher tag invalid',
  LINKS_NOT_PERMITTED: 'Links not permitted for this locale',
};

const SERVABLE_REASON: Readonly<Record<string, string>> = {
  STATUS: 'Not scheduled or active',
  SPONSOR_SUSPENDED: 'Sponsor suspended',
  CREATIVE_NOT_APPROVED: 'Creative not approved',
  WRONG_PLACEMENT: 'Different placement',
  WRONG_PLATFORM: 'Platform not included',
  NOT_STARTED: 'Not started yet',
  EXPIRED: 'Past its end date',
  CAP_REACHED: 'Impression cap reached',
};

const CAMPAIGN_STATUS_LABEL: Record<Campaign['status'], string> = {
  draft: 'Draft',
  in_review: 'In human review',
  scheduled: 'Approved and scheduled',
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
  rejected: 'Rejected',
};

/** Actions each campaign state allows (mirrors the domain workflow; the API re-checks). */
const CAMPAIGN_ACTIONS: Record<Campaign['status'], readonly CampaignAction[]> = {
  draft: ['submit'],
  in_review: ['approve', 'reject'],
  scheduled: ['activate', 'pause', 'end'],
  active: ['pause', 'end'],
  paused: ['resume', 'end'],
  rejected: ['revise'],
  ended: [],
};

const ACTION_LABEL: Record<CampaignAction, string> = {
  submit: 'Submit for review',
  approve: 'Approve',
  reject: 'Reject',
  activate: 'Activate',
  pause: 'Pause',
  resume: 'Resume',
  end: 'End',
  revise: 'Return to draft',
};

const SUBJECT_LABEL: Record<Subject, string> = {
  math: 'Math',
  reading: 'Reading',
  spelling_vocabulary: 'Spelling and vocabulary',
  grammar_writing: 'Grammar and writing',
  science: 'Science',
  social_studies: 'Social studies',
};
const SUBJECTS = Object.keys(SUBJECT_LABEL) as Subject[];

const KINDS: readonly CatalogItem['kind'][] = [
  'workbook',
  'flashcards',
  'manipulative',
  'parent_exercise',
  'in_app_practice',
];

const EVENT_KIND_LABEL: Record<MonetizationReport['events'][number]['kind'], string> = {
  opportunity: 'Opportunities',
  served: 'Served',
  viewable_impression: 'Viewable impressions',
  click: 'Clicks',
  dismiss: 'Dismissals',
  report: 'Reports',
};
const EVENT_KINDS = Object.keys(EVENT_KIND_LABEL) as (keyof typeof EVENT_KIND_LABEL)[];

const checkboxStyle = { width: 'auto', minHeight: 24 } as const;
const inlineLabel = { fontWeight: 400, display: 'flex', gap: 8, alignItems: 'center' } as const;
const fieldsetStyle = { border: 0, padding: 0, margin: '12px 0 0' } as const;
const textareaStyle = {
  width: '100%',
  maxWidth: 640,
  minHeight: 88,
  fontSize: '1rem',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--muted)',
  fontFamily: 'inherit',
} as const;
const mutedText = { color: 'var(--muted)', margin: '4px 0 0' } as const;

function ruleMessage(error: ApiRequestError): string {
  return adminErrorMessage(error, RULES);
}

/** "2026-10-01T05:00" (a datetime-local value read as UTC) -> ISO instant, or null. */
function utcInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoToUtcInput(iso: string): string {
  return iso.slice(0, 16);
}

/** "-12.50" / "12.50" -> signed integer cents, or null. */
function parseSignedDollars(input: string): number | null {
  const trimmed = input.trim();
  const negative = trimmed.startsWith('-');
  const cents = parseDollarsToCents(negative ? trimmed.slice(1) : trimmed);
  if (cents === null) return null;
  return negative ? -cents : cents;
}

function money(cents: number | null): string {
  return cents === null ? '—' : formatUsd(cents);
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function newIdempotencyKey(): string {
  return `adj:${crypto.randomUUID()}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId} style={{ marginTop: 0 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th scope="col" style={cellStyle}>
      {children}
    </th>
  );
}

function Td({ children }: { children: ReactNode }) {
  return <td style={cellStyle}>{children}</td>;
}

/**
 * A consequential action that records why: the button opens a short form with a required reason
 * and an explicit confirmation (spec P16.5 audit trail).
 */
function ReasonAction({
  label,
  accessibleLabel,
  prompt,
  confirmLabel,
  reasonRequired = true,
  onConfirm,
  disabled,
  secondary,
}: {
  label: string;
  accessibleLabel?: string;
  prompt: ReactNode;
  confirmLabel: string;
  reasonRequired?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
  disabled?: boolean;
  secondary?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className={secondary ? 'btn secondary' : 'btn'}
        aria-label={accessibleLabel}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    if ((reasonRequired || text.length > 0) && text.length < 3) {
      setError(
        reasonRequired
          ? 'Record a reason of at least 3 characters.'
          : 'Leave the reason empty or write at least 3 characters.',
      );
      return;
    }
    setError(null);
    setWorking(true);
    void onConfirm(text).finally(() => {
      setWorking(false);
      setOpen(false);
      setReason('');
    });
  };
  return (
    <form
      className="notice"
      aria-label={accessibleLabel ?? label}
      onSubmit={submit}
      style={{ margin: '8px 0' }}
    >
      <p id={`${id}-prompt`} style={{ margin: 0 }}>
        {prompt}
      </p>
      <label htmlFor={`${id}-reason`}>{reasonRequired ? 'Reason' : 'Reason (optional)'}</label>
      <input
        id={`${id}-reason`}
        value={reason}
        maxLength={200}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      <FieldError id={`${id}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={working || disabled}>
          {working ? 'Working…' : confirmLabel}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={working}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------------------------

function MonetizationConsole() {
  const [statusVersion, setStatusVersion] = useState(0);
  const status = useApiQuery(
    (api) => api.get(`${BASE}/status`, monetizationStatusSchema),
    [statusVersion],
  );
  const sponsorsQuery = useApiQuery(
    (api) => api.get(`${BASE}/sponsors`, sponsorsResponseSchema),
    [],
  );
  const last = useLastGood(status);
  const sponsors = useLastGood(sponsorsQuery)?.sponsors ?? [];
  const refreshStatus = () => setStatusVersion((v) => v + 1);

  if (status.status === 'error' && isAccessDenied(status.error)) return <AdminAccessDenied />;
  if (last === null) {
    return status.status === 'error' ? (
      <ErrorState message={ruleMessage(status.error)} onRetry={status.reload} />
    ) : (
      <Loading label="Loading monetization status…" />
    );
  }

  return (
    <>
      <div className="notice" role="note" aria-label="Monetization is off by default">
        <p style={{ margin: 0 }}>
          <strong>Monetization is OFF by default.</strong> Every switch starts off. Nothing is shown
          to parents unless the global switch, the provider switch, an enabled placement rule and a
          recorded, unexpired approval for that exact platform and property all agree.
        </p>
        <p style={{ margin: '8px 0 0' }}>
          <strong>
            Live Amazon Associates links and any ad network stay blocked until real approvals exist.
          </strong>{' '}
          A checkbox, account key or test fixture is not an approval. This build ships no ad network
          adapter, so ad networks are always blocked. This console never marks anything as live or
          revenue-generating.
        </p>
      </div>
      {status.status === 'error' ? (
        <ErrorState message={ruleMessage(status.error)} onRetry={status.reload} />
      ) : null}
      <StatusSection status={last} onChanged={refreshStatus} />
      <PlacementRulesSection />
      <ApprovalsSection onChanged={refreshStatus} />
      <SponsorsSection
        sponsors={sponsors}
        error={sponsorsQuery.status === 'error' ? sponsorsQuery.error : null}
        onChanged={sponsorsQuery.reload}
      />
      <CampaignsSection sponsors={sponsors} />
      <CatalogSection />
      <AdReportsSection />
      <RevenueSection />
      <ReportSection />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Status and kill switches
// ---------------------------------------------------------------------------------------------

function providerState(p: MonetizationStatus['providers'][number]): string {
  if (!p.enabled) return 'Blocked';
  if (p.fixture) return 'Gates pass with a labeled test fixture (mock). Not live.';
  return 'Gates pass (verify the evidence yourself). Not a claim of live revenue.';
}

function StatusSection({
  status,
  onChanged,
}: {
  status: MonetizationStatus;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const { feedback, run } = useAdminAction();
  const change = (s: Switch, reason: string) =>
    run(`switch:${s.key}`, async () => {
      const updated = await api.send(
        'PUT',
        `${BASE}/switches/${encodeURIComponent(s.key)}`,
        { enabled: !s.enabled, reason },
        switchSchema,
      );
      onChanged();
      return `${SWITCH_LABEL[updated.key]} is now ${updated.enabled ? 'on' : 'off'}.`;
    });
  return (
    <Section title="Kill switches and provider status">
      <p style={{ marginTop: 0 }}>Environment: {status.environment}</p>
      <AdminFeedback feedback={feedback} rules={RULES} />
      <TableScroll label="Switches">
        <table style={tableStyle}>
          <caption style={{ textAlign: 'left', fontWeight: 700 }}>Switches</caption>
          <thead>
            <tr>
              <Th>Switch</Th>
              <Th>State</Th>
              <Th>Last change</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {status.switches.map((s) => (
              <tr key={s.key}>
                <Td>{SWITCH_LABEL[s.key]}</Td>
                <Td>
                  <strong>{s.enabled ? 'On' : 'Off'}</strong>
                </Td>
                <Td>
                  {formatUtc(s.changedAt)}
                  {s.reason ? ` · ${s.reason}` : ''}
                </Td>
                <Td>
                  <ReasonAction
                    label={s.enabled ? 'Turn off' : 'Turn on'}
                    accessibleLabel={`${s.enabled ? 'Turn off' : 'Turn on'} ${SWITCH_LABEL[s.key]}`}
                    secondary={!s.enabled}
                    prompt={
                      s.enabled
                        ? `Turn off ${SWITCH_LABEL[s.key]}? Its placements and links stop at once. Homework, practice and rewards are unaffected.`
                        : `Turn on ${SWITCH_LABEL[s.key]}? This alone activates nothing: approvals, placement rules and campaign reviews still apply.${s.key === 'provider:ad_network' ? ' Ad networks stay blocked because no adapter ships.' : ''}`
                    }
                    confirmLabel={s.enabled ? 'Turn off' : 'Turn on'}
                    onConfirm={(reason) => change(s, reason)}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <TableScroll label="Provider status">
        <table style={{ ...tableStyle, marginTop: 16 }}>
          <caption style={{ textAlign: 'left', fontWeight: 700 }}>
            Provider status by platform
          </caption>
          <thead>
            <tr>
              <Th>Provider</Th>
              <Th>Platform</Th>
              <Th>Property</Th>
              <Th>State</Th>
              <Th>Why</Th>
            </tr>
          </thead>
          <tbody>
            {status.providers.map((p) => (
              <tr key={`${p.provider}:${p.platform}`}>
                <Td>{PROVIDER_LABEL[p.provider]}</Td>
                <Td>{PLATFORM_LABEL[p.platform]}</Td>
                <Td>{p.propertyIdentifier}</Td>
                <Td>{providerState(p)}</Td>
                <Td>
                  {p.reasons.length === 0
                    ? '—'
                    : p.reasons.map((r) => GATE_REASON[r] ?? r).join('; ')}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Placement rules
// ---------------------------------------------------------------------------------------------

function PlacementRulesSection() {
  const query = useApiQuery((api) => api.get(`${BASE}/placement-rules`, rulesResponseSchema), []);
  const rules = useLastGood(query)?.rules ?? null;
  return (
    <Section title="Placement rules">
      <p style={{ marginTop: 0 }}>
        One card per screen, always. A rule can lower the per-session limit (at most 3 new cards per
        parent session) or raise the viewability bar, never loosen them.
      </p>
      {query.status === 'loading' && rules === null ? <Loading label="Loading rules…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={ruleMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {(rules ?? []).map((rule) => (
        <RuleForm key={rule.placement} rule={rule} onSaved={query.reload} />
      ))}
    </Section>
  );
}

function RuleForm({ rule, onSaved }: { rule: PlacementRule; onSaved: () => void }) {
  const { api } = useSession();
  const id = useId();
  const { busy, feedback, run } = useAdminAction();
  const [enabled, setEnabled] = useState(rule.enabled);
  const [perSession, setPerSession] = useState(String(rule.maxNewCardsPerSession));
  const [visibleMs, setVisibleMs] = useState(String(rule.minVisibleMs));
  const [ratio, setRatio] = useState(String(rule.minVisibleRatio));
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cards = Number(perSession);
    const ms = Number(visibleMs);
    const share = Number(ratio);
    if (!Number.isInteger(cards) || cards < 0 || cards > 3) {
      setError('New cards per session must be a whole number from 0 to 3.');
      return;
    }
    if (!Number.isInteger(ms) || ms < 1000 || ms > 60000) {
      setError('Minimum visible time must be 1000 to 60000 ms.');
      return;
    }
    if (!Number.isFinite(share) || share < 0.5 || share > 1) {
      setError('Minimum visible share must be between 0.5 and 1.');
      return;
    }
    setError(null);
    void run(`rule:${rule.placement}`, async () => {
      await api.send(
        'PUT',
        `${BASE}/placement-rules/${rule.placement}`,
        {
          maxCardsPerScreen: 1,
          maxNewCardsPerSession: cards,
          minVisibleMs: ms,
          minVisibleRatio: share,
          enabled,
        },
        placementRuleSchema,
      );
      onSaved();
      return `${PLACEMENT_LABEL[rule.placement]} rule saved.`;
    });
  };

  return (
    <form
      aria-label={`${PLACEMENT_LABEL[rule.placement]} rule`}
      onSubmit={submit}
      style={{ marginTop: 12 }}
    >
      <h3 style={{ margin: '8px 0 0' }}>{PLACEMENT_LABEL[rule.placement]}</h3>
      <p style={mutedText}>Cards per screen: 1 (fixed)</p>
      <label style={inlineLabel}>
        <input
          type="checkbox"
          style={checkboxStyle}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Placement enabled
      </label>
      <label htmlFor={`${id}-cards`}>New cards per parent session (0–3)</label>
      <input
        id={`${id}-cards`}
        inputMode="numeric"
        value={perSession}
        onChange={(e) => setPerSession(e.target.value)}
      />
      <label htmlFor={`${id}-ms`}>Minimum visible time (ms)</label>
      <input
        id={`${id}-ms`}
        inputMode="numeric"
        value={visibleMs}
        onChange={(e) => setVisibleMs(e.target.value)}
      />
      <label htmlFor={`${id}-ratio`}>Minimum visible share (0.5–1)</label>
      <input
        id={`${id}-ratio`}
        inputMode="decimal"
        value={ratio}
        onChange={(e) => setRatio(e.target.value)}
      />
      <FieldError id={`${id}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn secondary" disabled={busy !== null}>
          Save rule
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Approvals (policy evidence)
// ---------------------------------------------------------------------------------------------

const EVIDENCE_LABEL: Record<Approval['evidenceQuality'], string> = {
  real: 'Reference recorded (verify the evidence itself)',
  fixture: 'Fixture: labeled test mock, never counts in production',
  invalid: 'Not usable as evidence',
};

const APPROVAL_STATUS_LABEL: Record<Approval['status'], string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  revoked: 'Revoked',
  expired: 'Expired',
};

function ApprovalsSection({ onChanged }: { onChanged: () => void }) {
  const { api } = useSession();
  const query = useApiQuery((api) => api.get(`${BASE}/approvals`, approvalsResponseSchema), []);
  const approvals = useLastGood(query)?.approvals ?? null;
  const { feedback, run } = useAdminAction();
  const changed = () => {
    query.reload();
    onChanged();
  };
  const act = (a: Approval, action: 'approve' | 'reject' | 'revoke', reason: string) =>
    run(`approval:${a.id}:${action}`, async () => {
      const updated = await api.send(
        'POST',
        `${BASE}/approvals/${a.id}/${action}`,
        { reason },
        approvalSchema,
      );
      changed();
      return `${PROVIDER_LABEL[updated.provider]} ${PLATFORM_LABEL[updated.platform]} approval is now ${APPROVAL_STATUS_LABEL[updated.status].toLowerCase()}.`;
    });

  return (
    <Section title="Provider and platform approvals">
      <p style={{ marginTop: 0 }}>
        Record the actual policy evidence for each platform, property and locale: who reviewed what,
        when, and where the evidence is kept. Expired, revoked or missing approvals remove
        monetization at once and never interrupt homework.
      </p>
      <AdminFeedback feedback={feedback} rules={RULES} />
      {query.status === 'loading' && approvals === null ? (
        <Loading label="Loading approvals…" />
      ) : null}
      {query.status === 'error' ? (
        <ErrorState message={ruleMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {approvals && approvals.length === 0 ? (
        <p>No approvals recorded. Every provider stays blocked.</p>
      ) : null}
      {approvals && approvals.length > 0 ? (
        <TableScroll label="Approvals">
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Provider</Th>
                <Th>Platform</Th>
                <Th>Property</Th>
                <Th>Evidence</Th>
                <Th>Expiry</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={a.id}>
                  <Td>
                    {PROVIDER_LABEL[a.provider]}
                    {a.publisherTag ? ` · tag ${a.publisherTag}` : ''}
                  </Td>
                  <Td>
                    {PLATFORM_LABEL[a.platform]} · {a.locale}
                  </Td>
                  <Td>
                    {a.propertyIdentifier}
                    <div style={mutedText}>Audience: {a.intendedAudience}</div>
                  </Td>
                  <Td>
                    {a.evidenceRef}
                    <div style={mutedText}>{EVIDENCE_LABEL[a.evidenceQuality]}</div>
                    <div style={mutedText}>Reviewed {formatUtc(a.policyReviewedAt)}</div>
                  </Td>
                  <Td>{formatUtc(a.expiresAt)}</Td>
                  <Td>
                    <strong>{APPROVAL_STATUS_LABEL[a.status]}</strong>
                    {a.statusReason ? <div style={mutedText}>{a.statusReason}</div> : null}
                  </Td>
                  <Td>
                    <div style={buttonRow}>
                      {a.status === 'pending' ? (
                        <>
                          <ReasonAction
                            label="Approve"
                            accessibleLabel={`Approve ${PROVIDER_LABEL[a.provider]} ${PLATFORM_LABEL[a.platform]} approval`}
                            prompt="Approve only with real policy evidence for this exact property. Approval never overrides the switches."
                            confirmLabel="Approve"
                            onConfirm={(reason) => act(a, 'approve', reason)}
                          />
                          <ReasonAction
                            label="Reject"
                            accessibleLabel={`Reject ${PROVIDER_LABEL[a.provider]} ${PLATFORM_LABEL[a.platform]} approval`}
                            secondary
                            prompt="Reject this approval record?"
                            confirmLabel="Reject"
                            onConfirm={(reason) => act(a, 'reject', reason)}
                          />
                        </>
                      ) : null}
                      {a.status === 'pending' || a.status === 'approved' ? (
                        <ReasonAction
                          label="Revoke"
                          accessibleLabel={`Revoke ${PROVIDER_LABEL[a.provider]} ${PLATFORM_LABEL[a.platform]} approval`}
                          secondary
                          prompt="Revoke this approval? Placements and links that depend on it stop at once."
                          confirmLabel="Revoke"
                          onConfirm={(reason) => act(a, 'revoke', reason)}
                        />
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
      <ApprovalForm onCreated={changed} />
    </Section>
  );
}

function ApprovalForm({ onCreated }: { onCreated: () => void }) {
  const { api } = useSession();
  const id = useId();
  const { busy, feedback, run } = useAdminAction();
  const [provider, setProvider] = useState<Provider>('sponsor_direct');
  const [platform, setPlatform] = useState<Platform>('web');
  const [property, setProperty] = useState('');
  const [locale, setLocale] = useState('en-US');
  const [audience, setAudience] = useState('');
  const [sdk, setSdk] = useState('');
  const [reviewedAt, setReviewedAt] = useState('');
  const [evidence, setEvidence] = useState('');
  const [scope, setScope] = useState('');
  const [tag, setTag] = useState('');
  const [status, setStatus] = useState<ApprovalInput['status']>('pending');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const reviewed = utcInputToIso(reviewedAt);
    const expires = utcInputToIso(expiresAt);
    if (property.trim().length < 3) return setError('Enter the property identifier.');
    if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale)) return setError('Enter a locale like en-US.');
    if (audience.trim().length < 3) return setError('Describe the intended audience.');
    if (!reviewed) return setError('Enter the policy review date and time (UTC).');
    if (evidence.trim().length < 6) {
      return setError('Enter a reference to the actual evidence (at least 6 characters).');
    }
    if (scope.trim().length < 3) return setError('Describe the approval scope.');
    if (!expires) return setError('Enter the expiry or revalidation date and time (UTC).');
    setError(null);
    const body: ApprovalInput = {
      provider,
      platform,
      propertyIdentifier: property.trim(),
      locale,
      intendedAudience: audience.trim(),
      vendorSdkVersion: sdk.trim() ? sdk.trim() : null,
      policyReviewedAt: reviewed,
      evidenceRef: evidence.trim(),
      approvalScope: scope.trim(),
      publisherTag: provider === 'amazon_associates' && tag.trim() ? tag.trim() : null,
      status,
      expiresAt: expires,
    };
    void run('approval:create', async () => {
      const created = await api.send('POST', `${BASE}/approvals`, body, approvalSchema);
      onCreated();
      setEvidence('');
      return `Recorded a ${APPROVAL_STATUS_LABEL[created.status].toLowerCase()} ${PROVIDER_LABEL[created.provider]} approval for ${PLATFORM_LABEL[created.platform]}. Evidence: ${EVIDENCE_LABEL[created.evidenceQuality]}.`;
    });
  };

  return (
    <form aria-label="Record an approval" onSubmit={submit} style={{ marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Record an approval</h3>
      <label htmlFor={`${id}-provider`}>Provider</label>
      <select
        id={`${id}-provider`}
        value={provider}
        onChange={(e) => setProvider(e.target.value as Provider)}
      >
        {PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_LABEL[p]}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-platform`}>Platform</label>
      <select
        id={`${id}-platform`}
        value={platform}
        onChange={(e) => setPlatform(e.target.value as Platform)}
      >
        {PLATFORMS.map((p) => (
          <option key={p} value={p}>
            {PLATFORM_LABEL[p]}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-property`}>Property identifier (bundle id or site origin)</label>
      <input id={`${id}-property`} value={property} onChange={(e) => setProperty(e.target.value)} />
      <label htmlFor={`${id}-locale`}>Locale</label>
      <input id={`${id}-locale`} value={locale} onChange={(e) => setLocale(e.target.value)} />
      <label htmlFor={`${id}-audience`}>Intended audience</label>
      <input id={`${id}-audience`} value={audience} onChange={(e) => setAudience(e.target.value)} />
      <label htmlFor={`${id}-sdk`}>Vendor SDK and version (if any)</label>
      <input id={`${id}-sdk`} value={sdk} onChange={(e) => setSdk(e.target.value)} />
      <label htmlFor={`${id}-reviewed`}>Policy review date (UTC)</label>
      <input
        id={`${id}-reviewed`}
        type="datetime-local"
        value={reviewedAt}
        onChange={(e) => setReviewedAt(e.target.value)}
      />
      <label htmlFor={`${id}-evidence`}>Evidence reference</label>
      <input
        id={`${id}-evidence`}
        value={evidence}
        aria-describedby={`${id}-evidence-hint`}
        onChange={(e) => setEvidence(e.target.value)}
      />
      <p id={`${id}-evidence-hint`} style={mutedText}>
        Where the actual policy evidence is kept (document, ticket or letter reference). Never paste
        an account key or secret; a “yes” or checkbox is not evidence.
      </p>
      <label htmlFor={`${id}-scope`}>Approval scope</label>
      <input id={`${id}-scope`} value={scope} onChange={(e) => setScope(e.target.value)} />
      {provider === 'amazon_associates' ? (
        <>
          <label htmlFor={`${id}-tag`}>Publisher-level tag (as issued)</label>
          <input id={`${id}-tag`} value={tag} onChange={(e) => setTag(e.target.value)} />
        </>
      ) : null}
      <label htmlFor={`${id}-status`}>Status</label>
      <select
        id={`${id}-status`}
        value={status}
        onChange={(e) => setStatus(e.target.value as ApprovalInput['status'])}
      >
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
      </select>
      <label htmlFor={`${id}-expires`}>Expiry or revalidation date (UTC)</label>
      <input
        id={`${id}-expires`}
        type="datetime-local"
        value={expiresAt}
        onChange={(e) => setExpiresAt(e.target.value)}
      />
      <FieldError id={`${id}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          Record approval
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Sponsors and creatives
// ---------------------------------------------------------------------------------------------

function SponsorsSection({
  sponsors,
  error,
  onChanged,
}: {
  sponsors: readonly Sponsor[];
  error: ApiRequestError | null;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const { feedback, run } = useAdminAction();
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = sponsors.find((s) => s.id === selected) ?? null;
  const setStatus = (s: Sponsor, status: Sponsor['status']) =>
    run(`sponsor:${s.id}`, async () => {
      const updated = await api.send(
        'PATCH',
        `${BASE}/sponsors/${s.id}`,
        { status },
        sponsorSchema,
      );
      onChanged();
      return `${updated.businessName} is now ${updated.status}.`;
    });

  return (
    <Section title="Sponsors and creatives">
      <p style={{ marginTop: 0 }}>
        Sponsors are education-relevant businesses contracted by the owner. There is no advertiser
        self-service. Creative text is shown here as plain text exactly as parents would read it.
      </p>
      <AdminFeedback feedback={feedback} rules={RULES} />
      {error ? <ErrorState message={ruleMessage(error)} onRetry={onChanged} /> : null}
      {sponsors.length === 0 ? <p>No sponsors yet.</p> : null}
      {sponsors.length > 0 ? (
        <TableScroll label="Sponsors">
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Business</Th>
                <Th>Allowed domains</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {sponsors.map((s) => (
                <tr key={s.id}>
                  <Td>
                    {s.businessName}
                    {s.contactRef ? <div style={mutedText}>Contact: {s.contactRef}</div> : null}
                  </Td>
                  <Td>{s.allowedDomains.join(', ')}</Td>
                  <Td>{s.status === 'active' ? 'Active' : 'Suspended'}</Td>
                  <Td>
                    <div style={buttonRow}>
                      <button
                        type="button"
                        className="btn secondary"
                        aria-pressed={selected === s.id}
                        onClick={() => setSelected(selected === s.id ? null : s.id)}
                      >
                        {selected === s.id ? 'Hide creatives' : 'Creatives'}
                      </button>
                      {s.status === 'active' ? (
                        <ConfirmButton
                          label="Suspend"
                          accessibleLabel={`Suspend ${s.businessName}`}
                          secondary
                          prompt={`Suspend ${s.businessName}? Its campaigns stop serving at once.`}
                          confirmLabel="Suspend"
                          onConfirm={() => setStatus(s, 'suspended')}
                        />
                      ) : (
                        <ConfirmButton
                          label="Reactivate"
                          accessibleLabel={`Reactivate ${s.businessName}`}
                          secondary
                          prompt={`Reactivate ${s.businessName}? Campaigns still need approved creatives and passing gates.`}
                          confirmLabel="Reactivate"
                          onConfirm={() => setStatus(s, 'active')}
                        />
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
      {chosen ? <CreativesPanel sponsor={chosen} /> : null}
      <SponsorForm onCreated={onChanged} />
    </Section>
  );
}

function SponsorForm({ onCreated }: { onCreated: () => void }) {
  const { api } = useSession();
  const id = useId();
  const { busy, feedback, run } = useAdminAction();
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [domains, setDomains] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const list = splitList(domains.toLowerCase());
    if (name.trim().length < 2) return setError('Enter the business name.');
    if (list.length === 0) return setError('Add at least one allowed destination domain.');
    setError(null);
    void run('sponsor:create', async () => {
      const created = await api.send(
        'POST',
        `${BASE}/sponsors`,
        {
          businessName: name.trim(),
          contactRef: contact.trim() ? contact.trim() : null,
          allowedDomains: list,
        },
        sponsorSchema,
      );
      setName('');
      setContact('');
      setDomains('');
      onCreated();
      return `Added sponsor ${created.businessName}.`;
    });
  };
  return (
    <form aria-label="Add a sponsor" onSubmit={submit} style={{ marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Add a sponsor</h3>
      <label htmlFor={`${id}-name`}>Business name</label>
      <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor={`${id}-contact`}>Contract or contact reference (optional)</label>
      <input id={`${id}-contact`} value={contact} onChange={(e) => setContact(e.target.value)} />
      <label htmlFor={`${id}-domains`}>Allowed destination domains (comma separated)</label>
      <input id={`${id}-domains`} value={domains} onChange={(e) => setDomains(e.target.value)} />
      <FieldError id={`${id}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          Add sponsor
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

const CREATIVE_STATUS_LABEL: Record<Creative['reviewStatus'], string> = {
  draft: 'Draft',
  in_review: 'In human review',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Plain-text preview of a creative as the parent card would show it. Never rendered as HTML. */
function CreativePreview({ creative, sponsor }: { creative: Creative; sponsor: Sponsor }) {
  return (
    <div
      className="card sponsored"
      role="group"
      aria-label={`Preview of version ${creative.version}`}
      style={{ overflowWrap: 'anywhere', marginTop: 8 }}
    >
      <p style={{ margin: 0, fontWeight: 800 }}>Sponsored by {sponsor.businessName}</p>
      <p style={{ margin: '4px 0', color: 'var(--muted)' }}>(why-shown text for the placement)</p>
      <p style={{ margin: '4px 0', fontWeight: 700 }}>{creative.headline}</p>
      <p style={{ margin: '4px 0' }}>{creative.body}</p>
      <p style={{ margin: '4px 0' }}>Button: {creative.ctaLabel}</p>
      <p style={{ margin: '4px 0' }}>Destination: {creative.destinationUrl}</p>
      <p style={{ margin: '4px 0' }}>
        Image:{' '}
        {creative.imageAssetRef
          ? `${creative.imageAssetRef} (licence ${creative.imageLicenseRef ?? 'not recorded'})`
          : 'none'}
      </p>
    </div>
  );
}

function CreativesPanel({ sponsor }: { sponsor: Sponsor }) {
  const { api } = useSession();
  const query = useApiQuery(
    (api) => api.get(`${BASE}/sponsors/${sponsor.id}/creatives`, creativesResponseSchema),
    [sponsor.id],
  );
  const creatives = useLastGood(query)?.creatives ?? null;
  const { feedback, run } = useAdminAction();
  const review = (c: Creative, action: 'submit' | 'approve' | 'reject', note: string) =>
    run(`creative:${c.id}:${action}`, async () => {
      const updated = await api.send(
        'POST',
        `${BASE}/creatives/${c.id}/${action}`,
        action === 'submit' ? undefined : note ? { note } : {},
        creativeSchema,
      );
      query.reload();
      return `Version ${updated.version} is now ${CREATIVE_STATUS_LABEL[updated.reviewStatus].toLowerCase()}${updated.selfReviewed ? ' (self-reviewed by the sole owner admin; recorded in the audit trail)' : ''}.`;
    });

  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Creatives for {sponsor.businessName}</h3>
      <p style={mutedText}>
        Creative versions are immutable. Editing creates a new version that needs its own human
        review; a campaign that switches to it goes back to review.
      </p>
      <AdminFeedback feedback={feedback} rules={RULES} />
      {query.status === 'loading' && creatives === null ? (
        <Loading label="Loading creatives…" />
      ) : null}
      {query.status === 'error' ? (
        <ErrorState message={ruleMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {creatives && creatives.length === 0 ? <p>No creatives yet.</p> : null}
      {(creatives ?? []).map((c) => (
        <div key={c.id} style={{ marginTop: 12 }}>
          <p style={{ margin: 0 }}>
            <strong>Version {c.version}</strong> · {CREATIVE_STATUS_LABEL[c.reviewStatus]}
            {c.reviewedAt ? ` · reviewed ${formatUtc(c.reviewedAt)}` : ''}
            {c.selfReviewed ? ' · self-reviewed (sole owner admin)' : ''}
          </p>
          <CreativePreview creative={c} sponsor={sponsor} />
          <div style={buttonRow}>
            {c.reviewStatus === 'draft' ? (
              <ConfirmButton
                label="Submit for review"
                accessibleLabel={`Submit version ${c.version} for review`}
                prompt="Submit this version for human review?"
                confirmLabel="Submit"
                onConfirm={() => review(c, 'submit', '')}
              />
            ) : null}
            {c.reviewStatus === 'in_review' ? (
              <>
                <ReasonAction
                  label="Approve"
                  accessibleLabel={`Approve version ${c.version}`}
                  reasonRequired={false}
                  prompt="Approve this exact text, destination and licensed image for parents to see?"
                  confirmLabel="Approve"
                  onConfirm={(note) => review(c, 'approve', note)}
                />
                <ReasonAction
                  label="Reject"
                  accessibleLabel={`Reject version ${c.version}`}
                  reasonRequired={false}
                  secondary
                  prompt="Reject this version?"
                  confirmLabel="Reject"
                  onConfirm={(note) => review(c, 'reject', note)}
                />
              </>
            ) : null}
          </div>
        </div>
      ))}
      <CreativeForm sponsor={sponsor} onCreated={query.reload} />
    </div>
  );
}

function CreativeForm({ sponsor, onCreated }: { sponsor: Sponsor; onCreated: () => void }) {
  const { api } = useSession();
  const id = useId();
  const { busy, feedback, run } = useAdminAction();
  const [headline, setHeadline] = useState('');
  const [body, setBody] = useState('');
  const [cta, setCta] = useState('');
  const [destination, setDestination] = useState('');
  const [asset, setAsset] = useState('');
  const [license, setLicense] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run('creative:create', async () => {
      const created = await api.send(
        'POST',
        `${BASE}/sponsors/${sponsor.id}/creatives`,
        {
          headline,
          body,
          ctaLabel: cta,
          destinationUrl: destination.trim(),
          imageAssetRef: asset.trim() ? asset.trim() : null,
          imageLicenseRef: license.trim() ? license.trim() : null,
        },
        creativeSchema,
      );
      onCreated();
      return `Saved version ${created.version} as a draft. Submit it for review before any campaign can use it.`;
    });
  };
  return (
    <form
      aria-label={`New creative version for ${sponsor.businessName}`}
      onSubmit={submit}
      style={{ marginTop: 16 }}
    >
      <h4 style={{ margin: 0 }}>New creative version</h4>
      <p style={mutedText}>
        Plain text only: no HTML, scripts, pixels or remote images. The destination must use https
        on one of the sponsor’s allowed domains ({sponsor.allowedDomains.join(', ')}).
      </p>
      <label htmlFor={`${id}-headline`}>Headline</label>
      <input id={`${id}-headline`} value={headline} onChange={(e) => setHeadline(e.target.value)} />
      <label htmlFor={`${id}-body`}>Body</label>
      <textarea
        id={`${id}-body`}
        style={textareaStyle}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <label htmlFor={`${id}-cta`}>Button label</label>
      <input id={`${id}-cta`} value={cta} onChange={(e) => setCta(e.target.value)} />
      <label htmlFor={`${id}-destination`}>Destination URL</label>
      <input
        id={`${id}-destination`}
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
      />
      <label htmlFor={`${id}-asset`}>Licensed image asset key (optional, first-party)</label>
      <input id={`${id}-asset`} value={asset} onChange={(e) => setAsset(e.target.value)} />
      <label htmlFor={`${id}-license`}>Image licence reference (optional)</label>
      <input id={`${id}-license`} value={license} onChange={(e) => setLicense(e.target.value)} />
      <div style={buttonRow}>
        <button type="submit" className="btn secondary" disabled={busy !== null}>
          Save as new version
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------------------------

function CampaignsSection({ sponsors }: { sponsors: readonly Sponsor[] }) {
  const { api } = useSession();
  const query = useApiQuery((api) => api.get(`${BASE}/campaigns`, campaignsResponseSchema), []);
  const campaigns = useLastGood(query)?.campaigns ?? null;
  const { feedback, run } = useAdminAction();
  const sponsorNames = useMemo(
    () => new Map(sponsors.map((s) => [s.id, s.businessName])),
    [sponsors],
  );
  const transition = (c: Campaign, action: CampaignAction, reason: string) =>
    run(`campaign:${c.id}:${action}`, async () => {
      const updated = await api.send(
        'POST',
        `${BASE}/campaigns/${c.id}/transition`,
        reason ? { action, reason } : { action },
        campaignSchema,
      );
      query.reload();
      return `${updated.name} is now ${CAMPAIGN_STATUS_LABEL[updated.status].toLowerCase()}.`;
    });

  return (
    <Section title="Campaigns">
      <p style={{ marginTop: 0 }}>
        Workflow: draft → human review → approved and scheduled → active → paused, ended or
        rejected. Campaign approval never overrides a provider or platform gate.
      </p>
      <AdminFeedback feedback={feedback} rules={RULES} />
      {query.status === 'loading' && campaigns === null ? (
        <Loading label="Loading campaigns…" />
      ) : null}
      {query.status === 'error' ? (
        <ErrorState message={ruleMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {campaigns && campaigns.length === 0 ? <p>No campaigns yet.</p> : null}
      {campaigns && campaigns.length > 0 ? (
        <TableScroll label="Campaigns">
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>Where</Th>
                <Th>Dates (UTC)</Th>
                <Th>Cap</Th>
                <Th>Fee and invoice</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <Td>
                    {c.name}
                    <div style={mutedText}>
                      {sponsorNames.get(c.sponsorId) ?? 'Unknown sponsor'}
                    </div>
                  </Td>
                  <Td>
                    {PLACEMENT_LABEL[c.placement]}
                    <div style={mutedText}>
                      {c.platforms.map((p) => PLATFORM_LABEL[p]).join(', ')}
                    </div>
                  </Td>
                  <Td>
                    {formatUtc(c.startsAt)} to {formatUtc(c.endsAt)}
                  </Td>
                  <Td>
                    {c.viewableImpressions.toLocaleString('en-US')} of{' '}
                    {c.impressionCap.toLocaleString('en-US')} viewable impressions
                  </Td>
                  <Td>
                    {c.feeModel === 'fixed_fee'
                      ? `Fixed fee ${formatUsd(c.contractedFeeCents)}`
                      : 'No fee'}
                    <div style={mutedText}>Invoice: {c.invoiceStatus.replace('_', ' ')}</div>
                  </Td>
                  <Td>
                    <strong>{CAMPAIGN_STATUS_LABEL[c.status]}</strong>
                    {c.pausedReason ? <div style={mutedText}>Paused: {c.pausedReason}</div> : null}
                    <div style={mutedText}>
                      {c.servableNow
                        ? 'Campaign rules allow serving now (provider gates still apply)'
                        : `Not servable: ${SERVABLE_REASON[c.notServableReason ?? ''] ?? c.notServableReason ?? 'unknown'}`}
                    </div>
                  </Td>
                  <Td>
                    <div style={buttonRow}>
                      {CAMPAIGN_ACTIONS[c.status].map((action) =>
                        action === 'pause' || action === 'reject' ? (
                          <ReasonAction
                            key={action}
                            label={ACTION_LABEL[action]}
                            accessibleLabel={`${ACTION_LABEL[action]} ${c.name}`}
                            reasonRequired={action === 'pause'}
                            secondary
                            prompt={`${ACTION_LABEL[action]} ${c.name}?`}
                            confirmLabel={ACTION_LABEL[action]}
                            onConfirm={(reason) => transition(c, action, reason)}
                          />
                        ) : (
                          <ConfirmButton
                            key={action}
                            label={ACTION_LABEL[action]}
                            accessibleLabel={`${ACTION_LABEL[action]} ${c.name}`}
                            secondary={action === 'end'}
                            prompt={`${ACTION_LABEL[action]} ${c.name}?`}
                            confirmLabel={ACTION_LABEL[action]}
                            onConfirm={() => transition(c, action, '')}
                          />
                        ),
                      )}
                    </div>
                    {c.status !== 'ended' ? (
                      <CampaignEditForm campaign={c} onSaved={query.reload} />
                    ) : (
                      <CampaignInvoiceForm campaign={c} onSaved={query.reload} />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
      <CampaignForm sponsors={sponsors} onCreated={query.reload} />
    </Section>
  );
}

const INVOICE_STATUSES: readonly Campaign['invoiceStatus'][] = [
  'not_invoiced',
  'invoiced',
  'paid',
  'void',
];

function CampaignInvoiceForm({ campaign, onSaved }: { campaign: Campaign; onSaved: () => void }) {
  const { api } = useSession();
  const id = useId();
  const { busy, feedback, run } = useAdminAction();
  const [invoice, setInvoice] = useState(campaign.invoiceStatus);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run('invoice', async () => {
      await api.send(
        'PATCH',
        `${BASE}/campaigns/${campaign.id}`,
        { invoiceStatus: invoice },
        campaignSchema,
      );
      onSaved();
      return 'Invoice status saved.';
    });
  };
  return (
    <form aria-label={`Invoice status for ${campaign.name}`} onSubmit={submit}>
      <label htmlFor={`${id}-invoice`}>Invoice status</label>
      <select
        id={`${id}-invoice`}
        value={invoice}
        onChange={(e) => setInvoice(e.target.value as Campaign['invoiceStatus'])}
      >
        {INVOICE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.replace('_', ' ')}
          </option>
        ))}
      </select>
      <div style={buttonRow}>
        <button type="submit" className="btn secondary" disabled={busy !== null}>
          Save invoice status
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

function CampaignEditForm({ campaign, onSaved }: { campaign: Campaign; onSaved: () => void }) {
  const { api } = useSession();
  const id = useId();
  const [open, setOpen] = useState(false);
  const { busy, feedback, run } = useAdminAction();
  const [cap, setCap] = useState(String(campaign.impressionCap));
  const [starts, setStarts] = useState(isoToUtcInput(campaign.startsAt));
  const [ends, setEnds] = useState(isoToUtcInput(campaign.endsAt));
  const [invoice, setInvoice] = useState(campaign.invoiceStatus);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <button
        type="button"
        className="btn secondary"
        aria-label={`Edit caps and dates for ${campaign.name}`}
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        Edit caps and dates
      </button>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const capValue = Number(cap);
    const startsAt = utcInputToIso(starts);
    const endsAt = utcInputToIso(ends);
    if (!Number.isInteger(capValue) || capValue < 1) {
      return setError('The impression cap must be a whole number of at least 1.');
    }
    if (!startsAt || !endsAt) return setError('Enter start and end dates (UTC).');
    if (endsAt <= startsAt) return setError('The campaign must end after it starts.');
    setError(null);
    void run('edit', async () => {
      await api.send(
        'PATCH',
        `${BASE}/campaigns/${campaign.id}`,
        { impressionCap: capValue, startsAt, endsAt, invoiceStatus: invoice },
        campaignSchema,
      );
      onSaved();
      setOpen(false);
      return 'Campaign saved.';
    });
  };
  return (
    <form aria-label={`Caps and dates for ${campaign.name}`} onSubmit={submit}>
      <label htmlFor={`${id}-cap`}>Viewable impression cap</label>
      <input
        id={`${id}-cap`}
        inputMode="numeric"
        value={cap}
        onChange={(e) => setCap(e.target.value)}
      />
      <label htmlFor={`${id}-starts`}>Starts (UTC)</label>
      <input
        id={`${id}-starts`}
        type="datetime-local"
        value={starts}
        onChange={(e) => setStarts(e.target.value)}
      />
      <label htmlFor={`${id}-ends`}>Ends (UTC)</label>
      <input
        id={`${id}-ends`}
        type="datetime-local"
        value={ends}
        onChange={(e) => setEnds(e.target.value)}
      />
      <label htmlFor={`${id}-invoice`}>Invoice status</label>
      <select
        id={`${id}-invoice`}
        value={invoice}
        onChange={(e) => setInvoice(e.target.value as Campaign['invoiceStatus'])}
      >
        {INVOICE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.replace('_', ' ')}
          </option>
        ))}
      </select>
      <FieldError id={`${id}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn secondary" disabled={busy !== null}>
          Save campaign
        </button>
        <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

function CampaignForm({
  sponsors,
  onCreated,
}: {
  sponsors: readonly Sponsor[];
  onCreated: () => void;
}) {
  const { api } = useSession();
  const id = useId();
  const { busy, feedback, run } = useAdminAction();
  const [sponsorId, setSponsorId] = useState('');
  const [creativeId, setCreativeId] = useState('');
  const [name, setName] = useState('');
  const [placement, setPlacement] = useState<Placement>('resources_browse');
  const [platforms, setPlatforms] = useState<Platform[]>(['web']);
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [cap, setCap] = useState('10000');
  const [feeModel, setFeeModel] = useState<CampaignInput['feeModel']>('fixed_fee');
  const [fee, setFee] = useState('');
  const [error, setError] = useState<string | null>(null);
  const creatives = useApiQuery(
    (api) =>
      sponsorId
        ? api.get(`${BASE}/sponsors/${sponsorId}/creatives`, creativesResponseSchema)
        : Promise.resolve({ creatives: [] }),
    [sponsorId],
  );
  const creativeList = creatives.status === 'ready' ? creatives.data.creatives : [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const startsAt = utcInputToIso(starts);
    const endsAt = utcInputToIso(ends);
    const capValue = Number(cap);
    const feeCents = feeModel === 'fixed_fee' ? parseDollarsToCents(fee) : 0;
    if (!sponsorId) return setError('Choose a sponsor.');
    if (!creativeId) return setError('Choose a creative version.');
    if (!name.trim()) return setError('Name the campaign.');
    if (platforms.length === 0) return setError('Choose at least one platform.');
    if (!startsAt || !endsAt) return setError('Enter start and end dates (UTC).');
    if (endsAt <= startsAt) return setError('The campaign must end after it starts.');
    if (!Number.isInteger(capValue) || capValue < 1) {
      return setError('The impression cap must be a whole number of at least 1.');
    }
    if (feeCents === null || (feeModel === 'fixed_fee' && feeCents === 0)) {
      return setError('Enter the contracted fee in dollars.');
    }
    setError(null);
    const body: CampaignInput = {
      sponsorId,
      creativeId,
      name: name.trim(),
      placement,
      platforms,
      startsAt,
      endsAt,
      impressionCap: capValue,
      feeModel,
      contractedFeeCents: feeCents,
    };
    void run('campaign:create', async () => {
      const created = await api.send('POST', `${BASE}/campaigns`, body, campaignSchema);
      onCreated();
      setName('');
      return `Created ${created.name} as a draft. Submit it for review when ready.`;
    });
  };

  return (
    <form aria-label="Create a campaign" onSubmit={submit} style={{ marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Create a campaign</h3>
      <label htmlFor={`${id}-sponsor`}>Sponsor</label>
      <select
        id={`${id}-sponsor`}
        value={sponsorId}
        onChange={(e) => {
          setSponsorId(e.target.value);
          setCreativeId('');
        }}
      >
        <option value="">Choose a sponsor</option>
        {sponsors.map((s) => (
          <option key={s.id} value={s.id}>
            {s.businessName}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-creative`}>Creative version</label>
      <select
        id={`${id}-creative`}
        value={creativeId}
        onChange={(e) => setCreativeId(e.target.value)}
      >
        <option value="">Choose a version</option>
        {creativeList.map((c) => (
          <option key={c.id} value={c.id}>
            Version {c.version} ({CREATIVE_STATUS_LABEL[c.reviewStatus]})
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-name`}>Campaign name</label>
      <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor={`${id}-placement`}>Placement</label>
      <select
        id={`${id}-placement`}
        value={placement}
        onChange={(e) => setPlacement(e.target.value as Placement)}
      >
        {PLACEMENTS.map((p) => (
          <option key={p} value={p}>
            {PLACEMENT_LABEL[p]}
          </option>
        ))}
      </select>
      <fieldset style={fieldsetStyle}>
        <legend style={{ fontWeight: 700 }}>Platforms</legend>
        {PLATFORMS.map((p) => (
          <label key={p} style={inlineLabel}>
            <input
              type="checkbox"
              style={checkboxStyle}
              checked={platforms.includes(p)}
              onChange={(e) =>
                setPlatforms((current) =>
                  e.target.checked ? [...current, p] : current.filter((x) => x !== p),
                )
              }
            />
            {PLATFORM_LABEL[p]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${id}-starts`}>Starts (UTC)</label>
      <input
        id={`${id}-starts`}
        type="datetime-local"
        value={starts}
        onChange={(e) => setStarts(e.target.value)}
      />
      <label htmlFor={`${id}-ends`}>Ends (UTC)</label>
      <input
        id={`${id}-ends`}
        type="datetime-local"
        value={ends}
        onChange={(e) => setEnds(e.target.value)}
      />
      <label htmlFor={`${id}-cap`}>Viewable impression cap</label>
      <input
        id={`${id}-cap`}
        inputMode="numeric"
        value={cap}
        onChange={(e) => setCap(e.target.value)}
      />
      <label htmlFor={`${id}-fee-model`}>Fee model</label>
      <select
        id={`${id}-fee-model`}
        value={feeModel}
        onChange={(e) => setFeeModel(e.target.value as CampaignInput['feeModel'])}
      >
        <option value="fixed_fee">Fixed contracted fee</option>
        <option value="none">No fee</option>
      </select>
      {feeModel === 'fixed_fee' ? (
        <>
          <label htmlFor={`${id}-fee`}>Contracted fee (USD)</label>
          <input
            id={`${id}-fee`}
            inputMode="decimal"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
          />
        </>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          Create campaign
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Resource catalog
// ---------------------------------------------------------------------------------------------

const CATALOG_STATUS_LABEL: Record<CatalogItem['status'], string> = {
  draft: 'Draft (needs review)',
  approved: 'Approved',
  retired: 'Retired',
};

function linkCheckText(check: {
  status: LinkCheck['status'] | null;
  httpStatus?: number | null;
  at?: string | null;
}): string {
  if (check.status === null) return 'Not checked yet';
  const http = check.httpStatus ? ` (HTTP ${check.httpStatus})` : '';
  const when = check.at ? ` · ${formatUtc(check.at)}` : '';
  const label: Record<LinkCheck['status'], string> = {
    ok: 'Link OK',
    broken: 'Link broken',
    error: 'Check failed',
    skipped: 'Check skipped (no network request made)',
  };
  return `${label[check.status]}${http}${when}`;
}

function CatalogSection() {
  const { api } = useSession();
  const query = useApiQuery((api) => api.get(`${BASE}/catalog`, catalogResponseSchema), []);
  const items = useLastGood(query)?.items ?? null;
  const { feedback, run } = useAdminAction();
  const [checks, setChecks] = useState<Record<string, LinkCheck>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const act = (item: CatalogItem, action: 'approve' | 'retire') =>
    run(`catalog:${item.id}:${action}`, async () => {
      const updated = await api.send(
        'POST',
        `${BASE}/catalog/${item.id}/${action}`,
        undefined,
        catalogItemSchema,
      );
      query.reload();
      return `${updated.title} is now ${CATALOG_STATUS_LABEL[updated.status].toLowerCase()}.`;
    });
  const check = (item: CatalogItem) =>
    run(`catalog:${item.id}:check`, async () => {
      const result = await api.send(
        'POST',
        `${BASE}/catalog/${item.id}/link-check`,
        undefined,
        linkCheckResponseSchema,
      );
      setChecks((current) => ({ ...current, [item.id]: result }));
      query.reload();
      return `${item.title}: ${linkCheckText(result)}.${result.note ? ` ${result.note}` : ''}`;
    });

  return (
    <Section title="Resource catalog">
      <p style={{ marginTop: 0 }}>
        Reviewed study resources with our own descriptions. Amazon links are stored as the plain
        product page (no tag); prices are never stored or shown. Link checks request the untagged
        page only, so a check is never a click.
      </p>
      <AdminFeedback feedback={feedback} rules={RULES} />
      {query.status === 'loading' && items === null ? <Loading label="Loading catalog…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={ruleMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {items && items.length === 0 ? <p>No catalog items yet.</p> : null}
      {items && items.length > 0 ? (
        <TableScroll label="Catalog">
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Resource</Th>
                <Th>Fit</Th>
                <Th>Link</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const latest = checks[item.id];
                return (
                  <tr key={item.id}>
                    <Td>
                      {item.title}
                      <div style={mutedText}>
                        {item.stableKey} · {item.kind.replace('_', ' ')}
                      </div>
                    </Td>
                    <Td>
                      {item.subjects.map((s) => SUBJECT_LABEL[s]).join(', ')}
                      <div style={mutedText}>
                        Grades {item.gradeMin}–{item.gradeMax}
                        {item.skills.length ? ` · ${item.skills.join(', ')}` : ''}
                      </div>
                    </Td>
                    <Td>
                      {item.merchantUrl ?? 'No merchant link (free option)'}
                      <div style={mutedText}>
                        Availability: {item.availability} ·{' '}
                        {latest
                          ? linkCheckText({ status: latest.status, httpStatus: latest.httpStatus })
                          : linkCheckText({
                              status: item.lastLinkCheckStatus,
                              at: item.lastLinkCheckAt,
                            })}
                      </div>
                    </Td>
                    <Td>{CATALOG_STATUS_LABEL[item.status]}</Td>
                    <Td>
                      <div style={buttonRow}>
                        {item.status === 'draft' ? (
                          <ConfirmButton
                            label="Approve"
                            accessibleLabel={`Approve ${item.title}`}
                            prompt={`Approve ${item.title} for the parent resource browser?`}
                            confirmLabel="Approve"
                            onConfirm={() => act(item, 'approve')}
                          />
                        ) : null}
                        {item.merchant !== 'none' ? (
                          <button
                            type="button"
                            className="btn secondary"
                            aria-label={`Check link for ${item.title}`}
                            onClick={() => void check(item)}
                          >
                            Check link
                          </button>
                        ) : null}
                        {item.status !== 'retired' ? (
                          <>
                            <button
                              type="button"
                              className="btn secondary"
                              aria-label={`Edit ${item.title}`}
                              aria-pressed={editing === item.id}
                              onClick={() => setEditing(editing === item.id ? null : item.id)}
                            >
                              Edit
                            </button>
                            <ConfirmButton
                              label="Retire"
                              accessibleLabel={`Retire ${item.title}`}
                              secondary
                              prompt={`Retire ${item.title}? Parents stop seeing it.`}
                              confirmLabel="Retire"
                              onConfirm={() => act(item, 'retire')}
                            />
                          </>
                        ) : null}
                      </div>
                      {editing === item.id ? (
                        <CatalogForm
                          item={item}
                          onSaved={() => {
                            setEditing(null);
                            query.reload();
                          }}
                        />
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
      <CatalogForm item={null} onSaved={query.reload} />
    </Section>
  );
}

/** Create (item = null) or edit a catalog item. Any edit to an approved item needs re-review. */
function CatalogForm({ item, onSaved }: { item: CatalogItem | null; onSaved: () => void }) {
  const { api } = useSession();
  const id = useId();
  const { busy, feedback, run } = useAdminAction();
  const [stableKey, setStableKey] = useState('');
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [skills, setSkills] = useState(item?.skills.join(', ') ?? '');
  const [subjects, setSubjects] = useState<Subject[]>(item?.subjects ?? ['math']);
  const [gradeMin, setGradeMin] = useState(String(item?.gradeMin ?? 0));
  const [gradeMax, setGradeMax] = useState(String(item?.gradeMax ?? 12));
  const [kind, setKind] = useState<CatalogItem['kind']>(item?.kind ?? 'workbook');
  const [merchant, setMerchant] = useState<CatalogItem['merchant']>(item?.merchant ?? 'amazon');
  const [url, setUrl] = useState(item?.merchantUrl ?? '');
  const [asset, setAsset] = useState(item?.imageAssetRef ?? '');
  const [license, setLicense] = useState(item?.imageLicenseRef ?? '');
  const [error, setError] = useState<string | null>(null);
  const free = kind === 'parent_exercise' || kind === 'in_app_practice';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const min = Number(gradeMin);
    const max = Number(gradeMax);
    if (item === null && !/^[a-z0-9][a-z0-9-]{2,63}$/.test(stableKey)) {
      return setError('The stable key uses 3–64 lowercase letters, numbers and dashes.');
    }
    if (title.trim().length < 2) return setError('Enter a title.');
    if (description.trim().length < 10)
      return setError('Write our own description (10+ characters).');
    if (subjects.length === 0) return setError('Choose at least one subject.');
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 12 || max < min) {
      return setError('Grades run from 0 (kindergarten) to 12, lowest first.');
    }
    const effectiveMerchant = free ? 'none' : merchant;
    if (effectiveMerchant !== 'none' && !url.trim()) {
      return setError('Paste the plain product link for this merchant item.');
    }
    setError(null);
    const common = {
      title: title.trim(),
      description: description.trim(),
      skills: splitList(skills.toLowerCase()),
      subjects,
      gradeMin: min,
      gradeMax: max,
      kind,
      merchant: effectiveMerchant,
      merchantUrl: effectiveMerchant === 'none' ? null : url.trim(),
      imageAssetRef: asset.trim() ? asset.trim() : null,
      imageLicenseRef: license.trim() ? license.trim() : null,
    };
    void run('catalog:save', async () => {
      if (item === null) {
        const body: CatalogInput = { stableKey, ...common };
        const created = await api.send('POST', `${BASE}/catalog`, body, catalogItemSchema);
        onSaved();
        return `Added ${created.title} as a draft. Approve it after review.`;
      }
      const updated = await api.send(
        'PATCH',
        `${BASE}/catalog/${item.id}`,
        common,
        catalogItemSchema,
      );
      onSaved();
      return `Saved ${updated.title}.${item.status === 'approved' ? ' It returned to draft and needs a fresh review.' : ''}`;
    });
  };

  return (
    <form
      aria-label={item ? `Edit ${item.title}` : 'Add a catalog item'}
      onSubmit={submit}
      style={{ marginTop: 16 }}
    >
      <h3 style={{ margin: 0 }}>{item ? `Edit ${item.title}` : 'Add a catalog item'}</h3>
      {item?.status === 'approved' ? (
        <p style={mutedText}>Saving changes returns this approved item to draft for re-review.</p>
      ) : null}
      {item === null ? (
        <>
          <label htmlFor={`${id}-key`}>Stable key</label>
          <input
            id={`${id}-key`}
            value={stableKey}
            onChange={(e) => setStableKey(e.target.value)}
          />
        </>
      ) : null}
      <label htmlFor={`${id}-title`}>Title</label>
      <input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor={`${id}-description`}>Our own description</label>
      <textarea
        id={`${id}-description`}
        style={textareaStyle}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <label htmlFor={`${id}-skills`}>Skill tags (comma separated)</label>
      <input id={`${id}-skills`} value={skills} onChange={(e) => setSkills(e.target.value)} />
      <fieldset style={fieldsetStyle}>
        <legend style={{ fontWeight: 700 }}>Subjects</legend>
        {SUBJECTS.map((s) => (
          <label key={s} style={inlineLabel}>
            <input
              type="checkbox"
              style={checkboxStyle}
              checked={subjects.includes(s)}
              onChange={(e) =>
                setSubjects((current) =>
                  e.target.checked ? [...current, s] : current.filter((x) => x !== s),
                )
              }
            />
            {SUBJECT_LABEL[s]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${id}-min`}>Lowest grade (0 = kindergarten)</label>
      <input id={`${id}-min`} value={gradeMin} onChange={(e) => setGradeMin(e.target.value)} />
      <label htmlFor={`${id}-max`}>Highest grade</label>
      <input id={`${id}-max`} value={gradeMax} onChange={(e) => setGradeMax(e.target.value)} />
      <label htmlFor={`${id}-kind`}>Kind</label>
      <select
        id={`${id}-kind`}
        value={kind}
        onChange={(e) => setKind(e.target.value as CatalogItem['kind'])}
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {k.replace('_', ' ')}
          </option>
        ))}
      </select>
      {free ? (
        <p style={mutedText}>Free learning options never carry a merchant link.</p>
      ) : (
        <>
          <label htmlFor={`${id}-merchant`}>Merchant</label>
          <select
            id={`${id}-merchant`}
            value={merchant}
            onChange={(e) => setMerchant(e.target.value as CatalogItem['merchant'])}
          >
            <option value="amazon">Amazon</option>
            <option value="other">Other (reviewed hosts only)</option>
            <option value="none">None</option>
          </select>
          {merchant !== 'none' ? (
            <>
              <label htmlFor={`${id}-url`}>Plain product link (no tag or tracking)</label>
              <input id={`${id}-url`} value={url} onChange={(e) => setUrl(e.target.value)} />
            </>
          ) : null}
        </>
      )}
      <label htmlFor={`${id}-asset`}>Authorized image asset key (optional)</label>
      <input id={`${id}-asset`} value={asset} onChange={(e) => setAsset(e.target.value)} />
      <label htmlFor={`${id}-license`}>Image licence reference (optional)</label>
      <input id={`${id}-license`} value={license} onChange={(e) => setLicense(e.target.value)} />
      <FieldError id={`${id}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn secondary" disabled={busy !== null}>
          {item ? 'Save changes' : 'Add item'}
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Inappropriate-ad reports
// ---------------------------------------------------------------------------------------------

function AdReportsSection() {
  const { api } = useSession();
  const query = useApiQuery((api) => api.get(`${BASE}/ad-reports`, adReportsResponseSchema), []);
  const reports = useLastGood(query)?.reports ?? null;
  const { feedback, run } = useAdminAction();
  const review = (id: string) =>
    run(`report:${id}`, async () => {
      await api.send('POST', `${BASE}/ad-reports/${id}/review`, undefined, adminOkResponseSchema);
      query.reload();
      return 'Report marked as reviewed.';
    });
  return (
    <Section title="Reports from parents">
      <p style={{ marginTop: 0 }}>
        Reports carry the campaign, category, platform, placement and date only. They never identify
        the family or child.
      </p>
      <AdminFeedback feedback={feedback} rules={RULES} />
      {query.status === 'loading' && reports === null ? <Loading label="Loading reports…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={ruleMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {reports && reports.length === 0 ? <p>No reports.</p> : null}
      {reports && reports.length > 0 ? (
        <TableScroll label="Reports">
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Category</Th>
                <Th>Where</Th>
                <Th>Status</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <Td>{r.createdDate}</Td>
                  <Td>{r.category}</Td>
                  <Td>
                    {PLACEMENT_LABEL[r.placement]} · {PLATFORM_LABEL[r.platform]}
                  </Td>
                  <Td>{r.status === 'open' ? 'Open' : 'Reviewed'}</Td>
                  <Td>
                    {r.status === 'open' ? (
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => void review(r.id)}
                      >
                        Mark reviewed
                      </button>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Revenue ledger: imports and adjustments
// ---------------------------------------------------------------------------------------------

const IMPORT_SOURCES = [
  { value: 'sponsor_invoice', label: 'Sponsor invoices' },
  { value: 'amazon_report', label: 'Amazon Associates report' },
  { value: 'ad_network', label: 'Ad network report' },
  { value: 'manual', label: 'Manual entry' },
] as const;

const SAMPLE_ROWS = `[
  { "externalRef": "INV-1001", "category": "contracted", "provider": "sponsor_direct",
    "campaignId": null, "placement": "resources_browse", "amountCents": 50000 }
]`;

/** Parses pasted JSON rows and validates each against the import row contract. */
function parseImportRows(
  text: string,
): { ok: true; rows: z.infer<typeof revenueImportRowSchema>[] } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The rows are not valid JSON. Paste a JSON array of rows.' };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: 'Paste a JSON array with at least one row.' };
  }
  if (raw.length > 2000) return { ok: false, message: 'Import at most 2000 rows at a time.' };
  const rows: z.infer<typeof revenueImportRowSchema>[] = [];
  for (const [index, value] of raw.entries()) {
    const parsed = revenueImportRowSchema.safeParse(value);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join('.') || 'row').join(', ');
      return { ok: false, message: `Row ${index + 1} is invalid: ${fields}.` };
    }
    rows.push(parsed.data);
  }
  return { ok: true, rows };
}

function RevenueSection() {
  return (
    <Section title="Revenue imports and adjustments">
      <p style={{ marginTop: 0 }}>
        Revenue comes only from imported provider totals or invoices. A click is not a sale and a
        projected commission is not cash. Refunds and reversals are recorded as negative
        adjustments, never by editing an import.
      </p>
      <ImportForm />
      <AdjustmentForm />
    </Section>
  );
}

function ImportForm() {
  const { api } = useSession();
  const id = useId();
  const { busy, feedback, run } = useAdminAction();
  const [source, setSource] = useState<(typeof IMPORT_SOURCES)[number]['value']>('sponsor_invoice');
  const [month, setMonth] = useState(() => utcMonthOf(new Date()));
  const [note, setNote] = useState('');
  const [rows, setRows] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!MONTH_RE.test(month)) return setError('Enter the period month as YYYY-MM.');
    const parsed = parseImportRows(rows);
    if (!parsed.ok) return setError(parsed.message);
    setError(null);
    void run('import', async () => {
      const result = await api.send(
        'POST',
        `${BASE}/revenue/imports`,
        { source, periodMonth: month, note: note.trim() ? note.trim() : null, rows: parsed.rows },
        revenueImportResponseSchema,
      );
      setRows('');
      return `Imported ${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'} for ${monthLabel(month)} (import ${result.importId}, fingerprint ${result.fileSha256.slice(0, 12)}…).`;
    });
  };
  return (
    <form aria-label="Import revenue" onSubmit={submit}>
      <h3 style={{ margin: 0 }}>Import revenue rows</h3>
      <label htmlFor={`${id}-source`}>Source</label>
      <select
        id={`${id}-source`}
        value={source}
        onChange={(e) => setSource(e.target.value as typeof source)}
      >
        {IMPORT_SOURCES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-month`}>Period month</label>
      <input
        id={`${id}-month`}
        type="month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
      />
      <label htmlFor={`${id}-note`}>Note (optional)</label>
      <input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
      <label htmlFor={`${id}-rows`}>Rows (JSON)</label>
      <textarea
        id={`${id}-rows`}
        style={{ ...textareaStyle, minHeight: 140, fontFamily: 'monospace' }}
        value={rows}
        aria-describedby={`${id}-rows-hint`}
        onChange={(e) => setRows(e.target.value)}
      />
      <p id={`${id}-rows-hint`} style={mutedText}>
        Amounts are whole cents. Categories: projected, contracted, recognized, received,
        affiliate_reported. A file that was already imported is refused. Example:
      </p>
      <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: '0.9rem' }}>
        {SAMPLE_ROWS}
      </pre>
      <FieldError id={`${id}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          Import rows
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

function AdjustmentForm() {
  const { api } = useSession();
  const id = useId();
  const { busy, feedback, run } = useAdminAction();
  const [entryId, setEntryId] = useState('');
  const [kind, setKind] = useState<'refund' | 'reversal' | 'correction'>('refund');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  // One key per intended adjustment: a retry after a lost response cannot apply it twice.
  const [key, setKey] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cents = parseSignedDollars(amount);
    if (!z.uuid().safeParse(entryId.trim()).success) {
      return setError('Enter the revenue entry ID.');
    }
    if (cents === null || cents === 0) return setError('Enter a non-zero amount in dollars.');
    if (kind !== 'correction' && cents > 0) {
      return setError('Refunds and reversals are negative amounts (for example -12.50).');
    }
    if (reason.trim().length < 3) return setError('Record why (at least 3 characters).');
    setError(null);
    void run('adjust', async () => {
      const result = await api.send(
        'POST',
        `${BASE}/revenue/adjustments`,
        {
          entryId: entryId.trim(),
          kind,
          amountCents: cents,
          reason: reason.trim(),
          idempotencyKey: key,
        },
        adjustmentResponseSchema,
      );
      setKey(newIdempotencyKey());
      setAmount('');
      setReason('');
      return result.replayed
        ? 'This adjustment was already recorded. Nothing changed.'
        : `Recorded a ${kind} of ${formatUsd(cents)}.`;
    });
  };
  return (
    <form aria-label="Record an adjustment" onSubmit={submit} style={{ marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Record a refund, reversal or correction</h3>
      <label htmlFor={`${id}-entry`}>Revenue entry ID</label>
      <input
        id={`${id}-entry`}
        value={entryId}
        aria-describedby={`${id}-entry-hint`}
        onChange={(e) => setEntryId(e.target.value)}
      />
      <p id={`${id}-entry-hint`} style={mutedText}>
        The ledger entry being adjusted. This console cannot list entries yet, so copy the ID from
        the ledger record.
      </p>
      <label htmlFor={`${id}-kind`}>Kind</label>
      <select
        id={`${id}-kind`}
        value={kind}
        onChange={(e) => setKind(e.target.value as typeof kind)}
      >
        <option value="refund">Refund</option>
        <option value="reversal">Reversal</option>
        <option value="correction">Correction</option>
      </select>
      <label htmlFor={`${id}-amount`}>Amount (USD, negative for refunds and reversals)</label>
      <input
        id={`${id}-amount`}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label htmlFor={`${id}-reason`}>Reason</label>
      <input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
      <FieldError id={`${id}-error`} message={error} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          Record adjustment
        </button>
      </div>
      <AdminFeedback feedback={feedback} rules={RULES} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Monthly aggregate report
// ---------------------------------------------------------------------------------------------

function ReportSection() {
  const id = useId();
  const [month, setMonth] = useState(() => utcMonthOf(new Date()));
  const [monthText, setMonthText] = useState(month);
  const query = useApiQuery(
    (api) => api.get(`${BASE}/report?month=${encodeURIComponent(month)}`, monetizationReportSchema),
    [month],
  );
  const report = useLastGood(query);
  return (
    <Section title="Monthly report">
      <div className="notice" role="note" aria-label="Projected amounts are not revenue">
        <strong>Projected amounts are not revenue.</strong> Only imported contracted, recognized,
        received and affiliate-reported amounts are revenue. Clicks and impressions are never turned
        into sales.
      </div>
      <label htmlFor={`${id}-month`}>Report month</label>
      <input
        id={`${id}-month`}
        type="month"
        value={monthText}
        onChange={(e) => {
          setMonthText(e.target.value);
          if (MONTH_RE.test(e.target.value)) setMonth(e.target.value);
        }}
      />
      {query.status === 'loading' && report === null ? <Loading label="Loading report…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={ruleMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {report ? <ReportBody report={report} /> : null}
    </Section>
  );
}

function ReportBody({ report }: { report: MonetizationReport }) {
  const totals = EVENT_KINDS.map((kind) => {
    const rows = report.events.filter((e) => e.kind === kind);
    const shown = rows.reduce((sum, e) => sum + (e.count ?? 0), 0);
    const suppressed = rows.filter((e) => e.suppressed).length;
    return { kind, shown, suppressed };
  });
  const r = report.revenue;
  const revenueRows: readonly [string, number][] = [
    ['Contracted sponsorship', r.contractedCents],
    ['Recognized revenue', r.recognizedCents],
    ['Cash received', r.receivedCents],
    ['Affiliate reported (Amazon report totals)', r.affiliateReportedCents],
    ['Refunds', r.adjustments.refund],
    ['Reversals', r.adjustments.reversal],
    ['Corrections', r.adjustments.correction],
    [
      'Excluded double count (network revenue on sponsor-sold inventory)',
      r.excludedDoubleCountCents,
    ],
  ];
  return (
    <>
      <h3>Placement activity for {monthLabel(report.month)}</h3>
      <p style={mutedText}>
        Aggregate counts only, with no family, child or user identifiers. Counts from 1 to{' '}
        {report.minCohort - 1} are shown as “&lt;{report.minCohort}” so a small group can never be
        singled out; zero is shown as 0 because it identifies nobody.
      </p>
      <TableScroll label="Activity totals">
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>Measure</Th>
              <Th>Total shown</Th>
              <Th>Suppressed groups</Th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <tr key={t.kind}>
                <Td>{EVENT_KIND_LABEL[t.kind]}</Td>
                <Td>{t.shown.toLocaleString('en-US')}</Td>
                <Td>
                  {t.suppressed === 0
                    ? 'None'
                    : `${t.suppressed} ${t.suppressed === 1 ? 'group' : 'groups'} of <${report.minCohort} not included`}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {report.events.length > 0 ? (
        <TableScroll label="Activity detail">
          <table style={{ ...tableStyle, marginTop: 12 }}>
            <thead>
              <tr>
                <Th>Measure</Th>
                <Th>Where</Th>
                <Th>Campaign or resource</Th>
                <Th>Count</Th>
              </tr>
            </thead>
            <tbody>
              {report.events.map((e, index) => (
                <tr
                  key={`${e.kind}:${e.platform}:${e.placement}:${e.campaignId ?? ''}:${e.catalogId ?? ''}:${index}`}
                >
                  <Td>{EVENT_KIND_LABEL[e.kind]}</Td>
                  <Td>
                    {PLACEMENT_LABEL[e.placement]} · {PLATFORM_LABEL[e.platform]}
                  </Td>
                  <Td>
                    {e.campaignId
                      ? `Campaign ${e.campaignId.slice(0, 8)}`
                      : e.catalogId
                        ? `Resource ${e.catalogId.slice(0, 8)}`
                        : '—'}
                  </Td>
                  <Td>{e.suppressed || e.count === null ? `<${report.minCohort}` : e.count}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : (
        <p>No placement activity recorded this month.</p>
      )}

      <h3>Revenue for {monthLabel(report.month)}</h3>
      <TableScroll label="Revenue">
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>Line</Th>
              <Th>Amount</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>Projected (not revenue)</Td>
              <Td>{money(r.projectedCents)}</Td>
            </tr>
            {revenueRows.map(([label, cents]) => (
              <tr key={label}>
                <Td>{label}</Td>
                <Td>{money(cents)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {r.conflicts.length > 0 ? (
        <ul>
          {r.conflicts.map((c) => (
            <li key={`${c.category}:${c.placement}:${c.periodMonth}`}>
              Excluded {money(c.excludedNetworkCents)} of network {c.category} revenue for{' '}
              {PLACEMENT_LABEL[c.placement]} in {monthLabel(c.periodMonth)}: that inventory was sold
              to a sponsor.
            </li>
          ))}
        </ul>
      ) : null}
      <h3>Revenue per family</h3>
      <dl>
        <dt style={{ fontWeight: 700 }}>
          Recognized revenue per active family (all {r.activeFamilies.toLocaleString('en-US')}{' '}
          families, including non-buyers and ad-free families)
        </dt>
        <dd style={{ margin: '0 0 8px' }}>{money(r.recognizedPerActiveFamilyCents)}</dd>
        <dt style={{ fontWeight: 700 }}>
          Recognized revenue per ad-eligible adult ({r.adEligibleAdults.toLocaleString('en-US')}{' '}
          adults who are not ad-free and have not hidden sponsor cards)
        </dt>
        <dd style={{ margin: 0 }}>{money(r.recognizedPerAdEligibleAdultCents)}</dd>
      </dl>
      <p style={mutedText}>
        Incremental selling and serving costs are not recorded in this console, so commercial
        contribution is not computed here.
      </p>
    </>
  );
}
