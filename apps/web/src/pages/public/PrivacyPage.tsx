import { Link } from 'react-router';
import { DraftBanner } from '../../components/DraftBanner.tsx';
import { lead, muted, PageTitle, Section, SupportEmail } from './common.tsx';

/**
 * Draft privacy policy (spec P3, P4, P16.1, P15 privacy URL). It must describe the implemented
 * design exactly: consent before child data, private storage, 30-day raw-scan retention,
 * tombstone-first deletion within 30 days, AI only under zero data retention, and no ads or
 * affiliate links in children's areas. Anything not yet decided is marked "to be confirmed".
 *
 * Limits are stated, not glossed over (RV-public-site-1, -2, -4): photo metadata is removed on the
 * device where possible and always by the scan job before any processing (image-metadata.ts); export
 * files are not built by any deployed job yet; the retention exceptions match
 * app.purge_family_data (billing, consent records, audit log, family tombstone, adult sign-in).
 */
export default function PrivacyPage() {
  return (
    <>
      <DraftBanner />
      <PageTitle title="Privacy policy" />
      <h1>Privacy policy</h1>
      <p style={lead}>
        PencilLift is built for families with children in grades K–8. This draft explains what
        information PencilLift collects, how it is used, and the choices parents have.
      </p>
      <p style={muted}>Status: draft, not yet in effect. Effective date to be confirmed.</p>

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
            Subscription status reported by the App Store or Google Play. We don’t receive your card
            number.
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
            Raw homework photos are deleted after 30 days by default. You can delete them sooner.
          </li>
          <li>
            Learning history is kept while your account is active, with a yearly review for you and
            deletion after a period of inactivity (proposed: 12 months, to be confirmed).
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
          We share information only with service providers that help run PencilLift, such as hosting
          and database services, the consent provider, the AI provider (under zero data retention),
          and the App Store or Google Play for payments. The final list of providers is to be
          confirmed. We may also disclose information when the law requires it.
        </p>
      </Section>

      <Section title="Notifications">
        <p>
          Notifications go to parents’ devices by default and use general wording. They never
          include answers, homework photos or sensitive details about how your child is doing.
        </p>
      </Section>

      <Section title="Your choices">
        <ul>
          <li>Review and correct your child’s profile.</li>
          <li>
            Ask for a copy (export) of your family’s information. Export files aren’t available yet:
            a request is saved, but there is nothing to download until the export service is
            switched on.
          </li>
          <li>Delete homework photos, a child’s data, or your whole account.</li>
          <li>Withdraw consent for your child’s information to be processed.</li>
        </ul>
      </Section>

      <Section title="Deleting information">
        <p>
          When you ask us to delete your account or a child’s data, processing stops immediately:
          your child’s devices are signed out and pending work is cancelled. Deletion from our
          active systems completes within 30 days. Backups expire on a documented schedule (length
          to be confirmed). Only the family owner can delete the whole family account.
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
        </ul>
        <p>
          Deleting the whole family account does not close your parent sign-in (your email address
          and password), but that sign-in no longer opens any of the family’s information. To have
          the sign-in closed as well, email us.
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
          We will tell parents about important changes before they take effect and ask for new
          consent where it is required.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Email <SupportEmail />. Our business name, mailing address and phone number for privacy
          questions are to be confirmed.
        </p>
      </Section>
    </>
  );
}
