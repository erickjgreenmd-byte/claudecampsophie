import { Link } from 'react-router';

export function Landing() {
  return (
    <section>
      <h1>Turn homework into progress.</h1>
      <p>
        PencilLift helps your child understand their own homework with calm, step-by-step guidance —
        without handing over the answer key — and shows you exactly what needs attention.
      </p>
      <Link className="btn" to="/how-it-works">
        See how it works
      </Link>
    </section>
  );
}
