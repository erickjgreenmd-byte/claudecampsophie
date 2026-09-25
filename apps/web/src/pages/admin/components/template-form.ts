import type { z } from 'zod';
import {
  MAX_PROMO_BUDGET_CENTS,
  promoTemplateInputSchema,
  channelSchema,
  type promoTemplateSchema,
} from '@pencillift/contracts';
import { DEFAULT_MAX_PAID_SLOTS, formatUsd } from '@pencillift/domain';
import { centsToDollarsInput, parseDollarsToCents } from './admin-money.ts';

/**
 * Promo template form model (spec P17 "administrator-configured campaign template"). Validation
 * mirrors `promoTemplateInputSchema` and the activation rules so the owner sees problems before
 * saving; the API and domain re-validate everything. Pure: no React.
 */

export type Channel = z.infer<typeof channelSchema>;
export type PromoTemplate = z.infer<typeof promoTemplateSchema>;
export type PromoTemplateInput = z.infer<typeof promoTemplateInputSchema>;
export type SubscriberClass = 'new' | 'existing' | 'lapsed';

/** Mirrors the domain bound on individually issued codes per monthly campaign. */
export const MAX_INDIVIDUAL_CODES = 100_000;

/**
 * Largest monthly budget cap the console accepts: the contract's shared promo budget bound, which
 * the template input and every campaign listing use (RV-p17-ui-2), so an accepted budget always
 * stays listable. template-form.test.ts asserts this.
 */
export const MAX_BUDGET_CENTS = MAX_PROMO_BUDGET_CENTS;

export const CHANNEL_LABEL: Record<Channel, string> = {
  app_store: 'App Store',
  play_store: 'Google Play',
  stripe: 'Web billing (Stripe)',
  amazon_appstore: 'Amazon Appstore (no store codes)',
};

export const SUBSCRIBER_LABEL: Record<SubscriberClass, string> = {
  new: 'New subscribers',
  existing: 'Existing subscribers',
  lapsed: 'Lapsed subscribers',
};

export const TIERS: readonly number[] = Array.from(
  { length: DEFAULT_MAX_PAID_SLOTS },
  (_, i) => i + 1,
);

export interface TemplateFormValues {
  name: string;
  /** '' = no school audience. */
  schoolId: string;
  percentOff: string;
  eligibleTiers: number[];
  subscriberEligibility: SubscriberClass[];
  redemptionCap: string;
  budgetDollars: string;
  calendarTimezone: string;
  timezoneConfirmed: boolean;
  windowStartDay: string;
  /** 'end_of_month' or a day number as text. */
  windowEndDay: string;
  codeMode: 'shared' | 'individual';
  individualCodeCount: string;
  sharedCodeUsageCap: string;
  channels: Channel[];
}

export type TemplateField = keyof TemplateFormValues;
export type TemplateErrors = Partial<Record<TemplateField, string | undefined>>;

/**
 * Decision: a new draft starts with no plan sizes, subscriber groups, channels or caps selected,
 * so the owner chooses every limit explicitly (spec P17: never invent unlimited budgets). The
 * calendar defaults to UTC (spec P17) and is unconfirmed until the owner ticks the confirmation.
 */
export function emptyTemplateForm(): TemplateFormValues {
  return {
    name: '',
    schoolId: '',
    percentOff: '',
    eligibleTiers: [],
    subscriberEligibility: [],
    redemptionCap: '',
    budgetDollars: '',
    calendarTimezone: 'UTC',
    timezoneConfirmed: false,
    windowStartDay: '1',
    windowEndDay: 'end_of_month',
    codeMode: 'shared',
    individualCodeCount: '',
    sharedCodeUsageCap: '',
    channels: [],
  };
}

export function templateToForm(t: PromoTemplate): TemplateFormValues {
  return {
    name: t.name,
    schoolId: t.schoolId ?? '',
    percentOff: String(t.percentOff),
    eligibleTiers: [...t.eligibleTiers],
    subscriberEligibility: [...t.subscriberEligibility],
    redemptionCap: String(t.redemptionCap),
    budgetDollars: centsToDollarsInput(t.budgetCapCents),
    calendarTimezone: t.calendarTimezone,
    timezoneConfirmed: t.timezoneConfirmed,
    windowStartDay: String(t.windowStartDay),
    windowEndDay: t.windowEndDay === 'end_of_month' ? 'end_of_month' : String(t.windowEndDay),
    codeMode: t.codeMode,
    individualCodeCount: t.individualCodeCount === undefined ? '' : String(t.individualCodeCount),
    sharedCodeUsageCap: t.sharedCodeUsageCap === undefined ? '' : String(t.sharedCodeUsageCap),
    channels: [...t.channels],
  };
}

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** True when the runtime knows `zone` as an IANA timezone. */
export function isKnownTimezone(zone: string): boolean {
  if (zone.trim() === '' || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Sorted copy without duplicates, in the canonical order of `order`. */
function ordered<T>(values: readonly T[], order: readonly T[]): T[] {
  return order.filter((v) => values.includes(v));
}

export function validateTemplateForm(
  values: TemplateFormValues,
): { ok: true; input: PromoTemplateInput } | { ok: false; errors: TemplateErrors } {
  const errors: TemplateErrors = {};
  const name = values.name.trim();
  if (name.length < 1 || name.length > 120) errors.name = 'Enter a name (up to 120 characters).';

  const percent = wholeNumber(values.percentOff);
  if (percent === null || percent < 5 || percent > 100) {
    errors.percentOff = 'Discount must be a whole percentage from 5 to 100.';
  }
  if (values.eligibleTiers.length === 0) errors.eligibleTiers = 'Choose at least one plan size.';
  if (values.subscriberEligibility.length === 0) {
    errors.subscriberEligibility = 'Choose at least one subscriber group.';
  }
  const cap = wholeNumber(values.redemptionCap);
  if (cap === null || cap < 1) {
    errors.redemptionCap = 'Enter a positive whole number of redemptions.';
  }
  const budget = parseDollarsToCents(values.budgetDollars);
  if (budget === null || budget < 1) {
    errors.budgetDollars =
      'Enter a positive dollar amount, like 2500 or 2500.50. Campaigns are never unlimited.';
  } else if (budget > MAX_BUDGET_CENTS) {
    errors.budgetDollars = `The monthly budget cap can be at most ${formatUsd(MAX_BUDGET_CENTS)}.`;
  }
  const zone = values.calendarTimezone.trim();
  if (!isKnownTimezone(zone)) {
    errors.calendarTimezone = 'Enter a valid IANA timezone, such as UTC or America/Chicago.';
  }
  const start = wholeNumber(values.windowStartDay);
  if (start === null || start < 1 || start > 28) {
    errors.windowStartDay = 'The window must start on day 1 to 28.';
  }
  const end =
    values.windowEndDay === 'end_of_month' ? 'end_of_month' : wholeNumber(values.windowEndDay);
  if (end === null || (end !== 'end_of_month' && (end < 1 || end > 31))) {
    errors.windowEndDay = 'The window must end on day 1 to 31, or at the end of the month.';
  } else if (end !== 'end_of_month' && start !== null && end < start) {
    errors.windowEndDay = 'The window must end on or after the day it starts.';
  }
  let individualCodeCount: number | undefined;
  let sharedCodeUsageCap: number | undefined;
  if (values.codeMode === 'individual') {
    const count = wholeNumber(values.individualCodeCount);
    if (count === null || count < 1 || count > MAX_INDIVIDUAL_CODES) {
      errors.individualCodeCount = `Enter how many individual codes to issue (1 to ${MAX_INDIVIDUAL_CODES.toLocaleString('en-US')}).`;
    } else {
      individualCodeCount = count;
    }
  } else if (values.sharedCodeUsageCap.trim() !== '') {
    const usage = wholeNumber(values.sharedCodeUsageCap);
    if (usage === null || usage < 1) {
      errors.sharedCodeUsageCap = 'Leave empty, or enter a positive whole number of uses.';
    } else {
      sharedCodeUsageCap = usage;
    }
  }
  if (values.channels.length === 0) errors.channels = 'Choose at least one billing channel.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const candidate = {
    name,
    schoolId: values.schoolId === '' ? null : values.schoolId,
    percentOff: percent,
    eligibleTiers: ordered(values.eligibleTiers, TIERS),
    subscriberEligibility: ordered(values.subscriberEligibility, ['new', 'existing', 'lapsed']),
    redemptionCap: cap,
    budgetCapCents: budget,
    calendarTimezone: zone,
    timezoneConfirmed: values.timezoneConfirmed,
    windowStartDay: start,
    windowEndDay: end,
    codeMode: values.codeMode,
    ...(individualCodeCount === undefined ? {} : { individualCodeCount }),
    ...(sharedCodeUsageCap === undefined ? {} : { sharedCodeUsageCap }),
    // Contract order; a hard-coded list silently dropped amazon_appstore on save (R2C-WEB-2).
    channels: ordered(values.channels, channelSchema.options),
  };
  // Final guard: exactly the shared contract the API validates.
  const parsed = promoTemplateInputSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: { name: 'Some fields are not valid.' } };
  return { ok: true, input: parsed.data };
}

/** Owner-facing names of the template settings, for "not saved as entered" messages. */
export const TEMPLATE_SETTING_LABEL: Readonly<Record<keyof PromoTemplateInput, string>> = {
  name: 'name',
  schoolId: 'school audience',
  percentOff: 'discount percent',
  eligibleTiers: 'plan sizes',
  subscriberEligibility: 'who can redeem',
  redemptionCap: 'redemption cap',
  budgetCapCents: 'budget cap',
  calendarTimezone: 'calendar timezone',
  timezoneConfirmed: 'timezone confirmation',
  windowStartDay: 'window start day',
  windowEndDay: 'window end day',
  codeMode: 'code mode',
  individualCodeCount: 'individual code count',
  sharedCodeUsageCap: 'shared code usage cap',
  channels: 'billing channels',
};

function sameSetting(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    // Lists are sets here; the server may return them in its own order.
    const left = a.map(String).sort();
    const right = b.map(String).sort();
    return left.length === right.length && left.every((v, i) => v === right[i]);
  }
  return a === b;
}

/**
 * Settings the server did not store as submitted (RV-p17-ui-3: "compare the saved result"). An
 * empty list means the saved template matches the form; otherwise the console reports the
 * difference instead of a success message.
 */
export function unsavedSettings(
  submitted: PromoTemplateInput,
  saved: PromoTemplate,
): (keyof PromoTemplateInput)[] {
  const keys = Object.keys(TEMPLATE_SETTING_LABEL) as (keyof PromoTemplateInput)[];
  return keys.filter((key) => !sameSetting(submitted[key], saved[key]));
}

/** Readable text for the domain's activation problem codes (validateTemplateForActivation). */
export const ACTIVATION_PROBLEM_TEXT: Readonly<Record<string, string>> = {
  INVALID_TEMPLATE_ID: 'The template id is not valid.',
  INVALID_PERCENT: 'Discount must be a whole percentage from 5 to 100.',
  INVALID_ELIGIBLE_TIERS: 'Choose at least one eligible plan size, each listed once.',
  INVALID_SUBSCRIBER_ELIGIBILITY: 'Choose at least one of new, existing or lapsed subscribers.',
  INVALID_REDEMPTION_CAP: 'The redemption cap must be a positive whole number.',
  MISSING_BUDGET_CAP: 'A positive budget cap is required; campaigns are never unlimited.',
  INVALID_TIMEZONE: 'The calendar timezone must be a valid IANA zone.',
  TIMEZONE_NOT_CONFIRMED: 'Confirm the calendar timezone before activating (edit the template).',
  INVALID_REDEMPTION_WINDOW: 'The window must start on day 1–28 and end on or after the start day.',
  INVALID_CODE_MODE: 'Code mode must be shared or individual.',
  MISSING_INDIVIDUAL_CODE_COUNT: `Individual codes need a count from 1 to ${MAX_INDIVIDUAL_CODES.toLocaleString('en-US')}.`,
  INVALID_CODE_CONFIG: 'Code settings do not match the selected code mode.',
  INVALID_CHANNELS: 'Choose at least one billing channel, each listed once.',
  INVALID_SCHOOL_ID: 'The school audience is not a valid school.',
};
