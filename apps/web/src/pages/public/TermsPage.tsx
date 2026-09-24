import { Link } from 'react-router';
import { DraftBanner } from '../../components/DraftBanner.tsx';
import { lead, muted, PageTitle, Section, SupportEmail } from './common.tsx';

/**
 * Draft terms of use (spec P3, P6, P9, P11, P16). Plain-language summary of how the service is
 * designed to work.
 *
 * Decision: liability, dispute resolution and governing-law clauses are deliberately left out and
 * marked as pending. Legal counsel must write them; inventing them here could mislead families.
 */
export default function TermsPage() {
  return (
    <>
      <DraftBanner />
      <PageTitle title="Terms of use" />
      <h1>Terms of use</h1>
      <p style={lead}>
        These draft terms explain how PencilLift works for your family and what we expect from
        everyone who uses it.
      </p>
      <p style={muted}>Status: draft, not yet in effect. Effective date to be confirmed.</p>

      <Section title="Who can use PencilLift">
        <p>
          A parent or legal guardian who is an adult in the United States creates and owns the
          account. Children use PencilLift on a device their parent has paired, with their parent’s
          permission. Up to two adult guardians can share one family after an invitation is
          accepted.
        </p>
      </Section>

      <Section title="Your account and PIN">
        <p>
          Keep your password and six-digit parent PIN private. The PIN protects the parent area on a
          shared device; it does not replace your account password or parental consent. Tell us
          promptly if you think someone else has access to your account.
        </p>
      </Section>

      <Section title="Subscriptions and billing">
        <ul>
          <li>
            Current regular prices are on the <Link to="/pricing">pricing page</Link>. Plans are not
            yet available for purchase.
          </li>
          <li>
            Subscriptions are sold and billed by the App Store or Google Play. They show the exact
            amount, tax and renewal date at checkout, and their refund policies apply.
          </li>
          <li>
            Subscriptions renew monthly until you cancel them in the App Store or Google Play.
            Deleting your PencilLift account does not cancel a store subscription.
          </li>
          <li>Only a parent can make purchases. Children can’t buy anything in PencilLift.</li>
        </ul>
      </Section>

      <Section title="Learning support, not a replacement for teachers">
        <p>
          PencilLift helps your child practice and understand their own homework. It uses AI and
          automated checks, which can make mistakes; uncertain results are marked for a parent to
          review. We can’t promise particular grades or test results.
        </p>
        <p>
          PencilLift is for homework and practice, not for use during a live or closed-book test.
        </p>
      </Section>

      <Section title="Points and rewards">
        <p>
          Points are a family motivation tool. Points are not money, have no cash value and can’t be
          bought or sold. Parents choose rewards and deliver them outside PencilLift; PencilLift
          does not pay children or buy rewards.
        </p>
      </Section>

      <Section title="Commercial content">
        <p>
          Any sponsored cards or affiliate links appear only in the parent area and are clearly
          labeled. Purchases you make from other businesses are between you and that business and
          are separate from your PencilLift subscription.
        </p>
      </Section>

      <Section title="Acceptable use">
        <ul>
          <li>Use PencilLift only for your own family.</li>
          <li>Don’t upload content you don’t have the right to share.</li>
          <li>Don’t try to access another family’s information or get around safety features.</li>
        </ul>
      </Section>

      <Section title="Ending your account">
        <p>
          You can delete your account at any time; see{' '}
          <Link to="/account-deletion">how to delete your account</Link>. We may suspend accounts
          that put children or other families at risk.
        </p>
      </Section>

      <Section title="Terms still being written">
        <p>
          Sections covering liability, dispute resolution and governing law will be added after
          legal review. We will tell parents before any updated terms take effect.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about these terms? Email <SupportEmail />.
        </p>
      </Section>
    </>
  );
}
