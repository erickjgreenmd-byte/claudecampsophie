// Paid capacity, the normalized family entitlement ledger and child slot assignment (spec P11, E2).
export {
  ENTITLEMENT_STATUSES,
  MAX_ACCESS_AFTER_PERIOD_END_MS,
  grantsAccess,
  type EntitlementStatus,
} from './status.ts';
export {
  RESOLVE_PAID_SLOTS_ERROR_CODES,
  resolvePaidSlots,
  resolveProductSlots,
  type BillingEnvironment,
  type ProviderSubscriptionSnapshot,
  type ResolvePaidSlotsErrorCode,
  type StoreProductMapping,
} from './products.ts';
export {
  SUBSCRIBER_BINDING_ERROR_CODES,
  bindSnapshotToFamily,
  computeFamilyCapacity,
  reconcileEntitlements,
  type CapacityConflict,
  type CapacitySource,
  type EntitlementRecord,
  type FamilyCapacity,
  type PendingCapacityChange,
  type ReconcileOutcome,
  type ReconcileResult,
  type SubscriberBindingErrorCode,
} from './ledger.ts';
export {
  CHILD_ACTIVATION_ERROR_CODES,
  CLIENT_PURCHASE_RESULTS,
  childHasPaidAi,
  describeProfileRemoval,
  evaluateClientPurchaseResult,
  planChildActivation,
  type ChildActivationErrorCode,
  type ChildActivationInput,
  type ChildActivationPlan,
  type ChildProfileState,
  type ChildProfileStatus,
  type ClientPurchaseEvaluation,
  type ClientPurchaseResult,
  type PaidAiCheck,
  type Principal,
  type ProfileRemovalDescription,
} from './slots.ts';
export {
  DOWNGRADE_ERROR_CODES,
  applyDowngradeIfDue,
  planDowngrade,
  type DowngradeApplication,
  type DowngradeErrorCode,
  type DowngradeInput,
  type DowngradeRetention,
  type DowngradeState,
  type ScheduledDowngrade,
} from './downgrade.ts';
