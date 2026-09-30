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
// A `pending` answer therefore covers two different events, so it carries the `reason` the route's own
// branch established (`closePendingReasonSchema`): only one of them is a family purge, and the other
// deletes nothing at all (HUNT7-E-1).
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

/**
 * Why a closure is still `pending`. The route sets it where the branch is taken, because the two
 * causes have different consequences for the parent and nothing downstream can tell them apart:
 * - `after_family_purge`: the family the caller OWNS is being purged and the durable `account_close`
 *   job closes the sign-in once that has finished. The sign-in stays usable until then, by design.
 * - `retrying`: the closing service could not be reached, so the sign-in is not closed yet and the
 *   queued job retries. Nothing is being purged for this parent — a guardian's own closure only
 *   revokes their membership, and an adult with no family has nothing to purge.
 */
export const closePendingReasonSchema = z.enum(['after_family_purge', 'retrying']);
export type ClosePendingReason = z.infer<typeof closePendingReasonSchema>;

export const closeAccountResponseSchema = z.discriminatedUnion('status', [
  /** The sign-in is gone now. `signOut` is always true: the device clears its parent session. */
  z.strictObject({ status: z.literal('closed'), signOut: z.literal(true) }),
  /** It is not closed yet; `reason` says which event the parent is waiting for. */
  z.strictObject({
    status: z.literal('pending'),
    reason: closePendingReasonSchema,
    signOut: z.literal(true),
  }),
]);
export type CloseAccountResponse = z.infer<typeof closeAccountResponseSchema>;

/**
 * A settled closure as the COPY needs it: one key per outcome, so a surface cannot pick a sentence for
 * `pending` without saying which pending it means.
 */
export type AccountCloseOutcome = 'closed' | ClosePendingReason;

/**
 * The one place a closure answer becomes a copy key. Both surfaces call it (the portal's
 * AccountCloseSection and the app's `runAccountClosure`) so neither can re-derive the outcome from the
 * status alone, which is the mistake that let one `pending` sentence stand for both causes.
 */
export function accountCloseOutcome(
  answer:
    | { readonly status: 'closed' }
    | { readonly status: 'pending'; readonly reason: ClosePendingReason },
): AccountCloseOutcome {
  return answer.status === 'closed' ? 'closed' : answer.reason;
}

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
  // No `pending` line here: a pending closure has two causes and one sentence each, in
  // ACCOUNT_CLOSE_OUTCOME_COPY below. A single line for both told a guardian whose closing call was
  // merely refused to wait for a family deletion nobody had asked for (HUNT7-E-1).
  familyDeletionRequired:
    'Delete your whole family account first, then delete your account. Your sign-in closes once the family deletion has finished.',
} as const;

/**
 * What a parent reads for each settled outcome, in the two forms every surface needs. One definition,
 * shared by the portal (PrivacyControlsPage's AccountCloseSection and the public AccountDeletionPage)
 * and the app (parent-privacy.ts's `accountClosedDeviceMessage`), because they diverged once already
 * by each writing the closure clause out for themselves.
 *
 * - `full` ends with the CLIENT's half of the job ("and this device is signed out"), which only a
 *   surface that carried that half out may say.
 * - `serverOnly` says what the SERVER did and nothing about this device, for the paths that must deny
 *   or hedge the device half (a session that survived the sign-out, a device secret that stayed).
 *
 * Each pending cause gets its own sentence because they promise different things: one waits for a
 * deletion that is running, the other says the close itself has not gone through and is being retried,
 * with nothing being deleted meanwhile.
 */
export const ACCOUNT_CLOSE_OUTCOME_COPY = {
  closed: {
    full: ACCOUNT_CLOSE_COPY.closed,
    serverOnly: 'Your PencilLift account is closed.',
  },
  after_family_purge: {
    full: 'Your request is recorded. Your sign-in closes automatically once your family account’s deletion has finished, and this device is signed out now.',
    serverOnly:
      'Your request is recorded, and your sign-in closes automatically once your family account’s deletion has finished.',
  },
  retrying: {
    full: 'Your request is recorded, and this device is signed out now. We could not finish closing your sign-in just now, so it may still work for a little longer; PencilLift keeps trying until it is closed.',
    serverOnly:
      'Your request is recorded. We could not finish closing your sign-in just now, so it may still work for a little longer; PencilLift keeps trying until it is closed.',
  },
} as const satisfies Record<
  AccountCloseOutcome,
  { readonly full: string; readonly serverOnly: string }
>;

/**
 * HUNT6-F-1 / HUNT6-G-6: what a parent reads when this browser's session has been removed but the
 * auth service was never told to end it. Shared by the two surfaces that say it, so their wording
 * cannot drift apart: the portal's Sign out (apps/web/src/components/SignOutControl.tsx, `signInOpen`)
 * and the public deletion page (apps/web/src/pages/public/AccountDeletionPage.tsx, both strings). Each
 * is asserted against this constant where it is rendered — App.signout.test.tsx and
 * PrivacyControlsPage.test.tsx — so a surface that inlined its own sentence would turn a test red.
 *
 * HUNT6-F-SHARED-COPY: "and the app" was part of that list and was never true. The mobile app does not
 * import this constant. apps/mobile/src/privacy/parent-privacy.ts writes its own sentences in
 * accountClosedDeviceMessage, and they already differ — because they report a different fact: the app
 * knows whether ITS OWN device sign-out was confirmed, not whether the auth service was told, and it
 * points the parent at the app's parent menu rather than at a password. (ACCOUNT_CLOSE_COPY above is
 * genuinely shared with the app, which is how the list came to include it here.) Whether the app should
 * say this sentence too is a change to a mobile file, not to this one.
 *
 * Two strings, because the two situations offer different remedies and one of them offers none.
 * The first round of this copy named "sign out on your phone" first: every sign-out in this product
 * is scope 'local' by design (spec P3, L-039), so a phone sign-out ends the phone's session and
 * cannot touch this one — the first thing the parent was told to do did nothing, and they skipped
 * the one that helps. There is no "sign out everywhere" action in the product to point at.
 */
export const SIGN_OUT_NOT_TOLD_COPY = {
  /**
   * The sign-in still exists, so a password change is a remedy the parent can actually carry out: an
   * ordinary sign-out, and EITHER `pending` closure. HUNT7-E-1: this said "the `pending` closure, where
   * the sign-in stays usable until the family purge finishes", which is only the `after_family_purge`
   * cause; on `retrying` the sign-in is still there because the closing service refused and the queued
   * job has not closed it yet. The remedy is right on both, and the reason it is right differs — which
   * is why this string says nothing about why the sign-in is open, and the closure sentence beside it
   * (ACCOUNT_CLOSE_OUTCOME_COPY) does.
   */
  signInOpen:
    'This computer is signed out. We could not tell PencilLift’s servers to end the session, so change your password if you are worried.',
  /**
   * The sign-in is already closed (`closed`), so there is no password to change and no account to
   * sign into anywhere: naming either would ask the parent to do something the closure has just
   * made impossible.
   */
  signInClosed:
    'This computer is signed out. We could not tell PencilLift’s servers to end the session, but your sign-in is closed, so there is nothing left to do.',
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
