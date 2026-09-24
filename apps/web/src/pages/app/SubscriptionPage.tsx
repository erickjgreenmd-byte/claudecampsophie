import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  billingStatusResponseSchema,
  type BillingChannel,
  type BillingEntitlementStatus,
  type BillingStatus,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { formatUsd } from '@pencillift/domain/shared/money';
import { EmptyState, ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';

/**
 * Parent subscription overview (spec P11, P14 "subscription"; AC_CAPACITY_02/06/11, AC_BILLING_06).
 * Shows the verified paid slot count, assigned profiles, managing store, store subscriptions and
 * the approved price table. Purchases and plan changes happen in the App Store or Google Play from
 * the PencilLift app; optional web billing is disabled until the owner decides, so this page never
 * offers a purchase. Amounts are integer cents from the API and @pencillift/domain.
 */
export default function SubscriptionPage() {
  return (
    <RequireParent>
      <Subscription />
    </RequireParent>
  );
}

const STORE_NAME: Record<BillingChannel, string> = {
  app_store: 'App Store',
  play_store: 'Google Play',
  stripe: 'Web billing',
};

const STATUS_LABEL: Record<BillingEntitlementStatus, string> = {
  pending: 'Waiting for the store (for example Ask to Buy) — no access yet',
  active: 'Active',
  grace_period: 'Payment problem — access continues during the store’s grace period',
  billing_retry: 'Payment problem — the store is retrying; paid access is paused',
  cancelled_active: 'Cancelled — access continues until the period ends',
  expired: 'Ended',
  revoked: 'Revoked by the store',
  refunded: 'Refunded',
};

const sectionStyle = { marginTop: 16 } as const;
const cell = { textAlign: 'left', padding: '6px 12px 6px 0', verticalAlign: 'top' } as const;

function childrenLabel(count: number): string {
  return count === 1 ? '1 child' : `${count} children`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function toApiError(error: unknown): ApiRequestError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError('INTERNAL', 'Something went wrong. Please try again.', 0);
}

function Subscription() {
  const query = useApiQuery(
    (api) => api.get('/v1/billing/status', billingStatusResponseSchema),
    [],
  );
  const [synced, setSynced] = useState<BillingStatus | null>(null);
  const data = synced ?? (query.status === 'ready' ? query.data : null);
  return (
    <>
      <h1>Subscription</h1>
      {data === null && query.status === 'loading' ? (
        <Loading label="Loading your subscription…" />
      ) : null}
      {data === null && query.status === 'error' ? (
        query.error.code === 'NOT_FOUND' ? (
          <EmptyState title="Create your family first">
            <p>
              Set up your family on the <Link to="/app">family dashboard</Link>. Your subscription
              appears here once you choose a plan in the PencilLift app.
            </p>
          </EmptyState>
        ) : (
          <ErrorState message={query.error.message} onRetry={query.reload} />
        )
      ) : null}
      {data ? (
        <>
          <PlanSummary data={data} />
          <StoreSubscriptions data={data} />
          <CheckWithStore onSynced={setSynced} />
          <PriceTable data={data} />
          <ChangingYourPlan />
        </>
      ) : null}
    </>
  );
}

function PlanSummary({ data }: { data: BillingStatus }) {
  const headingId = useId();
  const unused = Math.max(0, data.paidSlots - data.assignedSlots);
  const current = data.tiers.find((t) => t.paidSlots === data.paidSlots);
  const requested = data.requestedChange;
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Your plan</h2>
      {data.conflict === 'duplicate_active_subscriptions' ? (
        <div className="error" role="alert">
          <p style={{ margin: 0 }}>
            <strong>You have more than one active subscription</strong> (for example in both the App
            Store and Google Play). They don’t add up — your family gets the larger plan only.
            Cancel the one you don’t need in its store so you aren’t charged twice.
          </p>
        </div>
      ) : null}
      {data.paidSlots === 0 ? (
        <p>
          <strong>No active subscription.</strong> Choose a plan in the PencilLift app to give your
          children paid learning features.
        </p>
      ) : (
        <p>
          <strong>Your plan covers {childrenLabel(data.paidSlots)}</strong>
          {current ? ` (approved price ${formatUsd(current.approvedMonthlyCents)} per month)` : ''}.
        </p>
      )}
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }}>
        <dt>Paid child slots</dt>
        <dd style={{ margin: 0 }}>{data.paidSlots}</dd>
        <dt>Children using a slot</dt>
        <dd style={{ margin: 0 }}>{data.assignedSlots}</dd>
        <dt>Billed by</dt>
        <dd style={{ margin: 0 }}>
          {data.managingChannel ? STORE_NAME[data.managingChannel] : 'No store yet'}
        </dd>
      </dl>
      {unused > 0 ? (
        <p>
          You have {unused} unused paid {unused === 1 ? 'slot' : 'slots'}. Assign{' '}
          {unused === 1 ? 'it' : 'them'} to a child on the <Link to="/app/children">Children</Link>{' '}
          page — no new purchase is needed.
        </p>
      ) : null}
      {data.pendingChange ? (
        <div className="notice">
          The store will change your plan to {childrenLabel(data.pendingChange.targetSlots)} on{' '}
          {formatDate(data.pendingChange.effectiveAt)}. Until then, your current plan continues.
        </div>
      ) : null}
      {requested ? (
        <p>
          {requested.kind === 'upgrade'
            ? `You started changing to ${childrenLabel(requested.toSlots)}. No store purchase has been confirmed yet, so nothing has changed.`
            : `You chose ${childrenLabel(requested.toSlots)} with ${childrenLabel(requested.keepCount)} staying active. It takes effect only when the store confirms the change.`}
        </p>
      ) : null}
    </section>
  );
}

function StoreSubscriptions({ data }: { data: BillingStatus }) {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Store subscriptions</h2>
      {data.entitlements.length === 0 ? (
        <p>No store subscriptions yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th scope="col" style={cell}>
                  Store
                </th>
                <th scope="col" style={cell}>
                  Plan
                </th>
                <th scope="col" style={cell}>
                  Status
                </th>
                <th scope="col" style={cell}>
                  Period ends
                </th>
                <th scope="col" style={cell}>
                  Auto-renew
                </th>
              </tr>
            </thead>
            <tbody>
              {data.entitlements.map((e, i) => (
                <tr key={`${e.channel}:${e.productId}:${i}`}>
                  <th scope="row" style={cell}>
                    {STORE_NAME[e.channel]}
                  </th>
                  <td style={cell}>
                    {e.paidSlots > 0 ? childrenLabel(e.paidSlots) : 'Plan not recognized'}
                  </td>
                  <td style={cell}>{STATUS_LABEL[e.status]}</td>
                  <td style={cell}>{e.periodEnd ? formatDate(e.periodEnd) : 'Not reported yet'}</td>
                  <td style={cell}>{e.autoRenew ? 'On' : 'Off'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize: '0.95rem' }}>
        This is what the stores report to PencilLift. Your store receipt shows the exact amount you
        were charged.
      </p>
    </section>
  );
}

function CheckWithStore({ onSynced }: { onSynced: (status: BillingStatus) => void }) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { kind: 'ok' } | { kind: 'error'; error: ApiRequestError } | null
  >(null);
  const check = async () => {
    setBusy(true);
    setResult(null);
    try {
      onSynced(await api.send('POST', '/v1/billing/sync', undefined, billingStatusResponseSchema));
      setResult({ kind: 'ok' });
    } catch (error) {
      setResult({ kind: 'error', error: toApiError(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={sectionStyle}>
      <p style={{ margin: '0 0 8px' }}>
        Just bought or changed a plan in the app? PencilLift updates when the store confirms it.
      </p>
      <button type="button" className="btn secondary" disabled={busy} onClick={() => void check()}>
        {busy ? 'Checking…' : 'Check with the store'}
      </button>
      {result?.kind === 'ok' ? (
        <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
          Checked with the store just now.
        </p>
      ) : null}
      {result?.kind === 'error' ? <ErrorState message={result.error.message} /> : null}
    </div>
  );
}

function storePriceCell(data: BillingStatus, channel: 'app_store' | 'play_store', slots: number) {
  const tier = data.tiers.find((t) => t.paidSlots === slots);
  const product = data.products.find(
    (p) => p.channel === channel && p.paidSlots === slots && p.storePriceCents !== null,
  );
  if (!product || product.storePriceCents === null || !tier) return 'Not verified yet';
  const price = formatUsd(product.storePriceCents);
  return product.storePriceCents === tier.approvedMonthlyCents
    ? price
    : `${price} (differs from the approved ${formatUsd(tier.approvedMonthlyCents)})`;
}

function PriceTable({ data }: { data: BillingStatus }) {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Prices</h2>
      <p>
        One family subscription covers up to {data.tiers.length} children. There is no separate
        family account fee.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse' }}>
          <caption style={{ textAlign: 'left', fontWeight: 800, padding: '0 0 8px' }}>
            Monthly price by number of children (US dollars)
          </caption>
          <thead>
            <tr>
              <th scope="col" style={cell}>
                Children
              </th>
              <th scope="col" style={cell}>
                Approved price
              </th>
              <th scope="col" style={cell}>
                App Store price
              </th>
              <th scope="col" style={cell}>
                Google Play price
              </th>
            </tr>
          </thead>
          <tbody>
            {data.tiers.map((tier) => (
              <tr key={tier.paidSlots}>
                <th scope="row" style={cell}>
                  {childrenLabel(tier.paidSlots)}
                </th>
                <td style={{ ...cell, fontWeight: 800 }}>{formatUsd(tier.approvedMonthlyCents)}</td>
                <td style={cell}>{storePriceCell(data, 'app_store', tier.paidSlots)}</td>
                <td style={cell}>{storePriceCell(data, 'play_store', tier.paidSlots)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: '0.95rem' }}>
        The store’s price is what you pay. Where a store can’t charge an approved amount exactly,
        the difference is shown here and in the app before you buy — it is never rounded silently.
      </p>
    </section>
  );
}

function ChangingYourPlan() {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Changing your plan</h2>
      <ul>
        <li>
          Buy, add a child slot or move to a smaller plan in the PencilLift app on your phone or
          tablet. The App Store or Google Play shows what you’ll pay today, including any proration,
          before you confirm.
        </li>
        <li>
          Plans can’t be bought on the web: PencilLift subscriptions are sold through the App Store
          and Google Play.
        </li>
        <li>
          A new child slot is added only after the store confirms payment. Purchases waiting for
          approval (Ask to Buy), cancelled or failed purchases don’t add a slot.
        </li>
        <li>
          To cancel, use the store that bills you. Deleting a child profile or your PencilLift
          account doesn’t cancel a store subscription or lower its price.
        </li>
      </ul>
      <p>
        Have a monthly promo code? Enter it on <Link to="/app/school">School and promotions</Link>.
      </p>
    </section>
  );
}
