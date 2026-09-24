import { Link } from 'react-router';
import { CtaLink, ctaRow, lead, PageTitle, Section, SubjectList } from './common.tsx';

/** The family journey (spec P1, P3, P5–P10), described without implementation detail. */
const steps: { title: string; body: string[] }[] = [
  {
    title: 'A parent sets up the family',
    body: [
      'You create the account with a verified email address and give verifiable parental consent before PencilLift collects or uses any information about your child.',
      'Then add each child with a nickname, grade and subjects. Children never need an email address, phone number or social login. To connect your child’s device, you create a one-time pairing code in the parent area.',
    ],
  },
  {
    title: 'Your child scans finished homework',
    body: [
      'Your child photographs completed homework on their paired device, or you can scan it for them. If a photo is blurry or cut off, PencilLift asks for a clearer picture instead of guessing.',
    ],
  },
  {
    title: 'Feedback that teaches',
    body: [
      'Each answer is marked “Correct” or “Try again” with an icon and words, never color alone. For a mistake, PencilLift names the idea, asks one next-step question, gives a short hint and, if needed, walks through a similar example that uses different numbers. Then your child tries again.',
      'The answer key stays with you. Work that can’t be checked confidently is marked for a parent or teacher to review.',
    ],
  },
  {
    title: 'You see the full picture',
    body: [
      'Unlock the parent area with your private six-digit PIN to see complete answers and explanations, trends by subject, strengths and practice areas. The parent area locks again after a short time.',
    ],
  },
  {
    title: 'Daily extra-credit practice',
    body: [
      'Every day, including weekends, at a time you choose. Five questions by default (you can pick 3 to 10), mostly from recent practice areas, with some review and confidence-building questions. Missed days are never penalized.',
    ],
  },
  {
    title: 'Thursday reviews before Friday tests',
    body: [
      'By default, reviews are ready on Thursday at 4 p.m. in your family’s time zone, one for each subject your child is studying, with that week’s difficulty areas first. You can change the day, time and test dates.',
      'Reviews help your child prepare; they can’t predict exactly what a teacher will put on a test.',
    ],
  },
  {
    title: 'Rewards you define',
    body: [
      'Your child earns points for practice and effort. Points are a family motivation tool, not money. You set the rewards, approve requests and deliver rewards yourself.',
    ],
  },
  {
    title: 'Learning resources for you',
    body: [
      'When a pattern of difficulty shows up, PencilLift suggests ways to help: free in-app practice, parent-led activities and optional materials like workbooks or flashcards. Suggestions are chosen for learning needs, not commissions.',
      'Any sponsored or affiliate content appears only in the parent area and is clearly labeled.',
    ],
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <PageTitle title="How PencilLift works" />
      <h1>How PencilLift works</h1>
      <p style={lead}>
        PencilLift checks your child’s own homework, coaches them through mistakes without giving
        away the answers, and gives you a clear, private view of how they are doing.
      </p>

      <ol style={{ paddingLeft: '1.25rem' }}>
        {steps.map((step) => (
          <li key={step.title} style={{ marginTop: 24 }}>
            <h2 style={{ marginBottom: 8 }}>{step.title}</h2>
            {step.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </li>
        ))}
      </ol>

      <Section title="Subjects PencilLift supports">
        <SubjectList />
        <p>
          PencilLift is designed for grades K–8. Coverage varies by grade and topic, and you can add
          study guides, spelling lists and test dates to focus practice.
        </p>
      </Section>

      <Section title="How PencilLift uses AI">
        <p>
          PencilLift uses AI together with automated checks to read homework photos, check answers
          and write explanations. AI can make mistakes, so results are checked in a separate step
          and uncertain results go to a parent for review.
        </p>
        <p>
          Your child’s information is sent to an AI provider only under zero-data-retention terms.
          Read the <Link to="/privacy">draft privacy policy</Link> for details.
        </p>
      </Section>

      <div style={ctaRow}>
        <CtaLink to="/pricing">View pricing</CtaLink>
        <CtaLink to="/support" variant="secondary">
          Get support
        </CtaLink>
      </div>
    </>
  );
}
