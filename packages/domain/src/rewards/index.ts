// Family rewards and points (spec P9, P16.4, P5): earning rules, the append-only points ledger,
// redemption workflow, parent adjustments and reconciliation. Points are not money: this module
// intentionally has no cash-out, transfer, sale or purchase operation.
export {
  DEFAULT_REWARD_RULES,
  MAX_POINTS_PER_AWARD,
  MAX_RESPONSE_THRESHOLD_MS,
  MIN_RESPONSE_THRESHOLD_MS,
  REWARD_RULES_ERROR_CODES,
  validateRules,
  type RewardRules,
  type RewardRulesErrorCode,
} from './rules.ts';
export {
  APPEND_ERROR_CODES,
  LEDGER_ACTORS,
  LEDGER_ENTRY_KINDS,
  LEDGER_INVARIANT_CODES,
  LedgerInvariantError,
  appendToLedger,
  balance,
  describeEntryProblem,
  type AppendErrorCode,
  type LedgerActor,
  type LedgerEntry,
  type LedgerEntryKind,
  type LedgerInvariantCode,
  type RewardsPrincipal,
} from './ledger.ts';
export {
  adjustmentKey,
  attemptKey,
  independentKey,
  isValidId,
  releaseKey,
  reserveKey,
  setKey,
} from './ids.ts';
export { isMeaningfulText } from './text.ts';
export {
  AWARD_ERROR_CODES,
  LEARNING_EVENT_KINDS,
  computeAwards,
  overrideAwards,
  parseLearningEvent,
  type AwardErrorCode,
  type ExistingIdempotencyKeys,
  type GradingOverride,
  type LearningEvent,
  type PracticeAttemptEvent,
  type SetCompletedEvent,
} from './awards.ts';
export {
  MAX_REWARD_POINT_COST,
  REDEMPTION_ACTIONS,
  REDEMPTION_STATES,
  REQUEST_REDEMPTION_ERROR_CODES,
  TRANSITION_ERROR_CODES,
  isValidPointCost,
  requestRedemption,
  transitionRedemption,
  type RedemptionAction,
  type RedemptionOutcome,
  type RedemptionRequest,
  type RedemptionState,
  type RequestRedemptionErrorCode,
  type RequestRedemptionInput,
  type RewardOffer,
  type TransitionContext,
  type TransitionErrorCode,
} from './redemption.ts';
export {
  MAX_ADJUSTMENT_POINTS,
  MAX_ADJUSTMENT_REASON_LENGTH,
  PARENT_ADJUSTMENT_ERROR_CODES,
  parentAdjustment,
  type ParentAdjustmentErrorCode,
  type ParentAdjustmentInput,
} from './adjustments.ts';
export {
  LEDGER_VIOLATION_CODES,
  reconcileLedger,
  type LedgerViolation,
  type LedgerViolationCode,
} from './reconcile.ts';
export {
  MAX_REWARD_INSTRUCTIONS_LENGTH,
  MAX_REWARD_TITLE_LENGTH,
  REWARD_DEFINITION_ERROR_CODES,
  validateRewardDefinition,
  type RewardDefinition,
  type RewardDefinitionErrorCode,
  type RewardDefinitionInput,
} from './catalog.ts';
