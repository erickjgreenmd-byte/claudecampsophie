import { Link } from 'react-router';
import { DraftBanner } from '../../components/DraftBanner.tsx';
import { lead, PageTitle, Section, SupportEmail } from './common.tsx';

/**
 * Public account-deletion page (spec P4, P15 deletion URL, AC_DEPLOY_04). Mirrors the implemented
 * flow: public.request_deletion requires a recent PIN unlock, tombstones the family, signs child
 * devices out and cancels queued jobs at once; purge of active data completes within 30 days.
 */
export default function AccountDeletionPage() {
  return (
    <>
      <DraftBanner />
      <PageTitle title="Delete your account" />
      <h1>Delete your PencilLift account</h1>
      <p style={lead}>
        You can delete one child’s data or your whole family account at any time. Here’s how, and
        what happens next.
      </p>

      <Section title="Option 1: In the parent area">
        <ol>
          <li>Sign in to PencilLift as the parent on the account.</li>
          <li>Unlock the parent area with your six-digit PIN.</li>
          <li>
            Open <Link to="/app/privacy">privacy controls in the parent area</Link>.
          </li>
          <li>
            Choose whether to delete one child’s data or the whole family account, and confirm.
          </li>
        </ol>
        <p>
          If you’d like a copy of your family’s information, ask for an export before you delete.
        </p>
      </Section>

      <Section title="Option 2: Email us">
        <p>
          Email <SupportEmail /> from the email address on your parent account and say whether you
          want to delete one child’s data or the whole account. We will confirm you are the parent
          on the account before deleting anything. Please don’t include homework photos or your
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
          <li>We may keep limited billing records where the law requires it.</li>
        </ul>
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
