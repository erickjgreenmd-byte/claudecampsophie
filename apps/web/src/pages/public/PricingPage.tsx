import {
  ADDITIONAL_CHILD_PRICE_CENTS,
  BASE_PRICE_CENTS,
  priceTable,
} from '@pencillift/domain/pricing';
import { formatUsd } from '@pencillift/domain/shared/money';
import { Link } from 'react-router';
import { isStoreLive } from '../../lib/config.ts';
import { lead, muted, PageTitle, Section } from './common.tsx';

/**
 * Public list prices (spec P11, AC_CAPACITY_11). Every amount comes from @pencillift/domain
 * (`priceTable`, `formatUsd`) so the site cannot drift from the owner-approved pricing formula.
 */
const tiers = priceTable();
const firstChildPrice = formatUsd(BASE_PRICE_CENTS);
const additionalChildPrice = formatUsd(ADDITIONAL_CHILD_PRICE_CENTS);

function childrenLabel(count: number): string {
  return count === 1 ? '1 child' : `${count} children`;
}

export default function PricingPage() {
  return (
    <>
      <PageTitle title="Pricing" />
      <h1>Pricing</h1>
      <p style={lead}>
        One family subscription covers up to {tiers.length} children. {firstChildPrice} per month
        includes your first child, and each additional child is {additionalChildPrice} per month.
        There is no separate family account fee.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table className="card" style={{ borderCollapse: 'collapse', minWidth: 280 }}>
          <caption style={{ textAlign: 'left', fontWeight: 800, padding: '0 0 8px' }}>
            Monthly price by number of children (US dollars)
          </caption>
          <thead>
            <tr>
              <th scope="col" style={cell}>
                Children
              </th>
              <th scope="col" style={cell}>
                Monthly price
              </th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier) => (
              <tr key={tier.paidSlots}>
                <th scope="row" style={cell}>
                  {childrenLabel(tier.paidSlots)}
                </th>
                <td style={{ ...cell, fontWeight: 800 }}>{formatUsd(tier.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Every child on the plan gets the same learning features: homework feedback, daily
        extra-credit practice, Thursday reviews, points and rewards. Creating a draft profile does
        not add a charge.
      </p>

      <Section title="Availability and checkout">
        {/* WEB-R1-11: pre-launch wording until the store review build sets VITE_STORE_LIVE=true. */}
        {isStoreLive() ? (
          <p>
            Plans are in-app subscriptions, bought by a parent in the PencilLift app through the App
            Store, Google Play or, on Fire tablets, the Amazon Appstore.
          </p>
        ) : (
          <div className="notice">
            <p style={{ margin: 0 }}>
              <strong>Plans are not yet available for purchase.</strong> They will be offered as
              in-app subscriptions through the App Store, Google Play and, on Fire tablets, the
              Amazon Appstore once store setup is complete.
            </p>
          </div>
        )}
        <ul>
          <li>Prices are listed in US dollars.</li>
          <li>
            The amount you pay at checkout, including any tax, proration and your renewal date, is
            shown by the App Store, Google Play or the Amazon Appstore and may differ by storefront.
          </li>
          <li>
            Only a parent can buy or change a plan, from the PIN-protected parent area. Children
            can’t make purchases.
          </li>
          <li>
            You manage or cancel your subscription in the App Store, Google Play or, on a Fire
            tablet, the Amazon Appstore. Deleting your PencilLift account doesn’t cancel a store
            subscription; see <Link to="/account-deletion">how to delete your account</Link>.
          </li>
        </ul>
      </Section>

      <Section title="Supporting your school">
        {/* Spec P17: PencilLift-funded, full-price months only, and never a tax-deductible customer donation. */}
        <p>
          You can choose one school for your family. For each month your subscription is paid at the
          full regular price with no discount, PencilLift contributes $1 to that school.
        </p>
        <ul>
          <li>
            The contribution is funded by PencilLift. It is not an extra charge to you and not a
            customer donation, so it is not tax-deductible for your family.
          </li>
          <li>
            Months with any discount or promotion, including a free month, don’t include a school
            contribution.
          </li>
          <li>
            There is one school and at most one $1 contribution per family each month, however many
            children are on the plan.
          </li>
        </ul>
      </Section>

      <Section title="Questions about plans">
        <p>
          Read <Link to="/how-it-works">how PencilLift works</Link> or visit the{' '}
          <Link to="/support">support page</Link>.
        </p>
        <p style={muted}>
          Prices shown are the regular recurring monthly prices for the United States.
        </p>
      </Section>
    </>
  );
}

const cell = {
  textAlign: 'left',
  padding: '10px 16px',
  borderBottom: '1px solid var(--off-white)',
} as const;
