import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type {
  MonetizationPreferences,
  OutboundUrlResponse,
  PlacementResponse,
  ResourceItem,
  ResourcesResponse,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import ResourcesPage from './ResourcesPage.tsx';

// Synthetic catalog and sponsor data only. Business names and products are invented.
const WORKBOOK = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const FLASHCARDS = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const EXERCISE = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const ASSOCIATES = 'As an Amazon Associate I earn from qualifying purchases.';
const AMAZON_URL = 'https://www.amazon.com/dp/B000000001?tag=pencillift-20';

function item(overrides: Partial<ResourceItem> = {}): ResourceItem {
  return {
    id: WORKBOOK,
    title: 'Fraction practice workbook',
    description: 'Short daily pages that compare fractions with pictures and number lines.',
    kind: 'workbook',
    subjects: ['math'],
    skills: ['math.fractions.compare'],
    gradeMin: 3,
    gradeMax: 5,
    relevance: 11,
    mode: 'amazon_associates',
    merchant: 'amazon',
    disclosure: ASSOCIATES,
    price: null,
    priceNote: 'Check current price on Amazon.',
    availability: 'available',
    imageAssetRef: null,
    ...overrides,
  };
}

function resources(overrides: Partial<ResourcesResponse> = {}): ResourcesResponse {
  return {
    mode: 'amazon_associates',
    commercialHidden: false,
    items: [
      item(),
      item({
        id: FLASHCARDS,
        title: 'Multiplication flashcards',
        description: 'A deck of cards for quick multiplication facts practice at home.',
        kind: 'flashcards',
        skills: ['math.multiplication.facts'],
        mode: 'plain_link',
        disclosure: 'External link',
        relevance: 3,
      }),
      item({
        id: EXERCISE,
        title: 'Kitchen fraction hunt',
        description: 'Cut fruit into halves and quarters together and compare the pieces.',
        kind: 'parent_exercise',
        skills: ['math.fractions.compare'],
        mode: 'education_only',
        merchant: 'none',
        disclosure: null,
        priceNote: null,
        relevance: 2,
      }),
    ],
    ...overrides,
  };
}

const card = {
  serveToken: TOKEN,
  placement: 'resources_browse' as const,
  label: 'Sponsored by Bright Owl Tutoring',
  headline: 'Weekly reading coaching',
  body: 'Small-group reading sessions with certified teachers.',
  ctaLabel: 'Learn more',
  destinationHost: 'brightowl.example',
  imageAssetRef: null,
  whyShown: 'Shown in the parent resource directory.',
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (path: string) => unknown;

/** Fake API that validates fixtures and responses through the real contract schemas. */
function fakeApi(
  options: {
    resources?: Handler;
    prefs?: MonetizationPreferences | Error;
    placement?: PlacementResponse | Error;
    outbound?: Handler;
    send?: (call: Call) => unknown;
  } = {},
) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const route = (path: string): unknown => {
    if (path.startsWith('/v1/resources?')) return (options.resources ?? (() => resources()))(path);
    if (path === '/v1/monetization/preferences') {
      return options.prefs ?? { hideAffiliate: false, hideSponsorCards: false };
    }
    if (path.startsWith('/v1/placements?')) {
      return options.placement ?? { card, reason: 'served' };
    }
    if (path.startsWith('/v1/resources/') && path.includes('/outbound?')) {
      return (options.outbound ?? (() => outbound()))(path);
    }
    return new Error(`unexpected GET ${path}`);
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      try {
        const value = route(path);
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      const call = { method, path, body };
      sends.push(call);
      try {
        const value = options.send
          ? options.send(call)
          : path.endsWith('/viewed')
            ? { counted: true, reason: null }
            : path.endsWith('/click')
              ? { url: 'https://brightowl.example/reading' }
              : path === '/v1/monetization/preferences'
                ? body
                : null;
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { api, gets, sends };
}

function outbound(overrides: Partial<OutboundUrlResponse> = {}): OutboundUrlResponse {
  return { url: AMAZON_URL, mode: 'amazon_associates', disclosure: ASSOCIATES, ...overrides };
}

/** Minimal IntersectionObserver double: tests decide what fraction of the card is on screen. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
  static show(ratio: number) {
    for (const observer of FakeIntersectionObserver.instances) {
      if (observer.disconnected) continue;
      observer.callback(
        observer.targets.map(
          (target) =>
            ({
              target,
              isIntersecting: ratio > 0,
              intersectionRatio: ratio,
            }) as unknown as IntersectionObserverEntry,
        ),
        observer as unknown as IntersectionObserver,
      );
    }
  }
}

let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
});

// Vitest globals are off, so Testing Library cannot register its automatic cleanup.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stepUp = () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403);

/** Synchronous work inside act: React flushes the resulting updates before act returns. */
function actSync(work: () => void): void {
  void act(work);
}

function describedText(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

async function resourceCard(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title, level: 3 });
  return heading.closest('li')!;
}

describe('ResourcesPage (spec P10, P16.1, P16.3; AC_MON_03/05/08/11/12)', () => {
  it('lists own descriptions and kinds, discloses each link beside it, and never shows a price', async () => {
    const { api } = fakeApi();
    renderPage(<ResourcesPage />, { api });
    const workbook = await resourceCard('Fraction practice workbook');
    expect(within(workbook).getByText(/Short daily pages that compare fractions/)).toBeTruthy();
    expect(within(workbook).getByText(/Workbook · Grades 3–5 · Math/)).toBeTruthy();
    expect(within(workbook).getByText('Check current price on Amazon.')).toBeTruthy();
    const link = within(workbook).getByRole('button', { name: /View on Amazon/ });
    // The disclosure is visible right beside the link and is its accessible description.
    expect(within(workbook).getByText(ASSOCIATES)).toBeTruthy();
    expect(describedText(link)).toContain(ASSOCIATES);
    expect(describedText(link)).toContain('Opens in a new tab.');
    expect(link.parentElement).toBe(within(workbook).getByText(ASSOCIATES).parentElement);

    const flashcards = await resourceCard('Multiplication flashcards');
    const plain = within(flashcards).getByRole('button', { name: /View on Amazon/ });
    expect(describedText(plain)).toContain('External link');
    expect(within(flashcards).queryByText(ASSOCIATES)).toBeNull();

    const exercise = await resourceCard('Kitchen fraction hunt');
    expect(within(exercise).getByText(/Parent-led exercise \(free\)/)).toBeTruthy();
    expect(within(exercise).getByText(/Free: no purchase needed/)).toBeTruthy();
    expect(within(exercise).queryByRole('button')).toBeNull();

    // No price, currency amount or merchant URL is ever rendered in the list.
    const list = screen.getByRole('heading', { name: 'Resources' }).closest('section')!;
    expect(list.textContent).not.toMatch(/\$\s?\d/);
    expect(list.querySelector('a[href*="amazon"]')).toBeNull();
    expect(screen.getByText(/Commission never changes the order/)).toBeTruthy();
  });

  it('keeps disclosures wrapping (no truncation) so they stay visible at 200% zoom', async () => {
    const { api } = fakeApi();
    renderPage(<ResourcesPage />, { api });
    const workbook = await resourceCard('Fraction practice workbook');
    const disclosure = within(workbook).getByTestId('disclosure');
    expect(disclosure.style.whiteSpace).toBe('normal');
    expect(disclosure.style.textOverflow).toBe('');
    expect(disclosure.style.overflow).toBe('');
    expect(disclosure.getAttribute('aria-hidden')).toBeNull();
    const row = within(workbook).getByTestId('link-row');
    expect(row.style.flexWrap).toBe('wrap');
    expect(row.style.overflow).toBe('');
  });

  it('opens a link only after a click, in a new context with no opener or referrer', async () => {
    const { api, gets } = fakeApi();
    renderPage(<ResourcesPage />, { api });
    const workbook = await resourceCard('Fraction practice workbook');
    expect(openSpy).not.toHaveBeenCalled();
    expect(gets.some((p) => p.includes('/outbound'))).toBe(false);

    await userEvent.click(within(workbook).getByRole('button', { name: /View on Amazon/ }));
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).toHaveBeenCalledWith(AMAZON_URL, '_blank', 'noopener,noreferrer');
    expect(gets).toContain(`/v1/resources/${WORKBOOK}/outbound?platform=web&locale=en-US`);

    const fallback = await within(workbook).findByRole('link', { name: /open www.amazon.com/ });
    expect(fallback.getAttribute('rel')).toBe('noopener noreferrer');
    expect(fallback.getAttribute('target')).toBe('_blank');
    expect(fallback.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(describedText(fallback)).toContain(ASSOCIATES);
  });

  it('does not open a link whose disclosure changed until the parent has seen the new one', async () => {
    const { api } = fakeApi({ outbound: () => outbound() });
    renderPage(<ResourcesPage />, { api });
    const flashcards = await resourceCard('Multiplication flashcards');
    await userEvent.click(within(flashcards).getByRole('button', { name: /View on Amazon/ }));
    expect(await within(flashcards).findByText(/This link changed/)).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
    const link = within(flashcards).getByRole('button', { name: /View on Amazon/ });
    expect(describedText(link)).toContain(ASSOCIATES);

    await userEvent.click(link);
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
  });

  it('explains unavailable and education-only links instead of failing silently', async () => {
    const { api } = fakeApi({
      outbound: () => new ApiRequestError('BUSINESS_RULE', 'No link', 422, 'LINKS_UNAVAILABLE'),
    });
    renderPage(<ResourcesPage />, { api });
    const workbook = await resourceCard('Fraction practice workbook');
    await userEvent.click(within(workbook).getByRole('button', { name: /View on Amazon/ }));
    expect(
      await within(workbook).findByText('This resource has no outside link here.'),
    ).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('shows items without links honestly when merchant links are off', async () => {
    const { api } = fakeApi({
      resources: () =>
        resources({
          mode: 'education_only',
          items: [item({ mode: 'education_only', disclosure: null, priceNote: null })],
        }),
    });
    renderPage(<ResourcesPage />, { api });
    const workbook = await resourceCard('Fraction practice workbook');
    expect(within(workbook).queryByRole('button')).toBeNull();
    expect(within(workbook).getByText(/No outside link is offered here/)).toBeTruthy();
    expect(within(workbook).queryByText(/Check current price/)).toBeNull();
    expect(within(workbook).queryByText(ASSOCIATES)).toBeNull();
  });

  it('sends the parent-selected subject, grade and focus skill', async () => {
    const { api, gets } = fakeApi();
    renderPage(<ResourcesPage />, { api });
    const form = await screen.findByRole('form', { name: 'Find resources' });
    await resourceCard('Fraction practice workbook');
    await userEvent.selectOptions(within(form).getByLabelText('Subject'), 'math');
    await userEvent.selectOptions(within(form).getByLabelText('Grade'), '3');
    await userEvent.selectOptions(
      within(form).getByLabelText(/Focus skill/),
      'math.fractions.compare',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Show resources' }));
    await waitFor(() =>
      expect(gets).toContain(
        '/v1/resources?platform=web&subject=math&grade=3&skill=math.fractions.compare&locale=en-US',
      ),
    );
    expect(gets[0]).toBe('/v1/resources?platform=web&locale=en-US');
  });

  it('asks for the parent PIN when the unlock has expired and requests no sponsor card', async () => {
    const { api, gets } = fakeApi({ resources: () => stepUp(), prefs: stepUp() });
    renderPage(<ResourcesPage />, { api });
    expect(await screen.findByText(/Enter your parent PIN to continue/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /unlock on the security page/i });
    expect(link.getAttribute('href')).toBe('/app/security');
    expect(screen.queryByText(/Sponsored by/)).toBeNull();
    expect(gets.some((p) => p.startsWith('/v1/placements'))).toBe(false);
  });

  it('shows loading, empty and error states', async () => {
    let fail = true;
    const { api } = fakeApi({
      resources: () =>
        fail
          ? new ApiRequestError('INTERNAL', 'Resources are unavailable', 500)
          : resources({ items: [] }),
    });
    renderPage(<ResourcesPage />, { api });
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByText('Resources are unavailable')).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    expect(await screen.findByRole('heading', { name: 'No resources match yet' })).toBeTruthy();
  });

  it('saves the hide-affiliate choice and reloads the list', async () => {
    const { api, gets, sends } = fakeApi();
    renderPage(<ResourcesPage />, { api });
    const form = await screen.findByRole('form', { name: 'Commercial content choices' });
    await userEvent.click(within(form).getByLabelText('Hide shopping and affiliate links'));
    await userEvent.click(within(form).getByRole('button', { name: 'Save choices' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'PUT',
      path: '/v1/monetization/preferences',
      body: { hideAffiliate: true, hideSponsorCards: false },
    });
    expect(await screen.findByText(/Your choices are saved/)).toBeTruthy();
    await waitFor(() => expect(gets.filter((p) => p.startsWith('/v1/resources?'))).toHaveLength(2));
  });

  it('never requests a sponsor card when the family hides them', async () => {
    const { api, gets } = fakeApi({ prefs: { hideAffiliate: false, hideSponsorCards: true } });
    renderPage(<ResourcesPage />, { api });
    await resourceCard('Fraction practice workbook');
    await screen.findByRole('form', { name: 'Commercial content choices' });
    expect(gets.some((p) => p.startsWith('/v1/placements'))).toBe(false);
    expect(screen.queryByText(/Sponsored by/)).toBeNull();
  });

  it('shows the hidden-links notice when the server hid commercial items', async () => {
    const { api } = fakeApi({
      resources: () => resources({ commercialHidden: true, items: [resources().items[2]!] }),
      prefs: { hideAffiliate: true, hideSponsorCards: false },
    });
    renderPage(<ResourcesPage />, { api });
    expect(await screen.findByText(/Shopping links are hidden by your choice/)).toBeTruthy();
  });
});

describe('Sponsor card on the resources screen (spec P16.1, P16.5; AC_MON_05/16)', () => {
  it('shows one labelled card apart from the educational list, with why it is shown', async () => {
    const { api, gets } = fakeApi();
    renderPage(<ResourcesPage />, { api });
    const aside = await screen.findByRole('complementary', {
      name: 'Sponsored by Bright Owl Tutoring',
    });
    expect(within(aside).getByText('Shown in the parent resource directory.')).toBeTruthy();
    expect(within(aside).getByText('Weekly reading coaching')).toBeTruthy();
    expect(within(aside).getByText(/Opens brightowl.example in a new tab/)).toBeTruthy();
    // Separate from the educational content: not inside the resource list section.
    const list = screen.getByRole('heading', { name: 'Resources' }).closest('section')!;
    expect(list.contains(aside)).toBe(false);
    expect(screen.getAllByText(/^Sponsored by/)).toHaveLength(1);
    expect(gets.filter((p) => p.startsWith('/v1/placements'))).toEqual([
      '/v1/placements?placement=resources_browse&platform=web&locale=en-US',
    ]);
  });

  it('renders creative text as plain text, never as HTML', async () => {
    const { api } = fakeApi({
      placement: {
        card: { ...card, body: '<img src="https://tracker.example/p.gif"> Reading help' },
        reason: 'served',
      },
    });
    renderPage(<ResourcesPage />, { api });
    const aside = await screen.findByRole('complementary', { name: /Sponsored by/ });
    expect(within(aside).getByText(/<img src=/)).toBeTruthy();
    expect(aside.querySelector('img')).toBeNull();
    expect(aside.querySelector('a')).toBeNull();
  });

  it('does not refresh or replace the card over time, even after dismissal', async () => {
    const { api, gets, sends } = fakeApi();
    renderPage(<ResourcesPage />, { api });
    const aside = await screen.findByRole('complementary', { name: /Sponsored by/ });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await userEvent.click(within(aside).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('complementary', { name: /Sponsored by/ })).toBeNull();
    expect(await screen.findByText('Sponsored card dismissed.')).toBeTruthy();
    expect(sends).toEqual([
      { method: 'POST', path: `/v1/placements/${TOKEN}/dismiss`, body: undefined },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gets.filter((p) => p.startsWith('/v1/placements'))).toHaveLength(1);
    // Dismissing never navigates to the advertiser.
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('reports a card by category without navigating, then hides it', async () => {
    const { api, sends } = fakeApi();
    renderPage(<ResourcesPage />, { api });
    const aside = await screen.findByRole('complementary', { name: /Sponsored by/ });
    await userEvent.click(within(aside).getByRole('button', { name: 'Report this ad' }));
    await userEvent.click(within(aside).getByRole('button', { name: 'Send report' }));
    expect(await within(aside).findByText('Choose what is wrong with this card.')).toBeTruthy();
    expect(sends).toHaveLength(0);
    await userEvent.click(within(aside).getByLabelText('Misleading'));
    await userEvent.click(within(aside).getByRole('button', { name: 'Send report' }));
    await waitFor(() =>
      expect(sends).toEqual([
        {
          method: 'POST',
          path: `/v1/placements/${TOKEN}/report`,
          body: { category: 'misleading' },
        },
      ]),
    );
    expect(await screen.findByText(/reported and hidden/)).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: /Sponsored by/ })).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens the sponsor only after the adult taps the call to action', async () => {
    const { api, sends } = fakeApi();
    renderPage(<ResourcesPage />, { api });
    const aside = await screen.findByRole('complementary', { name: /Sponsored by/ });
    expect(openSpy).not.toHaveBeenCalled();
    const cta = within(aside).getByRole('button', { name: 'Learn more' });
    expect(describedText(cta)).toContain('Sponsored by Bright Owl Tutoring');
    await userEvent.click(cta);
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).toHaveBeenCalledWith(
      'https://brightowl.example/reading',
      '_blank',
      'noopener,noreferrer',
    );
    expect(sends.map((c) => c.path)).toEqual([`/v1/placements/${TOKEN}/click`]);
  });

  it('removes a withdrawn card when the offer is no longer available', async () => {
    const { api } = fakeApi({
      send: () => new ApiRequestError('NOT_FOUND', 'This offer is no longer available', 404),
    });
    renderPage(<ResourcesPage />, { api });
    const aside = await screen.findByRole('complementary', { name: /Sponsored by/ });
    await userEvent.click(within(aside).getByRole('button', { name: 'Learn more' }));
    expect(await screen.findByText('This sponsored card is no longer available.')).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('renders nothing when no card is served', async () => {
    const { api } = fakeApi({ placement: { card: null, reason: 'session_cap' } });
    renderPage(<ResourcesPage />, { api });
    await resourceCard('Fraction practice workbook');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/Sponsored/)).toBeNull();
  });
});

describe('Sponsor card viewability beacon (spec P16.5; AC_MON_16)', () => {
  async function renderWithCard(visibility: DocumentVisibilityState = 'visible') {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility);
    const fake = fakeApi();
    renderPage(<ResourcesPage />, { api: fake.api });
    await screen.findByRole('complementary', { name: /Sponsored by/ });
    // The card is in the DOM before React runs the effect that starts observing it; a real
    // IntersectionObserver reports the current state on observe(), but this double only reports on
    // show(). Wait until the card is observed, or a show() under load reaches no observer (BUG-083).
    if (globalThis.IntersectionObserver === (FakeIntersectionObserver as unknown)) {
      await waitFor(() =>
        expect(
          FakeIntersectionObserver.instances.some((o) => !o.disconnected && o.targets.length > 0),
        ).toBe(true),
      );
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    return fake;
  }

  const viewed = (sends: Call[]) => sends.filter((c) => c.path.endsWith('/viewed'));

  it('reports viewed once, only after 50% visibility for 1000 ms', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { sends } = await renderWithCard();
    actSync(() => FakeIntersectionObserver.show(0.6));
    actSync(() => vi.advanceTimersByTime(999));
    expect(viewed(sends)).toHaveLength(0);
    actSync(() => vi.advanceTimersByTime(1));
    expect(viewed(sends)).toHaveLength(1);
    const body = viewed(sends)[0]!.body as { visibleMs: number; visibleRatio: number };
    expect(body.visibleMs).toBeGreaterThanOrEqual(1000);
    expect(body.visibleRatio).toBe(0.6);
    // Scrolling away and back does not report again.
    actSync(() => FakeIntersectionObserver.show(0));
    actSync(() => FakeIntersectionObserver.show(1));
    actSync(() => vi.advanceTimersByTime(5000));
    expect(viewed(sends)).toHaveLength(1);
  });

  it('does not report a card that leaves the viewport or is less than half visible', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { sends } = await renderWithCard();
    actSync(() => FakeIntersectionObserver.show(0.4));
    actSync(() => vi.advanceTimersByTime(5000));
    actSync(() => FakeIntersectionObserver.show(0.8));
    actSync(() => vi.advanceTimersByTime(600));
    actSync(() => FakeIntersectionObserver.show(0.2));
    actSync(() => vi.advanceTimersByTime(5000));
    expect(viewed(sends)).toHaveLength(0);
  });

  it('never reports while the document is hidden', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { sends } = await renderWithCard('hidden');
    actSync(() => FakeIntersectionObserver.show(1));
    actSync(() => vi.advanceTimersByTime(10_000));
    expect(viewed(sends)).toHaveLength(0);
  });

  it('never reports viewed when IntersectionObserver is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { sends } = await renderWithCard();
    actSync(() => vi.advanceTimersByTime(10_000));
    expect(viewed(sends)).toHaveLength(0);
  });
});
