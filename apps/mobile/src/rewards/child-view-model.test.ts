import { describe, expect, it } from 'vitest';
import type { ChildRewards } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  buildChildRewardsView,
  CHILD_COPY_FORBIDDEN,
  childRewardsErrorMessage,
} from './child-view-model.ts';

const AT = '2026-09-20T15:00:00.000Z';

function data(overrides: Partial<ChildRewards> = {}): ChildRewards {
  return {
    balance: 12,
    rewards: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Trip to the library',
        pointCost: 10,
        instructions: 'Saturday morning',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Pick the movie',
        pointCost: 20,
        instructions: null,
      },
    ],
    requests: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        rewardId: '11111111-1111-4111-8111-111111111111',
        rewardTitle: 'Trip to the library',
        pointCost: 10,
        state: 'pending',
        requestedAt: AT,
        decidedAt: null,
        fulfilledAt: null,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        rewardId: '55555555-5555-4555-8555-555555555555',
        rewardTitle: null,
        pointCost: 5,
        state: 'declined',
        requestedAt: AT,
        decidedAt: AT,
        fulfilledAt: null,
      },
    ],
    earningRules: { pointsPerTry: 2, firstTryBonus: 3, setCompletionPoints: 5 },
    ...overrides,
  };
}

/** Every string the view model generates (titles/instructions are parent-written and excluded). */
function generatedCopy(view: ReturnType<typeof buildChildRewardsView>): string[] {
  return [
    view.balanceLabel,
    view.encouragement,
    view.earning.heading,
    ...view.earning.lines,
    view.earning.note,
    view.emptyRewardsMessage ?? '',
    view.emptyRequestsMessage ?? '',
    ...view.rewards.flatMap((r) => [r.costLabel, r.progressLabel, r.askLabel, r.askA11yLabel]),
    ...view.requests.flatMap((r) => [r.statusLabel, r.cancelLabel, r.cancelA11yLabel]),
  ];
}

describe('child rewards view model (spec P9, P14)', () => {
  it('shows the balance and which rewards the child can ask for now', () => {
    const view = buildChildRewardsView(data());
    expect(view.balanceLabel).toBe('You have 12 points');
    const [library, movie] = view.rewards;
    expect(library).toMatchObject({ canAsk: true, costLabel: '10 points' });
    expect(library!.progressLabel).toMatch(/enough points/i);
    expect(library!.progress).toBe(1);
    expect(movie).toMatchObject({ canAsk: false, progress: 0.6 });
    expect(movie!.progressLabel).toBe('8 more points to go');
    expect(movie!.askA11yLabel).toContain('Pick the movie');
  });

  it('labels every request state in words and only pending requests can be cancelled', () => {
    const view = buildChildRewardsView(data());
    expect(view.requests[0]).toMatchObject({ canCancel: true, title: 'Trip to the library' });
    expect(view.requests[0]!.statusLabel).toMatch(/waiting for a grown-up/i);
    expect(view.requests[1]).toMatchObject({ canCancel: false, title: 'A reward' });
    expect(view.requests[1]!.statusLabel).toMatch(/points are back/i);
    for (const state of ['approved', 'fulfilled', 'cancelled'] as const) {
      const one = buildChildRewardsView(data({ requests: [{ ...data().requests[0]!, state }] }))
        .requests[0]!;
      expect(one.statusLabel.length).toBeGreaterThan(5);
      expect(one.canCancel).toBe(false);
    }
  });

  it('uses encouraging copy with no cash, wallet or shopping language', () => {
    for (const balance of [0, 1, 12, 500]) {
      const view = buildChildRewardsView(data({ balance }));
      for (const text of generatedCopy(view)) {
        expect(text).not.toMatch(CHILD_COPY_FORBIDDEN);
      }
    }
    for (const earningRules of [
      { pointsPerTry: 0, firstTryBonus: 0, setCompletionPoints: 0 },
      { pointsPerTry: 1, firstTryBonus: 1, setCompletionPoints: 1 },
      { pointsPerTry: 100, firstTryBonus: 100, setCompletionPoints: 100 },
    ]) {
      for (const text of generatedCopy(buildChildRewardsView(data({ earningRules })))) {
        expect(text).not.toMatch(CHILD_COPY_FORBIDDEN);
      }
    }
    expect(buildChildRewardsView(data({ balance: 1 })).balanceLabel).toBe('You have 1 point');
    expect(buildChildRewardsView(data({ balance: 0 })).encouragement).toMatch(/practice/i);
    // Awards are capped per question and per set (P9): never promise points for every attempt.
    for (const balance of [0, 3]) {
      expect(buildChildRewardsView(data({ balance })).encouragement).not.toMatch(
        /\b(every|all|any|always)\b/i,
      );
    }
  });

  it('shows how points are earned from the family’s published rules (spec P9, AC_REWARDS_01)', () => {
    const { earning } = buildChildRewardsView(data());
    expect(earning.heading).toBe('How you earn points');
    expect(earning.lines).toEqual([
      'Give a practice question a real try: 2 points, even if it isn’t right yet.',
      'Get it right on your first try: 3 points extra.',
      'Finish a practice set: 5 points.',
    ]);
    // The caps and the anti-farming rule, in child words.
    expect(earning.note).toMatch(/each question earns points once/i);
    expect(earning.note).toMatch(/rushed or empty answers don’t earn points/i);
  });

  it('follows changed rules: singular for 1 point, rules worth 0 are left out', () => {
    const one = buildChildRewardsView(
      data({ earningRules: { pointsPerTry: 1, firstTryBonus: 0, setCompletionPoints: 7 } }),
    ).earning;
    expect(one.lines).toEqual([
      'Give a practice question a real try: 1 point, even if it isn’t right yet.',
      'Finish a practice set: 7 points.',
    ]);
    const none = buildChildRewardsView(
      data({ earningRules: { pointsPerTry: 0, firstTryBonus: 0, setCompletionPoints: 0 } }),
    ).earning;
    expect(none.lines).toEqual([
      'Practice doesn’t earn points right now. Ask a grown-up about it.',
    ]);
  });

  it('never promises points for every try and never states the answer-time threshold', () => {
    const { earning } = buildChildRewardsView(
      data({ earningRules: { pointsPerTry: 4, firstTryBonus: 6, setCompletionPoints: 9 } }),
    );
    for (const text of [...earning.lines, earning.note]) {
      expect(text).not.toMatch(/\b(every|all|any|always)\b/i);
      expect(text).not.toMatch(/\b(seconds?|ms|milliseconds?)\b/i);
    }
  });

  it('has honest empty states', () => {
    const view = buildChildRewardsView(data({ rewards: [], requests: [] }));
    expect(view.emptyRewardsMessage).toMatch(/grown-up/i);
    expect(view.emptyRequestsMessage).toBeTruthy();
  });

  it('maps API errors to calm child messages without raw server text', () => {
    const cases: [ApiRequestError, RegExp][] = [
      [new ApiRequestError('UNAUTHENTICATED', 'raw', 401), /connect/i],
      [new ApiRequestError('NETWORK', 'raw', 0), /offline/i],
      [new ApiRequestError('BUSINESS_RULE', 'raw', 422, 'INSUFFICIENT_POINTS'), /few more points/i],
      [new ApiRequestError('BUSINESS_RULE', 'raw', 422, 'INVALID_TRANSITION'), /grown-up/i],
      [new ApiRequestError('NOT_FOUND', 'raw', 404), /isn’t available/i],
      [new ApiRequestError('RATE_LIMITED', 'raw', 429), /break/i],
      [new ApiRequestError('INTERNAL', 'raw', 500), /try again/i],
    ];
    for (const [error, expected] of cases) {
      const message = childRewardsErrorMessage(error);
      expect(message).toMatch(expected);
      expect(message).not.toContain('raw');
      expect(message).not.toMatch(CHILD_COPY_FORBIDDEN);
    }
    expect(childRewardsErrorMessage(new Error('boom'))).toMatch(/try again/i);
  });
});
