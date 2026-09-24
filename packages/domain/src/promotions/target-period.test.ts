import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BILLING_CUTOFF_LEAD_MS,
  isSameTargetPeriod,
  selectTargetPeriod,
  subscriberClassOf,
  targetPeriodKey,
  type PromoSubscriptionSnapshot,
} from './target-period.ts';
import { iso } from './test-fixtures.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function subscription(
  overrides: Partial<PromoSubscriptionSnapshot> = {},
): PromoSubscriptionSnapshot {
  return {
    status: 'active',
    channel: 'app_store',
    currentPeriodStart: iso('2026-09-15T00:00:00Z'),
    currentPeriodEnd: iso('2026-10-15T00:00:00Z'),
    finalizedPeriodStarts: [],
    ...overrides,
  };
}

function errorOf(result: ReturnType<typeof selectTargetPeriod>): string | null {
  return result.ok ? null : result.error.code;
}

describe('P17 target billing period (AC_PROMO_02)', () => {
  it('a family with no subscription is a new subscriber redeeming for its first full period', () => {
    expect(selectTargetPeriod({ subscription: null, now: iso('2026-10-03T12:00:00Z') })).toEqual({
      ok: true,
      value: { kind: 'first_full_period', lapsedPeriodEnd: null },
    });
    expect(subscriberClassOf(null)).toBe('new');
  });

  it('an expired subscription is a lapsed subscriber redeeming for the first full period of a new subscription', () => {
    const lapsed = subscription({ status: 'expired' });
    expect(selectTargetPeriod({ subscription: lapsed, now: iso('2026-12-01T00:00:00Z') })).toEqual({
      ok: true,
      value: { kind: 'first_full_period', lapsedPeriodEnd: iso('2026-10-15T00:00:00Z') },
    });
    expect(subscriberClassOf(lapsed)).toBe('lapsed');
  });

  it('an existing subscriber targets the NEXT provider period, starting exactly at the current period end', () => {
    const result = selectTargetPeriod({
      subscription: subscription(),
      now: iso('2026-10-03T12:00:00Z'),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'renewal_period',
        periodStart: iso('2026-10-15T00:00:00Z'),
        periodEnd: null,
        isProjection: true,
      },
    });
    expect(subscriberClassOf(subscription())).toBe('existing');
  });

  it('uses provider month-end/February boundaries, never +30 days (Jan 31 -> Feb 28 -> Mar 31)', () => {
    const january = subscription({
      currentPeriodStart: iso('2027-01-31T15:00:00Z'),
      currentPeriodEnd: iso('2027-02-28T15:00:00Z'),
      nextPeriodEnd: iso('2027-03-31T15:00:00Z'),
    });
    const result = selectTargetPeriod({ subscription: january, now: iso('2027-02-10T00:00:00Z') });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'renewal_period',
        periodStart: iso('2027-02-28T15:00:00Z'),
        periodEnd: iso('2027-03-31T15:00:00Z'),
        isProjection: true,
      },
    });
    // Not the naive 30-day projection (2027-03-02).
    if (result.ok && result.value.kind === 'renewal_period') {
      expect(result.value.periodStart.getTime()).not.toBe(
        iso('2027-01-31T15:00:00Z').getTime() + 30 * DAY,
      );
    }
    const february = subscription({
      currentPeriodStart: iso('2027-02-28T15:00:00Z'),
      currentPeriodEnd: iso('2027-03-31T15:00:00Z'),
    });
    const march = selectTargetPeriod({ subscription: february, now: iso('2027-03-05T00:00:00Z') });
    expect(march.ok && march.value.kind === 'renewal_period' && march.value.periodStart).toEqual(
      iso('2027-03-31T15:00:00Z'),
    );
  });

  it('closes redemption for the next period at the billing cutoff (default 24h before renewal)', () => {
    const periodStart = iso('2026-10-15T00:00:00Z').getTime();
    expect(DEFAULT_BILLING_CUTOFF_LEAD_MS).toBe(DAY);
    const justBefore = new Date(periodStart - DAY - 1);
    const atCutoff = new Date(periodStart - DAY);
    expect(
      errorOf(selectTargetPeriod({ subscription: subscription(), now: justBefore })),
    ).toBeNull();
    expect(errorOf(selectTargetPeriod({ subscription: subscription(), now: atCutoff }))).toBe(
      'NEXT_PERIOD_ALREADY_FINALIZED',
    );
    expect(
      errorOf(
        selectTargetPeriod({
          subscription: subscription(),
          now: new Date(periodStart - 3 * HOUR),
          billingCutoffLeadMs: 2 * HOUR,
        }),
      ),
    ).toBeNull();
  });

  it('never retroactively discounts: a stale snapshot past the renewal cannot target that period', () => {
    expect(
      errorOf(
        selectTargetPeriod({ subscription: subscription(), now: iso('2026-10-16T00:00:00Z') }),
      ),
    ).toBe('NEXT_PERIOD_ALREADY_FINALIZED');
  });

  it('a period the provider already finalized cannot be targeted even before the cutoff', () => {
    const finalized = subscription({ finalizedPeriodStarts: [iso('2026-10-15T00:00:00Z')] });
    expect(
      errorOf(selectTargetPeriod({ subscription: finalized, now: iso('2026-10-01T00:00:00Z') })),
    ).toBe('NEXT_PERIOD_ALREADY_FINALIZED');
  });

  it('billing retry and grace period are not in good standing', () => {
    for (const status of ['billing_retry', 'grace_period'] as const) {
      expect(
        errorOf(
          selectTargetPeriod({
            subscription: subscription({ status }),
            now: iso('2026-10-01T00:00:00Z'),
          }),
        ),
      ).toBe('SUBSCRIPTION_NOT_IN_GOOD_STANDING');
    }
    expect(
      errorOf(
        selectTargetPeriod({
          subscription: subscription({ status: 'refunded' as 'active' }),
          now: iso('2026-10-01T00:00:00Z'),
        }),
      ),
    ).toBe('SUBSCRIPTION_NOT_IN_GOOD_STANDING');
  });

  it('a cancelled-but-active subscription is still an existing subscriber targeting only its next period', () => {
    const result = selectTargetPeriod({
      subscription: subscription({ status: 'cancelled_active' }),
      now: iso('2026-10-01T00:00:00Z'),
    });
    expect(result.ok && result.value.kind).toBe('renewal_period');
  });

  it('only ever targets the single next period, and only while it is still open (property)', () => {
    const start = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2030, 0, 1) });
    fc.assert(
      fc.property(
        start,
        fc.integer({ min: 28 * DAY, max: 31 * DAY }),
        fc.integer({ min: -40 * DAY, max: 40 * DAY }),
        fc.integer({ min: 0, max: 3 * DAY }),
        (periodStartMs, length, offset, lead) => {
          const sub = subscription({
            currentPeriodStart: new Date(periodStartMs),
            currentPeriodEnd: new Date(periodStartMs + length),
          });
          const now = new Date(periodStartMs + offset);
          const result = selectTargetPeriod({ subscription: sub, now, billingCutoffLeadMs: lead });
          const open = now.getTime() < periodStartMs + length - lead;
          expect(result.ok).toBe(open);
          if (result.ok && result.value.kind === 'renewal_period') {
            expect(result.value.periodStart.getTime()).toBe(periodStartMs + length);
            expect(result.value.periodStart.getTime()).toBeGreaterThan(now.getTime());
          }
        },
      ),
    );
  });

  it('rejects malformed provider periods as a programmer error', () => {
    expect(() =>
      selectTargetPeriod({
        subscription: subscription({ currentPeriodEnd: iso('2026-09-01T00:00:00Z') }),
        now: iso('2026-09-20T00:00:00Z'),
      }),
    ).toThrow(RangeError);
    expect(() => selectTargetPeriod({ subscription: null, now: new Date(Number.NaN) })).toThrow(
      RangeError,
    );
    expect(() =>
      selectTargetPeriod({
        subscription: null,
        now: iso('2026-09-20T00:00:00Z'),
        billingCutoffLeadMs: -1,
      }),
    ).toThrow(RangeError);
  });
});

describe('P17 target period keys', () => {
  it('keys a renewal by the provider period start and a first period by channel', () => {
    expect(
      targetPeriodKey(
        {
          kind: 'renewal_period',
          periodStart: iso('2026-10-15T00:00:00Z'),
          periodEnd: null,
          isProjection: true,
        },
        'app_store',
      ),
    ).toBe('2026-10-15T00:00:00.000Z');
    expect(targetPeriodKey({ kind: 'first_full_period', lapsedPeriodEnd: null }, 'stripe')).toBe(
      'first:stripe',
    );
  });

  it('keys a lapsed subscriber first period by the lapse, so a later return is a new period', () => {
    const key = targetPeriodKey(
      { kind: 'first_full_period', lapsedPeriodEnd: iso('2026-10-15T00:00:00Z') },
      'play_store',
    );
    expect(key).toBe('first:play_store:2026-10-15T00:00:00.000Z');
    expect(key.length).toBeLessThanOrEqual(80);
    expect(isSameTargetPeriod(key, 'first:play_store')).toBe(false);
  });

  it('treats first-period keys on different channels as the same period (no cross-channel double discount)', () => {
    expect(isSameTargetPeriod('first:app_store', 'first:stripe')).toBe(true);
    expect(
      isSameTargetPeriod(
        'first:app_store:2026-10-15T00:00:00.000Z',
        'first:stripe:2026-10-15T00:00:00.000Z',
      ),
    ).toBe(true);
    expect(isSameTargetPeriod('2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')).toBe(true);
    expect(isSameTargetPeriod('2026-10-15T00:00:00.000Z', '2026-11-15T00:00:00.000Z')).toBe(false);
    expect(isSameTargetPeriod('first:app_store', '2026-10-15T00:00:00.000Z')).toBe(false);
  });
});
