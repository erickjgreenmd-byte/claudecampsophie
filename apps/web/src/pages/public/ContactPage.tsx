import { Link } from 'react-router';
import { DraftBanner } from '../../components/DraftBanner.tsx';
import { lead, muted, PageTitle, Section, SupportEmail } from './common.tsx';

/**
 * Decision: no contact form. A form needs a monitored backend inbox, spam protection and a data
 * retention rule that do not exist yet; showing one would be a dead or misleading control.
 */
export default function ContactPage() {
  return (
    <>
      <DraftBanner />
      <PageTitle title="Contact" />
      <h1>Contact PencilLift</h1>
      <p style={lead}>We’d like to hear from parents, guardians, teachers and schools.</p>

      <Section title="Email">
        <p>
          Email <SupportEmail />.
        </p>
        <p style={muted}>
          This address and our response times will be confirmed before PencilLift launches.
        </p>
      </Section>

      <Section title="Before you write">
        <ul>
          <li>Please don’t include homework photos or your child’s full name.</li>
          <li>Never send your PIN or password. We will never ask for them.</li>
          <li>
            For account or privacy requests, write from the email address on your parent account so
            we can confirm it’s you.
          </li>
        </ul>
      </Section>

      <Section title="Find what you need faster">
        <ul>
          <li>
            <Link to="/support">Answers to common questions on the support page</Link>
          </li>
          <li>
            <Link to="/account-deletion">How to delete your account or your child’s data</Link>
          </li>
          <li>
            <Link to="/privacy">Read the draft privacy policy</Link>
          </li>
          <li>
            <Link to="/pricing">See plans and pricing</Link>
          </li>
        </ul>
      </Section>
    </>
  );
}
