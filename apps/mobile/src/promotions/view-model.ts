import { formatUsd } from '@pencillift/domain';
import type {
  Channel,
  FamilySchool,
  PromoQuote,
  PromoRedemption,
  RedemptionState,
  SchoolSummary,
} from './types.ts';

/**
 * View models for the parent School and promotions screen (spec P17 parent interfaces;
 * AC_PROMO_14). Every status is spelled out in text, never colour alone. Pure: no react-native
 * imports, no clock; amounts come from the API as integer cents.
 */

export interface DisplayOptions {
  /** IANA zone for dates; the device zone when omitted (tests pass one for determinism). */
  readonly timeZone?: string | undefined;
  readonly nativeStoreStepAvailable: boolean;
}

// ---------------------------------------------------------------------------------------------
// Calendar and date labels
// ---------------------------------------------------------------------------------------------

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function monthParts(month: string): { year: string; name: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match?.[1] && name ? { year: match[1], name } : null;
}

/** "2026-10" -> "October 2026". */
export function monthLabel(month: string): string {
  const parts = monthParts(month);
  return parts ? `${parts.name} ${parts.year}` : month;
}

/** "2026-10" -> "October 1, 2026" (the first day of a program month). */
export function monthStartLabel(month: string): string {
  const parts = monthParts(month);
  return parts ? `${parts.name} 1, ${parts.year}` : month;
}

export function longDate(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

// ---------------------------------------------------------------------------------------------
// School designation
// ---------------------------------------------------------------------------------------------

export const ONE_SCHOOL_RULE =
  'One school per family; a change starts next month. The current month stays with the school you had at its start.';

export const CONTRIBUTION_LINES: readonly string[] = [
  'PencilLift contributes $1/month for each month your family pays full price, to the one school you choose.',
  'Discounted months (any code, 5%–100%) contribute $0.',
  'The contribution is funded by PencilLift. It is not an extra charge to you and not a tax-deductible donation by you.',
];

export function schoolPlace(s: SchoolSummary): string {
  const place = [s.city, s.region].filter((x): x is string => Boolean(x)).join(', ');
  return place ? `${s.name} (${place})` : s.name;
}

export interface SchoolView {
  readonly currentLine: string;
  readonly pendingLine: string | null;
  /** Choosing the current school again cancels a pending change. */
  readonly keepCurrent: SchoolSummary | null;
  readonly timezoneLine: string;
}

export function buildSchoolView(data: FamilySchool): SchoolView {
  const { current, pending } = data;
  return {
    currentLine: current
      ? `Current school: ${schoolPlace(current)}`
      : 'No school chosen yet, so there is no school contribution until you choose one.',
    pendingLine: pending
      ? `Changing to ${schoolPlace(pending.school)} from ${monthStartLabel(pending.effectiveFromMonth)}.${
          current ? ` ${current.name} stays your school until then.` : ''
        }`
      : null,
    keepCurrent: pending && current ? current : null,
    timezoneLine: `Program months follow ${data.programTimezone} time.`,
  };
}

export function chooseSchoolPrompt(data: FamilySchool, chosen: SchoolSummary): string {
  return data.current || data.pending
    ? `Choose ${chosen.name}? A change starts on the first day of next month; this month stays with your current school.`
    : `Choose ${chosen.name}? If you haven’t chosen a school before, it applies from this month. Otherwise a change starts on the first day of next month.`;
}

/**
 * What the server saved (RV-p17-ui-8). With the designation shown before the choice, a school that
 * was already current "stays", and one that becomes current immediately (a first choice applies
 * from the current program month) "is now" the family's school. Without it, the message only states
 * the saved result and never claims the school merely stayed.
 */
export function savedSchoolMessage(
  next: FamilySchool,
  chosen: SchoolSummary,
  previous?: FamilySchool,
): string {
  if (next.pending?.school.id === chosen.id) {
    return `Saved. ${chosen.name} becomes your school on ${monthStartLabel(next.pending.effectiveFromMonth)}.`;
  }
  if (next.current?.id === chosen.id) {
    if (previous?.current?.id === chosen.id) {
      return previous.pending
        ? `Saved. ${chosen.name} stays your school; the pending change was cancelled.`
        : `Saved. ${chosen.name} stays your school with no change pending.`;
    }
    if (previous) {
      return `Saved. ${chosen.name} is now your school, starting this month (${next.programTimezone} time).`;
    }
    return `Saved. ${chosen.name} is your school${next.pending ? '' : ' with no change pending'}.`;
  }
  return 'Saved.';
}

// ---------------------------------------------------------------------------------------------
// Code entry and quote
// ---------------------------------------------------------------------------------------------

export function validateCodeEntry(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length < 8 || trimmed.length > 24
    ? 'Enter the code exactly as shown, including any dashes.'
    : null;
}

/**
 * The store that bills subscriptions bought on this device. Decision: the app never offers web
 * billing, so in-app redemption can never steer a family around store billing.
 */
export function channelForPlatform(platform: 'ios' | 'android' | 'web'): Channel | null {
  if (platform === 'ios') return 'app_store';
  if (platform === 'android') return 'play_store';
  return null;
}

export const STORE_NAME: Record<Channel, string> = {
  app_store: 'App Store',
  play_store: 'Google Play',
  stripe: 'Web billing',
  amazon_appstore: 'Amazon Appstore',
};

export type RedeemAvailability =
  { readonly available: true } | { readonly available: false; readonly reason: string };

export interface QuoteView {
  readonly heading: string;
  readonly periodLine: string;
  readonly onePeriodLine: string;
  readonly amounts: readonly { label: string; value: string }[];
  readonly renewalLine: string;
  readonly previewLine: string;
  readonly donationLine: string;
  readonly redeem: RedeemAvailability;
}

export function buildQuoteView(quote: PromoQuote, options: DisplayOptions): QuoteView {
  const native = quote.channel !== 'stripe';
  return {
    heading: `${quote.percentOff}% off · ${monthLabel(quote.campaignMonth)} code`,
    periodLine:
      quote.targetPeriod.kind === 'first_full_period'
        ? 'Applies to your first full monthly billing period.'
        : `Applies to your renewal starting ${longDate(quote.targetPeriod.periodStart, options.timeZone)} (expected date — your store sets the exact date).`,
    onePeriodLine: 'This code covers one monthly billing period only; it never renews itself.',
    amounts: [
      { label: 'Regular price', value: formatUsd(quote.regularCents) },
      { label: 'Discount', value: `−${formatUsd(quote.discountCents)}` },
      { label: 'You would pay', value: formatUsd(quote.chargedCents) },
    ],
    renewalLine: `Without a new code your next renewal is ${formatUsd(quote.nextRegularRenewalCents)}.`,
    previewLine: 'Preview — your store shows the final amount.',
    donationLine:
      'A discounted month contributes $0 to your school. Full-price months contribute $1 from PencilLift.',
    redeem:
      native && !options.nativeStoreStepAvailable
        ? {
            available: false,
            reason: `Redeeming ${STORE_NAME[quote.channel]} codes needs the store’s offer sheet, which isn’t available in this version of the app yet. No code has been used, and your next renewal stays at the regular price.`,
          }
        : { available: true },
  };
}

// ---------------------------------------------------------------------------------------------
// Redemption status and history
// ---------------------------------------------------------------------------------------------

export const STATE_LABEL: Record<RedemptionState, string> = {
  reserved: 'Reserved – waiting for the store step',
  provider_pending: 'Waiting for the store to confirm',
  confirmed: 'Confirmed by the store',
  rejected: 'Not applied – the store declined it',
  expired: 'Expired – not applied',
  reconciled: 'Used – discounted month completed',
};

export function nextActionLine(
  redemption: PromoRedemption,
  options: DisplayOptions,
): string | null {
  const action = redemption.nextAction;
  if (action?.kind === 'present_store_offer') {
    return options.nativeStoreStepAvailable
      ? 'Confirm the offer in your store to finish. No discount has been applied until the store confirms it.'
      : 'This code needs your store’s offer sheet, which isn’t available in this version of the app yet. No discount has been applied; unless your store confirms an offer, your next renewal stays at the regular price.';
  }
  if (action?.kind === 'await_provider') {
    return 'Your discount is not final until the store confirms it. Your store receipt is the final amount.';
  }
  return null;
}

export interface HistoryRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly status: string;
  readonly next: string | null;
}

export function historyRows(
  redemptions: readonly PromoRedemption[],
  options: DisplayOptions,
): HistoryRow[] {
  return redemptions.map((r) => ({
    id: r.id,
    title: `${monthLabel(r.campaignMonth)} code · ${r.percentOff}% off`,
    detail: `${
      r.targetPeriodStart
        ? `Billing period starting ${longDate(r.targetPeriodStart, options.timeZone)}`
        : 'Your first full monthly billing period'
    } · ${formatUsd(r.chargedCents)} instead of ${formatUsd(r.regularCents)}`,
    status: `Status: ${STATE_LABEL[r.state]}`,
    next: nextActionLine(r, options),
  }));
}
