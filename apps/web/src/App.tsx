import {
  createBrowserRouter,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router';
import { Logo } from './components/Logo.tsx';
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

function Shell() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header
        className="container"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <Link to="/" style={{ textDecoration: 'none' }}>
          <Logo />
        </Link>
        <nav aria-label="Main">
          <Link to="/how-it-works">How it works</Link> · <Link to="/pricing">Pricing</Link> ·{' '}
          <Link to="/support">Support</Link> · <Link to="/app">Parent portal</Link>
        </nav>
      </header>
      <ParentNav />
      <main id="main" className="container">
        <Outlet />
      </main>
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

export function App() {
  const router = createBrowserRouter([{ element: <Shell />, children: routes }]);
  return (
    <SessionProvider value={session}>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
