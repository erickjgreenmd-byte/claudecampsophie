/** Which limit was reached. */
export type ExhaustionKind = 'child_allowance' | 'family_allowance' | 'global_budget';

/** What always stays available after any limit is reached (spec P11, F4, AC_SECURITY_06). */
export const PRESERVED_ON_EXHAUSTION = Object.freeze([
  'existing_results',
  'learning_history',
  'vetted_offline_practice',
  'earned_points',
] as const);
export type PreservedItem = (typeof PRESERVED_ON_EXHAUSTION)[number];

/** Neutral choices the parent (never the child) is shown. None of them is a purchase from child mode. */
export type ParentChoice =
  | 'continue_vetted_offline_practice'
  | 'wait_for_next_billing_period'
  | 'review_paid_capacity'
  | 'retry_later';

export interface ExhaustionOutcome {
  readonly kind: ExhaustionKind;
  readonly preserve: readonly PreservedItem[];
  /** i18n key for the parent explanation; copy lives with the UI. */
  readonly parentMessageKey: string;
  readonly parentChoices: readonly ParentChoice[];
  readonly resumes: 'next_billing_period' | 'when_budget_restored';
  /** Queued/pending work is kept and retried safely, never dropped. */
  readonly pendingWork: 'kept_for_safe_retry';
  readonly surpriseOverageBilling: false;
  readonly childCanPurchase: false;
  /** Correctness verification is never skipped to save money (spec F4). */
  readonly bypassCorrectnessVerification: false;
}

function outcome(
  kind: ExhaustionKind,
  parentMessageKey: string,
  parentChoices: readonly ParentChoice[],
  resumes: ExhaustionOutcome['resumes'],
): ExhaustionOutcome {
  return Object.freeze({
    kind,
    preserve: PRESERVED_ON_EXHAUSTION,
    parentMessageKey,
    parentChoices: Object.freeze([...parentChoices]),
    resumes,
    pendingWork: 'kept_for_safe_retry',
    surpriseOverageBilling: false,
    childCanPurchase: false,
    bypassCorrectnessVerification: false,
  });
}

/**
 * What the product does when a limit is reached: keep everything already earned or produced,
 * explain the situation to the parent, and never bill an overage or let a child buy more usage.
 *
 * Decision: `review_paid_capacity` is offered only for the family ceiling (adding a paid slot is
 * the one parent action that raises it, and it still requires re-authentication and store
 * confirmation). A child's own allowance cannot be raised by purchase, and a global budget hold is
 * the operator's problem, so the family is only told to retry later.
 */
export function exhaustionOutcome(kind: ExhaustionKind): ExhaustionOutcome {
  switch (kind) {
    case 'child_allowance':
      return outcome(
        kind,
        'quota.exhausted.child_allowance',
        ['continue_vetted_offline_practice', 'wait_for_next_billing_period'],
        'next_billing_period',
      );
    case 'family_allowance':
      return outcome(
        kind,
        'quota.exhausted.family_allowance',
        [
          'continue_vetted_offline_practice',
          'wait_for_next_billing_period',
          'review_paid_capacity',
        ],
        'next_billing_period',
      );
    case 'global_budget':
      return outcome(
        kind,
        'quota.exhausted.global_budget',
        ['continue_vetted_offline_practice', 'retry_later'],
        'when_budget_restored',
      );
  }
}
