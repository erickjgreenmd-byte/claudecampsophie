// School referral attribution (spec P17): independent of discounts. A school code can attribute a
// signup without reducing its price; a promo can associate a school only when none is established
// and never silently overwrites one.
import { assertId } from './validation.ts';

export type AttributionSource = 'school_code' | 'promo' | 'manual';

export interface Attribution {
  readonly schoolId: string;
  readonly source: AttributionSource;
}

export interface ResolveAttributionInput {
  readonly existing: Attribution | null;
  readonly incoming: Attribution;
}

export type AttributionAction = 'set' | 'keep_existing' | 'requires_parent_confirmation';

export type AttributionReason =
  | 'NO_ESTABLISHED_SCHOOL'
  | 'SAME_SCHOOL'
  | 'EXPLICIT_PARENT_SELECTION'
  | 'PROMO_NEVER_OVERWRITES'
  | 'DIFFERENT_SCHOOL_CODE';

export interface AttributionResolution {
  readonly action: AttributionAction;
  readonly reason: AttributionReason;
}

/**
 * Decides how an incoming school association interacts with the established one.
 *
 * Decision: `manual` means the authenticated parent explicitly chose the school in the school
 * selector, so it is applied (`set`); the donation designation still follows the next-month rule
 * in planSchoolDesignation. A school code for a different school asks the parent to confirm. A
 * promo for a different school keeps the existing school outright: a discount flow must not become
 * a school-switching flow, and the promo's discount does not depend on attribution either way.
 */
export function resolveAttribution(input: ResolveAttributionInput): AttributionResolution {
  assertId(input.incoming.schoolId, 'incoming.schoolId');
  if (input.existing === null) return { action: 'set', reason: 'NO_ESTABLISHED_SCHOOL' };
  assertId(input.existing.schoolId, 'existing.schoolId');
  if (input.existing.schoolId === input.incoming.schoolId) {
    return { action: 'keep_existing', reason: 'SAME_SCHOOL' };
  }
  switch (input.incoming.source) {
    case 'manual':
      return { action: 'set', reason: 'EXPLICIT_PARENT_SELECTION' };
    case 'promo':
      return { action: 'keep_existing', reason: 'PROMO_NEVER_OVERWRITES' };
    case 'school_code':
      return { action: 'requires_parent_confirmation', reason: 'DIFFERENT_SCHOOL_CODE' };
  }
}
