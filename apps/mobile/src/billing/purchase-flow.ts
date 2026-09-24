import type { BillingStatus } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import type { AppMode } from '../lib/mode.ts';
import {
  billingProblem,
  requestCapacityChange,
  syncBilling,
  type BillingProblem,
} from './actions.ts';
import { childrenLabel, type PlanView, type TierView } from './plan-view.ts';
import {
  STORE_LABEL,
  type BillingStore,
  type PurchaseRequest,
  type StoreChannel,
  type StorePurchaseOutcome,
} from './store.ts';

/**
 * Plan purchase/change flow (spec P3, P11; AC_BILLING_02/05, AC_CAPACITY_04/06). Pure: no
 * react-native imports; the store and API are injected. Rules:
 * - child mode or a signed-out parent is blocked before anything opens;
 * - the server records the change only after a fresh parent PIN step-up, BEFORE the store opens;
 * - the store's own sheet is the confirmation; nothing is charged unless the parent confirms there;
 * - pending / Ask to Buy / cancelled / failed grant nothing, and even a store "success" is shown as
 *   done only once the server has verified the provider's state (POST /v1/billing/sync).
 *
 * idle → confirming → purchasing → verifying → success | scheduled
 *                                → pending | cancelled | failed
 * (any) → blocked when the device is in child mode or no parent is signed in.
 */

export interface PurchaseContext {
  readonly mode: AppMode;
  readonly parentSignedIn: boolean;
}

export type BlockReason =
  | 'child_mode'
  | 'signed_out'
  | 'not_in_build'
  | 'no_store_on_device'
  | 'managed_elsewhere'
  | 'store_loading'
  | 'tier_unavailable';

export interface Confirmation {
  readonly direction: 'upgrade' | 'downgrade';
  readonly channel: StoreChannel;
  readonly billingRef: string;
  readonly productId: string;
  readonly replacing: PurchaseRequest['replacing'];
  readonly currentSlots: number;
  readonly targetSlots: number;
  /** Children holding a paid slot today (a smaller plan needs a keep selection when above target). */
  readonly assignedSlots: number;
  readonly needsKeepSelection: boolean;
  readonly heading: string;
  readonly childCountLine: string;
  readonly recurringLine: string;
  readonly priceNotice: string | null;
  readonly dueNowLine: string;
  readonly storeConfirmationLine: string;
  readonly activationLine: string;
}

export type PurchaseState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'blocked'; readonly reason: BlockReason; readonly message: string }
  | { readonly kind: 'confirming'; readonly confirmation: Confirmation }
  | { readonly kind: 'purchasing'; readonly confirmation: Confirmation }
  | {
      readonly kind: 'verifying';
      readonly confirmation: Confirmation;
      readonly message: string;
    }
  | { readonly kind: 'pending'; readonly confirmation: Confirmation; readonly message: string }
  | { readonly kind: 'success'; readonly paidSlots: number; readonly message: string }
  | { readonly kind: 'scheduled'; readonly targetSlots: number; readonly message: string }
  | { readonly kind: 'cancelled'; readonly message: string }
  | {
      readonly kind: 'failed';
      readonly message: string;
      readonly needsPin: boolean;
      readonly confirmation: Confirmation | null;
    };

export type PurchaseEvent =
  | {
      readonly type: 'select';
      readonly tier: TierView;
      readonly plan: PlanView;
      readonly status: BillingStatus;
      readonly channel: StoreChannel | null;
      readonly context: PurchaseContext;
    }
  | { readonly type: 'confirm'; readonly context: PurchaseContext }
  | { readonly type: 'intent_rejected'; readonly problem: BillingProblem }
  | { readonly type: 'store_result'; readonly outcome: StorePurchaseOutcome }
  | { readonly type: 'verified'; readonly status: BillingStatus; readonly timeZone?: string }
  | { readonly type: 'verify_failed' }
  | { readonly type: 'reset' };

const CHILD_MODE_MESSAGE =
  'Plans can’t be bought or changed in child mode. A grown-up needs to unlock the parent area first.';
const SIGNED_OUT_MESSAGE = 'Sign in as a parent to buy or change a plan.';

/** Child mode and a missing parent session always win, whatever else is on screen. */
export function contextBlock(
  context: PurchaseContext,
): { reason: 'child_mode' | 'signed_out'; message: string } | null {
  if (context.mode === 'child') return { reason: 'child_mode', message: CHILD_MODE_MESSAGE };
  if (!context.parentSignedIn) return { reason: 'signed_out', message: SIGNED_OUT_MESSAGE };
  return null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildConfirmation(
  tier: TierView,
  plan: PlanView,
  status: BillingStatus,
  channel: StoreChannel,
): Confirmation {
  const store = STORE_LABEL[channel];
  const direction: Confirmation['direction'] =
    tier.paidSlots > status.paidSlots ? 'upgrade' : 'downgrade';
  const today = status.paidSlots > 0 ? ` (it covers ${childrenLabel(status.paidSlots)} today)` : '';
  const replacing =
    plan.currentProductId !== null && status.paidSlots > 0
      ? { productId: plan.currentProductId, direction }
      : null;
  return {
    direction,
    channel,
    billingRef: status.billingRef,
    productId: tier.productId!,
    replacing,
    currentSlots: status.paidSlots,
    targetSlots: tier.paidSlots,
    assignedSlots: status.assignedSlots,
    needsKeepSelection: direction === 'downgrade' && status.assignedSlots > tier.paidSlots,
    heading:
      status.paidSlots === 0
        ? `Subscribe for ${childrenLabel(tier.paidSlots)}`
        : `Change your plan to ${childrenLabel(tier.paidSlots)}`,
    childCountLine:
      direction === 'upgrade'
        ? `Your plan will cover ${childrenLabel(tier.paidSlots)}${today}.`
        : `After the change your plan will cover ${childrenLabel(tier.paidSlots)}${today}.`,
    recurringLine: `New monthly total: ${tier.storePriceText ?? tier.approvedPriceText}, as charged by ${store}.`,
    priceNotice: tier.priceNotice,
    // AC_CAPACITY_06: the store supplies due-now and proration; we never promise a fixed charge today.
    dueNowLine:
      direction === 'upgrade'
        ? `${capitalize(store)} shows what you’ll pay today, including any proration for the rest of this billing period, before you confirm.`
        : `The change takes effect on the date ${store} confirms, usually your next renewal. Until then, every child keeps access.`,
    storeConfirmationLine: `You’ll confirm in ${store}. Nothing is charged unless you confirm there.`,
    activationLine:
      direction === 'upgrade'
        ? 'The new child slot is added only after the store confirms payment. If the purchase needs approval (Ask to Buy) or is still pending, no slot is added yet.'
        : 'Removing a child profile alone doesn’t change your subscription; this change does, once the store confirms it.',
  };
}

function reached(confirmation: Confirmation, status: BillingStatus): boolean {
  if (confirmation.direction === 'upgrade') return status.paidSlots >= confirmation.targetSlots;
  return (
    (status.paidSlots > 0 && status.paidSlots <= confirmation.targetSlots) ||
    status.pendingChange?.targetSlots === confirmation.targetSlots
  );
}

function verifiedState(
  confirmation: Confirmation,
  status: BillingStatus,
  timeZone: string | undefined,
): PurchaseState {
  if (confirmation.direction === 'upgrade' || status.paidSlots <= confirmation.targetSlots) {
    const free = Math.max(0, status.paidSlots - status.assignedSlots);
    return {
      kind: 'success',
      paidSlots: status.paidSlots,
      message: `Confirmed by the store: your plan now covers ${childrenLabel(status.paidSlots)}.${free > 0 ? ` Assign the unused ${free === 1 ? 'slot' : 'slots'} to a child in Children.` : ''}`,
    };
  }
  const when = status.pendingChange
    ? new Date(status.pendingChange.effectiveAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        ...(timeZone === undefined ? {} : { timeZone }),
      })
    : null;
  return {
    kind: 'scheduled',
    targetSlots: confirmation.targetSlots,
    message: `Confirmed by the store: your plan changes to ${childrenLabel(confirmation.targetSlots)}${when ? ` on ${when}` : ' at your next renewal'}. Until then, every child keeps access.`,
  };
}

const VERIFYING_MESSAGE =
  'The store reported success. We’re waiting for it to confirm with PencilLift — nothing changes until it does. Check again in a moment.';
const PENDING_MESSAGE =
  'The purchase is waiting for approval (for example Ask to Buy) or for the payment to finish. No child slot is added until the store completes it.';

/** Pure state machine for the plan change flow. Invalid events leave the state unchanged. */
export function transition(state: PurchaseState, event: PurchaseEvent): PurchaseState {
  switch (event.type) {
    case 'reset':
      return { kind: 'idle' };
    case 'select': {
      const blocked = contextBlock(event.context);
      if (blocked) return { kind: 'blocked', ...blocked };
      const { plan, tier, status, channel } = event;
      if (plan.availability.kind !== 'ready') {
        return {
          kind: 'blocked',
          reason: plan.availability.kind,
          message: plan.availability.message,
        };
      }
      if (!tier.purchasable || tier.productId === null || channel === null) {
        return {
          kind: 'blocked',
          reason: 'tier_unavailable',
          message: tier.unavailableReason ?? 'This plan can’t be chosen right now.',
        };
      }
      return { kind: 'confirming', confirmation: buildConfirmation(tier, plan, status, channel) };
    }
    case 'confirm': {
      if (state.kind !== 'confirming') return state;
      // Re-checked at the moment of confirmation: the device may have switched to child mode.
      const blocked = contextBlock(event.context);
      if (blocked) return { kind: 'blocked', ...blocked };
      return { kind: 'purchasing', confirmation: state.confirmation };
    }
    case 'intent_rejected':
      if (state.kind !== 'purchasing') return state;
      return {
        kind: 'failed',
        message: event.problem.message,
        needsPin: event.problem.needsPin,
        confirmation: state.confirmation,
      };
    case 'store_result': {
      if (state.kind !== 'purchasing') return state;
      const { confirmation } = state;
      switch (event.outcome.kind) {
        case 'success':
          return { kind: 'verifying', confirmation, message: VERIFYING_MESSAGE };
        case 'pending':
          return { kind: 'pending', confirmation, message: PENDING_MESSAGE };
        case 'cancelled':
          return {
            kind: 'cancelled',
            message: 'Purchase cancelled. Nothing was charged and your plan is unchanged.',
          };
        case 'failed':
          return { kind: 'failed', message: event.outcome.message, needsPin: false, confirmation };
        default:
          // Anything unrecognized from a device is never treated as paid.
          return {
            kind: 'failed',
            message: 'The store couldn’t complete the purchase.',
            needsPin: false,
            confirmation,
          };
      }
    }
    case 'verified': {
      if (state.kind !== 'verifying' && state.kind !== 'pending' && state.kind !== 'failed') {
        return state;
      }
      const confirmation = state.confirmation;
      if (!confirmation) return state;
      // Only the server-verified provider state decides; a store "success" alone is not enough.
      if (reached(confirmation, event.status)) {
        return verifiedState(confirmation, event.status, event.timeZone);
      }
      return state;
    }
    case 'verify_failed':
      if (state.kind !== 'verifying') return state;
      return {
        ...state,
        message:
          'The store reported success, but we couldn’t check with PencilLift just now. Nothing changes until it’s confirmed; check again in a moment.',
      };
    default:
      return state;
  }
}

export interface PlanChangeDeps {
  readonly api: ApiClient;
  readonly store: BillingStore;
  /** Read at the moment of confirmation (mode can change while the sheet is open). */
  readonly context: () => PurchaseContext | Promise<PurchaseContext>;
  readonly onState?: ((state: PurchaseState) => void) | undefined;
  readonly timeZone?: string | undefined;
}

/**
 * Runs a confirmed plan change: step-up-gated intent on the server → store sheet → server sync.
 * Returns the final state. The store never opens if the parent is blocked or the server refuses.
 */
export async function runPlanChange(
  deps: PlanChangeDeps,
  confirming: PurchaseState,
  keepChildIds?: readonly string[],
): Promise<PurchaseState> {
  let state = transition(confirming, { type: 'confirm', context: await deps.context() });
  if (state.kind !== 'purchasing') return state;
  deps.onState?.(state);
  const { confirmation } = state;
  if (confirmation.needsKeepSelection && (keepChildIds?.length ?? 0) === 0) {
    return {
      kind: 'failed',
      message: 'Choose which children stay active on the smaller plan.',
      needsPin: false,
      confirmation,
    };
  }
  try {
    await requestCapacityChange(deps.api, {
      kind: confirmation.direction,
      toSlots: confirmation.targetSlots,
      ...(confirmation.direction === 'downgrade' && keepChildIds !== undefined
        ? { keepChildIds: [...keepChildIds] }
        : {}),
    });
  } catch (error) {
    return transition(state, { type: 'intent_rejected', problem: billingProblem(error) });
  }
  let outcome: StorePurchaseOutcome;
  try {
    await deps.store.identify(confirmation.billingRef);
    outcome = await deps.store.purchase({
      productId: confirmation.productId,
      replacing: confirmation.replacing,
    });
  } catch {
    outcome = {
      kind: 'failed',
      message: 'The store couldn’t be opened. Nothing was charged; please try again.',
    };
  }
  state = transition(state, { type: 'store_result', outcome });
  if (state.kind === 'cancelled') return state;
  deps.onState?.(state);
  return verify(deps, state);
}

/** Asks the server for the provider's verified state and folds it into the flow. */
export async function verify(deps: PlanChangeDeps, state: PurchaseState): Promise<PurchaseState> {
  try {
    const status = await syncBilling(deps.api);
    return transition(state, {
      type: 'verified',
      status,
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    });
  } catch {
    return transition(state, { type: 'verify_failed' });
  }
}

export type RestoreState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'restoring' }
  | { readonly kind: 'restored'; readonly paidSlots: number; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/** Restore purchases for this store account, then let the server verify what they grant. */
export async function runRestore(deps: PlanChangeDeps, billingRef: string): Promise<RestoreState> {
  const blocked = contextBlock(await deps.context());
  if (blocked) return { kind: 'blocked', message: blocked.message };
  if (!deps.store.available) {
    return {
      kind: 'blocked',
      message: 'Restoring purchases isn’t available in this build of the app.',
    };
  }
  try {
    await deps.store.identify(billingRef);
    const outcome = await deps.store.restore();
    if (outcome.kind === 'failed') return { kind: 'failed', message: outcome.message };
  } catch {
    return { kind: 'failed', message: 'The store couldn’t restore purchases. Please try again.' };
  }
  try {
    const status = await syncBilling(deps.api);
    return {
      kind: 'restored',
      paidSlots: status.paidSlots,
      message:
        status.paidSlots > 0
          ? `Checked with the store: your plan covers ${childrenLabel(status.paidSlots)}.`
          : 'Checked with the store: no active PencilLift subscription was found for this store account.',
    };
  } catch (error) {
    return { kind: 'failed', message: billingProblem(error).message };
  }
}
