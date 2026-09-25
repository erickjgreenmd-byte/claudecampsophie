import { useCallback, useEffect, useMemo, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { BillingStatus } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors } from '@pencillift/ui-tokens';
import {
  billingProblem,
  loadActiveChildren,
  loadBillingStatus,
  type ActiveChild,
} from '../../src/billing/actions.ts';
import { buildPlanView, type PlanView, type TierView } from '../../src/billing/plan-view.ts';
import {
  keepSelectionMessage,
  runPlanChange,
  runRestore,
  transition,
  verify,
  type Confirmation,
  type PlanChangeDeps,
  type PurchaseContext,
  type PurchaseState,
  type RestoreState,
} from '../../src/billing/purchase-flow.ts';
import { createNativeBillingStore } from '../../src/billing/revenuecat.ts';
import { STORE_LABEL, type BillingStore, type StoreProductInfo } from '../../src/billing/store.ts';
import { parentTokenSource } from '../../src/family/parent-session.ts';
import {
  Body,
  Button,
  Card,
  ErrorBox,
  Heading,
  LegalLinks,
  Loading,
  Notice,
  ParentAccessState,
  Screen,
  styles,
  Title,
  useLoad,
  useParentAccess,
} from '../../src/family/ui.tsx';
import { currentMode } from '../../src/lib/mode.ts';
import { secureStorage } from '../../src/lib/secure-storage.ts';

/**
 * Parent plan and paid child slots (spec P11, P14 "subscription" + "add-child/paid-slot management
 * with upgrade confirmation"; AC_BILLING_02/05, AC_CAPACITY_02/04/06). Parent area only: child mode
 * never reaches this screen (useParentAccess), and the purchase flow re-checks the mode itself.
 * Paid slots shown here always come from the server's verified provider state.
 */
export default function PlanScreen() {
  const access = useParentAccess();
  return (
    <Screen>
      <Title>Plan and child slots</Title>
      <ParentAccessState access={access} />
      {access.status === 'ready' ? <Plan api={access.api} /> : null}
    </Screen>
  );
}

async function purchaseContext(): Promise<PurchaseContext> {
  return { mode: await currentMode(secureStorage), parentSignedIn: parentTokenSource() !== null };
}

function Plan({ api }: { api: ApiClient }) {
  const store = useMemo(() => createNativeBillingStore(), []);
  const load = useCallback(() => loadBillingStatus(api), [api]);
  const { state, reload } = useLoad(load);
  const status = state.status === 'ready' ? state.data : null;
  const [products, setProducts] = useState<StoreProductInfo[] | null>(null);
  const [productsProblem, setProductsProblem] = useState<string | null>(null);
  const [productsVersion, setProductsVersion] = useState(0);

  const billingRef = status?.billingRef ?? null;
  useEffect(() => {
    if (!billingRef || !store.available) return;
    let active = true;
    setProductsProblem(null);
    // Bind the store SDK to this family first, then load the store's own prices.
    store
      .identify(billingRef)
      .then(() => store.loadProducts())
      .then(
        (list) => {
          if (active) setProducts(list);
        },
        () => {
          if (active)
            setProductsProblem(
              'Plans couldn’t be loaded from the store. Check your connection and try again.',
            );
        },
      );
    return () => {
      active = false;
    };
  }, [billingRef, store, productsVersion]);

  if (!status) {
    if (state.status === 'error') {
      const p = billingProblem(state.error);
      return (
        <ErrorBox
          message={p.message}
          needsPin={p.needsPin}
          onRetry={p.noFamily ? undefined : () => void reload()}
        />
      );
    }
    return <Loading label="Loading your plan" />;
  }

  const plan = buildPlanView({
    status,
    deviceChannel: store.channel,
    storeAvailable: store.available,
    storeProducts: products,
  });
  return (
    <>
      <CurrentPlan plan={plan} />
      <Plans
        api={api}
        store={store}
        status={status}
        plan={plan}
        productsProblem={productsProblem}
        onRetryProducts={() => setProductsVersion((v) => v + 1)}
        onChanged={() => void reload()}
      />
      <StoreTools api={api} store={store} status={status} plan={plan} onChanged={reload} />
      <Card>
        <Heading>Monthly promo codes</Heading>
        <Body>
          Promo codes are entered on the School and promotions screen. A code covers one monthly
          billing period only.
        </Body>
        <Button
          label="Go to School and promotions"
          secondary
          onPress={() => router.push('/(parent)/school')}
        />
      </Card>
    </>
  );
}

function CurrentPlan({ plan }: { plan: PlanView }) {
  return (
    <Card>
      <Heading>Your plan</Heading>
      <Body>{plan.headline}</Body>
      <Body>{plan.slotsLine}</Body>
      {plan.managedByLine ? <Body>{plan.managedByLine}</Body> : null}
      {plan.conflictWarning ? (
        <Notice alert>
          <Body>{plan.conflictWarning}</Body>
        </Notice>
      ) : null}
      {plan.pendingLine ? (
        <Notice>
          <Body>{plan.pendingLine}</Body>
        </Notice>
      ) : null}
      {plan.requestedLine ? <Body muted>{plan.requestedLine}</Body> : null}
      {plan.unusedSlotLine ? (
        <Notice>
          <Body>{plan.unusedSlotLine}</Body>
          <Button
            label="Go to Children"
            secondary
            onPress={() => router.push('/(parent)/children')}
          />
        </Notice>
      ) : null}
      {plan.entitlementLines.length > 0 ? <Heading>Store subscriptions</Heading> : null}
      {plan.entitlementLines.map((line) => (
        <Body key={line.key}>{line.text}</Body>
      ))}
    </Card>
  );
}

function Plans({
  api,
  store,
  status,
  plan,
  productsProblem,
  onRetryProducts,
  onChanged,
}: {
  api: ApiClient;
  store: BillingStore;
  status: BillingStatus;
  plan: PlanView;
  productsProblem: string | null;
  onRetryProducts: () => void;
  onChanged: () => void;
}) {
  const [flow, setFlow] = useState<PurchaseState>({ kind: 'idle' });
  const deps: PlanChangeDeps = { api, store, context: purchaseContext, onState: setFlow };
  const busy = flow.kind === 'purchasing';

  const select = async (tier: TierView) => {
    setFlow(
      transition(flow, {
        type: 'select',
        tier,
        plan,
        status,
        channel: store.channel,
        context: await purchaseContext(),
      }),
    );
  };

  const confirm = async (keepChildIds: readonly string[] | undefined) => {
    const final = await runPlanChange(deps, flow, keepChildIds);
    setFlow(final);
    onChanged();
  };

  const checkAgain = async () => {
    setFlow(await verify(deps, flow));
    onChanged();
  };

  return (
    <Card>
      <Heading>Plans</Heading>
      <Body>
        One family subscription covers up to {plan.tiers.length} children. Each child keeps their
        own homework, practice, reviews and points.
      </Body>
      {plan.availability.kind !== 'ready' ? (
        <Notice>
          <Body>{plan.availability.message}</Body>
        </Notice>
      ) : null}
      {productsProblem ? <ErrorBox message={productsProblem} onRetry={onRetryProducts} /> : null}
      {plan.tiers.map((tier) => (
        <View key={tier.paidSlots} style={{ marginVertical: 8 }}>
          <Text style={[styles.body, { fontWeight: '800' }]}>
            {tier.label}
            {tier.relation === 'current' ? ' — your current plan' : ''}
          </Text>
          <Body>PencilLift approved price: {tier.approvedPriceText}</Body>
          {tier.storePriceText ? (
            <Body>Store price (what you pay): {tier.storePriceText}</Body>
          ) : null}
          {tier.priceNotice && !tier.priceBlock ? (
            <Notice>
              <Body>{tier.priceNotice}</Body>
            </Notice>
          ) : null}
          {tier.purchasable && tier.actionLabel ? (
            <Button
              label={tier.actionLabel}
              accessibilityLabel={`${tier.actionLabel}: ${tier.a11yLabel}`}
              secondary={tier.relation === 'downgrade'}
              disabled={busy}
              onPress={() => void select(tier)}
            />
          ) : null}
          {!tier.purchasable &&
          tier.relation !== 'current' &&
          plan.availability.kind === 'ready' ? (
            <Body muted>{tier.unavailableReason}</Body>
          ) : null}
        </View>
      ))}
      <Heading>Subscription terms</Heading>
      {plan.termsLines.map((line) => (
        <Body key={line}>{line}</Body>
      ))}
      <LegalLinks />
      <FlowPanel
        api={api}
        flow={flow}
        onConfirm={(keep) => void confirm(keep)}
        onCheckAgain={() => void checkAgain()}
        onClose={() => setFlow(transition(flow, { type: 'reset' }))}
      />
    </Card>
  );
}

function FlowPanel({
  api,
  flow,
  onConfirm,
  onCheckAgain,
  onClose,
}: {
  api: ApiClient;
  flow: PurchaseState;
  onConfirm: (keepChildIds: readonly string[] | undefined) => void;
  onCheckAgain: () => void;
  onClose: () => void;
}) {
  switch (flow.kind) {
    case 'idle':
      return null;
    case 'blocked':
      return (
        <Notice>
          <Body>{flow.message}</Body>
          <Button label="Close" secondary onPress={onClose} />
        </Notice>
      );
    case 'confirming':
      return (
        <ConfirmPanel
          api={api}
          confirmation={flow.confirmation}
          onConfirm={onConfirm}
          onCancel={onClose}
        />
      );
    case 'purchasing':
      return <Loading label="Waiting for the store" />;
    case 'verifying':
    case 'pending':
      return (
        <Notice>
          <Body>{flow.message}</Body>
          <Button label="Check again" onPress={onCheckAgain} />
          <Button label="Close" secondary onPress={onClose} />
        </Notice>
      );
    case 'success':
    case 'scheduled':
      return (
        <Notice>
          <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.success }]}>
            {flow.message}
          </Text>
          <Button label="Done" secondary onPress={onClose} />
        </Notice>
      );
    case 'cancelled':
      return (
        <Notice>
          <Body>{flow.message}</Body>
          <Button label="Close" secondary onPress={onClose} />
        </Notice>
      );
    case 'failed':
      return (
        <>
          <ErrorBox message={flow.message} needsPin={flow.needsPin} />
          <Button label="Close" secondary onPress={onClose} />
        </>
      );
  }
}

function ConfirmPanel({
  api,
  confirmation,
  onConfirm,
  onCancel,
}: {
  api: ApiClient;
  confirmation: Confirmation;
  onConfirm: (keepChildIds: readonly string[] | undefined) => void;
  onCancel: () => void;
}) {
  const store = STORE_LABEL[confirmation.channel];
  const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
  const [keepError, setKeepError] = useState<string | null>(null);
  // One tap starts one flow: a double tap must not create two intents and two store sheets.
  const [submitted, setSubmitted] = useState(false);
  const continueLabel = `Continue to ${store}`;
  return (
    <View
      style={[styles.card, { borderWidth: 2, borderColor: colors.teal }]}
      accessibilityLabel="Confirm your plan change"
    >
      <Heading>{confirmation.heading}</Heading>
      <Body>{confirmation.titleLine}</Body>
      <Body>{confirmation.periodLine}</Body>
      <Body>{confirmation.childCountLine}</Body>
      <Text style={[styles.body, { fontWeight: '800' }]}>{confirmation.recurringLine}</Text>
      {confirmation.priceNotice ? <Body>{confirmation.priceNotice}</Body> : null}
      <Body>{confirmation.renewalLine}</Body>
      <Body>{confirmation.chargeLine}</Body>
      <Body>{confirmation.dueNowLine}</Body>
      <Body>{confirmation.activationLine}</Body>
      <Body>{confirmation.storeConfirmationLine}</Body>
      <Body>{confirmation.legalLine}</Body>
      <LegalLinks />
      {confirmation.needsKeepSelection ? (
        <KeepSelector
          api={api}
          count={confirmation.keepCount}
          selected={keep}
          onChange={(next) => {
            setKeep(next);
            setKeepError(null);
          }}
        />
      ) : null}
      {keepError ? <ErrorBox message={keepError} /> : null}
      <Button
        label={continueLabel}
        disabled={submitted}
        onPress={() => {
          if (submitted) return;
          if (confirmation.needsKeepSelection && keep.size !== confirmation.keepCount) {
            setKeepError(keepSelectionMessage(confirmation.keepCount));
            return;
          }
          setSubmitted(true);
          // Without a selection the server keeps every active child (they all fit the new plan).
          onConfirm(confirmation.needsKeepSelection ? [...keep] : undefined);
        }}
      />
      <Button label="Cancel" secondary onPress={onCancel} />
    </View>
  );
}

function KeepSelector({
  api,
  count,
  selected,
  onChange,
}: {
  api: ApiClient;
  /** Exactly this many children are chosen: the server never picks for the parent (RV-billing-3). */
  count: number;
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const load = useCallback(() => loadActiveChildren(api), [api]);
  const { state, reload } = useLoad(load);
  if (state.status === 'error') {
    return <ErrorBox message={billingProblem(state.error).message} onRetry={() => void reload()} />;
  }
  if (state.status !== 'ready') return <Loading label="Loading your children" />;
  const children: ActiveChild[] = state.data;
  return (
    <View accessibilityLabel={keepSelectionMessage(count)}>
      <Text style={styles.label}>
        {keepSelectionMessage(count)} The others keep their history, exports and rewards, but their
        paid learning features stop when the change takes effect. To stop a child’s paid features
        sooner, archive them in Children.
      </Text>
      <Body muted>
        {selected.size} of {count} chosen
      </Body>
      {children.map((child) => {
        const on = selected.has(child.id);
        return (
          <View key={child.id} style={[styles.row, { alignItems: 'center' }]}>
            <Switch
              value={on}
              disabled={!on && selected.size >= count}
              accessibilityLabel={`Keep ${child.nickname} active`}
              onValueChange={(value) => {
                const next = new Set(selected);
                if (value) next.add(child.id);
                else next.delete(child.id);
                onChange(next);
              }}
            />
            <Body>{child.nickname}</Body>
          </View>
        );
      })}
    </View>
  );
}

function StoreTools({
  api,
  store,
  status,
  plan,
  onChanged,
}: {
  api: ApiClient;
  store: BillingStore;
  status: BillingStatus;
  plan: PlanView;
  onChanged: () => Promise<void>;
}) {
  const [restore, setRestore] = useState<RestoreState>({ kind: 'idle' });
  const [manageProblem, setManageProblem] = useState<string | null>(null);
  if (!plan.canRestore && !plan.canManage) return null;
  const deps: PlanChangeDeps = { api, store, context: purchaseContext };
  const storeName = store.channel ? STORE_LABEL[store.channel] : 'your store';
  return (
    <Card>
      <Heading>Your store account</Heading>
      {plan.canRestore ? (
        <>
          <Body>
            Bought a plan on another device with the same store account? Restore it here. PencilLift
            checks with the store before showing any change.
          </Body>
          <Button
            label={restore.kind === 'restoring' ? 'Restoring…' : 'Restore purchases'}
            busy={restore.kind === 'restoring'}
            onPress={() => {
              setRestore({ kind: 'restoring' });
              void runRestore(deps, status.billingRef).then(async (result) => {
                setRestore(result);
                await onChanged();
              });
            }}
          />
          {restore.kind === 'restored' || restore.kind === 'blocked' ? (
            <Body>{restore.message}</Body>
          ) : null}
          {restore.kind === 'failed' ? <ErrorBox message={restore.message} /> : null}
        </>
      ) : null}
      {plan.canManage ? (
        <>
          <Body>
            Cancel, or see renewal dates and receipts, in {storeName}. Deleting a child profile
            doesn’t cancel or lower your subscription.
          </Body>
          <Button
            label={`Manage subscription in ${storeName}`}
            secondary
            onPress={() => {
              setManageProblem(null);
              store
                .openManageSubscriptions()
                .catch(() =>
                  setManageProblem(`${storeName} couldn’t be opened. Please try again.`),
                );
            }}
          />
          {manageProblem ? <ErrorBox message={manageProblem} /> : null}
        </>
      ) : null}
    </Card>
  );
}
