import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { channelSchema } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { ErrorState } from '../../../components/states.tsx';
import { RequireParent, type QueryState } from '../../../lib/session.tsx';

/**
 * Shared building blocks for the owner-admin console (spec P14 owner admin, P17 administration).
 * Every admin endpoint requires an owner-admin account with an MFA (aal2) session; the API enforces
 * it and these components turn a refusal into an explicit state instead of an empty screen.
 */

export const MFA_REQUIRED_MESSAGE = 'Owner administration requires an MFA session';

/** `{ ok: true }` acknowledgement returned by campaign actions and offer-mapping updates. */
export const adminOkResponseSchema = z.strictObject({ ok: z.literal(true) });

/**
 * GET /v1/admin/readiness has no shared contract yet, so its shape is validated here.
 * Decision: `status` is accepted as any string and everything other than "ready" is displayed as
 * not ready, so a new server status can never be shown as a pass.
 */
export const readinessResponseSchema = z.strictObject({
  environment: z.string(),
  checks: z.array(z.strictObject({ check: z.string(), status: z.string(), detail: z.string() })),
});

export function isAccessDenied(error: ApiRequestError): boolean {
  return error.code === 'FORBIDDEN' || error.code === 'UNAUTHENTICATED';
}

export function toApiError(error: unknown): ApiRequestError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError('INTERNAL', 'Something went wrong. Please try again.', 0);
}

export function AdminAccessDenied() {
  return (
    <div className="notice" role="alert">
      <p style={{ margin: 0 }}>
        <strong>{MFA_REQUIRED_MESSAGE}.</strong> Sign in with an owner-admin account and complete
        two-step verification, then reload this page. Nothing in the owner console is shown without
        it.
      </p>
      <p style={{ margin: '8px 0 0' }}>
        <Link to="/admin/mfa">Complete two-step verification</Link>
      </p>
    </div>
  );
}

const NAV: readonly { to: string; label: string }[] = [
  { to: '/admin', label: 'Owner admin' },
  { to: '/admin/support', label: 'Support' },
  { to: '/admin/revenue', label: 'Subscriptions and revenue' },
  { to: '/admin/promotions', label: 'Promotions' },
  { to: '/admin/schools', label: 'Schools and payouts' },
  { to: '/admin/monetization', label: 'Monetization' },
];

/** Page frame: parent sign-in gate, console navigation and the page heading. */
export function AdminPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <RequireParent>
      <nav aria-label="Owner console" style={{ marginBottom: 8 }}>
        {NAV.map((item, index) => (
          <span key={item.to}>
            {index > 0 ? ' · ' : null}
            <Link to={item.to}>{item.label}</Link>
          </span>
        ))}
      </nav>
      <h1>{title}</h1>
      {children}
    </RequireParent>
  );
}

/** Keeps the last successfully loaded data on screen while a reload is in flight. */
export function useLastGood<T>(query: QueryState<T>): T | null {
  const [last, setLast] = useState<T | null>(null);
  const ready = query.status === 'ready' ? query.data : null;
  useEffect(() => {
    if (ready !== null) setLast(ready);
  }, [ready]);
  return ready ?? last;
}

export type AdminFeedbackValue =
  | { kind: 'success'; message: string }
  | { kind: 'error'; error: ApiRequestError }
  | { kind: 'problem'; message: string };

/**
 * Thrown inside a `useAdminAction` action when the request succeeded but its outcome is not what
 * the owner asked for (e.g. the server kept a different value). Shown as an error, never a success.
 */
export class AdminProblem extends Error {}

/** Runs one mutation at a time and records its outcome for display. */
export function useAdminAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<AdminFeedbackValue | null>(null);
  const run = useCallback(async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setFeedback(null);
    try {
      const message = await action();
      setFeedback({ kind: 'success', message });
      return true;
    } catch (error) {
      setFeedback(
        error instanceof AdminProblem
          ? { kind: 'problem', message: error.message }
          : { kind: 'error', error: toApiError(error) },
      );
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, feedback, run, setFeedback };
}

/** Human wording for an admin API failure; `rules` maps BUSINESS_RULE / blocked rule codes. */
export function adminErrorMessage(
  error: ApiRequestError,
  rules: Readonly<Record<string, string>> = {},
): string {
  if (isAccessDenied(error))
    return `${MFA_REQUIRED_MESSAGE}. Complete two-step verification and try again.`;
  if (error.rule && rules[error.rule]) return rules[error.rule]!;
  return error.message;
}

export function AdminFeedback({
  feedback,
  rules,
}: {
  feedback: AdminFeedbackValue | null;
  rules?: Readonly<Record<string, string>>;
}) {
  if (!feedback) return null;
  if (feedback.kind === 'success') {
    if (feedback.message === '') return null;
    return (
      <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
        {feedback.message}
      </p>
    );
  }
  if (feedback.kind === 'problem') return <ErrorState message={feedback.message} />;
  return <ErrorState message={adminErrorMessage(feedback.error, rules)} />;
}

export function FieldError({ id, message }: { id: string; message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
      {message}
    </p>
  );
}

/**
 * A button that asks for an explicit second click before a consequential action (spec P17:
 * pause/revoke/generate/approve are never one accidental click).
 *
 * Focus (AC_UX_01, RV-p17-ui-7): opening the prompt replaces the focused button, so focus moves to
 * the confirm button inside the prompt; Cancel returns it to the original button. Otherwise
 * keyboard and screen-reader users would be dropped on <body> at the most consequential step.
 */
export function ConfirmButton({
  label,
  accessibleLabel,
  prompt,
  confirmLabel,
  onConfirm,
  disabled,
  secondary,
}: {
  label: string;
  accessibleLabel?: string | undefined;
  prompt: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  disabled?: boolean | undefined;
  secondary?: boolean | undefined;
}) {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const promptId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Where focus goes after the next render: into the prompt, back to the trigger, or nowhere.
  const focusNext = useRef<'confirm' | 'trigger' | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'confirm') confirmRef.current?.focus();
    // Only reclaim focus that the removed prompt dropped (a finished action may have moved it).
    if (
      target === 'trigger' &&
      (document.activeElement === document.body || !document.activeElement)
    ) {
      triggerRef.current?.focus();
    }
  }, [asking]);
  const open = () => {
    focusNext.current = 'confirm';
    setAsking(true);
  };
  const close = () => {
    focusNext.current = 'trigger';
    setAsking(false);
  };
  if (!asking) {
    return (
      <button
        ref={triggerRef}
        type="button"
        className={secondary ? 'btn secondary' : 'btn'}
        disabled={disabled}
        aria-label={accessibleLabel}
        onClick={open}
      >
        {label}
      </button>
    );
  }
  return (
    <div className="notice" role="group" aria-describedby={promptId} style={{ margin: '8px 0' }}>
      <p id={promptId} style={{ margin: 0 }}>
        {prompt}
      </p>
      <div style={buttonRow}>
        <button
          ref={confirmRef}
          type="button"
          className="btn"
          disabled={working || disabled}
          onClick={() => {
            setWorking(true);
            void onConfirm().finally(() => {
              setWorking(false);
              close();
            });
          }}
        >
          {working ? 'Working…' : confirmLabel}
        </button>
        <button type="button" className="btn secondary" disabled={working} onClick={close}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export const buttonRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as const;
export const sectionStyle = { marginTop: 16 } as const;
export const tableStyle = { width: '100%', borderCollapse: 'collapse' } as const;
/**
 * Hairline rule derived from the navy token (brand: every colour comes from the token set; no
 * other hex literal). The same 14% navy that styles.css uses under the brand bar.
 */
export const RULE_COLOR = 'color-mix(in srgb, var(--navy) 14%, var(--white))';

export const cellStyle = {
  textAlign: 'left',
  borderTop: `1px solid ${RULE_COLOR}`,
  padding: '8px 8px 8px 0',
  verticalAlign: 'top',
} as const;

/** Right-aligned numeric cell: tabular figures so columns of money line up. */
export const numberCellStyle = {
  ...cellStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
} as const;

/** styles.css sizes inputs and selects; a textarea gets the same treatment inline. */
export const textareaStyle = {
  display: 'block',
  width: '100%',
  maxWidth: 640,
  minHeight: 120,
  fontSize: '1rem',
  fontFamily: 'inherit',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--muted)',
  color: 'var(--navy)',
  background: 'var(--white)',
} as const;

/**
 * Wide tables scroll inside their own box on small screens instead of the whole page; the box is
 * focusable so keyboard users can scroll it.
 */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }} tabIndex={0} role="group" aria-label={label}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Formatting (deterministic; admin instants are shown in UTC and labelled as such)
// ---------------------------------------------------------------------------------------------

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-10" -> "October 2026" without any timezone arithmetic. */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && name ? `${name} ${match[1]}` : month;
}

/** The UTC calendar month containing `now`, e.g. "2026-09". */
export function utcMonthOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "2026-10-01T05:00:00Z" -> "Oct 1, 2026, 05:00 UTC". */
export function formatUtc(iso: string): string {
  const text = new Date(iso).toLocaleString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${text} UTC`;
}

// ---------------------------------------------------------------------------------------------
// Company dashboard building blocks (owner overview, support queue, revenue)
// ---------------------------------------------------------------------------------------------

export type Channel = z.infer<typeof channelSchema>;

/** Every billing channel the contract knows, read at run time (never a hardcoded list). */
export const CHANNELS: readonly Channel[] = channelSchema.options;

const CHANNEL_LABEL: Readonly<Record<Channel, string>> = {
  app_store: 'App Store',
  play_store: 'Google Play',
  stripe: 'Web billing (Stripe)',
  amazon_appstore: 'Amazon Appstore',
};

export function channelLabel(channel: Channel): string {
  return CHANNEL_LABEL[channel];
}

export const smallMutedStyle = { color: 'var(--muted)', fontSize: '0.85rem' } as const;

/**
 * Names the table a number was read from and how it was counted (product decision: every number
 * on the owner dashboard says its source and definition; nothing is rounded up). A disclosure
 * rather than a hover-only tooltip so keyboard and touch users can open it.
 */
export function Provenance({
  source,
  definition,
  label = 'Source',
}: {
  source: string;
  definition: string;
  label?: string;
}) {
  return (
    <details style={{ ...smallMutedStyle, marginTop: 4, overflowWrap: 'anywhere' }}>
      <summary style={{ cursor: 'pointer' }}>
        {label}: <code style={{ overflowWrap: 'anywhere' }}>{source}</code>
      </summary>
      <p style={{ margin: '4px 0 0' }}>{definition}</p>
    </details>
  );
}

export type Tone = 'neutral' | 'attention' | 'success' | 'danger';

const PILL_TONES: Readonly<Record<Tone, { background: string; color: string }>> = {
  neutral: { background: 'var(--off-white)', color: 'var(--navy)' },
  attention: { background: 'var(--gold)', color: 'var(--navy)' },
  success: { background: 'var(--success)', color: 'var(--white)' },
  danger: { background: 'var(--danger)', color: 'var(--white)' },
};

/** A short status label. Gold means "needs a person", danger only for failures. */
export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      style={{
        ...PILL_TONES[tone],
        display: 'inline-block',
        borderRadius: 999,
        padding: '2px 10px',
        fontSize: '0.85rem',
        fontWeight: 700,
        whiteSpace: 'nowrap',
        border: `1px solid ${RULE_COLOR}`,
      }}
    >
      {children}
    </span>
  );
}

export function StatGrid({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="list"
      aria-label={label}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
        marginTop: 12,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Stat tile: label, one value, an optional detail line and the number's provenance. The value
 * is text-coloured (never the data colour); a gold top rule marks a tile that needs attention.
 */
export function StatTile({
  label,
  value,
  detail,
  source,
  definition,
  tone = 'neutral',
  to,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  source: string;
  definition: string;
  tone?: 'neutral' | 'attention';
  to?: string | undefined;
}) {
  return (
    <div
      role="listitem"
      className="card"
      style={{
        padding: 16,
        borderTop: `4px solid ${tone === 'attention' ? 'var(--gold)' : 'var(--teal)'}`,
      }}
    >
      <p style={{ ...smallMutedStyle, margin: 0, fontWeight: 700, color: 'var(--navy)' }}>
        {label}
      </p>
      <p style={{ margin: '4px 0 0', fontSize: '1.75rem', fontWeight: 800, color: 'var(--navy)' }}>
        {value}
      </p>
      {detail !== undefined ? (
        <p style={{ ...smallMutedStyle, margin: '4px 0 0' }}>{detail}</p>
      ) : null}
      {to !== undefined ? (
        <p style={{ margin: '6px 0 0', fontSize: '0.9rem' }}>
          <Link to={to}>Open {label.toLowerCase()}</Link>
        </p>
      ) : null}
      <Provenance source={source} definition={definition} />
    </div>
  );
}

/** "2026-10-01T05:00:00Z" -> "Oct 1, 2026" (UTC calendar date). */
export function formatUtcDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Whole hours as "3h", "2d 5h" or "14d"; null reads as "—". */
export function ageText(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/** Whole percent rounded down, as the API rounds; never rounds up. */
export function percentText(basisPoints: number | null): string {
  return basisPoints === null ? '—' : `${(basisPoints / 100).toFixed(2)}%`;
}

/** First eight characters of an id, for tables where the full uuid is available on the detail. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
