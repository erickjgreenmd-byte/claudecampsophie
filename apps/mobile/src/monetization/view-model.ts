import type {
  MonetizationPreferences,
  PlacementResponse,
  ResourceItem,
  ResourcesResponse,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  AMAZON_ASSOCIATES_DISCLOSURE,
  AMAZON_PRICE_NOTE,
  PLAIN_LINK_DISCLOSURE,
} from '@pencillift/domain/monetization';
import type { AppMode } from '../lib/mode.ts';

/**
 * View models for the parent Resources screen (spec P10 resources, P16.1/P16.3; AC_MON_02/03/05/08).
 * Pure: no react-native imports, no clock, no network.
 *
 * Commercial content exists only in parent mode. Every builder here returns nothing commercial
 * (no resource cards, no sponsor card) unless the app mode is 'parent'. Child routes never import
 * this module (see child-navigation.test.ts).
 */

export type Platform = 'ios' | 'android' | 'web';
export type Subject = ResourceItem['subjects'][number];
export type MerchantMode = ResourceItem['mode'];
export type ResourcePlacement = 'adult_dashboard' | 'resources_browse';

export const CHILD_MODE_REFUSAL =
  'Resources and sponsor cards are only for grown-ups. Unlock the parent area to see them.';

// ---------------------------------------------------------------------------------------------
// Filters and request paths
// ---------------------------------------------------------------------------------------------

export interface ResourceFilters {
  readonly subject: Subject | null;
  readonly grade: number | null;
  readonly skill: string | null;
}

export const NO_FILTERS: ResourceFilters = { subject: null, grade: null, skill: null };

export const SUBJECT_LABEL: Readonly<Record<Subject, string>> = {
  math: 'Math',
  reading: 'Reading',
  spelling_vocabulary: 'Spelling and vocabulary',
  grammar_writing: 'Grammar and writing',
  science: 'Science',
  social_studies: 'Social studies',
};

export const SUBJECT_OPTIONS: readonly { value: Subject | 'all'; label: string }[] = [
  { value: 'all', label: 'All subjects' },
  ...(Object.keys(SUBJECT_LABEL) as Subject[]).map((value) => ({
    value,
    label: SUBJECT_LABEL[value],
  })),
];

export const GRADE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'any', label: 'Any grade' },
  ...Array.from({ length: 13 }, (_, grade) => ({
    value: String(grade),
    label: grade === 0 ? 'K' : String(grade),
  })),
];

export const KIND_LABEL: Readonly<Record<ResourceItem['kind'], string>> = {
  workbook: 'Workbook',
  flashcards: 'Flashcards',
  manipulative: 'Hands-on manipulative',
  parent_exercise: 'Parent-led exercise (free)',
  in_app_practice: 'In-app practice (free)',
};

export function gradeName(grade: number): string {
  return grade === 0 ? 'Kindergarten' : `Grade ${grade}`;
}

export function gradeRange(min: number, max: number): string {
  const short = (g: number) => (g === 0 ? 'K' : String(g));
  return min === max ? gradeName(min) : `Grades ${short(min)}–${short(max)}`;
}

/** "math.fractions.compare" -> "math fractions compare". */
export function skillLabel(skill: string): string {
  return skill.replace(/[._:-]+/g, ' ').trim();
}

/** Skill chips: skills present in the loaded list, plus the chosen one. Sorted for stability. */
export function skillOptions(items: readonly ResourceItem[], chosen: string | null): string[] {
  const all = new Set(items.flatMap((item) => item.skills));
  if (chosen) all.add(chosen);
  return [...all].sort();
}

/** "en-US"-style device locale for the API, or null so the server uses its default. */
export function apiLocale(deviceLocale: string | null | undefined): string | null {
  return deviceLocale && /^[a-z]{2}-[A-Z]{2}$/.test(deviceLocale) ? deviceLocale : null;
}

function withLocale(query: URLSearchParams, locale: string | null): string {
  if (locale) query.set('locale', locale);
  return query.toString();
}

export function resourcesPath(
  filters: ResourceFilters,
  platform: Platform,
  locale: string | null,
): string {
  const query = new URLSearchParams({ platform });
  if (filters.subject) query.set('subject', filters.subject);
  if (filters.grade !== null) query.set('grade', String(filters.grade));
  if (filters.skill) query.set('skill', filters.skill);
  return `/v1/resources?${withLocale(query, locale)}`;
}

export function outboundPath(itemId: string, platform: Platform, locale: string | null): string {
  const query = new URLSearchParams({ platform });
  return `/v1/resources/${encodeURIComponent(itemId)}/outbound?${withLocale(query, locale)}`;
}

export function placementPath(
  placement: ResourcePlacement,
  platform: Platform,
  locale: string | null,
): string {
  const query = new URLSearchParams({ placement, platform });
  return `/v1/placements?${withLocale(query, locale)}`;
}

// ---------------------------------------------------------------------------------------------
// Resource cards
// ---------------------------------------------------------------------------------------------

/**
 * The adjacent disclosure for a linked item. Amazon's required sentence is always used in
 * affiliate mode, whatever text the server sent.
 */
export function disclosureFor(mode: MerchantMode): string | null {
  if (mode === 'amazon_associates') return AMAZON_ASSOCIATES_DISCLOSURE;
  if (mode === 'plain_link') return PLAIN_LINK_DISCLOSURE;
  return null;
}

export interface ResourceLinkView {
  readonly mode: MerchantMode;
  readonly label: string;
  /** Shown as visible text right beside the button, wrapping at any text size. */
  readonly disclosure: string;
  readonly a11yLabel: string;
  /** Screen readers announce the disclosure with the button. */
  readonly a11yHint: string;
}

export interface ResourceCardView {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly description: string;
  readonly freeNote: string | null;
  readonly priceNote: string | null;
  readonly availabilityNote: string | null;
  readonly noLinkNote: string | null;
  readonly link: ResourceLinkView | null;
}

export type ResourcesView =
  | { readonly kind: 'refused'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly cards: readonly ResourceCardView[];
      readonly orderNote: string;
      readonly hiddenNote: string | null;
      readonly emptyMessage: string | null;
    };

export const ORDER_NOTE =
  'Listed by learning fit: skills, grade and availability, with free options first when they fit equally well. Commission never changes the order.';

function resourceCard(
  item: ResourceItem,
  mode: MerchantMode,
  focusSkill: string | null,
): ResourceCardView {
  const disclosure = disclosureFor(mode);
  const free = item.merchant === 'none';
  const unavailable = item.availability === 'unavailable';
  const linked = disclosure !== null && !free && !unavailable;
  const label = item.merchant === 'amazon' ? 'View on Amazon' : 'Open website';
  const focus = focusSkill !== null && item.skills.includes(focusSkill);
  return {
    id: item.id,
    title: item.title,
    meta: [
      KIND_LABEL[item.kind],
      gradeRange(item.gradeMin, item.gradeMax),
      item.subjects.map((s) => SUBJECT_LABEL[s]).join(', '),
      ...(focus ? ['Practices your focus skill'] : []),
    ].join(' · '),
    description: item.description,
    freeNote: free ? 'Free: no purchase needed.' : null,
    // Prices are never shown: no authorized, refreshed price source exists.
    priceNote: linked && item.merchant === 'amazon' ? AMAZON_PRICE_NOTE : null,
    availabilityNote: unavailable ? 'Currently unavailable.' : null,
    noLinkNote:
      !free && !linked && !unavailable
        ? 'No outside link is offered here. The description is for reference.'
        : null,
    link:
      linked && disclosure !== null
        ? {
            mode,
            label,
            disclosure,
            a11yLabel: `${label}: ${item.title}`,
            a11yHint: `${disclosure} Opens in your browser, outside PencilLift.`,
          }
        : null,
  };
}

/**
 * Resource cards for the parent screen. Refuses (no cards at all) unless the app is in parent
 * mode. `modeOverrides` holds items whose link mode changed since the list loaded, so the new
 * disclosure is shown before the link can open.
 */
export function buildResourcesView(
  mode: AppMode,
  data: ResourcesResponse,
  filters: ResourceFilters,
  modeOverrides: Readonly<Record<string, MerchantMode>> = {},
): ResourcesView {
  if (mode !== 'parent') return { kind: 'refused', message: CHILD_MODE_REFUSAL };
  return {
    kind: 'ready',
    cards: data.items.map((item) =>
      resourceCard(item, modeOverrides[item.id] ?? item.mode, filters.skill),
    ),
    orderNote: ORDER_NOTE,
    hiddenNote: data.commercialHidden
      ? 'Shopping links are hidden by your choice. Free learning options are still shown.'
      : null,
    emptyMessage:
      data.items.length === 0
        ? 'No resources match yet. Try another subject, grade or focus skill.'
        : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Sponsor card
// ---------------------------------------------------------------------------------------------

export interface SponsorCardView {
  readonly serveToken: string;
  /** "Sponsored by <business>", or "Advertisement: ..." for any other server label. */
  readonly label: string;
  readonly whyShown: string;
  readonly headline: string | null;
  readonly body: string | null;
  readonly ctaLabel: string;
  readonly leaveNote: string;
  readonly ctaA11yHint: string;
}

/**
 * The single sponsor card for a parent screen, or null. Null whenever the app is not in parent
 * mode, the parent hides sponsor cards, nothing was served, or the card is for another placement.
 */
export function buildSponsorCardView(
  mode: AppMode,
  response: PlacementResponse | null,
  prefs: MonetizationPreferences | null,
  placement: ResourcePlacement,
): SponsorCardView | null {
  if (mode !== 'parent') return null;
  if (prefs === null || prefs.hideSponsorCards) return null;
  const card = response?.card ?? null;
  if (card === null || card.placement !== placement) return null;
  const leaveNote = card.destinationHost
    ? `Opens ${card.destinationHost} in your browser. You will leave PencilLift.`
    : 'Opens the sponsor’s site in your browser. You will leave PencilLift.';
  const label = card.label.startsWith('Sponsored by ')
    ? card.label
    : `Advertisement: ${card.label}`;
  return {
    serveToken: card.serveToken,
    label,
    whyShown: card.whyShown,
    headline: card.headline || null,
    body: card.body || null,
    ctaLabel: card.ctaLabel || 'Visit sponsor',
    leaveNote,
    ctaA11yHint: `${label}. ${leaveNote}`,
  };
}

export type ReportCategory = 'inappropriate' | 'misleading' | 'irrelevant' | 'other';

export const REPORT_OPTIONS: readonly { value: ReportCategory; label: string }[] = [
  { value: 'inappropriate', label: 'Inappropriate' },
  { value: 'misleading', label: 'Misleading' },
  { value: 'irrelevant', label: 'Not relevant' },
  { value: 'other', label: 'Something else' },
];

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export interface MonetizationProblem {
  readonly message: string;
  /** The server wants a fresh parent-PIN unlock. */
  readonly needsPin: boolean;
}

export type ProblemContext = 'load' | 'link' | 'sponsor';

const FALLBACK: Readonly<Record<ProblemContext, string>> = {
  load: 'We couldn’t load resources. Please try again.',
  link: 'We couldn’t open this link. Please try again.',
  sponsor: 'That didn’t work. Please try again.',
};

/** Adult-facing wording for a failed resources, link or sponsor request (branches on codes). */
export function monetizationError(error: unknown, context: ProblemContext): MonetizationProblem {
  if (!(error instanceof ApiRequestError)) return { message: FALLBACK[context], needsPin: false };
  if (error.code === 'STEP_UP_REQUIRED') {
    return { message: 'Enter your parent PIN to continue.', needsPin: true };
  }
  if (error.code === 'NETWORK' || error.code === 'RATE_LIMITED') {
    return { message: error.message, needsPin: false };
  }
  if (context === 'link' && error.rule === 'LINKS_UNAVAILABLE') {
    return { message: 'This resource has no outside link here.', needsPin: false };
  }
  if (error.code === 'NOT_FOUND') {
    const gone: Record<ProblemContext, string> = {
      load: 'Create your family first, then come back to resources.',
      link: 'This resource is no longer available.',
      sponsor: 'This sponsored card is no longer available.',
    };
    return { message: gone[context], needsPin: false };
  }
  return { message: FALLBACK[context], needsPin: false };
}
