import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { FamilyOverview } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import ChildrenPage from './ChildrenPage.tsx';

/**
 * Independent review of the family vertical (web). Synthetic data only (Riley, Sam).
 */

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const FAMILY = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';

/** Two paid slots, one in use by Riley: Sam's draft can take the unused slot without a purchase. */
function family(): FamilyOverview {
  return {
    id: FAMILY,
    displayName: 'Test Family',
    timezone: 'America/Chicago',
    paidSlots: 2,
    billingConflict: null,
    managingChannel: 'app_store',
    children: [
      { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
      { id: SAM, nickname: 'Sam', gradeLevel: 0, ageBand: '5-7', status: 'draft' },
    ],
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi() {
  const sends: Call[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(_path: string, schema: S) => Promise.resolve(schema.parse(family())),
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      sends.push({ method, path, body });
      // POST /v1/children/:id/activate (apps/api/src/routes/family.ts) response shape.
      const value = { childId: SAM, status: 'active', paidSlots: 2, assignedSlots: 2 };
      const parsed = schema.safeParse(value);
      return parsed.success ? Promise.resolve(parsed.data) : Promise.resolve(value as z.infer<S>);
    },
  };
  return { api, sends };
}

afterEach(cleanup);

describe('ChildrenPage review', () => {
  it('[RV-family-3] a draft child can be given an unused paid slot from the portal (no dead end)', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi();
    renderPage(<ChildrenPage />, { api });
    const sam = (await screen.findByRole('heading', { name: 'Sam' })).closest('li')!;

    // Spec P11 / AC_CAPACITY_03: an unused paid slot can be assigned without buying again. The API
    // has POST /v1/children/:id/activate for exactly this, but no screen calls it, and the page
    // sends parents to "subscription management in the app", which does not exist.
    const activate = within(sam).queryByRole('button', {
      name: /activate|assign.*slot|use.*slot/i,
    });
    expect(activate, 'no control assigns the unused paid slot to Sam').not.toBeNull();
    expect(
      screen.queryByText(/activation happens in subscription management in the app/),
    ).toBeNull();
    await user.click(activate!);
    await waitFor(() =>
      expect(sends).toContainEqual({
        method: 'POST',
        path: `/v1/children/${SAM}/activate`,
        body: undefined,
      }),
    );
  });
});
