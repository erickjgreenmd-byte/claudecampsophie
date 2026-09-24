import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import type { AppMode } from '../lib/mode.ts';
import {
  dismissSponsorCard,
  loadPreferences,
  loadResources,
  loadSponsorCard,
  openResourceLink,
  openSponsorLink,
  reportSponsorCard,
  savePreferences,
  sendViewed,
} from './actions.ts';
import { NO_FILTERS } from './view-model.ts';

// Synthetic data only.
const ITEM = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const AMAZON_URL = 'https://www.amazon.com/dp/B000000001?tag=pencillift-20';
const ASSOCIATES = 'As an Amazon Associate I earn from qualifying purchases.';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake API: every response passes through the real contract schema. */
function fakeApi(respond: (call: Call) => unknown = () => null) {
  const calls: Call[] = [];
  const settle = (call: Call, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    calls.push(call);
    try {
      const value = respond(call);
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value) as never);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const api: ApiClient = {
    get: (path, schema) => settle({ method: 'GET', path, body: undefined }, schema),
    send: (method, path, body, schema) => settle({ method, path, body }, schema),
  };
  return { api, calls };
}

function opener() {
  const opened: string[] = [];
  return {
    opened,
    openUrl: (url: string) => {
      opened.push(url);
      return Promise.resolve(true);
    },
  };
}

const card = { serveToken: TOKEN };

describe('no commercial request outside parent mode (AC_MON_02/03)', () => {
  it.each<AppMode>(['child', 'signed_out'])('makes no request in %s mode', async (mode) => {
    const { api, calls } = fakeApi();
    const { openUrl, opened } = opener();
    expect(await loadResources(api, mode, NO_FILTERS, 'ios', 'en-US')).toBeNull();
    expect(await loadPreferences(api, mode)).toBeNull();
    expect(
      await loadSponsorCard(
        api,
        mode,
        { hideAffiliate: false, hideSponsorCards: false },
        'resources_browse',
        'ios',
        'en-US',
      ),
    ).toBeNull();
    expect(
      await openResourceLink(
        api,
        mode,
        { id: ITEM, shownMode: 'amazon_associates' },
        'ios',
        null,
        openUrl,
      ),
    ).toMatchObject({ kind: 'error', needsPin: true });
    expect(await openSponsorLink(api, mode, card, openUrl)).toMatchObject({ kind: 'error' });
    expect(
      (await savePreferences(api, mode, { hideAffiliate: true, hideSponsorCards: true })).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
    expect(opened).toEqual([]);
  });
});

describe('resources and preferences (spec P16.3; AC_MON_04/11)', () => {
  it('loads resources for the parent-selected context', async () => {
    const { api, calls } = fakeApi(() => ({
      mode: 'plain_link',
      commercialHidden: false,
      items: [],
    }));
    const result = await loadResources(
      api,
      'parent',
      { subject: 'reading', grade: 2, skill: null },
      'android',
      'en-US',
    );
    expect(result).toEqual({ mode: 'plain_link', commercialHidden: false, items: [] });
    expect(calls[0]!.path).toBe(
      '/v1/resources?platform=android&subject=reading&grade=2&locale=en-US',
    );
  });

  it('never asks for a sponsor card when the family hides them', async () => {
    const { api, calls } = fakeApi();
    expect(
      await loadSponsorCard(
        api,
        'parent',
        { hideAffiliate: false, hideSponsorCards: true },
        'resources_browse',
        'ios',
        null,
      ),
    ).toBeNull();
    expect(await loadSponsorCard(api, 'parent', null, 'resources_browse', 'ios', null)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('treats a failed sponsor request as no card', async () => {
    const { api } = fakeApi(() => new ApiRequestError('INTERNAL', 'x', 500));
    expect(
      await loadSponsorCard(
        api,
        'parent',
        { hideAffiliate: false, hideSponsorCards: false },
        'resources_browse',
        'web',
        null,
      ),
    ).toBeNull();
  });

  it('saves preferences and reports a step-up', async () => {
    const prefs = { hideAffiliate: true, hideSponsorCards: false };
    const ok = fakeApi((call) => call.body);
    expect(await savePreferences(ok.api, 'parent', prefs)).toEqual({
      ok: true,
      prefs,
      message: 'Your choices are saved for your family.',
    });
    expect(ok.calls[0]).toEqual({
      method: 'PUT',
      path: '/v1/monetization/preferences',
      body: prefs,
    });
    const locked = fakeApi(() => new ApiRequestError('STEP_UP_REQUIRED', 'PIN', 403));
    expect(await savePreferences(locked.api, 'parent', prefs)).toMatchObject({
      ok: false,
      needsPin: true,
    });
  });
});

describe('outbound links open only in the system browser after a tap (AC_MON_11/12)', () => {
  it('opens the approved https URL through the injected system opener', async () => {
    const { api, calls } = fakeApi(() => ({
      url: AMAZON_URL,
      mode: 'amazon_associates',
      disclosure: ASSOCIATES,
    }));
    const { openUrl, opened } = opener();
    const outcome = await openResourceLink(
      api,
      'parent',
      { id: ITEM, shownMode: 'amazon_associates' },
      'ios',
      'en-US',
      openUrl,
    );
    expect(outcome).toEqual({ kind: 'opened', host: 'www.amazon.com' });
    expect(opened).toEqual([AMAZON_URL]);
    expect(calls[0]!.path).toBe(`/v1/resources/${ITEM}/outbound?platform=ios&locale=en-US`);
  });

  it('does not open when the disclosure changed since the list loaded', async () => {
    const { api } = fakeApi(() => ({
      url: AMAZON_URL,
      mode: 'amazon_associates',
      disclosure: ASSOCIATES,
    }));
    const { openUrl, opened } = opener();
    const outcome = await openResourceLink(
      api,
      'parent',
      { id: ITEM, shownMode: 'plain_link' },
      'ios',
      null,
      openUrl,
    );
    expect(outcome).toEqual({ kind: 'changed', mode: 'amazon_associates' });
    expect(opened).toEqual([]);
  });

  it('fails safely for unavailable products', async () => {
    const { api } = fakeApi(() => new ApiRequestError('NOT_FOUND', 'gone', 404));
    const { openUrl, opened } = opener();
    expect(
      await openResourceLink(
        api,
        'parent',
        { id: ITEM, shownMode: 'plain_link' },
        'ios',
        null,
        openUrl,
      ),
    ).toEqual({ kind: 'error', message: 'This resource is no longer available.', needsPin: false });
    expect(opened).toEqual([]);
  });
});

describe('sponsor card actions (spec P16.1; AC_MON_05/16)', () => {
  it('opens the sponsor destination only through the click endpoint and system opener', async () => {
    const { api, calls } = fakeApi(() => ({ url: 'https://brightowl.example/reading' }));
    const { openUrl, opened } = opener();
    expect(await openSponsorLink(api, 'parent', card, openUrl)).toEqual({
      kind: 'opened',
      host: 'brightowl.example',
    });
    expect(calls).toEqual([
      { method: 'POST', path: `/v1/placements/${TOKEN}/click`, body: undefined },
    ]);
    expect(opened).toEqual(['https://brightowl.example/reading']);
  });

  it('treats a withdrawn offer as gone', async () => {
    const { api } = fakeApi(() => new ApiRequestError('NOT_FOUND', 'gone', 404));
    const { openUrl, opened } = opener();
    expect(await openSponsorLink(api, 'parent', card, openUrl)).toEqual({
      kind: 'gone',
      message: 'This sponsored card is no longer available.',
    });
    expect(opened).toEqual([]);
  });

  it('dismisses without navigating and never throws', async () => {
    const { api, calls } = fakeApi(() => new ApiRequestError('NETWORK', 'offline', 0));
    await expect(dismissSponsorCard(api, card)).resolves.toBeUndefined();
    expect(calls).toEqual([
      { method: 'POST', path: `/v1/placements/${TOKEN}/dismiss`, body: undefined },
    ]);
  });

  it('reports by category without navigating', async () => {
    const { api, calls } = fakeApi(() => null);
    expect(await reportSponsorCard(api, card, 'misleading')).toMatchObject({ ok: true });
    expect(calls).toEqual([
      { method: 'POST', path: `/v1/placements/${TOKEN}/report`, body: { category: 'misleading' } },
    ]);
  });

  it('sends the viewed measurement and swallows failures', async () => {
    const { api, calls } = fakeApi(() => new ApiRequestError('INTERNAL', 'x', 500));
    await expect(
      sendViewed(api, card, { visibleMs: 1000, visibleRatio: 0.5 }),
    ).resolves.toBeUndefined();
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/v1/placements/${TOKEN}/viewed`,
      body: { visibleMs: 1000, visibleRatio: 0.5 },
    });
  });
});
