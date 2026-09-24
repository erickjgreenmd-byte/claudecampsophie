import { describe, expect, it } from 'vitest';
import type { FamilySchool, PromoQuote, PromoRedemption } from './types.ts';
import {
  buildQuoteView,
  buildSchoolView,
  channelForPlatform,
  chooseSchoolPrompt,
  CONTRIBUTION_LINES,
  historyRows,
  monthLabel,
  monthStartLabel,
  nextActionLine,
  ONE_SCHOOL_RULE,
  savedSchoolMessage,
  validateCodeEntry,
} from './view-model.ts';

// Synthetic data only. School names are invented.
const MAPLE = {
  id: '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c',
  name: 'Maple Grove Elementary',
  city: 'Springfield',
  region: 'IL',
};
const CEDAR = {
  id: '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  name: 'Cedar Park Middle',
  city: null,
  region: null,
};
const UTC = { timeZone: 'UTC' };

function school(overrides: Partial<FamilySchool> = {}): FamilySchool {
  return {
    current: MAPLE,
    pending: null,
    programTimezone: 'America/Chicago',
    contributionIsPencilLiftFunded: true,
    ...overrides,
  };
}

function quote(overrides: Partial<PromoQuote> = {}): PromoQuote {
  return {
    campaignMonth: '2026-10',
    percentOff: 50,
    channel: 'app_store',
    targetPeriod: {
      kind: 'renewal_period',
      periodStart: '2026-10-15T12:00:00.000Z',
      isProjection: true,
    },
    regularCents: 4998,
    discountCents: 2499,
    chargedCents: 2499,
    nextRegularRenewalCents: 4998,
    isPreview: true,
    ...overrides,
  };
}

function redemption(overrides: Partial<PromoRedemption> = {}): PromoRedemption {
  return {
    id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
    campaignMonth: '2026-10',
    channel: 'app_store',
    state: 'provider_pending',
    percentOff: 50,
    regularCents: 4998,
    discountCents: 2499,
    chargedCents: 2499,
    targetPeriodStart: '2026-10-15T12:00:00.000Z',
    createdAt: '2026-09-20T15:00:00.000Z',
    nextAction: { kind: 'await_provider' },
    ...overrides,
  };
}

describe('calendar labels', () => {
  it('labels months without timezone arithmetic', () => {
    expect(monthLabel('2026-02')).toBe('February 2026');
    expect(monthStartLabel('2026-10')).toBe('October 1, 2026');
    expect(monthLabel('garbage')).toBe('garbage');
  });
});

describe('school view (one school per family; change starts next month)', () => {
  it('describes the current school, the rule and the program timezone', () => {
    const view = buildSchoolView(school());
    expect(view.currentLine).toBe('Current school: Maple Grove Elementary (Springfield, IL)');
    expect(view.pendingLine).toBeNull();
    expect(view.keepCurrent).toBeNull();
    expect(ONE_SCHOOL_RULE).toMatch(/One school per family; a change starts next month/);
    expect(view.timezoneLine).toMatch(/America\/Chicago/);
  });

  it('shows a pending change with its start month and offers keeping the current school', () => {
    const view = buildSchoolView(
      school({ pending: { school: CEDAR, effectiveFromMonth: '2026-10' } }),
    );
    expect(view.pendingLine).toBe(
      'Changing to Cedar Park Middle from October 1, 2026. Maple Grove Elementary stays your school until then.',
    );
    expect(view.keepCurrent?.id).toBe(MAPLE.id);
  });

  it('says there is no contribution until a school is chosen', () => {
    expect(buildSchoolView(school({ current: null })).currentLine).toMatch(
      /No school chosen yet.*no school contribution/,
    );
  });

  it('explains when a new choice takes effect, and confirms what the server saved', () => {
    expect(chooseSchoolPrompt(school(), CEDAR)).toMatch(/starts on the first day of next month/);
    expect(chooseSchoolPrompt(school({ current: null }), CEDAR)).toMatch(/applies from this month/);
    expect(
      savedSchoolMessage(
        school({ pending: { school: CEDAR, effectiveFromMonth: '2026-10' } }),
        CEDAR,
      ),
    ).toBe('Saved. Cedar Park Middle becomes your school on October 1, 2026.');
    expect(savedSchoolMessage(school(), MAPLE)).toMatch(/Maple Grove Elementary stays your school/);
  });

  it('states the PencilLift-funded contribution rule, including $0 for any discounted month', () => {
    const text = CONTRIBUTION_LINES.join(' ');
    expect(text).toMatch(
      /PencilLift contributes \$1\/month for each month your family pays full price/,
    );
    expect(text).toMatch(/Discounted months \(any code, 5%–100%\) contribute \$0/);
    expect(text).toMatch(/not a tax-deductible donation/);
  });
});

describe('code entry', () => {
  it('validates length before calling the API', () => {
    expect(validateCodeEntry('ABC')).toMatch(/exactly as shown/);
    expect(validateCodeEntry('  ABCDE-FGHJK-X  ')).toBeNull();
    expect(validateCodeEntry('A'.repeat(25))).toMatch(/exactly as shown/);
  });

  it('uses the store that bills this device and never web billing inside the app', () => {
    expect(channelForPlatform('ios')).toBe('app_store');
    expect(channelForPlatform('android')).toBe('play_store');
    expect(channelForPlatform('web')).toBeNull();
  });
});

describe('quote view (AC_PROMO_14)', () => {
  it('shows percent, exact period, amounts, the regular renewal line and the preview label', () => {
    const view = buildQuoteView(quote(), { ...UTC, nativeStoreStepAvailable: true });
    expect(view.heading).toBe('50% off · October 2026 code');
    expect(view.periodLine).toBe(
      'Applies to your renewal starting October 15, 2026 (expected date — your store sets the exact date).',
    );
    expect(view.onePeriodLine).toMatch(/one monthly billing period only/);
    expect(view.amounts).toEqual([
      { label: 'Regular price', value: '$49.98' },
      { label: 'Discount', value: '−$24.99' },
      { label: 'You would pay', value: '$24.99' },
    ]);
    expect(view.renewalLine).toBe('Without a new code your next renewal is $49.98.');
    expect(view.previewLine).toBe('Preview — your store shows the final amount.');
    expect(view.donationLine).toMatch(/contributes \$0 to your school/);
    expect(view.redeem).toEqual({ available: true });
  });

  it('names the first full billing period for a new subscriber and shows a free month exactly', () => {
    const view = buildQuoteView(
      quote({
        targetPeriod: { kind: 'first_full_period' },
        percentOff: 100,
        regularCents: 3999,
        discountCents: 3999,
        chargedCents: 0,
        nextRegularRenewalCents: 3999,
      }),
      { ...UTC, nativeStoreStepAvailable: true },
    );
    expect(view.periodLine).toBe('Applies to your first full monthly billing period.');
    expect(view.amounts[2]).toEqual({ label: 'You would pay', value: '$0.00' });
    expect(view.renewalLine).toBe('Without a new code your next renewal is $39.99.');
  });

  it('does not offer redemption while the in-app store step is unavailable', () => {
    const view = buildQuoteView(quote(), { ...UTC, nativeStoreStepAvailable: false });
    expect(view.redeem.available).toBe(false);
    if (!view.redeem.available) {
      expect(view.redeem.reason).toMatch(/isn’t available in this version of the app yet/);
      expect(view.redeem.reason).toMatch(/No code has been used/);
    }
  });
});

describe('redemption status and history', () => {
  it('spells out every state in text', () => {
    const rows = historyRows(
      [
        redemption(),
        redemption({ state: 'confirmed', nextAction: { kind: 'none' } }),
        redemption({ state: 'rejected', nextAction: { kind: 'none' } }),
        redemption({ state: 'expired', nextAction: { kind: 'none' } }),
        redemption({ state: 'reconciled', nextAction: { kind: 'none' } }),
      ],
      { ...UTC, nativeStoreStepAvailable: false },
    );
    expect(rows.map((r) => r.status)).toEqual([
      'Status: Waiting for the store to confirm',
      'Status: Confirmed by the store',
      'Status: Not applied – the store declined it',
      'Status: Expired – not applied',
      'Status: Used – discounted month completed',
    ]);
    expect(rows[0]!.title).toBe('October 2026 code · 50% off');
    expect(rows[0]!.detail).toBe(
      'Billing period starting October 15, 2026 · $24.99 instead of $49.98',
    );
  });

  it('describes the next step honestly', () => {
    const opts = { ...UTC, nativeStoreStepAvailable: false };
    expect(nextActionLine(redemption(), opts)).toMatch(/not final until the store confirms/);
    const offer = redemption({
      state: 'reserved',
      nextAction: { kind: 'present_store_offer', providerOfferId: 'offer_2026_10_t2' },
    });
    expect(nextActionLine(offer, opts)).toMatch(
      /isn’t available in this version of the app yet.*No discount has been applied/,
    );
    expect(nextActionLine(offer, { ...opts, nativeStoreStepAvailable: true })).toMatch(
      /Confirm the offer in your store/,
    );
    expect(nextActionLine(redemption({ nextAction: { kind: 'none' } }), opts)).toBeNull();
  });

  it('labels the first full period when there is no known period start', () => {
    const [row] = historyRows([redemption({ targetPeriodStart: null })], {
      ...UTC,
      nativeStoreStepAvailable: false,
    });
    expect(row!.detail).toMatch(/^Your first full monthly billing period/);
  });
});
