import { Link } from 'react-router';
import { DraftBanner } from '../../components/DraftBanner.tsx';
import {
  DraftOnly,
  lead,
  LegalStatus,
  PageTitle,
  PAYMENT_STORES,
  ReviewedOnly,
  Section,
  SupportEmail,
} from './common.tsx';

/**
 * Privacy policy (spec P3, P4, P16.1, P15 privacy URL). It must describe the implemented design
 * exactly: consent before child data, private storage, 30-day raw-scan retention, tombstone-first
 * deletion within 30 days, AI only under zero data retention, and no ads or affiliate links in
 * children's areas.
 *
 * Draft vs reviewed (WEB-06 / APL-20): while `VITE_LEGAL_REVIEWED` is not "true" the page carries
 * the DraftBanner, "to be confirmed" notes and the placeholder mailbox. A reviewed build shows the
 * effective date (`VITE_LEGAL_EFFECTIVE_DATE`) and the confirmed mailbox (`VITE_SUPPORT_EMAIL`)
 * and none of the draft wording; legal.test.tsx enforces both states.
 *
 * Limits are stated, not glossed over (RV-public-site-1, -3, -4): photo metadata is removed on the
 * device where possible and always by the scan job before any processing (image-metadata.ts); the
 * retention exceptions match app.purge_family_data (billing, consent records, audit log, family
 * tombstone) plus the pseudonymous auth id after account closure (migration 0830). Photo deletion
 * before the 30-day sweep happens only through scan cancellation before processing
 * (routes/homework.ts cancel, CANCELLABLE_ASSIGNMENT_STATUSES) and child/family deletion: there is
 * no photo-only deletion control, so the copy promises none (CS-R1-03, BUG-031 precedent).
 *
 * Notices are by email only (APL-28 / PLAY-25): the apps register no push notification channel.
 * IP addresses: the API reads the client address only when a pairing code is redeemed
 * (routes/child-auth.ts, `cf-connecting-ip`) and keeps it only as a short-lived abuse counter in
 * private.rate_limit_buckets (cleared about a day after its 15-minute window); operational log
 * events carry no address (middleware/context.ts LogEvent).
 */
export default function PrivacyPage() {
  return (
    <>
      <DraftBanner />
      <PageTitle title="Privacy policy" />
      <h1>Privacy policy</h1>
      <p style={lead}>
        PencilLift is built for families with children in grades K–8. This{' '}
        <DraftOnly>draft</DraftOnly>
        <ReviewedOnly>policy</ReviewedOnly> explains what information PencilLift collects, how it is
        used, and the choices parents have.
      </p>
      <LegalStatus />

      <Section title="The short version">
        <ul>
          <li>A parent owns the account and gives verifiable parental consent first.</li>
          <li>
            Children don’t need an email address, phone number, social login or public profile.
          </li>
          <li>Homework photos are kept in private storage and deleted after 30 days by default.</li>
          <li>We do not sell personal information and there is no behavioral advertising.</li>
          <li>There are no ads or affiliate links in children’s areas.</li>
          <li>
            Any parent or guardian in the family can delete a child’s data at any time, and the
            family owner can delete the whole family account.
          </li>
        </ul>
      </Section>

      <Section title="Parents are in control">
        <p>
          A parent or legal guardian creates the account with a verified email address. We ask for
          verifiable parental consent before PencilLift collects or processes any information about
          a child, using a consent provider. A parent PIN protects the parent area on a shared
          device, but it is not consent and is not proof of age.
        </p>
        <p>
          You can withdraw consent at any time. When you do, we stop collecting and processing your
          child’s information.
        </p>
      </Section>

      <Section title="Information we collect">
        <h3>About parents</h3>
        <ul>
          <li>Email address and sign-in details.</li>
          <li>
            Consent records: status, date, version and the consent provider’s reference. We don’t
            keep identity documents unless that is required and reviewed.
          </li>
          <li>
            Subscription status reported by {PAYMENT_STORES}. We don’t receive your card number.
          </li>
        </ul>
        <h3>About children</h3>
        <ul>
          <li>
            A nickname, grade, age band (not an exact birth date), chosen subjects and any optional
            notes or accessibility preferences you add. Please use a nickname rather than a full
            name.
          </li>
          <li>Homework photos and the answers your child submits.</li>
          <li>Practice and review activity, points and reward requests.</li>
        </ul>
        <p>
          Children don’t need an email address, phone number, social login or public profile.
          PencilLift doesn’t ask for location permission and doesn’t use your child’s location.
        </p>
      </Section>

      <Section title="How we use information">
        <p>
          We use information to check homework, give your child guidance, build daily practice and
          Thursday reviews, show you progress, run your subscription, and keep the service safe and
          working. We don’t use your child’s learning information to choose ads.
        </p>
      </Section>

      <Section title="Homework photos and learning history">
        <ul>
          <li>Homework photos are stored in private storage, never on public web pages.</li>
          <li>
            The app removes location and camera details from photos on the device before upload
            where it can. If that step fails, the photo is stored as taken, and our servers remove
            those details before the photo is processed or sent to AI.
          </li>
          <li>
            Raw homework photos are deleted after 30 days by default. They are deleted sooner when
            you cancel a scan before it is processed, or when you delete the child’s data or your
            account.
          </li>
          <li>
            Learning history is kept while your account is active. Our planned rule is deletion
            after 12 months of inactivity, with a notice to you first
            <DraftOnly> (to be confirmed)</DraftOnly>. You can delete it sooner at any time.
          </li>
        </ul>
      </Section>

      <Section title="AI processing">
        <p>
          PencilLift uses an AI provider to read homework and write explanations. We process
          children’s information with AI only after the provider has approved zero data retention
          for our account. Until that approval is in place, features that send children’s homework
          to AI stay switched off.
        </p>
        <p>
          We send only the part of the page needed, with a pseudonymous ID and age band rather than
          your child’s name. We don’t use children’s homework to train or fine-tune AI models.
        </p>
      </Section>

      <Section title="Advertising and commercial content">
        <ul>
          <li>No behavioral advertising, and we do not sell personal information.</li>
          <li>
            No ads or affiliate links in children’s areas, or anywhere we can’t tell whether a
            parent is using the app.
          </li>
          <li>
            Optional sponsor cards are shown only to parents, inside the PIN-protected parent area.
            They are clearly labeled, reviewed by us and never chosen using your child’s grades,
            mistakes or learning history.
          </li>
          <li>
            Amazon links only where PencilLift is eligible, with a clear disclosure. You can hide
            commercial recommendations.
          </li>
        </ul>
      </Section>

      <Section title="Who we share information with">
        <p>
          We share information only with service providers that help run PencilLift: our hosting and
          database services (Cloudflare and Supabase), our subscription service (RevenueCat), our
          email service (Resend), the consent provider that verifies parental consent, the AI
          provider (OpenAI, under zero data retention), and {PAYMENT_STORES} for payments. Each
          provider may use the information only to provide its service to us. We may also disclose
          information when the law requires it.
        </p>
      </Section>

      <Section title="Notices and email">
        <p>
          We contact parents by email: for example about consent, your subscription, a safety
          notice, an inactivity notice or changes to this policy. PencilLift does not send push
          notifications. Emails use general wording and never include answers, homework photos or
          sensitive details about how your child is doing.
        </p>
      </Section>

      <Section title="IP addresses and technical information">
        <p>
          When a device connects to PencilLift, our hosting provider (Cloudflare) sees the device’s
          IP address in order to deliver the connection, as the host of every website does. Our own
          servers do not store IP addresses with your account or your child’s information, and IP
          addresses are never written to our own logs. The one exception is abuse protection: when a
          device redeems a pairing code, the network address (for IPv6, its prefix) is kept as a
          counter for a short time and deleted within about a day. It is never linked to a family or
          a child. Our sign-in service (Supabase) records parent sign-in events, including the
          address used, in its own security log; children never sign in through it.
        </p>
      </Section>

      <Section title="Your choices">
        <ul>
          <li>Review and correct your child’s profile.</li>
          <li>
            Ask for a copy (export) of your family’s information. Files are prepared within minutes
            and can be downloaded from the parent portal for a limited time.
          </li>
          <li>Delete a child’s data, or your whole account.</li>
          <li>Withdraw consent for your child’s information to be processed.</li>
        </ul>
      </Section>

      <Section title="Deleting information">
        <p>
          When you ask us to delete your account or a child’s data, processing stops immediately:
          your child’s devices are signed out and pending work is cancelled. Deletion from our
          active systems completes within 30 days. Backups expire on a documented schedule
          <DraftOnly> (length to be confirmed)</DraftOnly>. Only the family owner can delete the
          whole family account.
        </p>
        <p>After deletion we keep only:</p>
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
            When a parent sign-in is closed, a pseudonymous account id that those records point to.
            The email address, phone number and password are removed from it.
          </li>
        </ul>
        <p>
          When the family owner deletes the whole family account, the owner’s parent sign-in closes
          automatically once that deletion has finished. Any parent can also close their own sign-in
          from the app or the parent portal (“Delete my account”). If you can no longer sign in,
          email us.
        </p>
        <p>
          <Link to="/account-deletion">How to delete your account</Link>
        </p>
      </Section>

      <Section title="Security">
        <p>
          Family information is available only to that family’s parents and guardians and to the
          systems that provide the service. Children can’t see the parent-only solutions. No system
          is perfectly secure, and we will tell you if a breach affects your family as the law
          requires.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We will tell parents by email about important changes before they take effect and ask for
          new consent where it is required.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Email <SupportEmail /> with privacy questions, including requests to review, correct or
          delete your child’s information.
          <DraftOnly>
            {' '}
            Our business name, mailing address and phone number for privacy questions are to be
            confirmed.
          </DraftOnly>
        </p>
      </Section>
    </>
  );
}
