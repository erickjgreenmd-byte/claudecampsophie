import {
  SUPPORT_CASE_KIND_LABELS,
  SUPPORT_CASE_RESOLUTION_LABELS,
  SUPPORT_CASE_STATUS_LABELS,
  SUPPORT_INTAKE_NOTICE,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REFUND_NOTICE,
  SUPPORT_RULES,
  SUPPORT_SUBJECT_MAX_LENGTH,
  supportCaseKindSchema,
  type BillingSettlement,
  type CreateSupportCaseRequest,
  type ReplySupportCaseRequest,
  type SupportBillingPeriod,
  type SupportCase,
  type SupportCaseDetail,
  type SupportCaseKind,
  type SupportCaseStatus,
} from '@pencillift/contracts';
import { ApiRequestError, isRequestTimeout } from '@pencillift/contracts/client';
import { formatUsd } from '@pencillift/domain';

/**
 * View models for the parent Support screen: what a case looks like in the list and in its
 * thread, how old it is, what the store has reported on a linked billing period, and what a new
 * case or reply must carry before it is sent. Pure: no react-native imports, `now` is an input,
 * amounts are integer cents from the API. Every status is spelled out in text, never colour alone.
 *
 * A case is about the family's account, plan or the app, never about a child: the intake copy
 * (shared with the web portal through the contracts package) tells parents so, and nothing here
 * ever reads or shows a child name, homework text or answers.
 */

export {
  SUPPORT_INTAKE_NOTICE,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REFUND_NOTICE,
  SUPPORT_SUBJECT_MAX_LENGTH,
};

// ---------------------------------------------------------------------------------------------
// Kinds and statuses
// ---------------------------------------------------------------------------------------------

/** The kind picker, in the contract's order, labelled as on the web. */
export const SUPPORT_KIND_OPTIONS: readonly {
  readonly value: SupportCaseKind;
  readonly label: string;
}[] = supportCaseKindSchema.options.map((kind) => ({
  value: kind,
  label: SUPPORT_CASE_KIND_LABELS[kind],
}));

/** One calm line under the kind picker saying what to include. */
export const KIND_HINTS: Readonly<Record<SupportCaseKind, string>> = {
  complaint:
    'Tell us what went wrong with your account, your plan or the app, and what you’d like us to do.',
  refund_request:
    'Choose the billing period below if you can. The store issues the refund; we help you get there.',
  billing_issue:
    'A charge you don’t recognise, a wrong amount, or a plan change that didn’t apply.',
  bug: 'What you were doing, what you expected, and what happened instead. No homework text, please.',
  safety_question:
    'Questions about how PencilLift keeps children safe. Safety reports for your own family are under Privacy and data.',
  other: 'Anything else about your account, your plan or the app.',
};

/** What each status means for the parent, shown next to the status label. */
export const STATUS_NOTES: Readonly<Record<SupportCaseStatus, string>> = {
  open: 'We’ve received it and will reply here.',
  in_progress: 'Someone on the PencilLift team is looking into it.',
  waiting_on_parent: 'We’ve asked you something. Reply below when you can.',
  resolved: 'If you still need help, reply below and the case reopens.',
  closed: 'This case takes no more replies. If you need more help, open a new case.',
};

export const EMPTY_CASES_COPY =
  'No support cases yet. If something about your account, your plan or the app needs attention, open a case below and we’ll reply here.';

export function statusLabel(status: SupportCaseStatus): string {
  return SUPPORT_CASE_STATUS_LABELS[status];
}

// ---------------------------------------------------------------------------------------------
// Ageing and dates
// ---------------------------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export function shortDate(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

/**
 * How long ago an instant was, for a reader: "just now", "5 minutes ago", "3 hours ago",
 * "2 days ago", and the date once it is a week or more old. A future instant (clock skew) reads
 * as "just now" rather than a negative age.
 */
export function ageLabel(iso: string, now: Date, timeZone?: string): string {
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (Number.isNaN(elapsed) || elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${plural(Math.floor(elapsed / MINUTE_MS), 'minute')} ago`;
  if (elapsed < DAY_MS) return `${plural(Math.floor(elapsed / HOUR_MS), 'hour')} ago`;
  if (elapsed < 7 * DAY_MS) return `${plural(Math.floor(elapsed / DAY_MS), 'day')} ago`;
  return `on ${shortDate(iso, timeZone)}`;
}

// ---------------------------------------------------------------------------------------------
// Billing periods (refund requests)
// ---------------------------------------------------------------------------------------------

type Channel = SupportBillingPeriod['channel'];

/** Store names as parents know them; a channel the contract adds later shows its raw key until named here. */
const CHANNEL_NAMES = {
  app_store: 'App Store',
  play_store: 'Google Play',
  stripe: 'Web billing',
  amazon_appstore: 'Amazon Appstore',
} as const satisfies Record<Channel, string>;

export function channelName(channel: Channel): string {
  return (CHANNEL_NAMES as Record<string, string>)[channel] ?? channel;
}

const SETTLEMENT_LABELS: Readonly<Record<BillingSettlement, string>> = {
  pending: 'not settled by the store yet',
  settled: 'settled',
  failed: 'reported as failed by the store',
  refunded: 'refunded by the store',
  partially_refunded: 'partly refunded by the store',
  chargeback: 'charged back through the store',
};

/** "App Store · Sep 1, 2026 to Oct 1, 2026 · $39.99 for 1 child". */
export function periodLabel(period: SupportBillingPeriod, timeZone?: string): string {
  const slots = `${period.paidSlots} ${period.paidSlots === 1 ? 'child' : 'children'}`;
  return `${channelName(period.channel)} · ${shortDate(period.periodStart, timeZone)} to ${shortDate(period.periodEnd, timeZone)} · ${formatUsd(period.chargedCents)} for ${slots}`;
}

/** Short enough for a picker chip: "App Store · Sep 1, 2026 · $39.99". */
export function periodChipLabel(period: SupportBillingPeriod, timeZone?: string): string {
  return `${channelName(period.channel)} · ${shortDate(period.periodStart, timeZone)} · ${formatUsd(period.chargedCents)}`;
}

/**
 * What the provider has reported on the period so far, truthfully: PencilLift never moves money
 * for a store purchase, so this line only repeats the store's report.
 */
export function refundLine(period: SupportBillingPeriod): string {
  const settlement = SETTLEMENT_LABELS[period.settlement];
  if (period.refundedCents > 0) {
    return `The store has reported ${formatUsd(period.refundedCents)} refunded on this period (${settlement}).`;
  }
  if (period.settlement === 'pending' || period.settlement === 'failed') {
    return `No refund reported by the store yet; this charge is ${settlement}.`;
  }
  return 'No refund reported by the store yet. This case updates when the store reports one.';
}

export const NO_PERIOD_VALUE = '';

/** The refund-request picker: "no specific period" first, then the family's periods, newest first as the API sends them. */
export function billingPeriodOptions(
  periods: readonly SupportBillingPeriod[],
  timeZone?: string,
): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: NO_PERIOD_VALUE, label: 'Not sure which period' },
    ...periods.map((p) => ({ value: p.id, label: periodChipLabel(p, timeZone) })),
  ];
}

export const NO_PERIODS_COPY =
  'We don’t see a store purchase on your family yet, so there is no billing period to pick. You can still send the request.';

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

export interface CaseRow {
  readonly id: string;
  readonly subject: string;
  readonly kindLabel: string;
  readonly statusLabel: string;
  readonly statusNote: string;
  /** "Opened 2 days ago". */
  readonly openedLine: string;
  /** "No replies yet", "1 reply", "3 replies" (the opening message is not a reply). */
  readonly repliesLine: string;
  /** "Outcome: Refunded by the store", once resolved. */
  readonly outcomeLine: string | null;
  /** The staff asked the parent something: shown first and marked in text. */
  readonly needsYou: boolean;
  readonly canReply: boolean;
  readonly accessibilityLabel: string;
}

export function repliesLine(messageCount: number): string {
  if (messageCount === 0) return 'No replies yet';
  return plural(messageCount, 'reply').replace('replys', 'replies');
}

export function outcomeLine(c: Pick<SupportCase, 'resolution'>): string | null {
  return c.resolution === null ? null : `Outcome: ${SUPPORT_CASE_RESOLUTION_LABELS[c.resolution]}`;
}

export function caseRow(c: SupportCase, now: Date, timeZone?: string): CaseRow {
  const needsYou = c.status === 'waiting_on_parent';
  const openedLine = `Opened ${ageLabel(c.createdAt, now, timeZone)}`;
  const outcome = outcomeLine(c);
  return {
    id: c.id,
    subject: c.subject,
    kindLabel: SUPPORT_CASE_KIND_LABELS[c.kind],
    statusLabel: statusLabel(c.status),
    statusNote: STATUS_NOTES[c.status],
    openedLine,
    repliesLine: repliesLine(c.messageCount),
    outcomeLine: outcome,
    needsYou,
    canReply: c.canReply,
    accessibilityLabel: [
      c.subject,
      SUPPORT_CASE_KIND_LABELS[c.kind],
      needsYou ? 'Needs your reply' : statusLabel(c.status),
      openedLine,
      repliesLine(c.messageCount),
      ...(outcome ? [outcome] : []),
    ].join('. '),
  };
}

/**
 * Rows for the list: cases waiting on the parent first, then the rest in the order the API sends
 * them (newest first), so a question from the team is never buried under older cases.
 */
export function caseRows(cases: readonly SupportCase[], now: Date, timeZone?: string): CaseRow[] {
  const rows = cases.map((c) => caseRow(c, now, timeZone));
  return [...rows.filter((r) => r.needsYou), ...rows.filter((r) => !r.needsYou)];
}

// ---------------------------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------------------------

export interface ThreadEntry {
  readonly id: string;
  readonly author: 'You' | 'PencilLift support';
  /** "2 hours ago" / "on Sep 12, 2026". */
  readonly when: string;
  readonly body: string;
  /** The newest reply on the thread (never the opening message). */
  readonly isLatestReply: boolean;
}

/** The opening message first, then every reply oldest to newest; the newest reply is marked. */
export function threadEntries(
  detail: SupportCaseDetail,
  now: Date,
  timeZone?: string,
): ThreadEntry[] {
  const replies = [...detail.messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const latestId = replies.length > 0 ? replies[replies.length - 1]!.id : null;
  return [
    {
      id: detail.id,
      author: 'You',
      when: ageLabel(detail.createdAt, now, timeZone),
      body: detail.body,
      isLatestReply: false,
    },
    ...replies.map((m) => ({
      id: m.id,
      author: m.authorKind === 'parent' ? ('You' as const) : ('PencilLift support' as const),
      when: ageLabel(m.createdAt, now, timeZone),
      body: m.body,
      isLatestReply: m.id === latestId,
    })),
  ];
}

/** "Latest reply from PencilLift support, 2 hours ago", or null before any reply. */
export function latestReplyLine(
  detail: SupportCaseDetail,
  now: Date,
  timeZone?: string,
): string | null {
  const entries = threadEntries(detail, now, timeZone);
  const latest = entries.find((e) => e.isLatestReply);
  if (!latest) return null;
  const from = latest.author === 'You' ? 'you' : latest.author;
  return `Latest reply from ${from}, ${latest.when}`;
}

/** After a reply is accepted: says plainly when it put the case back with the team. */
export function replySentMessage(previous: SupportCaseStatus, next: SupportCaseStatus): string {
  if (previous !== next && next === 'open') {
    return 'Reply sent. Your case is open again and back with the PencilLift team.';
  }
  return 'Reply sent. We’ll answer here.';
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export interface CaseDraft {
  readonly kind: SupportCaseKind;
  readonly subject: string;
  readonly message: string;
  /** A billing period id, or NO_PERIOD_VALUE; only sent with a refund request. */
  readonly billingPeriodId: string;
}

export const EMPTY_DRAFT: CaseDraft = {
  kind: 'complaint',
  subject: '',
  message: '',
  billingPeriodId: NO_PERIOD_VALUE,
};

export type DraftField = 'subject' | 'message';
export type DraftProblems = Partial<Record<DraftField, string>>;

function lengthProblem(
  value: string,
  max: number,
  emptyMessage: string,
  what: string,
): string | null {
  if (value.length === 0) return emptyMessage;
  if (value.length > max) {
    return `Keep ${what} to ${max.toLocaleString('en-US')} characters (yours is ${value.length.toLocaleString('en-US')}).`;
  }
  return null;
}

/**
 * Checks a draft the way the server will (trim, then 1..120 and 1..2000), and builds the request
 * body. A billing period travels only with a refund request, so a period picked before the kind
 * was changed is dropped rather than rejected by the server.
 */
export function validateDraft(
  draft: CaseDraft,
):
  | { readonly ok: true; readonly body: CreateSupportCaseRequest }
  | { readonly ok: false; readonly problems: DraftProblems } {
  const subject = draft.subject.trim();
  const message = draft.message.trim();
  const problems: DraftProblems = {};
  const subjectProblem = lengthProblem(
    subject,
    SUPPORT_SUBJECT_MAX_LENGTH,
    'Add a short subject.',
    'the subject',
  );
  if (subjectProblem) problems.subject = subjectProblem;
  const messageProblem = lengthProblem(
    message,
    SUPPORT_MESSAGE_MAX_LENGTH,
    'Tell us what happened.',
    'your message',
  );
  if (messageProblem) problems.message = messageProblem;
  if (problems.subject || problems.message) return { ok: false, problems };
  const withPeriod = draft.kind === 'refund_request' && draft.billingPeriodId !== NO_PERIOD_VALUE;
  return {
    ok: true,
    body: {
      kind: draft.kind,
      subject,
      message,
      ...(withPeriod ? { billingPeriodId: draft.billingPeriodId } : {}),
    },
  };
}

export function validateReply(
  message: string,
):
  | { readonly ok: true; readonly body: ReplySupportCaseRequest }
  | { readonly ok: false; readonly problem: string } {
  const trimmed = message.trim();
  const problem = lengthProblem(
    trimmed,
    SUPPORT_MESSAGE_MAX_LENGTH,
    'Write your reply first.',
    'your reply',
  );
  return problem ? { ok: false, problem } : { ok: true, body: { message: trimmed } };
}

/** "1,980 characters left", never negative. */
export function charactersLeft(text: string, max: number): string {
  const left = Math.max(0, max - text.length);
  return `${left.toLocaleString('en-US')} ${left === 1 ? 'character' : 'characters'} left`;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export interface SupportProblem {
  readonly message: string;
  /** The server wants a fresh parent PIN step-up. */
  readonly needsPin: boolean;
  /** The caller has no family yet (NOT_FOUND while loading the list). */
  readonly noFamily: boolean;
}

export type SupportContext = 'load' | 'case' | 'open' | 'reply';

const GENERIC = 'Something went wrong. Please try again.';

/**
 * Turns a failure into calm parent copy keyed on stable codes and rules, never on server text
 * for anything but a business rule this module does not know.
 */
export function supportProblem(error: unknown, context: SupportContext): SupportProblem {
  const problem = (message: string, extra: Partial<SupportProblem> = {}): SupportProblem => ({
    message,
    needsPin: false,
    noFamily: false,
    ...extra,
  });
  if (!(error instanceof ApiRequestError)) return problem(GENERIC);
  const { code } = error;
  if (code === 'STEP_UP_REQUIRED') {
    return problem('Enter your parent PIN to continue, then try again.', { needsPin: true });
  }
  if (code === 'NOT_FOUND') {
    if (context === 'load') {
      return problem('Create your family in the parent portal first.', { noFamily: true });
    }
    return problem('This case isn’t available anymore. Refresh your cases to see what’s current.');
  }
  if (code === 'BUSINESS_RULE') {
    if (error.rule === SUPPORT_RULES.caseClosed) {
      return problem(
        'This case is closed, so it takes no more replies. If you need more help, open a new case.',
      );
    }
    if (error.rule === SUPPORT_RULES.billingPeriodNotFound) {
      return problem(
        'That billing period isn’t one of your family’s. Pick one from the list, or send the request without a period.',
      );
    }
    return problem(error.message);
  }
  if (code === 'RATE_LIMITED') {
    if (context === 'open') {
      return problem(
        'You’ve opened several cases in the last hour. Please wait a little before opening another; your existing cases are still with the team.',
      );
    }
    return problem(
      'You’ve sent quite a few messages in the last hour. Please wait a little and try again.',
    );
  }
  if (code === 'VALIDATION_FAILED') {
    return problem('Please check the subject and message, then try again.');
  }
  if (code === 'NETWORK') {
    return problem(
      isRequestTimeout(error)
        ? 'This is taking longer than usual. Check your connection and try again.'
        : 'You appear to be offline. Try again when you’re connected.',
    );
  }
  if (code === 'UNAUTHENTICATED') return problem('Please sign in again to use support.');
  if (code === 'CHILD_MODE_FORBIDDEN') {
    return problem('Support cases can only be opened by a grown-up.');
  }
  return problem(GENERIC);
}
