import type {
  channelSchema,
  familyPromotionsResponseSchema,
  familySchoolResponseSchema,
  listSchoolsResponseSchema,
  promoQuoteResponseSchema,
  promoRedemptionSchema,
  redemptionStateSchema,
  schoolSummarySchema,
} from '@pencillift/contracts';

/**
 * Types for the P17 promotions screens, derived from the shared contract schemas. The contracts
 * package exposes these as schemas only, and the mobile app does not depend on zod directly, so
 * this reads the parsed type the same way `z.infer` does (zod v4 keeps it at `_zod.output`).
 */
type Output<S> = S extends { readonly _zod: { readonly output: infer O } } ? O : never;
/**
 * If a zod upgrade ever moved that type, `Output` would degrade to `never`, which TypeScript lets
 * any property access through; this turns that into a loud type error everywhere instead.
 */
type Contract<S> = [Output<S>] extends [never] ? { readonly contractTypeNotFound: S } : Output<S>;

export type Channel = Contract<typeof channelSchema>;
export type SchoolSummary = Contract<typeof schoolSummarySchema>;
export type SchoolList = Contract<typeof listSchoolsResponseSchema>;
export type FamilySchool = Contract<typeof familySchoolResponseSchema>;
export type PromoQuote = Contract<typeof promoQuoteResponseSchema>;
export type PromoRedemption = Contract<typeof promoRedemptionSchema>;
export type PromoHistory = Contract<typeof familyPromotionsResponseSchema>;
export type RedemptionState = Contract<typeof redemptionStateSchema>;
