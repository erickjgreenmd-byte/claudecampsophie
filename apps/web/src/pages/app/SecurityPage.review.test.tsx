import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPage } from '../../test/render.tsx';
import SecurityPage from './SecurityPage.tsx';

/**
 * Independent review of the family vertical (web security page). No API calls are needed: the
 * defect is in what the page tells a parent who forgot their PIN.
 */

afterEach(cleanup);

describe('SecurityPage review', () => {
  it('[RV-family-4] a parent who forgot the PIN is sent to the working reset page, not told it does not exist', async () => {
    renderPage(<SecurityPage />, { path: '/app/security' });
    expect(await screen.findByRole('heading', { name: 'Forgot your PIN?' })).toBeTruthy();

    // /app/security/reset-pin (PinResetPage -> POST /v1/adult/pin/reset) is routed and working,
    // and the API's lockout message says "Try again later or reset your PIN", yet this page says
    // recovery "isn't available in the portal yet" and offers only "contact support".
    const resetLinks = screen
      .queryAllByRole('link')
      .filter((a) => a.getAttribute('href') === '/app/security/reset-pin');
    expect(resetLinks, 'no link to /app/security/reset-pin').toHaveLength(1);
    expect(screen.queryByText(/isn’t available in the portal yet/)).toBeNull();
  });
});
