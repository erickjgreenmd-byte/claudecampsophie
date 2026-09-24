import {
  familyPromotionsResponseSchema,
  familySchoolResponseSchema,
  listSchoolsResponseSchema,
  promoQuoteResponseSchema,
  promoRedemptionSchema,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import type {
  Channel,
  FamilySchool,
  PromoHistory,
  PromoQuote,
  PromoRedemption,
  SchoolSummary,
} from './types.ts';
import { savedSchoolMessage, validateCodeEntry } from './view-model.ts';

/**
 * API calls for the parent School and promotions screen (spec P17). Pure: no react-native imports.
 * Failures become calm, specific parent messages keyed on stable codes, never on server text.
 */

export interface PromoProblem {
  readonly message: string;
  /** The server wants a fresh parent PIN step-up (STEP_UP_REQUIRED). */
  readonly needsPin: boolean;
  /** The caller has no family yet (NOT_FOUND on family endpoints). */
  readonly noFamily: boolean;
}

const RULE_MESSAGES: Readonly<Record<string, string>> = {
  CODE_INVALID_FORMAT:
    'That doesn’t look like a PencilLift code. Check that you typed it exactly as shown.',
  CODE_CHECKSUM_MISMATCH: 'That code has a typo. Check each character and try again.',
  CAMPAIGN_NOT_ACTIVE: 'This code isn’t active right now.',
  OUTSIDE_REDEMPTION_WINDOW: 'This code can only be used during its redemption dates.',
  CODE_REVOKED: 'This code is no longer valid.',
  CODE_USAGE_CAP_REACHED: 'This code has reached its usage limit.',
  CAMPAIGN_REDEMPTION_CAP_REACHED: 'This month’s promotion has reached its limit.',
  CAMPAIGN_BUDGET_EXHAUSTED: 'This month’s promotion is fully used.',
  SCHOOL_AUDIENCE_MISMATCH: 'This code is for families supporting a different school.',
  TIER_NOT_ELIGIBLE: 'This code doesn’t apply to your plan size.',
  SUBSCRIBER_NOT_ELIGIBLE:
    'This code isn’t available for your subscription status (new, current or returning).',
  CHANNEL_UNAVAILABLE: 'This code isn’t available in this store yet. Please try again later.',
  CHANNEL_MISMATCH:
    'Your subscription is billed by a different store. Use the device or store that manages it.',
  FAMILY_ALREADY_REDEEMED_CAMPAIGN:
    'Your family already used this month’s code. Each monthly code works once per family — next month brings a new code.',
  PENDING_PROMOTION_EXISTS:
    'You already have a discount waiting for an upcoming billing period. You can use a new code after that one has been applied.',
  SUBSCRIPTION_NOT_IN_GOOD_STANDING:
    'Please resolve your subscription’s billing with your store before using a code.',
  NEXT_PERIOD_ALREADY_FINALIZED:
    'Your next bill is already final, so it can’t be discounted. Try a new code after it renews.',
  TARGET_PERIOD_ALREADY_DISCOUNTED:
    'That billing period already has a discount. Only one discount can apply to a billing period.',
};

/** Error codes whose server message is written for an adult and safe to show as-is. */
const SERVER_WORDED = new Set([
  'RATE_LIMITED',
  'LOCKED_OUT',
  'NETWORK',
  'UNAUTHENTICATED',
  'CONFLICT',
]);

export function promoProblem(error: unknown): PromoProblem {
  const problem = (message: string, extra: Partial<PromoProblem> = {}): PromoProblem => ({
    message,
    needsPin: false,
    noFamily: false,
    ...extra,
  });
  if (!(error instanceof ApiRequestError))
    return problem('Something went wrong. Please try again.');
  if (error.code === 'STEP_UP_REQUIRED') {
    return problem('Unlock with your parent PIN to use promo codes, then try again.', {
      needsPin: true,
    });
  }
  if (error.code === 'BUSINESS_RULE') {
    return problem((error.rule ? RULE_MESSAGES[error.rule] : undefined) ?? error.message);
  }
  if (error.code === 'NOT_FOUND') return problem('That code isn’t valid. Check it and try again.');
  if (error.code === 'CHILD_MODE_FORBIDDEN') {
    return problem('Promo codes can only be used by a grown-up.');
  }
  return problem(
    SERVER_WORDED.has(error.code) ? error.message : 'Something went wrong. Please try again.',
  );
}

/**
 * Problem for a school search or school change (RV-p17-ui-4). Mapping is keyed to the action:
 * NOT_FOUND from PUT /v1/family/school means the school is no longer available to choose (e.g.
 * deactivated after the search), never that a promo code is invalid.
 */
export function schoolProblem(error: unknown): PromoProblem {
  const problem = (message: string, extra: Partial<PromoProblem> = {}): PromoProblem => ({
    message,
    needsPin: false,
    noFamily: false,
    ...extra,
  });
  if (!(error instanceof ApiRequestError))
    return problem('Something went wrong. Please try again.');
  if (error.code === 'STEP_UP_REQUIRED') {
    return problem('Unlock with your parent PIN to change your school, then try again.', {
      needsPin: true,
    });
  }
  if (error.code === 'NOT_FOUND') {
    return problem(
      'That school isn’t available to choose anymore. Search again and pick a school from the list.',
    );
  }
  if (error.code === 'BUSINESS_RULE') return problem('That school can’t be selected right now.');
  if (error.code === 'CHILD_MODE_FORBIDDEN') {
    return problem('School settings can only be changed by a grown-up.');
  }
  return problem(
    SERVER_WORDED.has(error.code) ? error.message : 'Something went wrong. Please try again.',
  );
}

/** Problem for the family-scoped loads, where NOT_FOUND means "no family yet". */
export function loadProblem(error: unknown): PromoProblem {
  if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') {
    return {
      message: 'Create your family first, then come back to choose a school.',
      needsPin: false,
      noFamily: true,
    };
  }
  return promoProblem(error);
}

export type Outcome<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly problem: PromoProblem };

export function loadFamilySchool(api: ApiClient): Promise<FamilySchool> {
  return api.get('/v1/family/school', familySchoolResponseSchema);
}

export function loadPromoHistory(api: ApiClient): Promise<PromoHistory> {
  return api.get('/v1/family/promotions', familyPromotionsResponseSchema);
}

export async function searchSchools(
  api: ApiClient,
  query: string,
): Promise<{ ok: true; query: string; schools: SchoolSummary[] } | { ok: false; message: string }> {
  const q = query.trim();
  if (q.length < 2) return { ok: false, message: 'Type at least 2 letters of the school’s name.' };
  try {
    const found = await api.get(
      `/v1/schools?query=${encodeURIComponent(q)}`,
      listSchoolsResponseSchema,
    );
    return { ok: true, query: q, schools: found.schools };
  } catch (error) {
    return { ok: false, message: schoolProblem(error).message };
  }
}

export async function chooseSchool(
  api: ApiClient,
  school: SchoolSummary,
  /** The designation shown before this choice, so the message can say what changed. */
  previous?: FamilySchool,
): Promise<Outcome<{ data: FamilySchool; message: string }>> {
  try {
    const data = await api.send(
      'PUT',
      '/v1/family/school',
      { schoolId: school.id },
      familySchoolResponseSchema,
    );
    return { ok: true, data, message: savedSchoolMessage(data, school, previous) };
  } catch (error) {
    return { ok: false, problem: schoolProblem(error) };
  }
}

export interface PromoRequest {
  readonly code: string;
  readonly channel: Channel;
  /** Only for a family without a paid subscription yet (the server ignores it otherwise). */
  readonly paidSlots?: number | undefined;
}

function body(request: PromoRequest) {
  return {
    code: request.code.trim(),
    channel: request.channel,
    ...(request.paidSlots === undefined ? {} : { paidSlots: request.paidSlots }),
  };
}

export async function quotePromo(
  api: ApiClient,
  request: PromoRequest,
): Promise<Outcome<{ quote: PromoQuote }>> {
  const invalid = validateCodeEntry(request.code);
  if (invalid)
    return { ok: false, problem: { message: invalid, needsPin: false, noFamily: false } };
  try {
    const quote = await api.send(
      'POST',
      '/v1/family/promotions/quote',
      body(request),
      promoQuoteResponseSchema,
    );
    return { ok: true, quote };
  } catch (error) {
    return { ok: false, problem: promoProblem(error) };
  }
}

/**
 * Redeems with a caller-held idempotency key. Callers create one key per previewed quote and reuse
 * it for retries, so a double tap or a retry after a timeout never creates a second redemption.
 */
export async function redeemPromo(
  api: ApiClient,
  request: PromoRequest,
  idempotencyKey: string,
): Promise<Outcome<{ redemption: PromoRedemption }>> {
  try {
    const redemption = await api.send(
      'POST',
      '/v1/family/promotions/redeem',
      { ...body(request), idempotencyKey },
      promoRedemptionSchema,
    );
    return { ok: true, redemption };
  } catch (error) {
    return { ok: false, problem: promoProblem(error) };
  }
}
