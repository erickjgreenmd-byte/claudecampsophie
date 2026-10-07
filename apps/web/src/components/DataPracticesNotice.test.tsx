import { DATA_PRACTICES_COPY } from '@pencillift/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '@pencillift/contracts/client';
import { appRoutes } from '../App.tsx';
import { SessionProvider } from '../lib/session.tsx';
import type { AuthAdapter } from '../lib/auth.ts';
import { DataPracticesNotice } from './DataPracticesNotice.tsx';

/**
 * The notice on every page (spec P4, P15). What it says is the server's answer; what it says BEFORE
 * that answer is the interesting part, and it is asserted first.
 */

const auth: AuthAdapter = {
  configured: true,
  currentSession: () => Promise.resolve({ accessToken: 't', email: 'parent@example.test' }),
  signOut: () => Promise.resolve(),
};

function mount(element: ReactElement, api: Partial<ApiClient>): ReactNode {
  const client: ApiClient = {
    get: () => Promise.reject(new Error('unexpected GET')),
    send: () => Promise.reject(new Error('unexpected send')),
    ...api,
  };
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] });
  return (
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth,
        api: client,
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>
  );
}

/**
 * Resolves through the schema it is HANDED, exactly as `createApiClient` does — so a typo in a
 * fixture here fails as loudly as on the wire, and a fake that validates is the one being shipped.
 * The cast is on the signature only: `get` is generic in its schema and this body honours that at
 * runtime, which a concrete return type cannot express.
 */
const published = (childWork: string, adultId: string): Partial<ApiClient> => ({
  get: ((_path: string, schema: { parse: (value: unknown) => unknown }) =>
    Promise.resolve(schema.parse({ childWork, adultId }))) as ApiClient['get'],
});

const NEVER_RESOLVES: Partial<ApiClient> = { get: () => new Promise(() => undefined) };

afterEach(cleanup);

describe('an unknown state discloses, it does not reassure', () => {
  it('shows the wider case before the server has answered', async () => {
    render(mount(<DataPracticesNotice />, NEVER_RESOLVES));
    expect(await screen.findByText(DATA_PRACTICES_COPY.unconfirmed)).toBeTruthy();
    // The one sentence that must never appear on a guess: it is the reassuring one.
    expect(screen.queryByText(DATA_PRACTICES_COPY.childWork.not_sent)).toBeNull();
  });

  it('keeps showing the wider case when the request fails', async () => {
    render(mount(<DataPracticesNotice />, { get: () => Promise.reject(new Error('offline')) }));
    expect(await screen.findByText(DATA_PRACTICES_COPY.unconfirmed)).toBeTruthy();
    expect(screen.queryByText(DATA_PRACTICES_COPY.childWork.not_sent)).toBeNull();
  });

  it('a body the schema refuses is not half-believed', async () => {
    // A client that skipped validation would set adultId to the REASSURING value out of this body.
    render(
      mount(<DataPracticesNotice />, {
        get: () => Promise.resolve({ childWork: 'definitely_fine', adultId: 'not_sent' } as never),
      }),
    );
    expect(await screen.findByText(DATA_PRACTICES_COPY.unconfirmed)).toBeTruthy();
    expect(screen.queryByText(DATA_PRACTICES_COPY.adultId.not_sent)).toBeNull();
  });

  it('names OpenAI even while unconfirmed, because that is the wider case', () => {
    // Guards the direction of the fallback: an `unconfirmed` sentence rewritten into something
    // soothing would pass every other case in this file.
    expect(DATA_PRACTICES_COPY.unconfirmed).toContain('OpenAI');
    expect(DATA_PRACTICES_COPY.childWork.not_sent).not.toContain('OpenAI');
  });
});

describe('a published state is printed as published', () => {
  it('prints the “nothing is sent” sentence, with no retention claim in it', async () => {
    render(mount(<DataPracticesNotice />, published('not_sent', 'not_sent')));
    expect(await screen.findByText(DATA_PRACTICES_COPY.childWork.not_sent)).toBeTruthy();
    expect(screen.queryByText(DATA_PRACTICES_COPY.unconfirmed)).toBeNull();
    // BUG-430 in one line: a "not sent" state may not carry a zero-data-retention claim.
    expect(document.body.textContent).not.toContain('zero data retention');
  });

  it('prints the OpenAI sentences when the server says the work travels', async () => {
    render(mount(<DataPracticesNotice />, published('openai_under_zdr', 'openai_under_zdr')));
    expect(await screen.findByText(DATA_PRACTICES_COPY.childWork.openai_under_zdr)).toBeTruthy();
    expect(screen.getByText(DATA_PRACTICES_COPY.adultId.openai_under_zdr)).toBeTruthy();
  });

  it('prints the vendor sentence for an identity vendor', async () => {
    render(mount(<DataPracticesNotice />, published('not_sent', 'identity_vendor')));
    expect(await screen.findByText(DATA_PRACTICES_COPY.adultId.identity_vendor)).toBeTruthy();
  });

  it('carries a heading and a way to the full policy', async () => {
    render(mount(<DataPracticesNotice />, published('not_sent', 'not_sent')));
    expect(await screen.findByRole('heading', { name: DATA_PRACTICES_COPY.heading })).toBeTruthy();
    const link = screen.getByRole('link', { name: DATA_PRACTICES_COPY.linkLabel });
    expect(link.getAttribute('href')).toBe('/privacy');
  });
});

describe('“every page” means every shell, including the ones where the page did not arrive', () => {
  /*
   * Asserted from the ROUTE OBJECT rather than by grepping App.tsx for the component's name: a
   * source grep passes on a mention in a comment (L-077), and the three slots below are exactly
   * the three ways a parent can end up looking at the chrome — the page, a page that threw, and
   * the hydrate fallback before the page's chunk arrives.
   */
  const [root] = appRoutes([{ index: true, element: <h1>A page</h1> }]);

  it.each([
    ['element', root?.element],
    ['errorElement', root?.errorElement],
    ['hydrateFallbackElement', root?.hydrateFallbackElement],
  ])('the %s shell renders the notice', async (_slot, element) => {
    expect(element).toBeTruthy();
    render(mount(element as ReactElement, NEVER_RESOLVES));
    expect(await screen.findByRole('heading', { name: DATA_PRACTICES_COPY.heading })).toBeTruthy();
  });
});
