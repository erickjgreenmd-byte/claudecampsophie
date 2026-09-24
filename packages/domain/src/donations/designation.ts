// One designated school per family, with effective month ranges (spec P17 "School attribution and
// donation ledger"). The database enforces the same invariant with an exclusion constraint on
// non-overlapping ranges; this module plans changes so that constraint is never hit in practice.
import { err, ok, type Result } from '../shared/result.ts';
import {
  addMonths,
  assertIanaZone,
  calendarMonthOf,
  compareMonths,
  parseCalendarMonth,
  type CalendarMonth,
} from '../shared/time.ts';
import { assertId, assertInstant, isWellFormedId } from './validation.ts';

/** A family's designated school for program months [effectiveFromMonth, effectiveToMonth). */
export interface Designation {
  readonly schoolId: string;
  readonly effectiveFromMonth: CalendarMonth;
  /** Exclusive end month; null while open-ended (the latest designation). */
  readonly effectiveToMonth: CalendarMonth | null;
}

export const DESIGNATION_ERROR_CODES = ['INVALID_SCHOOL_ID'] as const;
export type DesignationErrorCode = (typeof DESIGNATION_ERROR_CODES)[number];

export interface PlanSchoolDesignationInput {
  /** The family's stored designation history (any order). */
  readonly designations: readonly Designation[];
  readonly newSchoolId: string;
  readonly now: Date;
  /** Fixed program calendar zone (IANA). */
  readonly programZone: string;
}

export interface SchoolDesignationPlan {
  /** The complete new history, sorted by effectiveFromMonth, never overlapping. */
  readonly designations: readonly Designation[];
  /** First program month in which `newSchoolId` is the family's school. */
  readonly effectiveFromMonth: CalendarMonth;
  /** False when the selection changes nothing (same school, or the already pending school). */
  readonly changed: boolean;
}

/**
 * Plans a school selection.
 *
 * - A change takes effect at the start of the NEXT program month: the current designation is
 *   closed there, so the current month's designation (and any accrual made under it) is preserved.
 * - Changing again before the change takes effect replaces the pending designation; it never
 *   stacks a second future row. Choosing the current school again cancels the pending change.
 * - Selecting the school that already applies from next month is a no-op (`changed: false`).
 *
 * Decision: a first-ever designation (empty history) takes effect in the CURRENT program month.
 * There is no prior designation or ledger row for this month to preserve, and a family that picks
 * a school right after subscribing expects that month's full-price payment to count.
 * Decision: only an empty history counts as "first-ever". A family whose earlier designation has
 * already ended is treated as a change (next month), the conservative reading that can never
 * re-attribute a month that was previously evaluated.
 */
export function planSchoolDesignation(
  input: PlanSchoolDesignationInput,
): Result<SchoolDesignationPlan, DesignationErrorCode> {
  assertInstant(input.now, 'now');
  assertIanaZone(input.programZone);
  const history = normalizeDesignations(input.designations);
  const schoolId = input.newSchoolId;
  if (!isWellFormedId(schoolId)) {
    return err('INVALID_SCHOOL_ID', 'School id must be a well-formed identifier');
  }

  const currentMonth = calendarMonthOf(input.now, input.programZone);
  if (history.length === 0) {
    const first: Designation = {
      schoolId,
      effectiveFromMonth: currentMonth,
      effectiveToMonth: null,
    };
    return ok({ designations: [first], effectiveFromMonth: currentMonth, changed: true });
  }

  // Keep everything up to the end of the current month; replace everything from next month.
  const switchMonth = addMonths(currentMonth, 1);
  const next: Designation[] = [];
  for (const d of history) {
    if (compareMonths(d.effectiveFromMonth, switchMonth) >= 0) continue; // pending: replaced
    const endsAfterSwitch =
      d.effectiveToMonth === null || compareMonths(d.effectiveToMonth, switchMonth) > 0;
    next.push(endsAfterSwitch ? { ...d, effectiveToMonth: switchMonth } : d);
  }
  const last = next.at(-1);
  if (last !== undefined && last.schoolId === schoolId && last.effectiveToMonth === switchMonth) {
    // Same school continues across the switch: extend it rather than splitting it into two rows.
    next[next.length - 1] = { ...last, effectiveToMonth: null };
  } else {
    next.push({ schoolId, effectiveFromMonth: switchMonth, effectiveToMonth: null });
  }

  const changed = !sameHistory(history, next);
  const latest = next.at(-1);
  if (latest === undefined) throw new Error('unreachable: a designation was just added');
  return ok({
    designations: changed ? next : history,
    effectiveFromMonth: latest.effectiveFromMonth,
    changed,
  });
}

/**
 * The family's school for a program month, or null when none was designated.
 *
 * Decision: overlapping stored designations throw (see normalizeDesignations) instead of picking
 * one, so a bypassed exclusion constraint can never route a donation to the wrong school.
 */
export function designationForMonth(
  designations: readonly Designation[],
  month: CalendarMonth,
): string | null {
  parseCalendarMonth(month);
  const covering = normalizeDesignations(designations).find(
    (d) =>
      compareMonths(d.effectiveFromMonth, month) <= 0 &&
      (d.effectiveToMonth === null || compareMonths(month, d.effectiveToMonth) < 0),
  );
  return covering?.schoolId ?? null;
}

/** Validates and sorts a stored history; throws RangeError when ranges overlap or are malformed. */
function normalizeDesignations(designations: readonly Designation[]): readonly Designation[] {
  for (const d of designations) {
    assertId(d.schoolId, 'designation.schoolId');
    parseCalendarMonth(d.effectiveFromMonth);
    if (d.effectiveToMonth !== null) {
      parseCalendarMonth(d.effectiveToMonth);
      if (compareMonths(d.effectiveToMonth, d.effectiveFromMonth) <= 0) {
        throw new RangeError('A designation must end after it starts');
      }
    }
  }
  const sorted = [...designations].sort((a, b) =>
    compareMonths(a.effectiveFromMonth, b.effectiveFromMonth),
  );
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) continue;
    if (
      previous.effectiveToMonth === null ||
      compareMonths(previous.effectiveToMonth, current.effectiveFromMonth) > 0
    ) {
      throw new RangeError(
        'Overlapping school designations: a family may have at most one school per month',
      );
    }
  }
  return sorted;
}

function sameHistory(a: readonly Designation[], b: readonly Designation[]): boolean {
  return (
    a.length === b.length &&
    a.every((d, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        d.schoolId === other.schoolId &&
        d.effectiveFromMonth === other.effectiveFromMonth &&
        d.effectiveToMonth === other.effectiveToMonth
      );
    })
  );
}
