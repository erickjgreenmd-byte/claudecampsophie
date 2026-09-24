// P17 monthly timing: when the idempotent campaign generator runs for a campaign month
// (AC_PROMO_01, timing side) and when the school-donation accrual for a program month runs.
// What is generated/accrued lives in the promotions and donations modules.
import {
  addMonths,
  calendarMonthOf,
  parseCalendarMonth,
  type CalendarMonth,
} from '../shared/time.ts';
import {
  addCalendarDays,
  assertSchedulingZone,
  isValidInstant,
  startOfLocalDay,
} from './local-time.ts';

export const DEFAULT_GENERATION_LEAD_DAYS = 5;
export const DEFAULT_SETTLEMENT_GRACE_DAYS = 7;
/**
 * Decision: lead and grace are bounded to 0..28 days (never more than the shortest month), which
 * also guarantees at most the current and the next campaign month are ever due at once.
 */
export const MAX_SCHEDULE_OFFSET_DAYS = 28;

function assertDays(days: number, what: string): void {
  if (!Number.isInteger(days) || days < 0 || days > MAX_SCHEDULE_OFFSET_DAYS) {
    throw new RangeError(`${what} must be an integer 0..${MAX_SCHEDULE_OFFSET_DAYS}`);
  }
}

function firstDayOf(month: CalendarMonth): string {
  parseCalendarMonth(month);
  return `${month}-01`;
}

/**
 * Instant the generator should run for campaign `month`: `leadDays` local calendar days before the
 * first instant of that month in the template's calendar `zone`. Decision: lead days are calendar
 * days in the zone (the run is at local start of day), not multiples of 24 h, so it does not drift
 * by an hour across DST. Deterministic, so concurrent workers and retries agree; exactly-once
 * creation is enforced by the unique template/month generation key, not by this timing.
 * Throws RangeError on invalid month/zone/lead (configuration is validated upstream).
 */
export function nextMonthlyGenerationAt(input: {
  readonly month: CalendarMonth;
  readonly zone: string;
  readonly leadDays?: number;
}): Date {
  assertSchedulingZone(input.zone);
  const leadDays = input.leadDays ?? DEFAULT_GENERATION_LEAD_DAYS;
  assertDays(leadDays, 'leadDays');
  return startOfLocalDay(input.zone, addCalendarDays(firstDayOf(input.month), -leadDays));
}

/**
 * Campaign months whose generation is due at `now` in the template zone: the current month
 * (Decision: idempotent catch-up if the lead-time run was missed; the generation key prevents a
 * duplicate) plus the next month once its lead-time run instant has passed.
 */
export function dueGenerationMonths(input: {
  readonly now: Date;
  readonly zone: string;
  readonly leadDays?: number;
}): CalendarMonth[] {
  assertSchedulingZone(input.zone);
  if (!isValidInstant(input.now)) throw new RangeError('Invalid now');
  const current = calendarMonthOf(input.now, input.zone);
  const next = addMonths(current, 1);
  const nextRunAt = nextMonthlyGenerationAt({
    month: next,
    zone: input.zone,
    ...(input.leadDays === undefined ? {} : { leadDays: input.leadDays }),
  });
  return input.now.getTime() >= nextRunAt.getTime() ? [current, next] : [current];
}

/**
 * Instant the donation accrual for program `month` runs: `settlementGraceDays` local calendar
 * days after the first instant of the next month in the fixed program calendar zone, so payments
 * for periods starting in `month` have time to settle. Late settlement is still recorded against
 * the original period by the donations ledger. Throws RangeError on invalid input.
 */
export function donationAccrualRunAt(input: {
  readonly month: CalendarMonth;
  readonly zone: string;
  readonly settlementGraceDays?: number;
}): Date {
  assertSchedulingZone(input.zone);
  const grace = input.settlementGraceDays ?? DEFAULT_SETTLEMENT_GRACE_DAYS;
  assertDays(grace, 'settlementGraceDays');
  parseCalendarMonth(input.month);
  return startOfLocalDay(input.zone, addCalendarDays(firstDayOf(addMonths(input.month, 1)), grace));
}
