import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../test/render.tsx';
import { unconfiguredAuth } from './auth.ts';
import { RequireParent } from './session.tsx';

const Protected = () => (
  <RequireParent>
    <p>Family data for Riley</p>
  </RequireParent>
);

describe('RequireParent (spec P14 honest states)', () => {
  it('shows an honest not-configured state and no family data when auth is not connected', async () => {
    renderPage(<Protected />, { auth: unconfiguredAuth });
    expect(await screen.findByText(/sign-in isn’t available yet/i)).toBeTruthy();
    expect(screen.queryByText(/Riley/)).toBeNull();
  });

  it('asks a signed-out parent to sign in without rendering protected content', async () => {
    renderPage(<Protected />, {
      auth: {
        configured: true,
        currentSession: () => Promise.resolve(null),
        signOut: () => Promise.resolve(),
      },
    });
    expect(await screen.findByText(/please sign in/i)).toBeTruthy();
    expect(screen.queryByText(/Riley/)).toBeNull();
  });

  it('renders protected content for a signed-in parent', async () => {
    renderPage(<Protected />);
    expect(await screen.findByText('Family data for Riley')).toBeTruthy();
  });
});
