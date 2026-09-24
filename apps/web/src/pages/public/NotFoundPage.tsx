import { CtaLink, ctaRow, PageTitle } from './common.tsx';

/** Catch-all route: an honest dead-end state with real ways back (spec P14). */
export default function NotFoundPage() {
  return (
    <>
      <PageTitle title="Page not found" />
      <h1>Page not found</h1>
      <p>We couldn’t find that page. It may have moved, or the address may have a typo.</p>
      <div style={ctaRow}>
        <CtaLink to="/">Go to the PencilLift home page</CtaLink>
        <CtaLink to="/support" variant="secondary">
          Get help on the support page
        </CtaLink>
      </div>
    </>
  );
}
