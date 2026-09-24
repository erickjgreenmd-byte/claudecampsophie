import { createBrowserRouter, Link, Outlet, RouterProvider } from 'react-router';
import { Logo } from './components/Logo.tsx';
import { routes } from './routes.tsx';

function Shell() {
  return (
    <>
      <header
        className="container"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <Link to="/" style={{ textDecoration: 'none' }}>
          <Logo />
        </Link>
        <nav aria-label="Main">
          <Link to="/how-it-works">How it works</Link> · <Link to="/pricing">Pricing</Link> ·{' '}
          <Link to="/support">Support</Link> · <Link to="/app">Parent sign in</Link>
        </nav>
      </header>
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

export function App() {
  const router = createBrowserRouter([{ element: <Shell />, children: routes }]);
  return <RouterProvider router={router} />;
}
