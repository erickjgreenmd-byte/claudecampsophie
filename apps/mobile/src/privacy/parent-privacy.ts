/**
 * Parent privacy screen logic (spec P4, P10, P14 "export/delete"; AC_ACCESS_10, AC_SECURITY_05;
 * Apple 5.1.1(v) / Google Play account deletion). Request a private export and open a ready one,
 * request deletion of a child or the whole family with typed confirmation, delete the parent's own
 * sign-in, and handle the server-enforced PIN step-up. Pure: no react-native imports.
 */
import {
  ACCOUNT_CLOSE_COPY,
  ACCOUNT_CLOSE_RULES,
  adultUnlockResponseSchema,
  closeAccountResponseSchema,
  dataExportResponseSchema,
  dataExportsResponseSchema,
  deletionRequestResponseSchema,
  deletionRequestsResponseSchema,
  exportDownloadResponseSchema,
  PARENT_SAFETY_FLAG_ACTIONS,
  PARENT_SAFETY_FLAG_COPY,
  PRIVACY_RETENTION,
  privacyFamilyViewSchema,
  safetyReportResponseSchema,
  safetyReportsResponseSchema,
  type CreateDeletionRequest,
  type DataExport,
  type DeletionRequest,
  type ListedSafetyReportCategory,
  type ParentReportOutcome,
  type PrivacyFamilyView,
  type SafetyFlagEmailStatus,
  type SafetyReport,
  type SafetyReportStatus,
  type StandardExportKind,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';

export const PRIVACY_RETENTION_LINES: readonly string[] = [
  `Raw homework photos are deleted after ${PRIVACY_RETENTION.rawScanDays} days by default. Deleting a child or your account removes them sooner.`,
  'Results, practice history, points and rewards are kept while your account is active, until you delete that child or your family account.',
  `When you ask for deletion, processing stops at once and devices are signed out. Deletion from our active systems completes within ${PRIVACY_RETENTION.deletionTargetDays} days.`,
  'Backups expire on a documented schedule (length to be confirmed).',
  'We may keep limited billing records where the law requires it, plus consent records and a security log with pseudonymous ids only.',
  'Deleting your PencilLift account does not cancel an App Store, Google Play or Amazon Appstore subscription. Cancel it in the store.',
];

/**
 * Decision: the phone screen offers whole-family exports only. Per-child review PDFs and the
 * parent-only answer key are requested from the web portal, which has the child picker and the
 * distinct answer-key route; nothing here can ask for an answer key.
 */
export const MOBILE_EXPORT_OPTIONS: readonly { kind: StandardExportKind; label: string }[] = [
  { kind: 'family_data', label: 'All family data' },
  { kind: 'progress_pdf', label: 'Progress summary (PDF)' },
  { kind: 'progress_csv', label: 'Progress data (CSV)' },
];

const EXPORT_KIND_LABELS: Record<DataExport['kind'], string> = {
  family_data: 'All family data',
  progress_pdf: 'Progress summary (PDF)',
  progress_csv: 'Progress data (CSV)',
  review_questions_pdf: 'Thursday review questions (PDF)',
  review_answer_key_pdf: 'Thursday review answer key (PDF)',
};

const EXPORT_STATUS_LABELS: Record<DataExport['status'], string> = {
  queued: 'Requested — waiting to be prepared',
  ready: 'Ready to download',
  failed: 'Couldn’t be prepared — please request it again',
  expired: 'Expired — request a new copy',
};

export function exportLine(item: DataExport): string {
  return `${EXPORT_KIND_LABELS[item.kind]} · ${EXPORT_STATUS_LABELS[item.status]}`;
}

export type DeletionTarget =
  | { readonly scope: 'family' }
  | { readonly scope: 'child'; readonly childId: string; readonly nickname: string };

export const FAMILY_CONFIRMATION = 'DELETE';

/** What the parent must type before a deletion is sent. */
export function confirmationPhrase(target: DeletionTarget): string {
  return target.scope === 'family' ? FAMILY_CONFIRMATION : target.nickname;
}

/**
 * Decision: a child's nickname matches ignoring case and surrounding spaces; the family phrase must
 * be DELETE in capitals. The server-side PIN step-up is the security control; this guards slips.
 */
export function confirmationMatches(target: DeletionTarget, typed: string): boolean {
  const value = typed.trim();
  return target.scope === 'family'
    ? value === FAMILY_CONFIRMATION
    : value.toLowerCase() === target.nickname.trim().toLowerCase();
}

export type ActionResult =
  | { readonly status: 'done'; readonly message: string }
  | { readonly status: 'step_up' }
  | { readonly status: 'error'; readonly message: string };

export function parentErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Something went wrong. Please try again.';
  if (error.code === 'NETWORK')
    return 'You appear to be offline. Check your connection and try again.';
  if (error.code === 'RATE_LIMITED') {
    return 'There have been too many requests. Please wait a little and try again.';
  }
  return error.message;
}

function toResult(error: unknown): ActionResult {
  if (error instanceof ApiRequestError && error.code === 'STEP_UP_REQUIRED') {
    return { status: 'step_up' };
  }
  return { status: 'error', message: parentErrorMessage(error) };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export async function requestExportAction(
  api: ApiClient,
  kind: StandardExportKind,
): Promise<ActionResult> {
  try {
    await api.send('POST', '/v1/exports', { kind }, dataExportResponseSchema);
    return { status: 'done', message: 'Export requested. Its status is shown below.' };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * Opens a ready export: the API answers a one-minute signed link (family and step-up checked
 * server-side; never a durable URL), which `open` hands to the system browser. The link is never
 * shown or stored.
 */
export async function exportDownloadAction(
  api: ApiClient,
  exportId: string,
  open: (url: string) => Promise<void>,
): Promise<ActionResult> {
  try {
    const link = await api.get(`/v1/exports/${exportId}/download`, exportDownloadResponseSchema);
    await open(link.url);
    return { status: 'done', message: 'Opening your download. The link works for one minute.' };
  } catch (error) {
    return toResult(error);
  }
}

export type CloseAccountResult =
  | { readonly status: 'closed' | 'pending'; readonly message: string }
  | { readonly status: 'step_up' }
  | { readonly status: 'error'; readonly message: string };

/**
 * Deletes the parent's own sign-in (POST /v1/account/close). Nothing is sent until the parent has
 * ticked the confirmation; the server needs a recent PIN unlock. A family owner is told to delete
 * the family account first (the server's FAMILY_DELETION_REQUIRED rule); `closed` and `pending`
 * both mean the device must sign out now (the API's signOut flag).
 */
export async function closeAccountAction(
  api: ApiClient,
  confirmed: boolean,
): Promise<CloseAccountResult> {
  if (!confirmed) return { status: 'error', message: 'Tick the box to confirm.' };
  try {
    const result = await api.send(
      'POST',
      '/v1/account/close',
      { confirm: true },
      closeAccountResponseSchema,
    );
    return {
      status: result.status,
      message: result.status === 'closed' ? ACCOUNT_CLOSE_COPY.closed : ACCOUNT_CLOSE_COPY.pending,
    };
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      error.code === 'CONFLICT' &&
      error.rule === ACCOUNT_CLOSE_RULES.familyDeletionRequired
    ) {
      return { status: 'error', message: ACCOUNT_CLOSE_COPY.familyDeletionRequired };
    }
    const fallback = toResult(error);
    return fallback.status === 'step_up'
      ? fallback
      : { status: 'error', message: parentErrorMessage(error) };
  }
}

export async function requestDeletionAction(
  api: ApiClient,
  target: DeletionTarget,
  typed: string,
): Promise<ActionResult> {
  if (!confirmationMatches(target, typed)) {
    return {
      status: 'error',
      message:
        target.scope === 'family'
          ? 'Type DELETE in capital letters to confirm.'
          : `Type ${target.nickname} exactly to confirm.`,
    };
  }
  const body: CreateDeletionRequest =
    target.scope === 'family' ? { scope: 'family' } : { scope: 'child', childId: target.childId };
  try {
    const { deletion } = await api.send(
      'POST',
      '/v1/deletion',
      body,
      deletionRequestResponseSchema,
    );
    return {
      status: 'done',
      message: `Deletion requested. Processing has stopped and deletion completes by ${formatDate(deletion.completeBy)}.`,
    };
  } catch (error) {
    return toResult(error);
  }
}

export async function unlockAction(
  api: ApiClient,
  pin: string,
): Promise<{ ok: true; unlockedUntil: string } | { ok: false; message: string }> {
  if (!/^\d{6}$/.test(pin)) return { ok: false, message: 'Enter your 6-digit parent PIN.' };
  try {
    const result = await api.send(
      'POST',
      '/v1/adult/unlock',
      { method: 'pin', pin },
      adultUnlockResponseSchema,
    );
    return { ok: true, unlockedUntil: result.unlockedUntil };
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'FORBIDDEN') {
      return { ok: false, message: 'That PIN is not correct.' };
    }
    if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') {
      return { ok: false, message: 'Set a parent PIN first.' };
    }
    return { ok: false, message: parentErrorMessage(error) };
  }
}

export interface PrivacyOverview {
  /** Null when the account has no live family (for example after a family deletion). */
  readonly family: PrivacyFamilyView | null;
  readonly deletions: readonly DeletionRequest[];
  readonly exports: readonly DataExport[];
  /** The family's safety reports, newest first (empty without a live family). */
  readonly reports: readonly SafetyReport[];
}

const isNotFound = (error: unknown) =>
  error instanceof ApiRequestError && error.code === 'NOT_FOUND';

/** Loads everything the screen shows. A missing family is a state, not an error. */
export async function loadPrivacyOverview(api: ApiClient): Promise<PrivacyOverview> {
  const [family, deletions, exportsList, reportsList] = await Promise.all([
    api.get('/v1/family', privacyFamilyViewSchema).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    }),
    api.get('/v1/deletion', deletionRequestsResponseSchema),
    api.get('/v1/exports', dataExportsResponseSchema).catch((error: unknown) => {
      if (isNotFound(error)) return { exports: [] };
      throw error;
    }),
    api.get('/v1/safety-reports', safetyReportsResponseSchema).catch((error: unknown) => {
      if (isNotFound(error)) return { reports: [] };
      throw error;
    }),
  ]);
  return {
    family,
    deletions: deletions.requests,
    exports: exportsList.exports,
    reports: reportsList.reports,
  };
}

/** The family-wide deletion shown as the deleted-account state, if any. */
export function familyDeletion(deletions: readonly DeletionRequest[]): DeletionRequest | null {
  return deletions.find((d) => d.scope === 'family' && d.status !== 'cancelled') ?? null;
}

/** Children that can still be deleted (none with a deletion already in progress). */
export function deletableChildren(
  family: PrivacyFamilyView,
  deletions: readonly DeletionRequest[],
): PrivacyFamilyView['children'] {
  const open = new Set(
    deletions
      .filter((d) => d.scope === 'child' && (d.status === 'requested' || d.status === 'processing'))
      .map((d) => d.childId),
  );
  return family.children.filter((c) => !open.has(c.id));
}

export function deletionStatusText(d: DeletionRequest): string {
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

// ---------------------------------------------------------------------------------------------
// Family safety reports (owner decision, 2026-09-25: the parent is the only safety recipient and
// addresses the concern). Same copy as the web portal: everything shown comes from the contracts.
// ---------------------------------------------------------------------------------------------

/**
 * Honest by construction: no flag is held from this list, the guardian email's state is the
 * recorded delivery (never assumed), and nothing promises a staffed review of every flag (Owner
 * action #24). Reports are sent from the web portal, which has the form.
 */
export const SAFETY_REPORTS_INTRO =
  'When your child picks one of the “Tell PencilLift” choices in the app, or you send a report from the parent portal on the web, it is saved to PencilLift’s review queue and its status is shown here. PencilLift also adds a report when its safety check flags one of your child’s answers for a grown-up to look at, and emails the guardians on this account so they know to look; each flag says whether that email was sent. For that question, your child’s results show a calm message about talking with a grown-up they trust instead of a hint, and PencilLift gives no hints on it.';

const REPORT_CATEGORY_LABELS: Record<ListedSafetyReportCategory, string> = {
  unsafe_content: 'Unsafe or inappropriate content',
  wrong_or_confusing: 'Wrong or confusing',
  upsetting: 'Something upsetting',
  answer_revealed: 'Showed an answer',
  other: 'Something else',
  severe_risk: PARENT_SAFETY_FLAG_COPY.category,
};

const REPORT_STATUS_LABELS: Record<SafetyReportStatus, string> = {
  open: 'Waiting for review',
  triaged: 'Being reviewed',
  escalated: 'Escalated for urgent review',
  resolved: 'Resolved',
};

/** The recorded delivery of the guardian email a flag sends (migration 0790). */
const EMAIL_STATE_COPY: Record<SafetyFlagEmailStatus, string> = {
  sent: PARENT_SAFETY_FLAG_COPY.emailSent,
  not_sent: PARENT_SAFETY_FLAG_COPY.emailNotSent,
  failed: PARENT_SAFETY_FLAG_COPY.emailFailed,
};

export interface SafetyReportAction {
  readonly outcome: ParentReportOutcome;
  readonly label: string;
  readonly effect: string;
}

export interface SafetyReportView {
  readonly id: string;
  readonly title: string;
  /** Who reported it, its status and its date. */
  readonly meta: string;
  readonly note: string | null;
  /** What the row says: the flag's state, the email state, the hotlines (in reading order). */
  readonly lines: readonly string[];
  /** Empty for a resolved report and for a parent's own report (reviewed by PencilLift). */
  readonly actions: readonly SafetyReportAction[];
}

const ADDRESSED_ACTION: SafetyReportAction = {
  outcome: 'addressed',
  ...PARENT_SAFETY_FLAG_ACTIONS.addressed,
};
const FALSE_MATCH_ACTION: SafetyReportAction = {
  outcome: 'false_match',
  ...PARENT_SAFETY_FLAG_ACTIONS.falseMatch,
};

function childNickname(family: PrivacyFamilyView | null, childId: string | null): string {
  return family?.children.find((c) => c.id === childId)?.nickname ?? 'A removed child profile';
}

function reporterText(family: PrivacyFamilyView | null, report: SafetyReport): string {
  switch (report.reporterKind) {
    case 'child':
      return `Reported by ${childNickname(family, report.childId)}`;
    case 'parent':
      return 'Reported by a parent';
    case 'system':
      return `${PARENT_SAFETY_FLAG_COPY.reporter} · about ${childNickname(family, report.childId)}`;
  }
}

/** What a flag says about itself: the state after a clearing or a guardian's action, else the summary. */
function flagText(report: SafetyReport): string {
  if (report.clearedAsFalseMatch) return PARENT_SAFETY_FLAG_COPY.cleared;
  if (report.parentOutcome === 'addressed') return PARENT_SAFETY_FLAG_COPY.addressed;
  return PARENT_SAFETY_FLAG_COPY.summary;
}

/**
 * One report row. A flag says what the product shows the child, whether the guardian email was
 * sent and the hotlines; a child's report says no email was sent for it. While a flag or a child's
 * report is unresolved the guardian can mark it looked into (nothing changes for the child) or,
 * for a flag, a false alarm (the reviewer's clearing: the notice goes and the question is checked
 * normally). Both need a recent PIN unlock, checked by the server.
 */
export function safetyReportView(
  family: PrivacyFamilyView | null,
  report: SafetyReport,
): SafetyReportView {
  const meta = `${reporterText(family, report)} · ${REPORT_STATUS_LABELS[report.status]} · ${formatDate(report.createdAt)}`;
  const lines: string[] = [];
  if (report.reporterKind === 'system') {
    lines.push(
      flagText(report),
      EMAIL_STATE_COPY[report.emailStatus],
      PARENT_SAFETY_FLAG_COPY.resources,
    );
  } else if (report.reporterKind === 'child') {
    if (report.parentOutcome === 'addressed')
      lines.push(PARENT_SAFETY_FLAG_COPY.childReportAddressed);
    lines.push(EMAIL_STATE_COPY[report.emailStatus]);
  }
  const actionable = report.status !== 'resolved' && report.reporterKind !== 'parent';
  const actions = actionable
    ? report.reporterKind === 'system'
      ? [ADDRESSED_ACTION, FALSE_MATCH_ACTION]
      : [ADDRESSED_ACTION]
    : [];
  return {
    id: report.id,
    title: REPORT_CATEGORY_LABELS[report.category],
    meta,
    note: report.note,
    lines,
    actions,
  };
}

/** PATCH /v1/safety-reports/:id with the guardian's outcome; the server checks the PIN unlock. */
export async function reportOutcomeAction(
  api: ApiClient,
  reportId: string,
  outcome: ParentReportOutcome,
): Promise<ActionResult> {
  try {
    await api.send(
      'PATCH',
      `/v1/safety-reports/${reportId}`,
      { outcome },
      safetyReportResponseSchema,
    );
    return {
      status: 'done',
      message:
        outcome === 'addressed'
          ? 'Marked as looked into. Nothing changes for your child.'
          : 'Cleared as a false alarm. The message is removed from your child’s results for that question, and PencilLift is checking it normally.',
    };
  } catch (error) {
    return toResult(error);
  }
}
