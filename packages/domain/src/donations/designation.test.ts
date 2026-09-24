import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMonths, calendarMonthOf, type CalendarMonth } from '../shared/time.ts';
import {
  designationForMonth,
  planSchoolDesignation,
  type Designation,
  type SchoolDesignationPlan,
} from './designation.ts';
import { MAPLE, MAPLE_SINCE_JANUARY, OAK, PINE, ZONE } from './test-fixtures.ts';

/** 2026-09-15 12:00 PDT: mid-September in the program zone. */
const MID_SEPTEMBER = new Date('2026-09-15T19:00:00.000Z');

function plan(
  designations: readonly Designation[],
  newSchoolId: string,
  now: Date = MID_SEPTEMBER,
  programZone: string = ZONE,
): SchoolDesignationPlan {
  const result = planSchoolDesignation({ designations, newSchoolId, now, programZone });
  if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
  return result.value;
}

/** How many designations cover `month` (the one-school-per-family invariant says at most 1). */
function coveringCount(designations: readonly Designation[], month: CalendarMonth): number {
  return designations.filter(
    (d) =>
      d.effectiveFromMonth <= month && (d.effectiveToMonth === null || month < d.effectiveToMonth),
  ).length;
}

describe('planSchoolDesignation — one school per family, changes from the next program month (P17)', () => {
  it('a first-ever designation takes effect in the current program month', () => {
    const result = plan([], MAPLE);
    expect(result).toEqual({
      designations: [{ schoolId: MAPLE, effectiveFromMonth: '2026-09', effectiveToMonth: null }],
      effectiveFromMonth: '2026-09',
      changed: true,
    });
    expect(designationForMonth(result.designations, '2026-09')).toBe(MAPLE);
    expect(designationForMonth(result.designations, '2026-08')).toBeNull();
  });

  it('a school change mid-month preserves the current month and switches at the next month', () => {
    const result = plan(MAPLE_SINCE_JANUARY, OAK);
    expect(result.changed).toBe(true);
    expect(result.effectiveFromMonth).toBe('2026-10');
    expect(result.designations).toEqual([
      { schoolId: MAPLE, effectiveFromMonth: '2026-01', effectiveToMonth: '2026-10' },
      { schoolId: OAK, effectiveFromMonth: '2026-10', effectiveToMonth: null },
    ]);
    expect(designationForMonth(result.designations, '2026-09')).toBe(MAPLE);
    expect(designationForMonth(result.designations, '2026-10')).toBe(OAK);
    expect(designationForMonth(result.designations, '2027-06')).toBe(OAK);
  });

  it('changing again before the change takes effect replaces the pending school (never stacks)', () => {
    const pendingOak = plan(MAPLE_SINCE_JANUARY, OAK).designations;
    const result = plan(pendingOak, PINE, new Date('2026-09-28T19:00:00.000Z'));
    expect(result.designations).toEqual([
      { schoolId: MAPLE, effectiveFromMonth: '2026-01', effectiveToMonth: '2026-10' },
      { schoolId: PINE, effectiveFromMonth: '2026-10', effectiveToMonth: null },
    ]);
    expect(designationForMonth(result.designations, '2026-10')).toBe(PINE);
  });

  it('choosing the current school again before a pending change takes effect cancels it', () => {
    const pendingOak = plan(MAPLE_SINCE_JANUARY, OAK).designations;
    const result = plan(pendingOak, MAPLE);
    expect(result.changed).toBe(true);
    expect(result.designations).toEqual(MAPLE_SINCE_JANUARY);
    expect(result.effectiveFromMonth).toBe('2026-01');
  });

  it('re-selecting the same school is a no-op', () => {
    const result = plan(MAPLE_SINCE_JANUARY, MAPLE);
    expect(result).toEqual({
      designations: MAPLE_SINCE_JANUARY,
      effectiveFromMonth: '2026-01',
      changed: false,
    });
  });

  it('re-selecting the already pending school is a no-op', () => {
    const pendingOak = plan(MAPLE_SINCE_JANUARY, OAK).designations;
    const result = plan(pendingOak, OAK);
    expect(result.changed).toBe(false);
    expect(result.designations).toEqual(pendingOak);
    expect(result.effectiveFromMonth).toBe('2026-10');
  });

  it('a change after the pending school took effect closes it at the following month', () => {
    const pendingOak = plan(MAPLE_SINCE_JANUARY, OAK).designations;
    const result = plan(pendingOak, PINE, new Date('2026-10-05T19:00:00.000Z'));
    expect(result.designations).toEqual([
      { schoolId: MAPLE, effectiveFromMonth: '2026-01', effectiveToMonth: '2026-10' },
      { schoolId: OAK, effectiveFromMonth: '2026-10', effectiveToMonth: '2026-11' },
      { schoolId: PINE, effectiveFromMonth: '2026-11', effectiveToMonth: null },
    ]);
  });

  it('uses the program-zone month, not UTC, near midnight', () => {
    // 2026-09-30 23:30 PDT is still September in Los Angeles although it is October in UTC.
    const lateSeptember = plan(MAPLE_SINCE_JANUARY, OAK, new Date('2026-10-01T06:30:00.000Z'));
    expect(lateSeptember.effectiveFromMonth).toBe('2026-10');
    // 2026-10-01 00:30 PDT is October: the change waits for November.
    const earlyOctober = plan(MAPLE_SINCE_JANUARY, OAK, new Date('2026-10-01T07:30:00.000Z'));
    expect(earlyOctober.effectiveFromMonth).toBe('2026-11');
    expect(designationForMonth(earlyOctober.designations, '2026-10')).toBe(MAPLE);
  });

  it('never alters earlier history', () => {
    const history: readonly Designation[] = [
      { schoolId: OAK, effectiveFromMonth: '2025-09', effectiveToMonth: '2026-01' },
      { schoolId: MAPLE, effectiveFromMonth: '2026-01', effectiveToMonth: null },
    ];
    const result = plan(history, PINE);
    expect(result.designations[0]).toEqual(history[0]);
    expect(designationForMonth(result.designations, '2025-12')).toBe(OAK);
    expect(designationForMonth(result.designations, '2026-09')).toBe(MAPLE);
    expect(designationForMonth(result.designations, '2026-10')).toBe(PINE);
  });

  it('a family whose earlier designation already ended is treated as a change (next month)', () => {
    const ended: readonly Designation[] = [
      { schoolId: OAK, effectiveFromMonth: '2025-09', effectiveToMonth: '2026-03' },
    ];
    const result = plan(ended, MAPLE);
    expect(result.effectiveFromMonth).toBe('2026-10');
    expect(designationForMonth(result.designations, '2026-09')).toBeNull();
    expect(designationForMonth(result.designations, '2026-10')).toBe(MAPLE);
  });

  it('accepts stored designations in any order', () => {
    const pendingOak = plan(MAPLE_SINCE_JANUARY, OAK).designations;
    const result = plan([...pendingOak].reverse(), OAK);
    expect(result.changed).toBe(false);
    expect(result.designations).toEqual(pendingOak);
  });

  it.each(['', '   ', ' sch_maple', 'sch\nmaple'])('rejects a malformed school id %j', (id) => {
    const result = planSchoolDesignation({
      designations: MAPLE_SINCE_JANUARY,
      newSchoolId: id,
      now: MID_SEPTEMBER,
      programZone: ZONE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_SCHOOL_ID');
  });

  it('refuses stored designations that overlap (the DB exclusion constraint was bypassed)', () => {
    const overlapping: readonly Designation[] = [
      { schoolId: MAPLE, effectiveFromMonth: '2026-01', effectiveToMonth: null },
      { schoolId: OAK, effectiveFromMonth: '2026-05', effectiveToMonth: null },
    ];
    expect(() => plan(overlapping, PINE)).toThrow(RangeError);
    expect(() => designationForMonth(overlapping, '2026-06')).toThrow(RangeError);
  });

  it('rejects an invalid clock or program zone as programmer errors', () => {
    expect(() => plan([], MAPLE, new Date(Number.NaN))).toThrow(RangeError);
    expect(() => plan([], MAPLE, MID_SEPTEMBER, 'Mars/Olympus')).toThrow(RangeError);
  });

  it('property: two schools never overlap; the past and current month are preserved; the latest choice applies from next month', () => {
    const stepArb = fc.record({
      days: fc.integer({ min: 0, max: 75 }),
      minutes: fc.integer({ min: 0, max: 1439 }),
      school: fc.constantFrom(MAPLE, OAK, PINE),
    });
    const zoneArb = fc.constantFrom('America/Los_Angeles', 'Pacific/Auckland', 'UTC');
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 12 }), zoneArb, (steps, zone) => {
        let designations: readonly Designation[] = [];
        let t = Date.parse('2026-01-01T00:00:00.000Z');
        for (const step of steps) {
          t += step.days * 86_400_000 + step.minutes * 60_000;
          const now = new Date(t);
          const current = calendarMonthOf(now, zone);
          const before = designations;
          const after = plan(before, step.school, now, zone).designations;
          for (let k = -24; k <= 24; k++) {
            const month = addMonths(current, k);
            expect(coveringCount(after, month)).toBeLessThanOrEqual(1);
            if (k < 0 || (k === 0 && before.length > 0)) {
              expect(designationForMonth(after, month)).toBe(designationForMonth(before, month));
            } else {
              expect(designationForMonth(after, month)).toBe(step.school);
            }
          }
          designations = after;
        }
      }),
    );
  });
});

describe('designationForMonth', () => {
  const history: readonly Designation[] = [
    { schoolId: OAK, effectiveFromMonth: '2026-02', effectiveToMonth: '2026-05' },
    { schoolId: MAPLE, effectiveFromMonth: '2026-05', effectiveToMonth: null },
  ];

  it('returns null before any designation', () => {
    expect(designationForMonth(history, '2026-01')).toBeNull();
    expect(designationForMonth([], '2026-09')).toBeNull();
  });

  it('treats the end month as exclusive', () => {
    expect(designationForMonth(history, '2026-04')).toBe(OAK);
    expect(designationForMonth(history, '2026-05')).toBe(MAPLE);
  });

  it('rejects a malformed month', () => {
    expect(() => designationForMonth(history, '2026-13')).toThrow(RangeError);
  });
});
