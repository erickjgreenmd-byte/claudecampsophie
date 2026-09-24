// Contracts for the rewards vertical (spec P9, P16.4). Owned by the rewards feature agent.
// Points are a family motivational ledger, not money: no contract here moves value, and there is
// deliberately no request shape that awards points for ads, sponsor/affiliate clicks, purchases or
// referrals (AC_MON_13).
import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from './common.ts';

// ---------------------------------------------------------------------------------------------
// Limits (mirror migration 0400 and @pencillift/domain/rewards)
// ---------------------------------------------------------------------------------------------

export const REWARD_TITLE_MAX_LENGTH = 80;
export const REWARD_INSTRUCTIONS_MAX_LENGTH = 500;
/** Decision: the domain cap (100,000) is tighter than the DB check (1,000,000); the API uses it. */
export const REWARD_POINT_COST_MAX = 100_000;
/** Decision: one adjustment moves at most 10,000 points either way (domain MAX_ADJUSTMENT_POINTS). */
export const POINTS_ADJUSTMENT_MAX = 10_000;
/** points_ledger.reason is limited to 300 characters by the database. */
export const POINTS_REASON_MAX_LENGTH = 300;

/** Stable `rule` codes returned with 422 BUSINESS_RULE by the rewards API. */
export const REWARD_BUSINESS_RULES = ['INSUFFICIENT_POINTS', 'INVALID_TRANSITION'] as const;
export type RewardBusinessRule = (typeof REWARD_BUSINESS_RULES)[number];

/**
 * Decision: reward text is shown to children and P16.3 ("No affiliate URL in a push, SMS, exported
 * child worksheet or learning reward") keeps learning rewards free of merchant links, so titles and
 * instructions may not contain any link. A link is any of:
 * - a URL scheme (`https://`) or `www.`;
 * - an Amazon or Amazon short-link host with any country suffix (`amazon.fr`, `amzn.eu`,
 *   `amazon.com.be`), because a fixed suffix list let marketplaces through (RV-rewards-1);
 * - any host followed by a path (`name.tld/…`), whatever the suffix, which is how share links look;
 * - a bare host with a common public suffix (e.g. `a.co`, `shop.example.net`).
 * The text is NFKC-normalized and stripped of invisible code points first, so full-width letters or
 * a zero-width space inside a host cannot hide a link. Prose such as "Dr. Seuss book", "2.5 hours"
 * or "pizza/tacos" is unaffected. Mirrors the @pencillift/domain/rewards catalog rule.
 */
const PUBLIC_SUFFIXES =
  'com|net|org|co|io|app|shop|store|ly|me|to|us|uk|ca|au|de|in|biz|info|link|gl|gd|site|online|xyz' +
  // Amazon marketplace and short-link suffixes.
  '|eu|asia|fr|es|nl|se|pl|sg|ae|sa|eg|jp|mx|br|nz|ie|cn|tr';
const LINK_PATTERN = new RegExp(
  [
    String.raw`[a-z][a-z0-9+.-]*:\/\/`,
    String.raw`\bwww\.`,
    String.raw`\b(?:amzn|amazon)\.[a-z]{2,}`,
    String.raw`\b[a-z0-9-]+\.[a-z]{2,63}\/`,
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:${PUBLIC_SUFFIXES})\b`,
  ].join('|'),
  'i',
);
/** Code points that render as nothing (zero-width spaces/joiners, soft hyphen, BOM, fillers). */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const MEANINGFUL_PATTERN = /[\p{L}\p{N}]/u;

export function rewardTextContainsLink(text: string): boolean {
  return LINK_PATTERN.test(text.normalize('NFKC').replace(INVISIBLE, ''));
}

/**
 * Decision: free text (reward title, instructions, adjustment reason) refuses control characters
 * other than tab, line feed and carriage return. Postgres cannot store U+0000 in text at all, so a
 * NUL used to surface as a 500 (RV-rewards-2), and the other controls have no place in
 * child-visible text or an audit reason.
 */
export function textHasControlCharacter(text: string): boolean {
  return /\p{Cc}/u.test(text.replace(/[\t\n\r]/g, ''));
}

const noLinks = (text: string) => !rewardTextContainsLink(text);
const noControls = (text: string) => !textHasControlCharacter(text);
const LINK_MESSAGE = 'Links are not allowed in rewards';
const CONTROL_MESSAGE = 'Remove the hidden control characters';

// ---------------------------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------------------------

export const rewardTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(REWARD_TITLE_MAX_LENGTH)
  .refine(noControls, CONTROL_MESSAGE)
  .refine((t) => MEANINGFUL_PATTERN.test(t), 'Give the reward a name')
  .refine(noLinks, LINK_MESSAGE);

export const rewardInstructionsSchema = z
  .string()
  .trim()
  .max(REWARD_INSTRUCTIONS_MAX_LENGTH)
  .refine(noControls, CONTROL_MESSAGE)
  .refine(noLinks, LINK_MESSAGE);

export const rewardPointCostSchema = z.number().int().min(1).max(REWARD_POINT_COST_MAX);

export const rewardRequestStateSchema = z.enum([
  'pending',
  'approved',
  'fulfilled',
  'declined',
  'cancelled',
]);
export type RewardRequestState = z.infer<typeof rewardRequestStateSchema>;

export const rewardDecisionActionSchema = z.enum(['approve', 'decline', 'fulfill', 'cancel']);
export type RewardDecisionAction = z.infer<typeof rewardDecisionActionSchema>;

export const pointsLedgerKindSchema = z.enum([
  'award',
  'adjustment',
  'redemption_reserve',
  'redemption_release',
]);
export type PointsLedgerKind = z.infer<typeof pointsLedgerKindSchema>;

const balanceSchema = z.number().int().min(0);

// ---------------------------------------------------------------------------------------------
// Parent: reward definitions
// ---------------------------------------------------------------------------------------------

export const rewardSchema = z.strictObject({
  id: uuidSchema,
  title: z.string(),
  pointCost: z.number().int().min(1),
  instructions: z.string().nullable(),
  /** Null = offered to every child in the family. */
  childId: uuidSchema.nullable(),
  active: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Reward = z.infer<typeof rewardSchema>;

export const createRewardRequestSchema = z.strictObject({
  title: rewardTitleSchema,
  pointCost: rewardPointCostSchema,
  /** Null offers the reward to every child; a child id limits it to that child. */
  childId: uuidSchema.nullable(),
  instructions: rewardInstructionsSchema.optional(),
});
export type CreateRewardRequest = z.infer<typeof createRewardRequestSchema>;

export const updateRewardRequestSchema = z
  .strictObject({
    title: rewardTitleSchema.optional(),
    pointCost: rewardPointCostSchema.optional(),
    /** Null or an empty string clears the instructions. */
    instructions: rewardInstructionsSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update');
export type UpdateRewardRequest = z.infer<typeof updateRewardRequestSchema>;

export const rewardResponseSchema = z.strictObject({ reward: rewardSchema });

// ---------------------------------------------------------------------------------------------
// Parent: requests, balances, decisions
// ---------------------------------------------------------------------------------------------

export const parentRewardRequestSchema = z.strictObject({
  id: uuidSchema,
  childId: uuidSchema,
  childNickname: z.string(),
  rewardId: uuidSchema,
  rewardTitle: z.string(),
  /** Cost captured when the child asked; later price edits never change it. */
  pointCost: z.number().int().min(1),
  state: rewardRequestStateSchema,
  requestedAt: isoDateTimeSchema,
  decidedAt: isoDateTimeSchema.nullable(),
  fulfilledAt: isoDateTimeSchema.nullable(),
  cancelledBy: z.enum(['child', 'parent']).nullable(),
});
export type ParentRewardRequest = z.infer<typeof parentRewardRequestSchema>;

export const rewardChildBalanceSchema = z.strictObject({
  childId: uuidSchema,
  nickname: z.string(),
  balance: balanceSchema,
  /** Archived and draft profiles keep a readable balance (history, spec P11) but take no new rewards. */
  status: z.enum(['draft', 'active', 'archived']),
});
export type RewardChildBalance = z.infer<typeof rewardChildBalanceSchema>;

export const rewardsOverviewResponseSchema = z.strictObject({
  rewards: z.array(rewardSchema),
  children: z.array(rewardChildBalanceSchema),
  /** Pending and approved requests, oldest first (the parent's to-do list). */
  openRequests: z.array(parentRewardRequestSchema),
  /** The most recent fulfilled, declined or cancelled requests (at most 20). */
  recentRequests: z.array(parentRewardRequestSchema),
});
export type RewardsOverview = z.infer<typeof rewardsOverviewResponseSchema>;

export const rewardDecisionRequestSchema = z.strictObject({ action: rewardDecisionActionSchema });

export const rewardDecisionResponseSchema = z.strictObject({
  request: parentRewardRequestSchema,
  /** The child's balance after the decision. */
  balance: balanceSchema,
});
export type RewardDecisionResponse = z.infer<typeof rewardDecisionResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Parent: adjustments and history
// ---------------------------------------------------------------------------------------------

export const pointsAdjustmentRequestSchema = z.strictObject({
  childId: uuidSchema,
  points: z
    .number()
    .int()
    .min(-POINTS_ADJUSTMENT_MAX)
    .max(POINTS_ADJUSTMENT_MAX)
    .refine((p) => p !== 0, 'An adjustment must change the balance'),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(POINTS_REASON_MAX_LENGTH)
    .refine(noControls, CONTROL_MESSAGE)
    .refine((r) => MEANINGFUL_PATTERN.test(r), 'Explain why the points are being adjusted'),
  /** Client-generated; retrying with the same id never applies the adjustment twice. */
  adjustmentId: uuidSchema,
});
export type PointsAdjustmentRequest = z.infer<typeof pointsAdjustmentRequestSchema>;

export const pointsAdjustmentResponseSchema = z.strictObject({
  childId: uuidSchema,
  balance: balanceSchema,
  /** False when this adjustmentId was already recorded (idempotent retry; nothing changed). */
  applied: z.boolean(),
});
export type PointsAdjustmentResponse = z.infer<typeof pointsAdjustmentResponseSchema>;

export const pointsHistoryEntrySchema = z.strictObject({
  /** Ledger sequence number (bigint as a decimal string). */
  id: z.string().regex(/^\d+$/),
  kind: pointsLedgerKindSchema,
  points: z.number().int(),
  reason: z.string().nullable(),
  actor: z.enum(['system', 'parent', 'child']),
  redemptionId: uuidSchema.nullable(),
  rewardTitle: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type PointsHistoryEntry = z.infer<typeof pointsHistoryEntrySchema>;

export const pointsHistoryResponseSchema = z.strictObject({
  childId: uuidSchema,
  balance: balanceSchema,
  /** Newest first; at most 100 entries. */
  entries: z.array(pointsHistoryEntrySchema),
  hasMore: z.boolean(),
  /** Sums over the child's whole ledger; `net` always equals `balance` (P9 reconciliation). */
  totals: z.strictObject({
    awarded: z.number().int(),
    adjustments: z.number().int(),
    reserved: z.number().int(),
    released: z.number().int(),
    net: z.number().int(),
  }),
});
export type PointsHistory = z.infer<typeof pointsHistoryResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Parent: family earning rules (spec P9 "configurable earning rules"; AC_REWARDS_01)
// ---------------------------------------------------------------------------------------------

/** One rule awards 0–100 points (reward_rules checks, domain MAX_POINTS_PER_AWARD). */
export const REWARD_RULE_POINTS_MAX = 100;
/**
 * Decision: answers faster than the family's minimum response time earn nothing. Parents choose
 * 0.5–60 s, never less than 0.5 s (migration 0750 floor, domain MIN_RESPONSE_THRESHOLD_MS): with
 * blank answers never earning and one award per question and per set, that floor keeps rapid
 * retries from farming points at the lowest setting too.
 */
export const REWARD_RULE_MIN_RESPONSE_MS_MIN = 500;
export const REWARD_RULE_MIN_RESPONSE_MS_MAX = 60_000;

const rulePointsSchema = z.number().int().min(0).max(REWARD_RULE_POINTS_MAX);

export const familyRewardRulesSchema = z.strictObject({
  /** Points for a meaningful try, earned even when the answer is wrong (once per question). */
  attemptPoints: rulePointsSchema,
  /** Extra points when the first try is right without help (once per question). */
  independentCorrectBonus: rulePointsSchema,
  /** Points for finishing a practice set with meaningful work on every question (once per set). */
  setCompletionPoints: rulePointsSchema,
  /** Blank answers, and answers faster than this, earn nothing (anti-farming). */
  minMeaningfulResponseMs: z
    .number()
    .int()
    .min(REWARD_RULE_MIN_RESPONSE_MS_MIN)
    .max(REWARD_RULE_MIN_RESPONSE_MS_MAX),
});
export type FamilyRewardRules = z.infer<typeof familyRewardRulesSchema>;

/** PUT body: the complete rules (a full replacement, so a retried save is idempotent). */
export const updateRewardRulesRequestSchema = familyRewardRulesSchema;
export type UpdateRewardRulesRequest = z.infer<typeof updateRewardRulesRequestSchema>;

export const rewardRulesResponseSchema = z.strictObject({
  /** The rules that apply to the next award. */
  rules: familyRewardRulesSchema,
  /** The P9 suggested starting rules (what a family earns on until it changes them). */
  suggested: familyRewardRulesSchema,
  /** When the family last changed its rules; null = never (the suggested rules apply). */
  updatedAt: isoDateTimeSchema.nullable(),
});
export type RewardRulesResponse = z.infer<typeof rewardRulesResponseSchema>;

export const rewardRulesUpdateResponseSchema = z.strictObject({
  rules: familyRewardRulesSchema,
  suggested: familyRewardRulesSchema,
  updatedAt: isoDateTimeSchema.nullable(),
  /** False when exactly these rules were already in place (idempotent retry; nothing changed). */
  changed: z.boolean(),
});
export type RewardRulesUpdateResponse = z.infer<typeof rewardRulesUpdateResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Child: explicit allowlisted fields only (no family ids, creators, reasons or sibling data)
// ---------------------------------------------------------------------------------------------

/**
 * The family's published point values in child terms. Deliberately without the minimum response
 * time: a child told the exact threshold could simply wait it out before guessing.
 */
export const childEarningRulesSchema = z.strictObject({
  /** Points for trying a practice question, even when it isn't right yet (once per question). */
  pointsPerTry: rulePointsSchema,
  /** Extra points for getting it right on the first try without help (once per question). */
  firstTryBonus: rulePointsSchema,
  /** Points for finishing a practice set (once per set). */
  setCompletionPoints: rulePointsSchema,
});
export type ChildEarningRules = z.infer<typeof childEarningRulesSchema>;

export const childRewardSchema = z.strictObject({
  id: uuidSchema,
  title: z.string(),
  pointCost: z.number().int().min(1),
  instructions: z.string().nullable(),
});
export type ChildReward = z.infer<typeof childRewardSchema>;

export const childRewardRequestSchema = z.strictObject({
  id: uuidSchema,
  rewardId: uuidSchema,
  /** Null when the reward is no longer offered. */
  rewardTitle: z.string().nullable(),
  pointCost: z.number().int().min(1),
  state: rewardRequestStateSchema,
  requestedAt: isoDateTimeSchema,
  decidedAt: isoDateTimeSchema.nullable(),
  fulfilledAt: isoDateTimeSchema.nullable(),
});
export type ChildRewardRequest = z.infer<typeof childRewardRequestSchema>;

export const childRewardsResponseSchema = z.strictObject({
  balance: balanceSchema,
  rewards: z.array(childRewardSchema),
  /** Open requests first, then the most recent (at most 50). */
  requests: z.array(childRewardRequestSchema),
  /** How points are earned in this family ("How you earn points"). */
  earningRules: childEarningRulesSchema,
});
export type ChildRewards = z.infer<typeof childRewardsResponseSchema>;

export const childRewardRequestBodySchema = z.strictObject({
  /** Client-generated; a retried request with the same id never reserves points twice. */
  requestId: uuidSchema,
});

export const childRewardRequestResponseSchema = z.strictObject({
  request: childRewardRequestSchema,
  balance: balanceSchema,
});
export type ChildRewardRequestResponse = z.infer<typeof childRewardRequestResponseSchema>;
