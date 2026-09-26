import { useEffect, useRef } from 'react';
import {
  createBrowserRouter,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  ScrollRestoration,
  useLocation,
  type RouteObject,
} from 'react-router';
import { Logo } from './components/Logo.tsx';
import { RouteError } from './components/RouteError.tsx';
import { SignOutControl } from './components/SignOutControl.tsx';
import { Loading } from './components/states.tsx';
import { routes } from './routes.tsx';
import { unconfiguredAuth } from './lib/auth.ts';
import { readWebConfig } from './lib/config.ts';
import { createDefaultSession, SessionProvider } from './lib/session.tsx';
import { createSupabaseAuth } from './lib/supabase-auth.ts';

const PARENT_LINKS: readonly (readonly [string, string])[] = [
  ['/app', 'Family'],
  ['/app/children', 'Children'],
  ['/app/homework', 'Homework'],
  ['/app/learning', 'Learning'],
  ['/app/rewards', 'Rewards'],
  ['/app/school', 'School & codes'],
  ['/app/subscription', 'Subscription'],
  ['/app/resources', 'Resources'],
  ['/app/devices', 'Devices'],
  ['/app/guardians', 'Guardians'],
  ['/app/security', 'Security'],
  ['/app/privacy', 'Privacy & data'],
  ['/app/support', 'Support'],
];

/** Parent-portal navigation, shown only inside /app (never on public pages). */
function ParentNav() {
  const { pathname } = useLocation();
  if (!pathname.startsWith('/app')) return null;
  return (
    <nav aria-label="Parent portal" className="container" style={{ fontSize: '0.95rem' }}>
      {PARENT_LINKS.map(([to, label], i) => (
        <span key={to}>
          {i > 0 ? ' · ' : null}
          <NavLink to={to} end={to === '/app'}>
            {label}
          </NavLink>
        </span>
      ))}
    </nav>
  );
}

const MAIN_LINKS: readonly (readonly [string, string])[] = [
  ['/how-it-works', 'How it works'],
  ['/pricing', 'Pricing'],
  ['/support', 'Support'],
  ['/app', 'Parent portal'],
];

/**
 * Brand bar on every page (styles.css `.brand-bar`): off-white ground, the traced lockup at 36 px
 * (symbol only under 420 px), navy links with a teal focus ring, 16 px gutters from `.container`.
 */
function BrandBar() {
  return (
    <header className="brand-bar">
      <div className="container brand-bar-inner">
        <Link to="/" className="brand-home" aria-label="PencilLift home">
          <Logo />
        </Link>
        <nav aria-label="Main" className="brand-nav">
          {MAIN_LINKS.map(([to, label]) => (
            <NavLink key={to} to={to}>
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}

/**
 * WEB-R2-06 (WCAG 2.4.2 Page Titled): the browser tab, the window list and a screen reader's page
 * announcement all read `document.title`. index.html ships one static title, and only the public
 * pages replaced it, so every portal, admin and auth page said "PencilLift — Turn homework into
 * progress." and a parent could not tell Homework from Privacy & data.
 *
 * Kept here, next to the route table, rather than in each page: a page another area owns gets its
 * title without being edited. Public pages set their own (pages/public/common.tsx `PageTitle`) and
 * are deliberately absent, so nothing overwrites them.
 */
export const PORTAL_PAGE_TITLES: readonly [string, string][] = [
  ['/app', 'Your family'],
  ['/app/children', 'Children'],
  ['/app/homework', 'Homework'],
  ['/app/learning', 'Learning planner'],
  ['/app/rewards', 'Rewards'],
  ['/app/school', 'School & codes'],
  ['/app/subscription', 'Subscription'],
  ['/app/resources', 'Resources'],
  ['/app/devices', 'Devices'],
  ['/app/guardians', 'Guardians'],
  ['/app/security', 'Security'],
  ['/app/security/reset-pin', 'Reset your parent PIN'],
  ['/app/privacy', 'Privacy & data'],
  ['/app/support', 'Support'],
  ['/admin', 'Owner admin'],
  ['/admin/mfa', 'Two-step verification'],
  ['/admin/support', 'Support queue'],
  ['/admin/revenue', 'Subscriptions and revenue'],
  ['/admin/promotions', 'Promotions'],
  ['/admin/schools', 'Schools and payouts'],
  ['/admin/monetization', 'Monetization'],
  ['/sign-in', 'Parent sign in'],
  ['/sign-up', 'Create a parent account'],
  ['/reset-password', 'Reset your password'],
  ['/update-password', 'Choose a new password'],
];

const TITLE_BY_PATH = new Map<string, string>(PORTAL_PAGE_TITLES);

function useDocumentTitle(pathname: string) {
  useEffect(() => {
    const title = TITLE_BY_PATH.get(pathname);
    if (title) document.title = `${title} · PencilLift`;
  }, [pathname]);
}

/**
 * WEB-R2-06 (WCAG 2.4.3): a client-side navigation replaces the page without moving focus, so a
 * screen reader announces nothing and a keyboard user keeps tabbing from where the old page was.
 * Focus goes to the new page's h1 (or the main landmark while the page is still loading). The first
 * load is left alone: focus belongs at the top of the document, before the skip link.
 */
function useFocusOnNavigation(pathname: string) {
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const main = document.getElementById('main');
    const target: HTMLElement | null = main?.querySelector('h1') ?? main;
    if (!target) return;
    // Headings are not focusable by default; -1 keeps it out of the tab order.
    target.setAttribute('tabindex', '-1');
    target.focus();
  }, [pathname]);
}

function Shell() {
  const { pathname } = useLocation();
  useDocumentTitle(pathname);
  useFocusOnNavigation(pathname);
  // WEB-R2-01: the session controls belong to the signed-in surfaces (parent portal, owner console).
  const portal = pathname.startsWith('/app') || pathname.startsWith('/admin');
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <BrandBar />
      <ParentNav />
      {portal ? <SignOutControl /> : null}
      <main id="main" className="container">
        <Outlet />
      </main>
      {/* WEB-R2-06: without this, navigating from the bottom of a long page (Homework, Privacy)
          leaves the next page scrolled down at the same offset. */}
      <ScrollRestoration />
      <footer className="container" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
        <Link to="/privacy">Privacy</Link> · <Link to="/terms">Terms</Link> ·{' '}
        <Link to="/account-deletion">Delete an account</Link> · <Link to="/contact">Contact</Link>
      </footer>
    </>
  );
}

const config = readWebConfig();
// Real sign-in only when the owner's Supabase project is configured; otherwise an honest
// "not configured" state (never a fake login).
const session = createDefaultSession(
  config,
  config.supabaseUrl && config.supabasePublishableKey
    ? createSupabaseAuth(config)
    : unconfiguredAuth,
);

/**
 * WEB-R2-09: every route is lazily loaded, so on the first load React Router has nothing to render
 * until the page chunk arrives. Without a hydrate fallback that is a blank off-white page — no brand
 * bar, no skip link — on a slow tablet connection, and React Router warns about it. The fallback is
 * the same shell, so the first paint is branded and the skip link works straight away.
 */
function ShellLoading() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <BrandBar />
      <main id="main" className="container">
        <Loading label="Loading PencilLift…" />
      </main>
    </>
  );
}

/** Last resort when the Shell itself fails: still branded, still offers a way back. */
function ShellError() {
  return (
    <>
      <BrandBar />
      <main id="main" className="container">
        <RouteError />
      </main>
    </>
  );
}

/**
 * WEB-R1-02: every page renders under a pathless route whose error boundary shows inside the Shell's
 * <Outlet>, so a page that throws or a stale lazy chunk after a deploy keeps the brand bar and
 * navigation and offers "Reload" / "Go to the family dashboard" (never React Router's default
 * "Unexpected Application Error!" page).
 */
export function appRoutes(children: RouteObject[]): RouteObject[] {
  return [
    {
      element: <Shell />,
      errorElement: <ShellError />,
      hydrateFallbackElement: <ShellLoading />,
      children: [{ errorElement: <RouteError />, children }],
    },
  ];
}

export function App() {
  const router = createBrowserRouter(appRoutes(routes));
  return (
    <SessionProvider value={session}>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
