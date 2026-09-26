import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { SponsorCard as SponsorCardDto } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import type { AuthAdapter } from '../lib/auth.ts';
import { SessionProvider } from '../lib/session.tsx';
import { renderPage } from '../test/render.tsx';
import { ActionFeedback, StepUpNotice } from './learning/feedback.tsx';
import { SponsorCard } from './SponsorCard.tsx';
import RewardsPage from '../pages/app/RewardsPage.tsx';

/**
 * WEB-R2-05 re-fix. The first attempt shared the inline PIN prompt through SecurityPage's
 * StepUpNotice and HomeworkPage's copy, but three more copies of the link-only notice survived:
 *
 *   1. components/learning/feedback.tsx — the whole learning planner (ScheduleSection,
 *      SubjectsSection, PracticeSetsSection, StudyMaterialSection, TestDatesSection) answers
 *      STEP_UP_REQUIRED through it, so a half-filled schedule or test date was still lost.
 *   2. pages/app/RewardsPage.tsx — its own private ActionFeedback, so the rewards forms were not
 *      covered even though the first attempt's report claimed they were.
 *   3. components/SponsorCard.tsx — the "report this ad" flow, which loses the chosen category.
 *
 * Each pointed at /app/security with no return path, so the Security page could not offer the way
 * back either. The link stays with the same name and href (ChildrenPage.test.tsx and
 * LearningPlannerPage.test.tsx, other areas' files, pin both) but now carries the return path as
 * router state, and the PIN can be typed in place.
 *
 * Pinned clock (L-027): every timestamp here is derived from NOW. Synthetic names and PINs only.
 */

afterEach(cleanup);

const NOW = new Date('2026-09-25T18:00:00.000Z');
const AT = NOW.toISOString();
const UNLOCKED_UNTIL = new Date(NOW.getTime() + 5 * 60_000).toISOString();
const stepUp = () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403);

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const REWARD = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';

const signedIn: AuthAdapter = {
  configured: true,
  currentSession: () =>
    Promise.resolve({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' }),
  signOut: () => Promise.resolve(),
};

/** Renders `element` at `path` inside a real router so the link's history state can be read. */
function renderAt(element: React.ReactElement, path: string, api: Partial<ApiClient>) {
  const router = createMemoryRouter(
    [
      { path, element },
      { path: '/app/security', element: <h1>Security</h1> },
    ],
    { initialEntries: [path] },
  );
  const view = render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth: signedIn,
        api: {
          get: () => Promise.reject(new Error('unexpected GET')),
          send: () => Promise.reject(new Error('unexpected send')),
          ...api,
        },
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return { ...view, router };
}

describe('WEB-R2-05 the learning planner answers a step-up in place', () => {
  it('StepUpNotice asks for the PIN where the parent is and unlocks without navigating', async () => {
    const send = vi.fn(() => Promise.resolve({ unlockedUntil: UNLOCKED_UNTIL }));
    const { router } = renderAt(
      <StepUpNotice what="Saving the study schedule" />,
      '/app/learning',
      { send: send as unknown as ApiClient['send'] },
    );
    // The wording other areas' tests pin is kept.
    expect(
      await screen.findByText(/Saving the study schedule needs a recent PIN unlock/),
    ).toBeTruthy();
    await userEvent.type(await screen.findByLabelText('Parent PIN'), '284917');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(send).toHaveBeenCalledWith(
      'POST',
      '/v1/adult/unlock',
      { method: 'pin', pin: '284917' },
      expect.anything(),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/app/learning');
  });

  it('keeps the Security-page link and carries the way back as router state', async () => {
    const { router } = renderAt(<StepUpNotice what="Adding a test date" />, '/app/learning', {});
    const link = await screen.findByRole('link', { name: 'Unlock on the Security page' });
    expect(link.getAttribute('href')).toBe('/app/security');
    await userEvent.click(link);
    expect(router.state.location.pathname).toBe('/app/security');
    expect(router.state.location.state).toEqual({ stepUpNext: '/app/learning' });
  });

  it("ActionFeedback's step-up branch offers the same inline prompt", async () => {
    renderAt(
      <ActionFeedback feedback={{ kind: 'error', error: stepUp() }} stepUpWhat="Exporting a PDF" />,
      '/app/learning',
      {},
    );
    expect(await screen.findByLabelText('Parent PIN')).toBeTruthy();
    expect(screen.getByText(/Exporting a PDF needs a recent PIN unlock/)).toBeTruthy();
  });

  it('renders no form of its own, so it is safe inside the planner and rewards forms', async () => {
    // The planner sections and the rewards page render the notice inside their own <form>; a
    // nested form is invalid HTML and its submit event bubbles into the outer form.
    const { container } = renderAt(
      <StepUpNotice what="Saving the study schedule" />,
      '/app/learning',
      {},
    );
    await screen.findByLabelText('Parent PIN');
    expect(container.querySelectorAll('form')).toHaveLength(0);
  });
});

describe('WEB-R2-05 the rewards page answers a step-up in place', () => {
  const rewardsOverview = {
    rewards: [
      {
        id: REWARD,
        title: 'Trip to the library',
        pointCost: 10,
        instructions: 'Saturday morning',
        childId: null,
        active: true,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    children: [{ childId: RILEY, nickname: 'Riley', balance: 12, status: 'active' as const }],
    openRequests: [],
    recentRequests: [],
  };

  /** The family earning rules the page also loads; suggested values, not under test here. */
  const suggested = {
    attemptPoints: 2,
    independentCorrectBonus: 3,
    setCompletionPoints: 5,
    minMeaningfulResponseMs: 1500,
  };
  const rewardRules = { rules: suggested, suggested, updatedAt: null };

  it('asks for the PIN inside the add-reward form and keeps what was typed', async () => {
    const sent: string[] = [];
    const send = ((_method: string, path: string) => {
      sent.push(path);
      if (path === '/v1/adult/unlock') return Promise.resolve({ unlockedUntil: UNLOCKED_UNTIL });
      return Promise.reject(stepUp());
    }) as unknown as ApiClient['send'];
    renderPage(<RewardsPage />, {
      api: {
        get: (path: string) => {
          if (path === '/v1/rewards') return Promise.resolve(rewardsOverview);
          if (path === '/v1/reward-rules') return Promise.resolve(rewardRules);
          return Promise.reject(new ApiRequestError('NOT_FOUND', 'not used here', 404));
        },
        send,
      } as unknown as Partial<ApiClient>,
      path: '/app/rewards',
    });
    const form = await screen.findByRole('form', { name: 'Add a reward' });
    await userEvent.type(within(form).getByLabelText('Reward name'), 'Pick the movie');
    await userEvent.type(within(form).getByLabelText('Points needed'), '20');
    await userEvent.click(within(form).getByRole('button', { name: 'Add reward' }));

    // The PIN is asked for inside the form, with the fallback link still offered beside it.
    const pin = await within(form).findByLabelText('Parent PIN');
    expect(
      within(form)
        .getByRole('link', { name: /unlock on the security page/i })
        .getAttribute('href'),
    ).toBe('/app/security');

    // Unlocking happens in place, and the typed reward survives it.
    await userEvent.type(pin, '284917');
    await userEvent.click(within(form).getByRole('button', { name: 'Unlock' }));
    expect(sent).toContain('/v1/adult/unlock');
    expect(await within(form).findByRole('status')).toBeTruthy();
    expect(within(form).getByLabelText('Reward name')).toHaveProperty('value', 'Pick the movie');
  });
});

describe('WEB-R2-05 the sponsored-card report answers a step-up in place', () => {
  const card: SponsorCardDto = {
    serveToken: 'synthetic-serve-token',
    placement: 'resources_browse',
    label: 'Sponsored by Example Reading Club',
    headline: 'Reading club',
    body: 'A local library programme.',
    ctaLabel: 'Visit sponsor',
    destinationHost: 'sponsor.example.invalid',
    imageAssetRef: null,
    whyShown: 'Chosen for your area.',
  };

  it('offers the inline PIN prompt instead of only a Security-page link', async () => {
    const send = ((_method: string, path: string) =>
      path === '/v1/adult/unlock'
        ? Promise.resolve({ unlockedUntil: UNLOCKED_UNTIL })
        : Promise.reject(stepUp())) as unknown as ApiClient['send'];
    renderAt(<SponsorCard card={card} onClosed={() => undefined} />, '/app/resources', { send });
    await userEvent.click(await screen.findByRole('button', { name: 'Report this ad' }));
    await userEvent.click(screen.getAllByRole('radio')[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    // The chosen category is still selected while the PIN is entered in place.
    expect(await screen.findByLabelText('Parent PIN')).toBeTruthy();
    expect(screen.getAllByRole('radio')[0]!).toHaveProperty('checked', true);
  });
});
