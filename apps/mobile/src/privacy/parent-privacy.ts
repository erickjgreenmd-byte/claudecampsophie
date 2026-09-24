/**
 * Parent privacy screen logic (spec P4, P10, P14 "export/delete"; AC_ACCESS_10, AC_SECURITY_05).
 * Request a private export, request deletion of a child or the whole family with typed
 * confirmation, and handle the server-enforced PIN step-up. Pure: no react-native imports.
 */
import {
  adultUnlockResponseSchema,
  dataExportResponseSchema,
  dataExportsResponseSchema,
  deletionRequestResponseSchema,
  deletionRequestsResponseSchema,
  PRIVACY_RETENTION,
  privacyFamilyViewSchema,
  type CreateDeletionRequest,
  type DataExport,
  type DeletionRequest,
  type PrivacyFamilyView,
  type StandardExportKind,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';

export const PRIVACY_RETENTION_LINES: readonly string[] = [
  `Raw homework photos are deleted after ${PRIVACY_RETENTION.rawScanDays} days by default. Deleting a child or your account removes them sooner.`,
  'Results, practice history, points and rewards are kept while your account is active, until you delete that child or your family account.',
  `When you ask for deletion, processing stops at once and devices are signed out. Deletion from our active systems completes within ${PRIVACY_RETENTION.deletionTargetDays} days.`,
  'Backups expire on a documented schedule (length to be confirmed).',
  'We may keep limited billing records where the law requires it, plus consent records and a security log with pseudonymous ids only.',
  'Deleting your PencilLift account does not cancel an App Store or Google Play subscription. Cancel it in the store.',
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
  ready: 'Ready — downloading in the app isn’t available yet',
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
}

const isNotFound = (error: unknown) =>
  error instanceof ApiRequestError && error.code === 'NOT_FOUND';

/** Loads everything the screen shows. A missing family is a state, not an error. */
export async function loadPrivacyOverview(api: ApiClient): Promise<PrivacyOverview> {
  const [family, deletions, exportsList] = await Promise.all([
    api.get('/v1/family', privacyFamilyViewSchema).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    }),
    api.get('/v1/deletion', deletionRequestsResponseSchema),
    api.get('/v1/exports', dataExportsResponseSchema).catch((error: unknown) => {
      if (isNotFound(error)) return { exports: [] };
      throw error;
    }),
  ]);
  return { family, deletions: deletions.requests, exports: exportsList.exports };
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
