import { Link } from 'react-router';
import { DraftBanner } from '../../components/DraftBanner.tsx';
import { draftPrefix, lead, PageTitle, PAYMENT_STORES, Section, SupportEmail } from './common.tsx';

/**
 * Common questions, answered to match the product's actual design (spec P3, P5, P6, P11).
 * Subscriptions are sold by Apple's App Store, Google Play and the Amazon Appstore (Fire tablets),
 * named together wherever any of them is named (AMZ-17).
 */
const questions: { question: string; answer: string }[] = [
  {
    question: 'How do I connect my child’s device?',
    answer:
      'In the parent area, create a one-time pairing code for your child and enter it on their device. The code expires quickly and only opens your child’s space, never the parent area.',
  },
  {
    question: 'Why doesn’t my child see the answers?',
    answer:
      'By design, children get guidance and hints for mistakes, not the answer key. You can see complete answers and explanations after unlocking the parent area with your PIN.',
  },
  {
    question: 'A homework photo couldn’t be read. What now?',
    answer:
      'Retake the photo in good light with the whole page in view. If PencilLift still can’t read the work confidently, it is marked for a parent to review rather than guessed.',
  },
  {
    question: 'I forgot my parent PIN.',
    answer:
      // WEB-R1-08: the portal has a verified self-serve reset (/app/security/reset-pin).
      'Sign in to the parent portal, open Security, choose Reset your parent PIN and confirm your account password. That check keeps the reset with the parent on the account. Contact support only if you can’t sign in.',
  },
  {
    question: 'How do I change or cancel my subscription?',
    answer: `Subscriptions are billed and managed by ${PAYMENT_STORES}, so you change or cancel them there. Deleting your PencilLift account doesn’t cancel a store subscription.`,
  },
  {
    question: 'How do I report something that looks wrong or unsafe?',
    answer:
      'Use the report or help option in the app, or email support. Describe what happened without including homework photos or your child’s full name.',
  },
];

export default function SupportPage() {
  return (
    <>
      <DraftBanner />
      <PageTitle title="Support" />
      <h1>Support</h1>
      <p style={lead}>Answers to common questions, and how to reach the PencilLift team.</p>

      <Section title="Contact support">
        <p>
          Email <SupportEmail />. Please don’t include homework photos, your child’s full name, your
          PIN or your password in your message. We will never ask for your PIN or password.
        </p>
        <p>
          If you think a child is in immediate danger, call 911 or your local emergency number.
          PencilLift is not an emergency service.
        </p>
      </Section>

      <Section title="Common questions">
        {questions.map((item) => (
          <div key={item.question} style={{ marginTop: 16 }}>
            <h3 style={{ marginBottom: 4 }}>{item.question}</h3>
            <p style={{ marginTop: 0 }}>{item.answer}</p>
          </div>
        ))}
      </Section>

      <Section title="Privacy and your account">
        <ul>
          <li>
            <Link to="/account-deletion">How to delete your account or your child’s data</Link>
          </li>
          <li>
            <Link to="/privacy">Read the {draftPrefix()}privacy policy</Link>
          </li>
          <li>
            <Link to="/terms">Read the {draftPrefix()}terms of use</Link>
          </li>
          <li>
            <Link to="/contact">Other ways to contact us</Link>
          </li>
        </ul>
      </Section>
    </>
  );
}
