import { Link, useLocation } from 'react-router';
import { ACCOUNT_CLOSE_COPY } from '@pencillift/contracts';
import { DraftBanner } from '../../components/DraftBanner.tsx';
import { DraftOnly, draftPrefix, lead, PageTitle, Section, SupportEmail } from './common.tsx';

/**
 * Public account-deletion page (spec P4, P15 deletion URL, AC_DEPLOY_04; Apple 5.1.1(v), Google
 * Play account deletion). Mirrors the implemented flow: in the PencilLift app (iPhone, iPad,
 * Android and Fire tablets) or the parent portal, with a recent PIN unlock, a parent deletes one
 * child's data, the family owner deletes the whole family account, and any parent deletes their
 * own sign-in (POST /v1/account/close: an owner's sign-in closes once the family purge has
 * finished, an invited guardian is removed and closed at once). Email remains the fallback for
 * someone who can no longer sign in.
 *
 * It also states the flow's limits (AC_UX_02, RV-public-site-3/4): whole-family deletion is
 * owner-only (privacy.ts ownerOnlyFamilyDeletion) and the retention list matches
 * app.purge_family_data (billing, consent records, audit log, family tombstone) plus the auth
 * user's pseudonymous id after a soft delete (migration 0830). Exports are built by the
 * export_build job and can be downloaded before deleting (RV-public-site-2 resolved).
 */

/** Set by the parent area after an in-app closure (router state, never a URL parameter). */
type ClosedState = 'closed' | 'pending';

function closedFromState(state: unknown): ClosedState | null {
  const value = (state as { accountClosed?: unknown } | null)?.accountClosed;
  return value === 'closed' || value === 'pending' ? value : null;
}

/**
 * WEB-R4-AUTH-2 / ACC-WEB-AUTH-A: whether the sign-out that went with the closure was refused by the
 * auth service. The closure flow (PrivacyControlsPage's AccountCloseSection) reads the adapter's
 * report and hands it over in the same router state as `accountClosed`; anything else means "not
 * reported", which is read as carried out — this page is public, so a stranger's plain GET must never
 * raise an alarm about a session nobody told us about.
 */
function signOutRefusedFromState(state: unknown): boolean {
  return (state as { signOutRefused?: unknown } | null)?.signOutRefused === true;
}

/**
 * Said only on the refusal path, beside the closure line. The adapter has already removed this
 * browser's stored session, so "this computer is signed out" is true; what failed is telling the auth
 * service, so a session elsewhere may still work — on the `pending` path the sign-in is not closed
 * yet either. Word for word SignOutControl's SERVER_NOT_TOLD (components/SignOutControl.tsx), because
 * the two paths report the same fact and a parent should not have to tell them apart.
 */
const SERVER_NOT_TOLD =
  'This computer is signed out. We could not tell PencilLift’s servers to end the session, so sign out on your phone, or change your password if you are worried.';

export default function AccountDeletionPage() {
  const state: unknown = useLocation().state;
  const closed = closedFromState(state);
  // Only a closure that happened in the parent area can report its sign-out, so the sentence is tied
  // to that notice rather than shown on its own.
  const signOutRefused = closed !== null && signOutRefusedFromState(state);
  return (
    <>
      <DraftBanner />
      <PageTitle title="Delete your account" />
      <h1>Delete your PencilLift account</h1>
      {closed ? (
        <div className="notice" role="status" style={{ marginBottom: 16 }}>
          <p style={{ margin: 0 }}>
            <strong>
              {closed === 'closed' ? ACCOUNT_CLOSE_COPY.closed : ACCOUNT_CLOSE_COPY.pending}
            </strong>
          </p>
          {signOutRefused ? <p style={{ margin: '8px 0 0' }}>{SERVER_NOT_TOLD}</p> : null}
        </div>
      ) : null}
      <p style={lead}>
        You can delete one child’s data, your whole family account (family owner only) and your own
        parent sign-in from inside the PencilLift app or the parent portal. Here’s how, and what
        happens next.
      </p>

      <Section title="Option 1: In the app or the parent portal">
        <ol>
          <li>
            Open the PencilLift app on your iPhone, iPad, Android phone or tablet or Fire tablet, or
            sign in to the parent portal at <Link to="/sign-in">this website</Link>.
          </li>
          <li>
            Sign in as a parent or guardian and unlock the parent area with your six-digit PIN.
          </li>
          <li>
            Open <strong>Privacy, export and deletion</strong> (in the portal:{' '}
            <Link to="/app/privacy">privacy controls in the parent area</Link>).
          </li>
          <li>
            Choose what to delete and confirm:
            <ul>
              <li>
                <strong>One child’s data.</strong> Any parent or guardian in the family can do this.
              </li>
              <li>
                <strong>The whole family account.</strong> Only the family owner, the parent who
                created the account, can do this. It removes every child’s data and every guardian’s
                access.
              </li>
              <li>
                <strong>Your own account (sign-in).</strong> “Delete my account” closes your email
                and password sign-in. The family owner deletes the family account first; their
                sign-in then closes automatically once that deletion has finished. An invited
                guardian is removed from the family and closed at once. Either way the device is
                signed out right away.
              </li>
            </ul>
          </li>
        </ol>
        <p>
          <strong>If you joined by invitation as a guardian:</strong> you can delete a child’s data
          and your own account, but only the family owner can delete the whole family account. The
          family owner can also remove you from the family.
        </p>
        <p>
          <strong>Copies of your information:</strong> request an export in privacy controls before
          you delete. Files are prepared within minutes and can be downloaded from the parent portal
          for a limited time. Deleting the data also removes its exports.
        </p>
      </Section>

      <Section title="Option 2: Email us">
        <p>
          If you can’t sign in, email <SupportEmail /> from the email address on your parent account
          and say whether you want to delete one child’s data, the whole family account or your own
          sign-in. We will confirm you are a parent or guardian in the family before deleting
          anything, and only the family owner can ask us to delete the whole family account. Please
          don’t include homework photos or your child’s full name.
        </p>
      </Section>

      <Section title="What happens after you ask">
        <h3>Right away</h3>
        <ul>
          <li>Processing stops immediately.</li>
          <li>Your child’s paired devices are signed out.</li>
          <li>Pending homework checks and other queued work are cancelled.</li>
          <li>The deleted family or child data can no longer be opened from any device.</li>
          <li>
            When you delete your own account, your sign-in stops working everywhere as soon as it is
            closed (at once for a guardian; after the family deletion for the family owner).
          </li>
        </ul>
        <h3>Within 30 days</h3>
        <ul>
          <li>
            Homework photos, results, practice and review history, points and rewards are deleted
            from our active systems.
          </li>
          <li>
            Backups expire on a documented schedule
            <DraftOnly> (length to be confirmed)</DraftOnly>.
          </li>
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
          <li>
            When your sign-in is closed, a pseudonymous account id that those records point to. Your
            email address, phone number and password are removed from it.
          </li>
        </ul>
        <p>
          Read the <Link to="/privacy">{draftPrefix()}privacy policy</Link> for more detail.
        </p>
      </Section>

      <Section title="Your App Store, Google Play or Amazon Appstore subscription">
        <div className="notice">
          <p style={{ margin: 0 }}>
            <strong>
              Deleting your PencilLift account does not cancel an App Store or Google Play
              subscription, or an Amazon Appstore subscription on a Fire tablet.
            </strong>{' '}
            To stop being charged, cancel it in the App Store or Google Play (or in the Amazon
            Appstore on a Fire tablet), in your Apple, Google Play or Amazon subscription settings.
            We recommend cancelling before you delete your account.
          </p>
        </div>
      </Section>
    </>
  );
}
