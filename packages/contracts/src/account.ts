// Account closure (Apple App Store 5.1.1(v), Google Play account-deletion policy): the parent's own
// sign-in, as distinct from the family's data (privacy.ts). Owned by the account-close area; the lead
// owns this file's registration in index.ts.
//
// POST /v1/account/close (parent token + recent PIN unlock, server-checked):
// - a family OWNER must already have asked for the family's deletion (POST /v1/deletion, scope
//   family); the sign-in is then closed by a durable job once the family purge has completed, so
//   the answer is `pending`;
// - an invited GUARDIAN is removed from the family and their sign-in is closed at once (`closed`;
//   `pending` only when the closing service was unreachable, in which case the queued job retries);
// - an adult with no family closes their sign-in at once.
// Every answer carries `signOut: true`: the device clears its parent session through the app's
// normal sign-out path. Child devices of an owner's family keep working until the family purge,
// which already revokes them.
import { z } from 'zod';
import { isoDateTimeSchema } from './common.ts';

/** Stable `rule` codes returned with 409 by POST /v1/account/close. */
export const ACCOUNT_CLOSE_RULES = {
  /** A family owner deletes the family account first; their sign-in closes after that purge. */
  familyDeletionRequired: 'FAMILY_DELETION_REQUIRED',
} as const;

/** The parent's explicit confirmation; anything but `confirm: true` is refused. */
export const closeAccountRequestSchema = z.strictObject({
  confirm: z.literal(true),
});
export type CloseAccountRequest = z.infer<typeof closeAccountRequestSchema>;

export const closeAccountStatusSchema = z.enum(['closed', 'pending']);
export type CloseAccountStatus = z.infer<typeof closeAccountStatusSchema>;

export const closeAccountResponseSchema = z.strictObject({
  /** `closed`: the sign-in is gone now. `pending`: it closes once the family purge has completed. */
  status: closeAccountStatusSchema,
  /** Always true: the device must clear its parent session now. */
  signOut: z.literal(true),
});
export type CloseAccountResponse = z.infer<typeof closeAccountResponseSchema>;

/**
 * Honest copy shared by the portal and the app (spec P14: what the product does, nothing more).
 * The store subscription line matches the deletion screens: PencilLift never cancels a store
 * subscription.
 */
export const ACCOUNT_CLOSE_COPY = {
  title: 'Delete my account',
  intro:
    'This closes your PencilLift sign-in: your email address and password stop working in the app and on the parent portal, and this device is signed out. It can’t be undone.',
  ownerRule:
    'If you are the family owner, delete your whole family account first (above). Your sign-in closes once that deletion has finished, usually within minutes; until then you can still sign in to check on it.',
  guardianRule:
    'If you joined a family by invitation, you are removed from that family at once. The family and its children’s data stay with the family owner.',
  keep: 'Billing records, consent records and the security log keep only a pseudonymous id, never your email address.',
  storeNotice:
    'Deleting your account does not cancel an App Store, Google Play or Amazon Appstore subscription. Cancel it in the store first if you no longer want to be charged.',
  confirmLabel: 'I understand my sign-in will be closed and this can’t be undone',
  action: 'Delete my account',
  closed: 'Your PencilLift account is closed and this device is signed out.',
  pending:
    'Your request is recorded. Your sign-in closes automatically once your family account’s deletion has finished, and this device is signed out now.',
  familyDeletionRequired:
    'Delete your whole family account first, then delete your account. Your sign-in closes once the family deletion has finished.',
} as const;

// ---------------------------------------------------------------------------------------------
// Export downloads (GET /v1/exports/:id/download; apps/api/src/routes/export-download.ts). Kept
// here rather than in privacy.ts because that file belongs to the privacy vertical; the route
// answers a one-minute signed link, never the bytes or a durable URL.
// ---------------------------------------------------------------------------------------------

export const exportDownloadResponseSchema = z.strictObject({
  url: z.url(),
  expiresAt: isoDateTimeSchema,
});
export type ExportDownload = z.infer<typeof exportDownloadResponseSchema>;
