import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMonths, calendarMonthOf } from '../shared/time.ts';
import {
  draftCampaignTemplate,
  explainMonthlyGeneration,
  planMonthlyGeneration,
  redemptionWindowUtc,
  validateTemplateForActivation,
  type CampaignTemplate,
} from './templates.ts';
import {
  SCHOOL_MAPLE,
  TEMPLATE_A,
  TEMPLATE_B,
  TEMPLATE_C,
  makeIndividualTemplate,
  makeTemplate,
} from './test-fixtures.ts';

function errorCode(template: CampaignTemplate): string | null {
  const result = validateTemplateForActivation(template);
  return result.ok ? null : result.error.code;
}

describe('P17 campaign templates: activation rules', () => {
  it('a draft defaults to UTC calendar months, disabled, and cannot activate until the zone is confirmed', () => {
    const draft = draftCampaignTemplate({
      id: TEMPLATE_A,
      schoolId: null,
      percentOff: 25,
      eligibleTiers: [1, 2],
      subscriberEligibility: ['existing'],
      redemptionCap: 100,
      budgetCapCents: 250_000,
      codeMode: 'shared',
      channels: ['stripe'],
    });
    expect(draft).toMatchObject({
      calendarTimezone: 'UTC',
      timezoneConfirmed: false,
      enabled: false,
      paused: false,
      redemptionWindow: { startDay: 1, endDay: 'end_of_month' },
    });
    expect(errorCode(draft)).toBe('TIMEZONE_NOT_CONFIRMED');
    expect(errorCode({ ...draft, timezoneConfirmed: true })).toBeNull();
  });

  it('accepts every whole percentage from 5 through 100 and nothing else', () => {
    fc.assert(
      fc.property(fc.integer({ min: 5, max: 100 }), (percentOff) => {
        expect(errorCode(makeTemplate({ percentOff }))).toBeNull();
      }),
    );
    for (const percentOff of [0, 4, 101, 50.5, Number.NaN, -10]) {
      expect(errorCode(makeTemplate({ percentOff }))).toBe('INVALID_PERCENT');
    }
  });

  it('never allows an unlimited or missing budget cap', () => {
    for (const budgetCapCents of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 10.5]) {
      expect(errorCode(makeTemplate({ budgetCapCents }))).toBe('MISSING_BUDGET_CAP');
    }
    const untyped = { ...makeTemplate() } as Record<string, unknown>;
    delete untyped['budgetCapCents'];
    expect(errorCode(untyped as unknown as CampaignTemplate)).toBe('MISSING_BUDGET_CAP');
  });

  it('requires a positive integer redemption cap', () => {
    for (const redemptionCap of [0, -5, 2.5, Number.POSITIVE_INFINITY]) {
      expect(errorCode(makeTemplate({ redemptionCap }))).toBe('INVALID_REDEMPTION_CAP');
    }
  });

  it('requires a non-empty, duplicate-free subset of the configured tiers', () => {
    for (const eligibleTiers of [[], [0], [5], [1, 1], [1.5]]) {
      expect(errorCode(makeTemplate({ eligibleTiers }))).toBe('INVALID_ELIGIBLE_TIERS');
    }
    expect(errorCode(makeTemplate({ eligibleTiers: [3] }))).toBeNull();
  });

  it('requires a non-empty, known subscriber eligibility set', () => {
    expect(errorCode(makeTemplate({ subscriberEligibility: [] }))).toBe(
      'INVALID_SUBSCRIBER_ELIGIBILITY',
    );
    expect(errorCode(makeTemplate({ subscriberEligibility: ['vip' as 'new'] }))).toBe(
      'INVALID_SUBSCRIBER_ELIGIBILITY',
    );
    expect(errorCode(makeTemplate({ subscriberEligibility: ['new', 'new'] }))).toBe(
      'INVALID_SUBSCRIBER_ELIGIBILITY',
    );
  });

  it('requires a real IANA calendar zone', () => {
    expect(errorCode(makeTemplate({ calendarTimezone: 'Mars/Olympus_Mons' }))).toBe(
      'INVALID_TIMEZONE',
    );
    expect(errorCode(makeTemplate({ calendarTimezone: 'America/Chicago' }))).toBeNull();
  });

  it('validates the redemption window days', () => {
    const bad: CampaignTemplate['redemptionWindow'][] = [
      { startDay: 0, endDay: 10 },
      { startDay: 29, endDay: 'end_of_month' },
      { startDay: 1, endDay: 0 },
      { startDay: 1, endDay: 32 },
      { startDay: 10, endDay: 9 },
      { startDay: 1.5, endDay: 20 },
    ];
    for (const redemptionWindow of bad) {
      expect(errorCode(makeTemplate({ redemptionWindow }))).toBe('INVALID_REDEMPTION_WINDOW');
    }
    expect(errorCode(makeTemplate({ redemptionWindow: { startDay: 28, endDay: 31 } }))).toBeNull();
  });

  it('distinguishes shared and individual code configuration', () => {
    const { individualCodeCount: _count, ...noCount } = makeIndividualTemplate();
    expect(errorCode(noCount)).toBe('MISSING_INDIVIDUAL_CODE_COUNT');
    expect(errorCode(makeIndividualTemplate({ individualCodeCount: 0 }))).toBe(
      'MISSING_INDIVIDUAL_CODE_COUNT',
    );
    expect(errorCode(makeIndividualTemplate())).toBeNull();
    expect(errorCode(makeTemplate({ sharedCodeUsageCap: 0 }))).toBe('INVALID_CODE_CONFIG');
    expect(errorCode(makeTemplate({ individualCodeCount: 10 }))).toBe('INVALID_CODE_CONFIG');
    expect(errorCode(makeIndividualTemplate({ sharedCodeUsageCap: 10 }))).toBe(
      'INVALID_CODE_CONFIG',
    );
    expect(errorCode(makeTemplate({ codeMode: 'lottery' as 'shared' }))).toBe('INVALID_CODE_MODE');
  });

  it('requires at least one known, non-duplicated channel', () => {
    expect(errorCode(makeTemplate({ channels: [] }))).toBe('INVALID_CHANNELS');
    expect(errorCode(makeTemplate({ channels: ['amazon' as 'stripe'] }))).toBe('INVALID_CHANNELS');
    expect(errorCode(makeTemplate({ channels: ['stripe', 'stripe'] }))).toBe('INVALID_CHANNELS');
  });

  it('reports every problem at once for the administrator, first code by documented order', () => {
    const result = validateTemplateForActivation(
      makeTemplate({ percentOff: 0, budgetCapCents: 0, timezoneConfirmed: false, channels: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PERCENT');
      expect(result.error.details?.['problems']).toEqual([
        'INVALID_PERCENT',
        'MISSING_BUDGET_CAP',
        'TIMEZONE_NOT_CONFIRMED',
        'INVALID_CHANNELS',
      ]);
    }
  });

  it('rejects template ids that could make generation keys ambiguous', () => {
    expect(errorCode(makeTemplate({ id: 'a:b' }))).toBe('INVALID_TEMPLATE_ID');
    expect(errorCode(makeTemplate({ id: '' }))).toBe('INVALID_TEMPLATE_ID');
  });
});

describe('P17 monthly generation plan (AC_PROMO_01)', () => {
  it('plans one campaign per enabled template with key `${templateId}:${month}` and the exact template percentage', () => {
    const plans = planMonthlyGeneration({
      templates: [makeTemplate({ percentOff: 35 })],
      month: '2026-10',
      existingGenerationKeys: new Set(),
    });
    expect(plans).toEqual([
      {
        generationKey: `${TEMPLATE_A}:2026-10`,
        templateId: TEMPLATE_A,
        month: '2026-10',
        percentOff: 35,
        window: {
          opensAt: new Date('2026-10-01T00:00:00.000Z'),
          closesAt: new Date('2026-11-01T00:00:00.000Z'),
        },
        codeCount: 1,
      },
    ]);
  });

  it('never chooses a discount: the planned percentage is always the template percentage', () => {
    fc.assert(
      fc.property(fc.integer({ min: 5, max: 100 }), (percentOff) => {
        const [plan] = planMonthlyGeneration({
          templates: [makeTemplate({ percentOff })],
          month: '2026-12',
          existingGenerationKeys: new Set(),
        });
        expect(plan?.percentOff).toBe(percentOff);
      }),
    );
  });

  it('computes the window from the template zone with DST-correct UTC instants', () => {
    const [november] = planMonthlyGeneration({
      templates: [makeTemplate({ calendarTimezone: 'America/New_York' })],
      month: '2026-11',
      existingGenerationKeys: new Set(),
    });
    expect(november?.window.opensAt.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(november?.window.closesAt.toISOString()).toBe('2026-12-01T05:00:00.000Z');

    // US DST starts 2027-03-14: the window opens at EST midnight and closes at EDT midnight.
    const [march] = planMonthlyGeneration({
      templates: [
        makeTemplate({
          calendarTimezone: 'America/New_York',
          redemptionWindow: { startDay: 1, endDay: 15 },
        }),
      ],
      month: '2027-03',
      existingGenerationKeys: new Set(),
    });
    expect(march?.window.opensAt.toISOString()).toBe('2027-03-01T05:00:00.000Z');
    expect(march?.window.closesAt.toISOString()).toBe('2027-03-16T04:00:00.000Z');
  });

  it('clamps an end day past the month end to the month end (February, leap years)', () => {
    const plan = (month: string, endDay: number) =>
      planMonthlyGeneration({
        templates: [makeTemplate({ redemptionWindow: { startDay: 10, endDay } })],
        month,
        existingGenerationKeys: new Set(),
      })[0]?.window;
    expect(plan('2027-02', 31)).toEqual({
      opensAt: new Date('2027-02-10T00:00:00.000Z'),
      closesAt: new Date('2027-03-01T00:00:00.000Z'),
    });
    expect(plan('2028-02', 28)?.closesAt).toEqual(new Date('2028-02-29T00:00:00.000Z'));
    expect(plan('2028-02', 29)?.closesAt).toEqual(new Date('2028-03-01T00:00:00.000Z'));
  });

  it('whole-month windows tile consecutive months exactly: no gap, no overlap, even after a midnight DST jump on the 1st', () => {
    // Regression for RV-promotions-2. Each listed month began at 01:00 local because DST skipped
    // midnight on the 1st; the previous month's window must close exactly at that first instant,
    // and that month's window must close at the following month's own local midnight.
    const whole = { startDay: 1, endDay: 'end_of_month' } as const;
    const skippedMidnightMonths: ReadonlyArray<[string, string]> = [
      ['America/Asuncion', '2023-10'],
      ['America/Asuncion', '2017-10'],
      ['America/Havana', '2012-04'],
      ['Asia/Amman', '2016-04'],
      ['Africa/Cairo', '2014-08'],
    ];
    const zones = [
      'UTC',
      'America/New_York',
      'America/Santiago',
      'Australia/Lord_Howe',
      ...skippedMidnightMonths.map(([zone]) => zone),
    ];
    const checkTiling = (zone: string, month: string) => {
      const current = redemptionWindowUtc(month, zone, whole);
      const next = redemptionWindowUtc(addMonths(month, 1), zone, whole);
      expect(current.closesAt.getTime(), `${zone} ${month}`).toBe(next.opensAt.getTime());
      expect(current.closesAt.getTime()).toBeGreaterThan(current.opensAt.getTime());
      // opensAt is the month's first real local instant; closesAt is the next month's.
      expect(calendarMonthOf(current.opensAt, zone)).toBe(month);
      expect(calendarMonthOf(new Date(current.opensAt.getTime() - 1), zone)).toBe(
        addMonths(month, -1),
      );
      expect(calendarMonthOf(new Date(current.closesAt.getTime() - 1), zone)).toBe(month);
      expect(calendarMonthOf(current.closesAt, zone)).toBe(addMonths(month, 1));
    };
    for (const [zone, month] of skippedMidnightMonths) {
      checkTiling(zone, addMonths(month, -1));
      checkTiling(zone, month);
    }
    fc.assert(
      fc.property(fc.constantFrom(...zones), fc.integer({ min: 0, max: 12 * 70 }), (zone, offset) =>
        checkTiling(zone, addMonths('1995-01', offset)),
      ),
      { numRuns: 200 },
    );

    // An explicit end day at the month's last day closes at the same boundary.
    const october = redemptionWindowUtc('2023-10', 'America/Asuncion', {
      startDay: 20,
      endDay: 31,
    });
    expect(october.closesAt.toISOString()).toBe('2023-11-01T03:00:00.000Z');
  });

  it('skips disabled, paused and invalid templates, with a visible reason in the preview', () => {
    const templates = [
      makeTemplate({ id: TEMPLATE_A, enabled: false }),
      makeTemplate({ id: TEMPLATE_B, paused: true }),
      makeTemplate({ id: TEMPLATE_C, timezoneConfirmed: false }),
    ];
    const input = { templates, month: '2026-10', existingGenerationKeys: new Set<string>() };
    expect(planMonthlyGeneration(input)).toEqual([]);
    expect(explainMonthlyGeneration(input).skipped).toEqual([
      { templateId: TEMPLATE_A, reason: 'TEMPLATE_DISABLED' },
      { templateId: TEMPLATE_B, reason: 'TEMPLATE_PAUSED' },
      { templateId: TEMPLATE_C, reason: 'TIMEZONE_NOT_CONFIRMED' },
    ]);
  });

  it('is idempotent: existing generation keys are skipped, so a retry or second worker plans nothing', () => {
    const templates = [makeTemplate({ id: TEMPLATE_A }), makeTemplate({ id: TEMPLATE_B })];
    const first = planMonthlyGeneration({
      templates,
      month: '2026-10',
      existingGenerationKeys: new Set([`${TEMPLATE_B}:2026-10`]),
    });
    expect(first.map((p) => p.templateId)).toEqual([TEMPLATE_A]);
    const retry = planMonthlyGeneration({
      templates,
      month: '2026-10',
      existingGenerationKeys: new Set([
        `${TEMPLATE_B}:2026-10`,
        ...first.map((p) => p.generationKey),
      ]),
    });
    expect(retry).toEqual([]);
    // A new month is a fresh generation: codes are never carried forward.
    const next = planMonthlyGeneration({
      templates,
      month: '2026-11',
      existingGenerationKeys: new Set([`${TEMPLATE_A}:2026-10`, `${TEMPLATE_B}:2026-10`]),
    });
    expect(next.map((p) => p.generationKey)).toEqual([
      `${TEMPLATE_A}:2026-11`,
      `${TEMPLATE_B}:2026-11`,
    ]);
  });

  it('is deterministic regardless of input order, and replanning after applying a plan yields nothing', () => {
    const pool = [
      makeTemplate({ id: TEMPLATE_C, percentOff: 100 }),
      makeIndividualTemplate({ id: TEMPLATE_A, schoolId: SCHOOL_MAPLE }),
      makeTemplate({ id: TEMPLATE_B, calendarTimezone: 'Pacific/Auckland' }),
    ];
    fc.assert(
      fc.property(
        fc.shuffledSubarray(pool, { minLength: 0, maxLength: pool.length }),
        fc.shuffledSubarray(pool, { minLength: 0, maxLength: pool.length }),
        (templates, alreadyGenerated) => {
          const existing = new Set(alreadyGenerated.map((t) => `${t.id}:2027-01`));
          const plans = planMonthlyGeneration({
            templates,
            month: '2027-01',
            existingGenerationKeys: existing,
          });
          const sortedAgain = planMonthlyGeneration({
            templates: [...templates].reverse(),
            month: '2027-01',
            existingGenerationKeys: existing,
          });
          expect(sortedAgain).toEqual(plans);
          const ids = plans.map((p) => p.templateId);
          expect(ids).toEqual([...ids].sort());
          for (const plan of plans) expect(existing.has(plan.generationKey)).toBe(false);
          const after = new Set([...existing, ...plans.map((p) => p.generationKey)]);
          expect(
            planMonthlyGeneration({ templates, month: '2027-01', existingGenerationKeys: after }),
          ).toEqual([]);
        },
      ),
    );
  });

  it('plans the configured number of individual codes, or one shared code', () => {
    const plans = planMonthlyGeneration({
      templates: [
        makeIndividualTemplate({ id: TEMPLATE_A, individualCodeCount: 250 }),
        makeTemplate({ id: TEMPLATE_B }),
      ],
      month: '2026-10',
      existingGenerationKeys: new Set(),
    });
    expect(plans.map((p) => p.codeCount)).toEqual([250, 1]);
  });

  it('treats duplicate template ids as a programmer error rather than generating twice', () => {
    expect(() =>
      planMonthlyGeneration({
        templates: [makeTemplate(), makeTemplate({ percentOff: 10 })],
        month: '2026-10',
        existingGenerationKeys: new Set(),
      }),
    ).toThrow(/duplicate/i);
  });
});
