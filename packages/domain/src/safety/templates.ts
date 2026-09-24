// Safety templates (spec P4: "Safety templates and human review procedures must exist before
// launch"; AC_SECURITY_02). DRAFTS: the owner and an educator must approve this wording before
// launch; SAFETY_TEMPLATES_STATUS is the flag the release-readiness report reads.
//
// Rules for every child-facing message: calm and short; thanks the child; never diagnoses; never
// says or implies that a parent or anyone else was alerted (no alert is sent); never asks for
// secrecy; always points to a grown-up the child trusts; names US resources for the launch
// market: 911 for immediate danger, the 988 Suicide & Crisis Lifeline (call or text 988) for
// self-harm, the Childhelp National Child Abuse Hotline (1-800-422-4453) for abuse, secrecy,
// sexual content or contact from a stranger. When an abuse-type category is present the child may be
// the one at risk, so the anger message for a threat is left out ("he said if I tell he will hurt my
// mom" is a victim's words, not a threat).
//
// The parent-facing wording for the family's report list lives in @pencillift/contracts
// (PARENT_SAFETY_FLAG_COPY in privacy.ts), so the parent web bundle never loads this screen's
// rules; it is a draft under the same approval status.
import type { SafetyAgeBand, SevereSafetyCategory } from './types.ts';

export const SAFETY_TEMPLATES_VERSION = 'safety-templates.v2';

/** Release-readiness flag: the templates below are drafts until approved. */
export const SAFETY_TEMPLATES_STATUS = 'draft_pending_owner_and_educator_approval' as const;
export const SAFETY_TEMPLATES_APPROVED = false;

export const SAFETY_RESOURCES_US = {
  emergency: '911',
  crisisLine: '988',
  childAbuseHotline: '1-800-422-4453',
} as const;

/** child_feedback.body allows 2000 characters; the message stays well under it. */
export const CHILD_SAFETY_MESSAGE_MAX_LENGTH = 900;

type Wording = 'young' | 'standard';

function wordingFor(ageBand: SafetyAgeBand | null): Wording {
  return ageBand === '5-7' ? 'young' : 'standard';
}

const OPENING: Readonly<Record<Wording, string>> = {
  young: 'Thank you for telling us. You matter. You should always feel safe.',
  standard:
    'Thank you for sharing this. What you wrote sounds important, and you deserve to feel safe and cared for.',
};

const TRUSTED_GROWN_UP: Readonly<Record<Wording, string>> = {
  young: 'Please tell a grown-up you trust today. It can be a teacher or someone in your family.',
  standard:
    'Please talk to a grown-up you trust today, like a teacher, a school counselor or someone in your family.',
};

const SELF_HARM: Readonly<Record<Wording, string>> = {
  young: 'You or a grown-up can call or text 988 any time. Kind people there help kids.',
  standard:
    'If you are thinking about hurting yourself, you can call or text 988 any time to talk with someone whose job is to help.',
};

const CHILDHELP: Readonly<Record<Wording, string>> = {
  young:
    'If someone is hurting you, it is not your fault. You or a grown-up can call 1-800-422-4453 any time.',
  standard:
    'If someone is hurting you or making you feel unsafe, it is not your fault. You can call the Childhelp hotline at 1-800-422-4453 any time. You do not have to keep secrets that make you feel unsafe.',
};

const VIOLENCE: Readonly<Record<Wording, string>> = {
  young: 'If you feel very angry, stop and take a slow breath. Then find a grown-up.',
  standard:
    'If you are feeling very angry or upset, take a slow breath and talk with a grown-up you trust right away.',
};

const EMERGENCY: Readonly<Record<Wording, string>> = {
  young: 'If you are in danger right now, a grown-up can call 911. You can call 911 too.',
  standard: 'If you or someone else is in danger right now, call 911.',
};

const CHILDHELP_CATEGORIES: ReadonlySet<SevereSafetyCategory> = new Set([
  'abuse',
  'sexual',
  'secrecy',
  'personal_contact',
]);

/**
 * Screen categories whose system report is HELD from the family's report list until a reviewer
 * releases it (runbook 5.1): the concern may involve someone in the household, so the family is not
 * told first. Proposed default; owner and counsel to approve. `personal_contact` (a stranger or an
 * online contact) is not held: the family is the child's protection there.
 */
export const FAMILY_HOLD_CATEGORIES: readonly SevereSafetyCategory[] = [
  'abuse',
  'sexual',
  'secrecy',
];

/** True when a system report with these categories starts held from the family list. */
export function heldFromFamily(categories: readonly SevereSafetyCategory[]): boolean {
  return categories.some((c) => FAMILY_HOLD_CATEGORIES.includes(c));
}

/**
 * The fixed message a child sees in place of coaching when their answer screened as severe.
 * Deterministic for the same categories and age band.
 */
export function childSafetyMessage(
  categories: readonly SevereSafetyCategory[],
  ageBand: SafetyAgeBand | null,
): string {
  const w = wordingFor(ageBand);
  const set = new Set(categories);
  const parts = [OPENING[w], TRUSTED_GROWN_UP[w]];
  const childhelp = [...set].some((c) => CHILDHELP_CATEGORIES.has(c));
  if (set.has('self_harm')) parts.push(SELF_HARM[w]);
  if (childhelp) parts.push(CHILDHELP[w]);
  // A possible victim never gets the anger message (abuse-type codes take precedence).
  if (set.has('violence') && !childhelp) parts.push(VIOLENCE[w]);
  parts.push(EMERGENCY[w]);
  return parts.join(' ');
}
