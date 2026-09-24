import { Link } from 'react-router';
import { cardGrid, CtaLink, ctaRow, lead, PageTitle, Section, SubjectList } from './common.tsx';

/** What PencilLift does (spec P1). Each claim describes implemented or specified behaviour only. */
const features: { title: string; body: string }[] = [
  {
    title: 'Guidance, not the answer key',
    body: 'Your child scans completed homework and sees which answers are correct and which need another try. For mistakes, PencilLift explains the method, asks a next-step question and offers a hint, then lets your child try again. It does not hand over the answer key.',
  },
  {
    title: 'Complete solutions for parents',
    body: 'After you unlock the parent area with your private PIN, you can see complete answers, worked explanations and suggestions you can use to teach.',
  },
  {
    title: 'Daily extra-credit practice',
    body: 'A short set each day, five questions by default, focused on what your child has recently found tricky. Effort and progress earn points.',
  },
  {
    title: 'Thursday reviews before Friday tests',
    body: 'Each Thursday, a review for every subject your child is studying puts that week’s difficulty areas first, so practice happens before test day.',
  },
  {
    title: 'Rewards you define',
    body: 'Points count toward rewards you choose, like a book or a family outing. You approve and deliver rewards yourself; PencilLift never pays children or holds money.',
  },
  {
    title: 'Learning resources for parents',
    body: 'See trends, strengths and practice areas for each child, plus suggested learning resources such as free practice ideas, parent-led activities and optional workbooks.',
  },
];

export default function LandingPage() {
  return (
    <>
      <PageTitle title="Turn homework into progress" />
      <div style={{ padding: '24px 0 8px' }}>
        <h1>Turn homework into progress.</h1>
        <p style={lead}>
          PencilLift helps your child understand their own homework, and helps you see what needs
          attention. Your child gets step-by-step guidance on mistakes instead of the answer key,
          while you see complete solutions in a PIN-protected parent area.
        </p>
        <p>Designed for elementary and middle-school learners, grades K–8, in the United States.</p>
        <div style={ctaRow}>
          <CtaLink to="/how-it-works">See how PencilLift works</CtaLink>
          <CtaLink to="/pricing" variant="secondary">
            View pricing
          </CtaLink>
        </div>
      </div>

      <Section title="What PencilLift does">
        <ul role="list" style={cardGrid}>
          {features.map((feature) => (
            <li key={feature.title} className="card">
              <h3 style={{ marginTop: 0 }}>{feature.title}</h3>
              <p style={{ marginBottom: 0 }}>{feature.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Six subjects">
        <SubjectList />
        <p>
          Coverage varies by grade and topic. Work PencilLift can’t check confidently is marked for
          a parent or teacher to review instead of being guessed.
        </p>
      </Section>

      <Section title="Privacy built in for families">
        <ul>
          <li>A parent owns the account and gives consent before any child information is used.</li>
          <li>Children don’t need an email address, phone number or social login.</li>
          <li>No ads or affiliate links in your child’s space, and we don’t sell family data.</li>
        </ul>
        <p>
          <Link to="/privacy">Read the draft privacy policy</Link>
        </p>
      </Section>

      <Section title="Where PencilLift is today">
        <div className="notice">
          <p style={{ margin: 0 }}>
            PencilLift is still being built. The app is not yet available to download, and plans are
            not yet available for purchase. Questions? Visit our{' '}
            <Link to="/support">support page</Link>.
          </p>
        </div>
      </Section>
    </>
  );
}
