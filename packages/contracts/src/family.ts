import { z } from 'zod';
import { freeTextSchema, ianaZoneSchema, isoDateTimeSchema, uuidSchema } from './common.ts';

/**
 * Family vertical contracts (spec P1 guardians, P3 identity/consent/authorization, P14 parent
 * screens): family overview, child profiles, paired devices, guardians/invitations and consent.
 * Every response schema is strict so a server change that adds a private field fails loudly.
 */

// ---------------------------------------------------------------------------------------------
// Family and child profiles
// ---------------------------------------------------------------------------------------------

/** draft: no paid slot, no charge, no premium access; active: holds a paid slot; archived: history. */
export const CHILD_PROFILE_STATUSES = ['draft', 'active', 'archived'] as const;
export const childProfileStatusSchema = z.enum(CHILD_PROFILE_STATUSES);
export type ChildProfileStatus = z.infer<typeof childProfileStatusSchema>;

/**
 * PARENT-FACING COPY ABOUT A CHILD'S STATUS — ONE DEFINITION, BOTH SURFACES.
 *
 * This exists because the claim "one helper decides the sentence for every surface" was written five
 * times inside `apps/web` alone (HUNT6-G-2, HUNT6-H-4, WEBR4-03, HUNT5-F-1, HUNT6-G-8) and was false
 * every time: the phone kept printing the older sentence, and seven of round 7's sixty findings are
 * that one shape. Round 7's first repair made the two helpers BYTE-IDENTICAL in two files and tied
 * them together with tests that read each other's source. A stage-4 checker and the repo-wide parity
 * audit both refused that: a source pin catches a reworded sentence but NOT a widened predicate, so it
 * guards the words and not the meaning — two identical switch bodies are a coincidence with good odds,
 * not an invariant (L-066, L-070).
 *
 * So the decision lives here, where `apps/web` and `apps/mobile` can both import it and neither can
 * hold its own copy. `packages/contracts/src/family.ts` is already `export *`-ed from the index, so
 * this needs no new registration point.
 *
 * The API is a FUNCTION over the child rather than a lookup table on the status, because the deciding
 * fact is not the status: `public.request_deletion` archives a child-scope target in the same
 * transaction that enqueues the purge, so EVERY deletion-pending child is `archived`, and a table
 * keyed on status alone would answer "Archived: history only" — that the history is KEPT — for exactly
 * the children whose history is being deleted. The flag is therefore tested FIRST, and a caller cannot
 * skip that by reading a different key.
 */
export interface ChildCopySubject {
  readonly status: string;
  /**
   * `| undefined` explicitly: with `exactOptionalPropertyTypes` a caller's parsed
   * `deletionPending?: boolean | undefined` is not assignable to a bare optional (HUNT5-F-2).
   */
  readonly deletionPending?: boolean | undefined;
}

/** What the parent reads when the purge is running. Precedes every status word. */
export const CHILD_DELETION_PENDING_STATUS = 'Data deletion under way';

/**
 * The status sentence, for a child whose data is NOT being deleted. Exported so a test can assert the
 * set is exactly `CHILD_PROFILE_STATUSES` — a fourth status must not fall through to a sentence
 * written for a third (L-057).
 */
export const CHILD_STATUS_COPY: Readonly<Record<ChildProfileStatus, string>> = {
  draft: 'Draft: not active yet, no charge',
  active: 'Active: uses a paid slot',
  archived: 'Archived: history only',
};

/** The one status sentence both the portal and the app print. */
export function childStatusCopy(child: ChildCopySubject): string {
  if (child.deletionPending === true) return CHILD_DELETION_PENDING_STATUS;
  return Object.hasOwn(CHILD_STATUS_COPY, child.status)
    ? CHILD_STATUS_COPY[child.status as ChildProfileStatus]
    : // A status neither surface has heard of: say what is certain and claim nothing else. Answering
      // with a third status's sentence is how "no paid child slots yet" reached a family whose plan
      // had lapsed (BUG-406).
      'Status unavailable';
}

/**
 * The suffix on a child's name in a picker. Two of its three arms had DIVERGED between the surfaces
 * (the audit's finding): the portal said ' (archived — history only)' where the phone said
 * ' (archived — plan is read-only)', and the portal's `default:` arm said ' (no paid slot YET)' where
 * the phone said ' (no paid slot)'. "Yet" is the word BUG-406 removed from the same claim elsewhere,
 * and it is false for a family whose plan lapsed: `releaseSlotlessProfiles` returns a previously
 * ACTIVE child to 'draft' on an expiry or a store-confirmed downgrade. The portal kept it here, on two
 * further pages, because the repair's grep was for the other wording.
 */
export const CHILD_PICKER_SUFFIX_COPY = {
  deletionPending: ' (data deletion under way)',
  draft: ' (no paid slot)',
  active: '',
  archived: ' (archived — history only)',
} as const;

/** The one picker suffix both surfaces print. */
export function childPickerSuffixCopy(child: ChildCopySubject): string {
  if (child.deletionPending === true) return CHILD_PICKER_SUFFIX_COPY.deletionPending;
  return Object.hasOwn(CHILD_PICKER_SUFFIX_COPY, child.status)
    ? CHILD_PICKER_SUFFIX_COPY[child.status as ChildProfileStatus]
    : // Claim nothing for a status we do not know rather than assert the draft arm (L-057).
      '';
}

/**
 * THE NOTE BESIDE A CHILD'S POINTS BALANCE — ONE DEFINITION, BOTH SURFACES.
 *
 * This was the THIRD independently written wording of the status claim above, and the last one still
 * inline in a page: `BalancesSection` (apps/web/src/pages/app/RewardsPage.tsx) built it from its own
 * expression — `({child.status === 'archived' ? 'archived' : 'no paid slot'} — history only)` —
 * while the phone's `buildParentApprovalsView` (apps/mobile/src/rewards/parent-view-model.ts)
 * printed the nickname and the points and NOTHING about the status at all.
 *
 * WHY THE PHONE HAS TO PRINT IT — from what the status means, not from symmetry. GET /v1/rewards
 * returns EVERY profile's balance, archived and draft included, because earned points are history
 * (spec P11; its `children` query filters on `notBeingDeleted` alone, apps/api/src/routes/rewards.ts).
 * For a profile that is not 'active' nothing can be added to that number from the child's side:
 * `app.current_child_id()` requires `c.status = 'active'` (migration 0001), so no child device
 * resolves a session, practises or asks for a reward under it; and POST /v1/rewards refuses a new
 * reward for an archived profile ('CHILD_ARCHIVED'). So the number is a closed total, and a bare
 * number reads as a live one on whichever surface prints it — the note is the whole difference
 * between "Jordan has 30 points to spend" and "Jordan's 30 points are what is left on a closed
 * profile". A parent on the phone was reading the first sentence about the second profile.
 *
 * 'active' is `null`: a live balance needs no note. The parentheses are part of the copy so both
 * surfaces print the same bytes instead of each framing the words their own way.
 */
export const REWARD_BALANCE_STATUS_NOTE: Readonly<Record<ChildProfileStatus, string | null>> = {
  draft: '(no paid slot — history only)',
  active: null,
  archived: '(archived — history only)',
};

/**
 * What the note says while a purge is running. It must NOT say "history only", which claims the
 * history is KEPT, about the one child whose history is being deleted — the same reason
 * `childStatusCopy` and `childPickerSuffixCopy` test this flag before the status.
 *
 * `rewardChildBalanceSchema` (./rewards.ts) cannot carry the flag today: it is a strictObject
 * without one, and GET /v1/rewards drops a deletion-pending child from `children` altogether. So
 * this arm is unreachable from that response and is asserted on the function directly in
 * family.test.ts. It exists so that a response which ever starts carrying the flag — or any other
 * caller of this helper — prints the deletion instead of the kept-history sentence, rather than the
 * change to the contract silently choosing the wrong sentence.
 */
export const REWARD_BALANCE_DELETION_PENDING_NOTE =
  '(data deletion under way — these points are being deleted)';

/**
 * A status neither surface has heard of. It names the CONSEQUENCE, which is certain for every
 * non-active status (`app.current_child_id()` requires 'active', so nothing new is earned), and no
 * CAUSE, which is not. Answering with the draft arm's "no paid slot" is how "no paid child slots
 * yet" reached a family whose plan had lapsed (BUG-406), and it is what the portal's `? :` did here
 * for anything that was not 'archived' — including a status added after it was written.
 */
export const REWARD_BALANCE_UNKNOWN_STATUS_NOTE = '(history only)';

/** The one note both the portal and the app print beside a points balance. */
export function rewardBalanceStatusNote(child: ChildCopySubject): string | null {
  if (child.deletionPending === true) return REWARD_BALANCE_DELETION_PENDING_NOTE;
  if (!Object.hasOwn(REWARD_BALANCE_STATUS_NOTE, child.status))
    return REWARD_BALANCE_UNKNOWN_STATUS_NOTE;
  return REWARD_BALANCE_STATUS_NOTE[child.status as ChildProfileStatus];
}

/**
 * Whether PencilLift prepares practice for this child. The single definition of the question that four
 * separate screen regions were each deciding for themselves (BUG-402, L-068), now shared by the portal
 * and the app rather than mirrored in each.
 *
 * The four statements that decide it: `app.current_child_id()` requires `c.status = 'active'`
 * (migration 0001), so no request from the child's device can open a set for any other status;
 * `loadChildContext` prepares nothing for a non-active profile (apps/api/src/jobs/learning-jobs.ts);
 * activation is what assigns a paid slot; and archiving releases it.
 *
 * It is NOT the same question as "is this plan read-only" — `ownedChild(c, 'write')` keeps a DRAFT
 * child's plan writable on purpose, so the two agree for 'archived' and disagree for every draft. A
 * region that needs the other question must ask the other question.
 */
export function receivesPractice(childStatus: string | undefined): boolean {
  return childStatus === 'active';
}

// ---------------------------------------------------------------------------------------------
// A pairing code a parent screen is holding — ONE DEFINITION, BOTH SURFACES
// ---------------------------------------------------------------------------------------------

/**
 * WHETHER A PAIRING CODE A PARENT SCREEN IS HOLDING COULD STILL BE REDEEMED — a NECESSARY condition,
 * and the only one a parent screen can observe.
 *
 * `POST /v1/child-auth/pair`'s claim (apps/api/src/routes/child-auth.ts) requires FOUR things besides
 * the code — `p.consumed_at is null`, `p.expires_at > now`, `c.status = 'active'`, `f.deleted_at is
 * null` — and then refuses separately when `consentAllowsChildAccess` is false. This value establishes
 * the third, and the fourth indirectly.
 *
 * It is therefore NOT "exactly the window in which the code works" (BUG-395): a profile that is not
 * active cannot redeem a code, so `false` here is always right, but `true` is not a guarantee, because
 * three things retire a code without moving the status:
 *  - POST /v1/consent/withdraw sets `consumed_at` on every live code for the family and leaves
 *    `child_profiles.status` alone (apps/api/src/routes/guardians.ts);
 *  - a provider-side consent flip with no route call at all leaves the code UNCONSUMED, the child
 *    active, and /pair answering 422 CONSENT_REQUIRED — pinned by the SQL-flip case in
 *    apps/api/tests/consent-withdrawal.review.test.ts;
 *  - minting a code for the same child on another surface consumes this one (the pairing-code route's
 *    "one live code per child" update, apps/api/src/routes/family.ts).
 * Neither surface reads /v1/consent on a pairing screen, so neither can see any of them. That is why
 * the copy below names the condition it can speak for and points at the other one, and why it never
 * claims the converse.
 *
 * THIS LIVES HERE, not in either app. BUG-410 is this project's ledger entry for the alternative: two
 * byte-identical helpers tied together by tests that read each other's source left the entire mobile
 * suite green at 859/859 when the portal's sentence was reverted, because a source pin guards the
 * WORDS and not the MEANING (L-070), and two identical bodies are a coincidence with good odds (L-066).
 * BUG-393, BUG-395 and BUG-397 are three findings' worth of work on this rule inside `apps/web`, and
 * the phone's pair-device screen had none of it (BUG-411 (g)).
 *
 * `child` is OPTIONAL because a screen that looks a child up by id can fail to find the row — the
 * phone's pair-device screen is reached with a `childId` route param and finds the row in GET
 * /v1/family, which may no longer list it. An absent row is NOT redeemable: that is the fall-through
 * (L-057), and it is the honest answer, because a profile this client cannot see is one it cannot
 * claim anything about.
 */
export function pairingRedeemable(child: ChildCopySubject | undefined): boolean {
  return child !== undefined && child.status === 'active' && child.deletionPending !== true;
}

/**
 * What a parent screen holds after minting a pairing code: the code, the fact that the code is dead
 * ('stale'), or nothing. The code string itself is dropped when it dies; 'stale' is what remains, so
 * the parent is told the code is gone rather than left looking for it.
 */
export type HeldPairingCode =
  { readonly code: string; readonly expiresAt: string } | 'stale' | null;

/**
 * THE HELD CODE AS IT MUST BE RENDERED, decided from the child the screen is looking at RIGHT NOW.
 *
 * BUG-397's conclusion, and the reason this is a function of the render's own inputs rather than an
 * effect: round 6's effect turned a code already in hand stale but could not touch one that ARRIVES
 * after the status change, so the panel the fix existed to close could still open on an archived child
 * — the enumerated case was fixed and the fall-through was not (L-057). A code that resolves into a
 * screen whose child has since moved is decided by this call like any other, because the deciding fact
 * is read where the code is printed and not where it was requested.
 *
 * A caller that ALSO writes the answer back into its own state gets the latch BUG-393's notice needs:
 * 'stale' in, 'stale' out for every child, so activating the child again never resurrects a code the
 * server has already refused. One rule, both jobs; there is no second body to keep in step.
 */
export function heldPairingCode(
  held: HeldPairingCode,
  child: ChildCopySubject | undefined,
): HeldPairingCode {
  if (held === null) return null;
  return pairingRedeemable(child) ? held : 'stale';
}

/**
 * The stale notice's fixed sentences. `consentLead` and `consentTarget` are split because the portal
 * renders the target as a react-router <Link> and the phone as a navigation button: the WORDS are
 * shared, the control is each surface's own.
 */
export const PAIRING_STALE_COPY = {
  headline: 'That pairing code can’t connect a device any more.',
  reason:
    'A code is never redeemed for a profile that is not active, so the code was taken off the screen rather than left here to fail on the device.',
  consentLead:
    'A code can also stop working while a profile stays active, because a device is checked against your family’s consent too: you can review that on the',
  consentTarget: 'family dashboard',
} as const;

/**
 * The stale notice's one moving sentence, decided by `pairingRedeemable` so the notice cannot
 * contradict the rest of the screen it is on (BUG-393). Two states reach it:
 *  - the profile is redeemable again (the parent activated the child from this very screen, and the
 *    success line — "You can now create a pairing code" — renders beside this notice). The code itself
 *    is gone for good and is not resurrected, but asserting that the profile "is not" active under a
 *    "Status: Active" line and a live Create button is three self-contradictions on one screen.
 *  - it is not, and the sentence then DEFERS to the notices beside it rather than PRESUPPOSING that
 *    activation will become possible: it also renders for a deletion-pending child, where processing
 *    has stopped, nothing can be activated and deletion cannot be undone from the app, and WEBR4-02 is
 *    this project's ledger entry for promising a recovery there. Hence "if {nickname} is active
 *    again", and not "once … again … yet".
 */
export function pairingStaleNextStep(
  child: ChildCopySubject | undefined,
  nickname: string,
): string {
  return pairingRedeemable(child)
    ? `${nickname} is active again, so you can create a new code above.`
    : `${nickname}’s is not active, so you can create a new one if ${nickname} is active again — the notices above say whether that is possible.`;
}

/** The three editable fields of a child profile, as a form holds them. */
export interface ChildEditFields {
  readonly nickname: string;
  readonly gradeLevel: number;
  readonly ageBand: AgeBand;
}

/**
 * Which of them the parent has edited in THIS form.
 *
 * BRANDED ON PURPOSE (HUNT7-G-4, the checker's blocker). The first version of this fix put the rule in
 * `childEditBody` and tested it as a pure function — and left the CALL SITE unpinned, so passing
 * `{ nickname: true, gradeLevel: true, ageBand: true }` instead of the real `touched` state restored
 * the whole defect (the phone sends a field the parent never edited, reverting the other guardian's
 * change) with the full mobile suite, `tsc` and `eslint` all green. A source-text pin would only guard
 * the spelling of that argument.
 *
 * So the type makes the wrong argument impossible instead: `editedBrand` is a module-private
 * `unique symbol`, so no object literal written outside this file can satisfy this interface. The only
 * values that exist are `NOTHING_EDITED` and what `markEdited` returns, both of which carry the real
 * per-field flags. Restoring the defect is now a COMPILE error, which the gate already runs — a
 * guarantee rather than an assertion about source text (L-070).
 */
declare const editedBrand: unique symbol;
export interface ChildEditTouched {
  readonly nickname: boolean;
  readonly gradeLevel: boolean;
  readonly ageBand: boolean;
  /** Module-private brand; see above. Never read, and unwritable from outside this file. */
  readonly [editedBrand]: true;
}

/** The starting point: the parent has edited nothing, so an immediate Save sends nothing. */
export const NOTHING_EDITED = {
  nickname: false,
  gradeLevel: false,
  ageBand: false,
  // The cast is the brand's ONE constructor and is confined to this module. `editedBrand` is declared
  // in type space only (`declare const`), so it does not exist at runtime and must never appear in a
  // value: writing `[editedBrand]: true` here threw `ReferenceError: editedBrand is not defined` when
  // the module loaded, which took two whole test FILES to zero — 54 cases that reported as "passing"
  // by being absent. The raised floor in scripts/test-minimums.json is what would have caught it.
} as unknown as ChildEditTouched;

/** Record that the parent edited one field. The only way to build a `ChildEditTouched` that sends. */
export function markEdited(
  touched: ChildEditTouched,
  field: 'nickname' | 'gradeLevel' | 'ageBand',
): ChildEditTouched {
  return { ...touched, [field]: true };
}

/**
 * What PATCH /v1/children/:childId carries from the phone's child form: the fields the parent EDITED
 * there, and nothing else (HUNT7-G-4).
 *
 * The form used to seed all three fields from the live prop once and then send all three,
 * unconditionally, from that seed. The card is keyed on `row.id` (app/(parent)/children.tsx), so a
 * reload never remounts it and the seed is as old as the open form: guardian B moved the child up a
 * grade on the portal while parent A had the phone form open on the old grade, A corrected a typo in
 * the nickname, and the PATCH put the grade back — the route writes exactly the fields present and
 * the contract's refine only rejects an empty body (packages/contracts/src/family.ts). That is
 * BUG-222/WEBR4-03 verbatim, which the portal fixed in round 4 (WEBR4-03), again in round 5
 * (HUNT5-F-1) and again in round 6 (HUNT6-G-8), each time inside apps/web only.
 *
 * "Edited" and not "differs from the seed": those two are the same until a concurrent change lands,
 * and after it the field the parent can SEE becomes unsavable, which is BUG-330. Reseeding the fields
 * from the live prop is not the fix either — that is the loss HUNT5-F-1 was filed for — so the form
 * carries `childEditDriftNote` below instead.
 *
 * The rule is a value-in/value-out helper because this suite cannot render react-native (see
 * apps/mobile/vitest.config.ts): a rule that only exists inside a screen cannot be tested at all,
 * which is why the phone kept the defect for three rounds while the portal's was pinned.
 */
export function childEditBody(
  fields: ChildEditFields,
  touched: ChildEditTouched,
): UpdateChildProfileRequest {
  return {
    ...(touched.nickname ? { nickname: fields.nickname } : {}),
    ...(touched.gradeLevel ? { gradeLevel: fields.gradeLevel } : {}),
    ...(touched.ageBand ? { ageBand: fields.ageBand } : {}),
  };
}

/**
 * Launch scope is K-8, children under 13 (API-AUTH-R1-05, docs/Threat_Model.md T38): no band for
 * 14-18 is offered, so a profile can never be declared outside the under-13 consent and
 * child-mode flows. Widening it is a product decision (the database check already allows more).
 */
export const AGE_BANDS = ['5-7', '8-10', '11-13'] as const;
export const ageBandSchema = z.enum(AGE_BANDS);
export type AgeBand = z.infer<typeof ageBandSchema>;

/** 0 = kindergarten … 8 = grade 8 (launch scope K-8; the database check allows up to 12). */
export const GRADE_LEVEL_MAX = 8;
export const gradeLevelSchema = z.number().int().min(0).max(GRADE_LEVEL_MAX);

export const createFamilyRequestSchema = z.strictObject({
  displayName: freeTextSchema({ max: 80 }),
  timezone: z.string().min(1).max(64),
});
export type CreateFamilyRequest = z.infer<typeof createFamilyRequestSchema>;

export const createFamilyResponseSchema = z.strictObject({ familyId: uuidSchema });

/**
 * PATCH /v1/family (parent + step-up, audited). Corrects the family's name and time zone after
 * creation (WEB-R2-03): the zone defaults to whatever the browser reported when the family was
 * created, and nothing could fix it or a typo in the name afterwards. Every field is optional but
 * at least one must be present, so an empty body is a 400 rather than a silent no-op.
 */
export const updateFamilyRequestSchema = z
  .strictObject({
    displayName: freeTextSchema({ max: 80 }).optional(),
    timezone: ianaZoneSchema.optional(),
  })
  .refine(
    (body) => body.displayName !== undefined || body.timezone !== undefined,
    'Change the family name or the time zone',
  );
export type UpdateFamilyRequest = z.infer<typeof updateFamilyRequestSchema>;

export const updateFamilyResponseSchema = z.strictObject({
  family: z.strictObject({
    id: uuidSchema,
    displayName: z.string(),
    timezone: z.string(),
  }),
});
export type UpdateFamilyResponse = z.infer<typeof updateFamilyResponseSchema>;

export const familyChildSchema = z.strictObject({
  id: uuidSchema,
  nickname: z.string(),
  gradeLevel: gradeLevelSchema,
  ageBand: ageBandSchema,
  status: childProfileStatusSchema,
  /**
   * True while a data deletion covering this child is `requested` or `processing` (API-AUTH-R2-02).
   * The row stays in GET /v1/family so the privacy screens can still name the child a pending
   * request, an export or a safety report refers to; activation, pairing and profile edits refuse
   * it server-side, so the parent screens label such a child and offer no control on it. Additive
   * and optional so a client (and a fixture) written before the flag still parses this response.
   */
  deletionPending: z.boolean().optional(),
});
export type FamilyChild = z.infer<typeof familyChildSchema>;

/** GET /v1/family */
export const familyOverviewResponseSchema = z.strictObject({
  id: uuidSchema,
  displayName: z.string(),
  timezone: z.string(),
  paidSlots: z.number().int().min(0),
  billingConflict: z.string().nullable(),
  managingChannel: z.string().nullable(),
  children: z.array(familyChildSchema),
});
export type FamilyOverview = z.infer<typeof familyOverviewResponseSchema>;

/**
 * POST /v1/children (parent + step-up). Always creates an uncharged draft.
 *
 * `parentalAttestation` is the ticked statement, and it arrives WITH the child's details in one
 * submission rather than as a later step: that way a child row never exists without an attestation
 * covering it, not even momentarily. It must be literally `true` — an absent or false value is a 422,
 * because an untickable checkbox and an unticked one are the same thing to a parent and neither is
 * consent. The server records `CONSENT_ATTESTATION_VERSION` and its own clock, never a
 * client-supplied version or instant.
 */
export const createChildProfileRequestSchema = z.strictObject({
  nickname: freeTextSchema({ max: 40 }),
  gradeLevel: gradeLevelSchema,
  ageBand: ageBandSchema,
  parentalAttestation: z.literal(true),
});
export type CreateChildProfileRequest = z.infer<typeof createChildProfileRequestSchema>;

export const createChildProfileResponseSchema = z.strictObject({
  childId: uuidSchema,
  status: z.literal('draft'),
});

/**
 * PATCH /v1/children/:childId (parent + step-up, audited). Corrects a child's nickname, grade and
 * age band (WEB-R2-03): no client or route could change them, so every family stayed on last
 * year's grade once the school year rolled over, and the grade is what practice generation is
 * pitched at. Every field is optional but at least one must be present.
 */
export const updateChildProfileRequestSchema = z
  .strictObject({
    nickname: freeTextSchema({ max: 40 }).optional(),
    gradeLevel: gradeLevelSchema.optional(),
    ageBand: ageBandSchema.optional(),
  })
  .refine(
    (body) =>
      body.nickname !== undefined || body.gradeLevel !== undefined || body.ageBand !== undefined,
    'Change the nickname, grade or age band',
  );
export type UpdateChildProfileRequest = z.infer<typeof updateChildProfileRequestSchema>;

export const updateChildProfileResponseSchema = z.strictObject({ child: familyChildSchema });
export type UpdateChildProfileResponse = z.infer<typeof updateChildProfileResponseSchema>;

/**
 * POST /v1/children/:id/activate (parent + step-up). Assigns one of the family's verified, unused
 * paid slots to a draft child (spec P11: "If an existing paid slot is unused, assigning it requires
 * no new purchase"). It never buys capacity: with no unused slot the API answers BUSINESS_RULE
 * NEEDS_PAID_SLOT, and without verified consent CONSENT_REQUIRED.
 */
export const childActivationResponseSchema = z.strictObject({
  childId: uuidSchema,
  status: z.literal('active'),
  paidSlots: z.number().int().min(0),
  assignedSlots: z.number().int().min(0),
});
export type ChildActivationResponse = z.infer<typeof childActivationResponseSchema>;

/**
 * POST /v1/children/:id/archive (parent + step-up). Frees the child's paid slot, signs its devices
 * out and keeps the history (spec P11, AC_CAPACITY_08). It never cancels or lowers a store
 * subscription, which `note` says in the parent's own words.
 */
export const childArchiveResponseSchema = z.strictObject({
  childId: uuidSchema,
  status: z.literal('archived'),
  paidSlots: z.number().int().min(0),
  assignedSlots: z.number().int().min(0),
  note: z.string(),
});
export type ChildArchiveResponse = z.infer<typeof childArchiveResponseSchema>;

/**
 * Stable BUSINESS_RULE codes from PATCH /v1/children/:childId (FL-R4-04). `archived` is the
 * long-standing code for a history-only profile; `deletionPending` replaced a misleading NOT_FOUND
 * for a child whose data deletion is still `requested` or `processing` — GET /v1/family names that
 * child to the same caller and flags it `deletionPending`, so denying its existence on the edit
 * protected nothing and told the parent a profile they can see is gone. An id that is unknown or
 * another family's still answers NOT_FOUND.
 */
export const CHILD_PROFILE_RULES = {
  archived: 'CHILD_ARCHIVED',
  deletionPending: 'CHILD_DELETION_PENDING',
} as const;

/** Stable BUSINESS_RULE codes from child activation that the parent screens branch on. */
export const CHILD_ACTIVATION_RULES = {
  needsPaidSlot: 'NEEDS_PAID_SLOT',
  consentRequired: 'CONSENT_REQUIRED',
} as const;

/** GET /v1/child/me — the paired child's own safe fields only. */
export const childMeResponseSchema = z.strictObject({
  id: uuidSchema,
  nickname: z.string(),
  gradeLevel: gradeLevelSchema,
  ageBand: ageBandSchema,
});
export type ChildMe = z.infer<typeof childMeResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

export const devicePlatformSchema = z.enum(['ios', 'android', 'web']);

export const childDeviceSchema = z.strictObject({
  id: uuidSchema,
  childId: uuidSchema,
  label: z.string(),
  platform: devicePlatformSchema,
  pairedAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
});
export type ChildDevice = z.infer<typeof childDeviceSchema>;

/** GET /v1/devices */
export const childDevicesResponseSchema = z.strictObject({ devices: z.array(childDeviceSchema) });
export type ChildDevices = z.infer<typeof childDevicesResponseSchema>;

/** `{ ok: true }` acknowledgement used by revoke/lock/remove endpoints. */
export const familyOkResponseSchema = z.strictObject({ ok: z.literal(true) });

// ---------------------------------------------------------------------------------------------
// Guardians and invitations (spec P1: two adults, verified acceptance, owner removal)
// ---------------------------------------------------------------------------------------------

/** Spec P1: the owner plus one invited guardian. The DB trigger enforces the same limit. */
export const MAX_FAMILY_ADULTS = 2;
export const GUARDIAN_INVITATION_TTL_DAYS = 7;

export const adultRoleSchema = z.enum(['owner', 'guardian']);
export type AdultRole = z.infer<typeof adultRoleSchema>;

export const guardianInvitationRequestSchema = z.strictObject({
  email: z.email().max(254),
});
export type GuardianInvitationRequest = z.infer<typeof guardianInvitationRequestSchema>;

/** The invitation token is never returned: it travels only inside the emailed link. */
export const guardianInvitationResponseSchema = z.strictObject({
  invitationId: uuidSchema,
  email: z.string(),
  status: z.literal('pending'),
  expiresAt: isoDateTimeSchema,
});
export type GuardianInvitationResponse = z.infer<typeof guardianInvitationResponseSchema>;

export const guardianMemberSchema = z.strictObject({
  userId: uuidSchema,
  role: adultRoleSchema,
  /** The caller's own address in full; the other adult's address masked. Null when unknown. */
  email: z.string().nullable(),
  isYou: z.boolean(),
  acceptedAt: isoDateTimeSchema,
});
export type GuardianMember = z.infer<typeof guardianMemberSchema>;

export const pendingInvitationSchema = z.strictObject({
  id: uuidSchema,
  /** Full for the family owner who sent it; masked for anyone else. */
  email: z.string(),
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});
export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;

/** GET /v1/guardians */
export const guardiansResponseSchema = z.strictObject({
  callerRole: adultRoleSchema,
  maxAdults: z.number().int().min(1),
  members: z.array(guardianMemberSchema),
  pendingInvitations: z.array(pendingInvitationSchema),
});
export type GuardiansOverview = z.infer<typeof guardiansResponseSchema>;

export const acceptInvitationRequestSchema = z.strictObject({
  token: z
    .string()
    .min(20)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const acceptInvitationResponseSchema = z.strictObject({
  familyId: uuidSchema,
  role: z.literal('guardian'),
});

/** Stable BUSINESS_RULE / CONFLICT rule codes the guardian screens branch on. */
export const GUARDIAN_RULES = {
  adultLimitReached: 'ADULT_LIMIT_REACHED',
  invitationAlreadyPending: 'INVITATION_ALREADY_PENDING',
  invitationNotPending: 'INVITATION_NOT_PENDING',
  invitationExpired: 'INVITATION_EXPIRED',
  invitationEmailMismatch: 'INVITATION_EMAIL_MISMATCH',
  emailNotVerified: 'EMAIL_NOT_VERIFIED',
  alreadyInFamily: 'ALREADY_IN_FAMILY',
  cannotRemoveOwner: 'CANNOT_REMOVE_OWNER',
  ownerOnly: 'OWNER_ONLY',
} as const;

/**
 * Masks an email address for display to the other adult: first (and last) character of the local
 * part plus the domain, e.g. `s***m@example.test`. Anything that is not an address becomes `***`.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const masked =
    local.length <= 2 ? `${local[0] ?? ''}***` : `${local[0] ?? ''}***${local[local.length - 1]}`;
  return `${masked}@${domain}`;
}

// ---------------------------------------------------------------------------------------------
// Consent (spec P3: verifiable parental consent behind a provider adapter)
// ---------------------------------------------------------------------------------------------

/** Version of the consent notice the parent agrees to; bump when the notice text changes. */
export const CONSENT_POLICY_VERSION = '2026-09-v1';
export const CONSENT_PURPOSE = 'child_learning_data';

/**
 * The parental/guardian ATTESTATION, made once per child (migration 0970,
 * docs/design/Consent_Design.md).
 *
 * Verifiable parental consent is two claims. That the consenting person is an ADULT is established by
 * the consent provider and recorded on `public.consent_records`. That this adult is THIS CHILD'S parent
 * or legal guardian is established by nothing an identity check can produce — no COPPA-enumerated
 * method verifies a family relationship, because there is no database of who is whose parent — so the
 * regulation contemplates the adult's own assertion, and the assertion therefore does real legal work.
 *
 * The statement lives here rather than in a page so the portal and the app present the SAME words, and
 * it is VERSIONED so the record of what a parent agreed to survives a later rewording: the child row
 * stores the version and the instant, and this repository stores the wording that version names.
 * Bump the version whenever a character of the statement changes, and never edit a released version's
 * text in place.
 *
 * Counsel approves this wording as part of owner action #15; until they do it is the draft the product
 * ships behind the same legal-review gate as the public pages.
 */
export const CONSENT_ATTESTATION_VERSION = '2026-09-v1';
/**
 * What a surface says when the box is not ticked. HERE rather than in either client, because a
 * one-surface copy change is the divergence seven findings of round 7 were made of: the portal and the
 * app must refuse in the same words for the same reason.
 */
export const ATTESTATION_REQUIRED_COPY =
  'Please confirm you are this child\u2019s parent or legal guardian before adding them.';
export const CONSENT_ATTESTATION_STATEMENT =
  'I am the parent or legal guardian of this child, and I agree to PencilLift collecting and ' +
  'processing their homework and practice work as described in the Privacy Policy.';

export const CONSENT_STATES = ['none', 'pending', 'verified', 'failed', 'withdrawn'] as const;
export const consentStateSchema = z.enum(CONSENT_STATES);
export type ConsentState = z.infer<typeof consentStateSchema>;

/** GET /v1/consent and POST /v1/consent/:id/refresh */
export const consentStatusResponseSchema = z.strictObject({
  state: consentStateSchema,
  /** The latest consent record, or null when none exists. */
  consentId: uuidSchema.nullable(),
  /** True when the latest record came from a development/test provider (never real consent). */
  isTestProvider: z.boolean(),
  /** True when this environment's configured consent provider is a development/test double. */
  configuredProviderIsTest: z.boolean(),
  verifiedAt: isoDateTimeSchema.nullable(),
  withdrawnAt: isoDateTimeSchema.nullable(),
  policyVersion: z.string().nullable(),
  currentPolicyVersion: z.string(),
});
export type ConsentStatus = z.infer<typeof consentStatusResponseSchema>;

/** POST /v1/consent/start takes an empty object: nothing from the client can set the outcome. */
export const consentStartRequestSchema = z.strictObject({});

export const consentStartResponseSchema = z.strictObject({
  consentId: uuidSchema,
  state: z.literal('pending'),
  /** Where the parent completes verification with the provider (null when none is needed). */
  redirectUrl: z.url().nullable(),
  isTestProvider: z.boolean(),
});
export type ConsentStartResponse = z.infer<typeof consentStartResponseSchema>;

export const consentWithdrawResponseSchema = z.strictObject({
  state: z.literal('withdrawn'),
  cancelledJobs: z.number().int().min(0),
});

export const CONSENT_RULES = {
  alreadyVerified: 'CONSENT_ALREADY_VERIFIED',
  alreadyWithdrawn: 'CONSENT_ALREADY_WITHDRAWN',
  providerChanged: 'CONSENT_PROVIDER_CHANGED',
} as const;

// ---------------------------------------------------------------------------------------------
// Parent PIN feedback (the API's isWeakPin stays authoritative)
// ---------------------------------------------------------------------------------------------

/**
 * Client-side mirror of the API's weak-PIN rule so parents get feedback before submitting.
 * Returns a reason string, or null when the PIN looks acceptable. The server still decides.
 */
export function weakParentPinReason(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return 'Use exactly 6 digits.';
  if (/^(\d)\1{5}$/.test(pin)) return 'Avoid repeating one digit.';
  if ('0123456789012345'.includes(pin) || '9876543210987654'.includes(pin))
    return 'Avoid counting up or down.';
  if (['123123', '121212', '112233'].includes(pin)) return 'Avoid simple patterns.';
  return null;
}
