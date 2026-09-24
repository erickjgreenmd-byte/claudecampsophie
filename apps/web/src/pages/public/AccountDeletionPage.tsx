import { Link } from 'react-router';
import { DraftBanner } from '../../components/DraftBanner.tsx';
import { lead, PageTitle, Section, SupportEmail } from './common.tsx';

/**
 * Public account-deletion page (spec P4, P15 deletion URL, AC_DEPLOY_04). Mirrors the implemented
 * flow: public.request_deletion requires a recent PIN unlock, tombstones the family, signs child
 * devices out and cancels queued jobs at once; purge of active data completes within 30 days.
 *
 * It also states the flow's limits (AC_UX_02, RV-public-site-2..4): whole-family deletion is
 * owner-only (privacy.ts ownerOnlyFamilyDeletion); export files are not built by any deployed job,
 * so no "export first" advice; and the retention list matches app.purge_family_data (billing,
 * consent records, audit log, family tombstone; the adult's sign-in is not removed).
 */
export default function AccountDeletionPage() {
  return (
    <>
      <DraftBanner />
      <PageTitle title="Delete your account" />
      <h1>Delete your PencilLift account</h1>
      <p style={lead}>
        Any parent or guardian in your family can delete one child’s data at any time. Only the
        family owner, the parent who created the account, can delete the whole family account.
        Here’s how, and what happens next.
      </p>

      <Section title="Option 1: In the parent area">
        <ol>
          <li>Sign in to PencilLift as a parent or guardian in your family.</li>
          <li>Unlock the parent area with your six-digit PIN.</li>
          <li>
            Open <Link to="/app/privacy">privacy controls in the parent area</Link>.
          </li>
          <li>
            Choose to delete one child’s data or, if you are the family owner, the whole family
            account, and confirm.
          </li>
        </ol>
        <p>
          <strong>If you joined by invitation as a guardian:</strong> you can delete a child’s data,
          but only the family owner can delete the whole family account. Ask the family owner to do
          it. The family owner can also remove you from the family.
        </p>
        <p>
          <strong>Copies of your information:</strong> export files aren’t available yet. You can
          request an export in privacy controls, but there is nothing to download until the export
          service is switched on, and deleting the data also removes its export requests.
        </p>
      </Section>

      <Section title="Option 2: Email us">
        <p>
          Email <SupportEmail /> from the email address on your parent account and say whether you
          want to delete one child’s data or the whole family account. We will confirm you are a
          parent or guardian in the family before deleting anything, and only the family owner can
          ask us to delete the whole family account. Please don’t include homework photos or your
          child’s full name.
        </p>
      </Section>

      <Section title="What happens after you ask">
        <h3>Right away</h3>
        <ul>
          <li>Processing stops immediately.</li>
          <li>Your child’s paired devices are signed out.</li>
          <li>Pending homework checks and other queued work are cancelled.</li>
          <li>The deleted family or child data can no longer be opened from any device.</li>
        </ul>
        <h3>Within 30 days</h3>
        <ul>
          <li>
            Homework photos, results, practice and review history, points and rewards are deleted
            from our active systems.
          </li>
          <li>Backups expire on a documented schedule (length to be confirmed).</li>
        </ul>
        <h3>What we keep</h3>
        <ul>
          <li>
            Limited billing records (subscription, promotion and school-donation records) where the
            law requires it.
          </li>
          <li>
            Consent records: when consent was given or withdrawn, its version and the consent
            provider’s reference.
          </li>
          <li>A security log that uses pseudonymous ids only, never homework or answers.</li>
          <li>
            When the whole family account is deleted, a minimal record that the family was deleted,
            so late store notices can’t bring any data back.
          </li>
        </ul>
        <p>
          Deleting the whole family account does not close your parent sign-in (your email address
          and password), but that sign-in no longer opens any of the family’s information. To have
          the sign-in closed as well, email us.
        </p>
        <p>
          Read the <Link to="/privacy">draft privacy policy</Link> for more detail.
        </p>
      </Section>

      <Section title="Your App Store or Google Play subscription">
        <div className="notice">
          <p style={{ margin: 0 }}>
            <strong>
              Deleting your PencilLift account does not cancel an App Store or Google Play
              subscription.
            </strong>{' '}
            To stop being charged, cancel it in the App Store or Google Play, in your Apple account
            or Google Play subscription settings. We recommend cancelling before you delete your
            account.
          </p>
        </div>
      </Section>
    </>
  );
}
