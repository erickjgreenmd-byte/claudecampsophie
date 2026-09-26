import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ApiRequestError } from '@pencillift/contracts/client';
import type { AuthAdapter } from '../lib/auth.ts';
import { SessionProvider } from '../lib/session.tsx';
import { ActionFeedback } from './learning/feedback.tsx';
import { StepUpPrompt } from './StepUpPrompt.tsx';

/**
 * WEBR4-06: every step-up notice the shared prompt replaced was `<div className="notice"
 * role="alert">`. The replacement is a plain fieldset with no role, no live region and no focus
 * move, while every other refusal on the same screens still goes through ErrorState (role="alert").
 * On the learning planner the feedback sits ~150 lines of fields above the submit button, so a
 * parent who pressed "Save schedule" with a lapsed unlock got a PIN field far off-screen, nothing
 * announced and no visible change near the control they used.
 *
 * Synthetic data only.
 */

afterEach(cleanup);

const signedIn: AuthAdapter = {
  configured: true,
  currentSession: () =>
    Promise.resolve({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' }),
  signOut: () => Promise.resolve(),
};

function renderAt(element: React.ReactElement, path = '/app/learning') {
  const router = createMemoryRouter([{ path, element }], { initialEntries: [path] });
  return render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth: signedIn,
        api: {
          get: () => Promise.reject(new Error('unexpected GET')),
          send: () => Promise.reject(new Error('unexpected send')),
        },
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
}

describe('[WEBR4-06] a step-up refusal is announced and takes the focus', () => {
  it('announces the prompt through a live region, as the notices it replaced did', async () => {
    renderAt(
      <StepUpPrompt
        explanation="Saving the schedule needs a recent PIN unlock."
        retryHint={() => 'Press the same button again to continue.'}
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Saving the schedule needs a recent PIN unlock/);
    // The prompt the alert belongs to is the one holding the PIN field.
    const prompt = await screen.findByRole('group', { name: /enter your parent pin/i });
    expect(prompt.contains(alert)).toBe(true);
    expect(within(prompt).getByLabelText('Parent PIN')).toBeTruthy();
  });

  it('moves the focus to the PIN field, so the parent is not left at an off-screen form', async () => {
    renderAt(
      <StepUpPrompt
        explanation="Saving the schedule needs a recent PIN unlock."
        retryHint={() => 'Press the same button again to continue.'}
      />,
    );
    const pin = await screen.findByLabelText('Parent PIN');
    expect(document.activeElement).toBe(pin);
  });

  it('announces the planner’s own STEP_UP_REQUIRED branch too', async () => {
    renderAt(
      <ActionFeedback
        feedback={{
          kind: 'error',
          error: new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
        }}
        stepUpWhat="Saving the schedule"
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Saving the schedule needs a recent PIN unlock/);
  });
});
