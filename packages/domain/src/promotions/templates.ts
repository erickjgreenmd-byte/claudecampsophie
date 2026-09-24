import { DateTime } from 'luxon';
import { DEFAULT_MAX_PAID_SLOTS } from '../pricing/index.ts';
import type { BillingChannel } from '../shared/billing.ts';
import type { Cents } from '../shared/money.ts';
import { err, ok, type Result } from '../shared/result.ts';
import {
  isValidIanaZone,
  monthBoundsUtc,
  parseCalendarMonth,
  type CalendarMonth,
} from '../shared/time.ts';
import { isValidPercentOff } from './discount.ts';

export const SUBSCRIBER_CLASSES = ['new', 'existing', 'lapsed'] as const;
/** new = never subscribed; existing = has a current subscription; lapsed = subscription expired. */
export type SubscriberClass = (typeof SUBSCRIBER_CLASSES)[number];

export const PROMO_CHANNELS = [
  'app_store',
  'play_store',
  'stripe',
] as const satisfies readonly BillingChannel[];

export const CODE_MODES = ['shared', 'individual'] as const;
export type CodeMode = (typeof CODE_MODES)[number];

/**
 * Decision: an upper bound on individually issued codes per monthly campaign, so a mistyped
 * template cannot make the generator job create millions of rows. Raise it deliberately if needed.
 */
export const MAX_INDIVIDUAL_CODES_PER_CAMPAIGN = 100_000;

/** Calendar days (in the template zone) during which codes can be redeemed. */
export interface RedemptionWindow {
  /** First redeemable day of the campaign month, 1..28. */
  readonly startDay: number;
  /**
   * Last redeemable day (inclusive), 1..31, or the month end. Decision: a day past the end of a
   * short month (e.g. 31 in February) closes at that month's end.
   */
  readonly endDay: number | 'end_of_month';
}

/** Administrator-configured template from which each month's campaign is generated (spec P17). */
export interface CampaignTemplate {
  readonly id: string;
  readonly enabled: boolean;
  readonly paused: boolean;
  /** Optional school audience. */
  readonly schoolId: string | null;
  /** Exact whole percentage 5..100. Never chosen randomly. */
  readonly percentOff: number;
  /** Paid-slot tiers that may redeem (non-empty subset of 1..max). */
  readonly eligibleTiers: readonly number[];
  readonly subscriberEligibility: readonly SubscriberClass[];
  /** Total live (in-flight + confirmed) redemptions allowed per monthly campaign. */
  readonly redemptionCap: number;
  /** Total live discount allowed per monthly campaign, in cents. Never unlimited. */
  readonly budgetCapCents: Cents;
  /** IANA zone of the campaign calendar month. Drafts default to UTC. */
  readonly calendarTimezone: string;
  /** The administrator saw and confirmed the zone; required before activation. */
  readonly timezoneConfirmed: boolean;
  readonly redemptionWindow: RedemptionWindow;
  readonly codeMode: CodeMode;
  /** Individual mode: number of single-use codes generated per month. */
  readonly individualCodeCount?: number;
  /** Shared mode: optional usage cap for the one shared code (the campaign cap always applies). */
  readonly sharedCodeUsageCap?: number;
  readonly channels: readonly BillingChannel[];
}

export const TEMPLATE_ERROR_CODES = [
  'INVALID_TEMPLATE_ID',
  'INVALID_PERCENT',
  'INVALID_ELIGIBLE_TIERS',
  'INVALID_SUBSCRIBER_ELIGIBILITY',
  'INVALID_REDEMPTION_CAP',
  'MISSING_BUDGET_CAP',
  'INVALID_TIMEZONE',
  'TIMEZONE_NOT_CONFIRMED',
  'INVALID_REDEMPTION_WINDOW',
  'INVALID_CODE_MODE',
  'MISSING_INDIVIDUAL_CODE_COUNT',
  'INVALID_CODE_CONFIG',
  'INVALID_CHANNELS',
  'INVALID_SCHOOL_ID',
] as const;
export type TemplateErrorCode = (typeof TEMPLATE_ERROR_CODES)[number];

/** Opaque ids (UUIDs in the database). No `:` so generation keys stay unambiguous. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const MESSAGES: Readonly<Record<TemplateErrorCode, string>> = {
  INVALID_TEMPLATE_ID: 'Template id must be 1-64 letters, digits, "-" or "_".',
  INVALID_PERCENT: 'Discount must be a whole percentage from 5 to 100.',
  INVALID_ELIGIBLE_TIERS: 'Choose at least one eligible paid-slot tier, each listed once.',
  INVALID_SUBSCRIBER_ELIGIBILITY: 'Choose at least one of new, existing or lapsed subscribers.',
  INVALID_REDEMPTION_CAP: 'Redemption cap must be a positive whole number.',
  MISSING_BUDGET_CAP: 'A positive budget cap in cents is required; campaigns are never unlimited.',
  INVALID_TIMEZONE: 'Calendar timezone must be a valid IANA zone.',
  TIMEZONE_NOT_CONFIRMED: 'Confirm the calendar timezone before activating.',
  INVALID_REDEMPTION_WINDOW: 'Window must start on day 1-28 and end on or after the start day.',
  INVALID_CODE_MODE: 'Code mode must be shared or individual.',
  MISSING_INDIVIDUAL_CODE_COUNT: `Individual codes need a count from 1 to ${MAX_INDIVIDUAL_CODES_PER_CAMPAIGN}.`,
  INVALID_CODE_CONFIG: 'Code settings do not match the selected code mode.',
  INVALID_CHANNELS: 'Choose at least one billing channel, each listed once.',
  INVALID_SCHOOL_ID: 'School scope must be empty or a valid school id.',
};

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Untrusted-shape guard: the value as a list, or empty if it is not an array. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length;
}

function windowIsValid(window: RedemptionWindow | undefined): boolean {
  if (window === undefined || window === null) return false;
  const { startDay, endDay } = window;
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 28) return false;
  if (endDay === 'end_of_month') return true;
  return Number.isInteger(endDay) && endDay >= 1 && endDay <= 31 && endDay >= startDay;
}

/** Every problem with `t`, in the documented check order. */
function templateProblems(t: CampaignTemplate, maxPaidSlots: number): TemplateErrorCode[] {
  const problems: TemplateErrorCode[] = [];
  const add = (code: TemplateErrorCode) => problems.push(code);

  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) add('INVALID_TEMPLATE_ID');
  if (!isValidPercentOff(t.percentOff)) add('INVALID_PERCENT');
  const tiers = listOf(t.eligibleTiers);
  if (
    tiers.length === 0 ||
    hasDuplicates(tiers) ||
    !tiers.every(
      (tier) =>
        typeof tier === 'number' && Number.isInteger(tier) && tier >= 1 && tier <= maxPaidSlots,
    )
  ) {
    add('INVALID_ELIGIBLE_TIERS');
  }
  const classes = listOf(t.subscriberEligibility);
  if (
    classes.length === 0 ||
    hasDuplicates(classes) ||
    !classes.every((c) => (SUBSCRIBER_CLASSES as readonly unknown[]).includes(c))
  ) {
    add('INVALID_SUBSCRIBER_ELIGIBILITY');
  }
  if (!isPositiveInt(t.redemptionCap)) add('INVALID_REDEMPTION_CAP');
  if (!isPositiveInt(t.budgetCapCents)) add('MISSING_BUDGET_CAP');
  if (typeof t.calendarTimezone !== 'string' || !isValidIanaZone(t.calendarTimezone)) {
    add('INVALID_TIMEZONE');
  }
  if (t.timezoneConfirmed !== true) add('TIMEZONE_NOT_CONFIRMED');
  if (!windowIsValid(t.redemptionWindow)) add('INVALID_REDEMPTION_WINDOW');

  switch (t.codeMode) {
    case 'individual':
      if (
        !isPositiveInt(t.individualCodeCount) ||
        t.individualCodeCount > MAX_INDIVIDUAL_CODES_PER_CAMPAIGN
      ) {
        add('MISSING_INDIVIDUAL_CODE_COUNT');
      }
      // Decision: contradictory settings are rejected rather than silently ignored.
      if (t.sharedCodeUsageCap !== undefined) add('INVALID_CODE_CONFIG');
      break;
    case 'shared':
      if (
        t.individualCodeCount !== undefined ||
        (t.sharedCodeUsageCap !== undefined && !isPositiveInt(t.sharedCodeUsageCap))
      ) {
        add('INVALID_CODE_CONFIG');
      }
      break;
    default:
      add('INVALID_CODE_MODE');
  }

  const channels = listOf(t.channels);
  if (
    channels.length === 0 ||
    hasDuplicates(channels) ||
    !channels.every((c) => (PROMO_CHANNELS as readonly unknown[]).includes(c))
  ) {
    add('INVALID_CHANNELS');
  }
  if (t.schoolId !== null && (typeof t.schoolId !== 'string' || !ID_RE.test(t.schoolId))) {
    add('INVALID_SCHOOL_ID');
  }
  return problems;
}

/**
 * Whether `t` may be enabled/generated. Returns the first problem by documented order as the error
 * code, with every problem listed in `details.problems` for the administrator console.
 */
export function validateTemplateForActivation(
  t: CampaignTemplate,
  opts: { readonly maxPaidSlots?: number } = {},
): Result<CampaignTemplate, TemplateErrorCode> {
  const problems = templateProblems(t, opts.maxPaidSlots ?? DEFAULT_MAX_PAID_SLOTS);
  const [first] = problems;
  if (first === undefined) return ok(t);
  return err(first, MESSAGES[first], { problems });
}

export type TemplateDraftFields = Omit<
  CampaignTemplate,
  'enabled' | 'paused' | 'calendarTimezone' | 'timezoneConfirmed' | 'redemptionWindow'
> &
  Partial<Pick<CampaignTemplate, 'calendarTimezone' | 'redemptionWindow'>>;

/**
 * A new, disabled template. Drafts default to UTC calendar months and whole-month windows; the zone
 * is always unconfirmed so the administrator must see and confirm it before activation.
 */
export function draftCampaignTemplate(fields: TemplateDraftFields): CampaignTemplate {
  return {
    ...fields,
    enabled: false,
    paused: false,
    calendarTimezone: fields.calendarTimezone ?? 'UTC',
    timezoneConfirmed: false,
    redemptionWindow: fields.redemptionWindow ?? { startDay: 1, endDay: 'end_of_month' },
  };
}

export function generationKeyFor(templateId: string, month: CalendarMonth): string {
  parseCalendarMonth(month);
  return `${templateId}:${month}`;
}

/**
 * [opensAt, closesAt) UTC instants of `window` within `month` in `zone`: opens at the start of
 * `startDay`, closes at the start of the day after `endDay` (or at the next month's start).
 * DST-correct because each boundary is a local start-of-day converted to UTC.
 */
export function redemptionWindowUtc(
  month: CalendarMonth,
  zone: string,
  window: RedemptionWindow,
): { opensAt: Date; closesAt: Date } {
  if (!windowIsValid(window)) throw new RangeError('Invalid redemption window');
  const { year, month: m } = parseCalendarMonth(month);
  const bounds = monthBoundsUtc(month, zone);
  const startOfDay = (day: number) =>
    DateTime.fromObject({ year, month: m, day }, { zone }).startOf('day').toUTC().toJSDate();
  const daysInMonth = DateTime.fromObject({ year, month: m, day: 1 }, { zone }).daysInMonth ?? 28;
  const opensAt = startOfDay(window.startDay);
  const closesAt =
    window.endDay === 'end_of_month' || window.endDay >= daysInMonth
      ? bounds.end
      : startOfDay(window.endDay + 1);
  return { opensAt, closesAt };
}

export interface GenerationPlan {
  /** `${templateId}:${month}`; the database enforces its uniqueness. */
  readonly generationKey: string;
  readonly templateId: string;
  readonly month: CalendarMonth;
  readonly percentOff: number;
  readonly window: { readonly opensAt: Date; readonly closesAt: Date };
  /** 1 for a shared code, otherwise the template's individual code count. */
  readonly codeCount: number;
}

export type GenerationSkipReason =
  'TEMPLATE_DISABLED' | 'TEMPLATE_PAUSED' | 'ALREADY_GENERATED' | TemplateErrorCode;

export interface GenerationPreview {
  readonly planned: readonly GenerationPlan[];
  readonly skipped: readonly {
    readonly templateId: string;
    readonly reason: GenerationSkipReason;
  }[];
}

export interface MonthlyGenerationInput {
  readonly templates: readonly CampaignTemplate[];
  readonly month: CalendarMonth;
  /** Generation keys already stored (from any worker or earlier retry). */
  readonly existingGenerationKeys: ReadonlySet<string>;
  readonly maxPaidSlots?: number;
}

/**
 * Administrator preview of a monthly run: what would be generated and why each other template is
 * skipped. Ordered by template id (code-unit order) so every worker computes the same plan.
 * Duplicate template ids are a programmer error (the id is a primary key).
 */
export function explainMonthlyGeneration(input: MonthlyGenerationInput): GenerationPreview {
  parseCalendarMonth(input.month);
  const seen = new Set<string>();
  for (const t of input.templates) {
    if (seen.has(t.id)) throw new RangeError(`Duplicate template id ${t.id}`);
    seen.add(t.id);
  }
  const ordered = [...input.templates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const planned: GenerationPlan[] = [];
  const skipped: { templateId: string; reason: GenerationSkipReason }[] = [];
  for (const t of ordered) {
    if (!t.enabled) {
      skipped.push({ templateId: t.id, reason: 'TEMPLATE_DISABLED' });
      continue;
    }
    if (t.paused) {
      skipped.push({ templateId: t.id, reason: 'TEMPLATE_PAUSED' });
      continue;
    }
    const valid = validateTemplateForActivation(
      t,
      input.maxPaidSlots === undefined ? {} : { maxPaidSlots: input.maxPaidSlots },
    );
    if (!valid.ok) {
      skipped.push({ templateId: t.id, reason: valid.error.code });
      continue;
    }
    const generationKey = generationKeyFor(t.id, input.month);
    if (input.existingGenerationKeys.has(generationKey)) {
      skipped.push({ templateId: t.id, reason: 'ALREADY_GENERATED' });
      continue;
    }
    planned.push({
      generationKey,
      templateId: t.id,
      month: input.month,
      percentOff: t.percentOff,
      window: redemptionWindowUtc(input.month, t.calendarTimezone, t.redemptionWindow),
      codeCount: t.codeMode === 'individual' ? (t.individualCodeCount ?? 0) : 1,
    });
  }
  return { planned, skipped };
}

/**
 * Idempotent, deterministic monthly generation plan: one campaign per enabled, unpaused, valid
 * template whose `${templateId}:${month}` key does not exist yet. Discounts come only from the
 * template; nothing is chosen at random here (codes are drawn later by `generatePromoCodes`).
 */
export function planMonthlyGeneration(input: MonthlyGenerationInput): GenerationPlan[] {
  return [...explainMonthlyGeneration(input).planned];
}
