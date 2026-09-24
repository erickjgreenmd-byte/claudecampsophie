// Daily extra-credit set composition (spec P7, AC_LEARNING_04). Offered every local day including
// weekends: nothing here depends on the weekday, and the optional `localDate` is only echoed.
import { DateTime } from 'luxon';
import { err, ok, type Result } from '../shared/result.ts';
import type { CalendarDate } from '../shared/time.ts';
import {
  countBackfills,
  normalizeCandidates,
  selectItems,
  uniqueSkills,
  type CandidateItem,
  type ItemCategory,
  type SelectionGroup,
  type SelectionStage,
} from './selection.ts';

export const DAILY_SET_MIN_COUNT = 3;
export const DAILY_SET_MAX_COUNT = 10;
export const DEFAULT_DAILY_SET_COUNT = 5;

/** Target shares in percent (P7 "roughly 60% / 20% / 20%"). */
export const DAILY_MIX_PERCENT = Object.freeze({ weak: 60, spaced: 20, confidence: 20 });

/**
 * Decision: a weak skill gets at most two questions before prerequisites and current material are
 * each offered once; only then do weak skills repeat. This keeps a single weak concept from
 * turning a set into rote repetition while still weighting the most urgent skills.
 */
export const WEAK_SKILL_FIRST_PASS_CAP = 2;

export const DAILY_SLOTS = ['weak', 'spaced', 'confidence', 'diagnostic'] as const;
export type DailySlot = (typeof DAILY_SLOTS)[number];

export const DAILY_ITEM_SOURCES = [
  'weak',
  'prerequisite',
  'current_material',
  'spaced_review',
  'confidence',
  'grade_fallback',
] as const;
export type DailyItemSource = (typeof DAILY_ITEM_SOURCES)[number];

export const DAILY_SET_ERROR_CODES = [
  'INVALID_COUNT',
  'INVALID_LOCAL_DATE',
  'INVALID_CANDIDATE',
  'NO_SKILLS_AVAILABLE',
  'NO_CANDIDATE_ITEMS',
] as const;
export type DailySetErrorCode = (typeof DAILY_SET_ERROR_CODES)[number];

export interface DailyMix {
  readonly weak: number;
  readonly spaced: number;
  readonly confidence: number;
}

export interface DailySetInput {
  /** Questions in the set, integer 3..10; default 5. */
  readonly count?: number;
  /** The family-local date the set is for (`YYYY-MM-DD`); echoed, never changes the selection. */
  readonly localDate?: CalendarDate;
  /** Weak skills, most urgent first (e.g. `prioritizeSkills(...).map((r) => r.skill)`). */
  readonly weakSkills: readonly string[];
  readonly spacedReviewSkills: readonly string[];
  readonly confidenceSkills: readonly string[];
  /** Parent-selected grade/subject skills: the diagnostic pool and the last-resort fallback. */
  readonly gradeFallbackSkills: readonly string[];
  readonly prerequisiteSkills?: readonly string[];
  /** Current study material: teacher spelling lists, current reading passages, study guides. */
  readonly currentMaterialSkills?: readonly string[];
  readonly recentlyUsedTemplateKeys: ReadonlySet<string>;
  readonly candidateItems: readonly CandidateItem[];
}

export interface DailySetItem {
  readonly templateKey: string;
  readonly skill: string;
  readonly category: ItemCategory;
  readonly slot: DailySlot;
  readonly source: DailyItemSource;
  readonly reusedRecentTemplate: boolean;
}

export type DailySetNote =
  | {
      readonly code: 'BACKFILLED';
      readonly slot: DailySlot;
      readonly source: DailyItemSource;
      readonly count: number;
    }
  | {
      readonly code:
        'NO_HISTORY_GRADE_DIAGNOSTIC' | 'RECENT_TEMPLATE_REUSED' | 'INSUFFICIENT_CANDIDATES';
      readonly count: number;
    };

export interface DailySet {
  readonly count: number;
  readonly localDate?: CalendarDate;
  /** `grade_diagnostic` when there is no learning history to adapt to (P7). */
  readonly mode: 'adaptive' | 'grade_diagnostic';
  /** Weak items first, then spaced review, then confidence building (or all diagnostic). */
  readonly items: readonly DailySetItem[];
  /** Items actually placed per slot. */
  readonly mix: DailyMix & { readonly diagnostic: number };
  readonly notes: readonly DailySetNote[];
}

/**
 * Target slot counts for a set of `count` questions: largest-remainder rounding of 60/20/20
 * (remainder ties go weak > spaced > confidence), then at least one confidence item, taken from
 * weak. Resulting table (weak/spaced/confidence):
 *
 * | count | 3     | 4     | 5     | 6     | 7     | 8     | 9     | 10    |
 * |-------|-------|-------|-------|-------|-------|-------|-------|-------|
 * | mix   | 1/1/1 | 2/1/1 | 3/1/1 | 4/1/1 | 4/2/1 | 5/2/1 | 5/2/2 | 6/2/2 |
 */
export function dailyMix(count: number): DailyMix {
  if (!Number.isInteger(count) || count < DAILY_SET_MIN_COUNT || count > DAILY_SET_MAX_COUNT) {
    throw new RangeError(
      `Daily set size must be an integer ${DAILY_SET_MIN_COUNT}..${DAILY_SET_MAX_COUNT}`,
    );
  }
  // Integer arithmetic in hundredths: no floating-point remainders.
  const parts = (['weak', 'spaced', 'confidence'] as const).map((slot, order) => {
    const scaled = count * DAILY_MIX_PERCENT[slot];
    return { slot, order, value: Math.floor(scaled / 100), remainder: scaled % 100 };
  });
  let remaining = count - parts.reduce((sum, p) => sum + p.value, 0);
  const byRemainder = [...parts].sort((a, b) => b.remainder - a.remainder || a.order - b.order);
  for (const part of byRemainder) {
    if (remaining === 0) break;
    part.value += 1;
    remaining -= 1;
  }
  const mix = {
    weak: parts[0]?.value ?? 0,
    spaced: parts[1]?.value ?? 0,
    confidence: parts[2]?.value ?? 0,
  };
  if (mix.confidence === 0) {
    mix.confidence = 1;
    mix.weak -= 1;
  }
  return mix;
}

export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).isValid;
}

const STANDARD_FIRST: readonly ItemCategory[] = ['standard', 'accessible', 'diagnostic'];
const ACCESSIBLE_FIRST: readonly ItemCategory[] = ['accessible', 'standard', 'diagnostic'];
const DIAGNOSTIC_FIRST: readonly ItemCategory[] = ['diagnostic', 'standard', 'accessible'];

const PRIMARY_SOURCE: Readonly<Record<DailySlot, DailyItemSource>> = {
  weak: 'weak',
  spaced: 'spaced_review',
  confidence: 'confidence',
  diagnostic: 'grade_fallback',
};

/**
 * Composes one day's practice set.
 *
 * Adaptive mode backfill chains (each slot's own pool first):
 * - weak: weak skills (max 2 each) -> prerequisites (1 each) -> current material (1 each) ->
 *   more weak -> more prerequisites/current -> grade fallback;
 * - spaced review: spaced skills -> weak -> prerequisites -> current material -> grade fallback;
 * - confidence: confidence skills (accessible items preferred) -> spaced skills -> grade fallback.
 * Every backfill is recorded in `notes`. With no history at all (no weak, spaced, confidence,
 * prerequisite or current-material skills) the whole set is a grade-level diagnostic. Decision: those
 * items use a distinct `diagnostic` slot (reported in `mix.diagnostic`) and prefer diagnostic items.
 * A short set is returned with an INSUFFICIENT_CANDIDATES note rather than invented content.
 */
export function composeDailySet(input: DailySetInput): Result<DailySet, DailySetErrorCode> {
  const count = input.count ?? DEFAULT_DAILY_SET_COUNT;
  if (!Number.isInteger(count) || count < DAILY_SET_MIN_COUNT || count > DAILY_SET_MAX_COUNT) {
    return err(
      'INVALID_COUNT',
      `Daily set size must be an integer from ${DAILY_SET_MIN_COUNT} to ${DAILY_SET_MAX_COUNT}`,
    );
  }
  if (input.localDate !== undefined && !isCalendarDate(input.localDate)) {
    return err('INVALID_LOCAL_DATE', 'localDate must be a valid YYYY-MM-DD date');
  }
  const candidates = normalizeCandidates(input.candidateItems);
  if (!candidates.ok) return candidates;

  const weak = uniqueSkills(input.weakSkills);
  const spaced = uniqueSkills(input.spacedReviewSkills);
  const confidence = uniqueSkills(input.confidenceSkills);
  const grade = uniqueSkills(input.gradeFallbackSkills);
  const prerequisite = uniqueSkills(input.prerequisiteSkills ?? []);
  const current = uniqueSkills(input.currentMaterialSkills ?? []);
  const noHistory =
    weak.length + spaced.length + confidence.length + prerequisite.length + current.length === 0;
  if (noHistory && grade.length === 0) {
    return err('NO_SKILLS_AVAILABLE', 'No weak, review, confidence or grade-level skills to use');
  }

  const all = (
    source: DailyItemSource,
    skills: readonly string[],
  ): SelectionStage<DailyItemSource> => ({
    source,
    skills,
    cap: Number.POSITIVE_INFINITY,
  });
  const once = (
    source: DailyItemSource,
    skills: readonly string[],
    cap = 1,
  ): SelectionStage<DailyItemSource> => ({
    source,
    skills,
    cap,
  });

  let groups: SelectionGroup<DailySlot, DailyItemSource>[];
  if (noHistory) {
    groups = [
      {
        key: 'diagnostic',
        need: count,
        primary: [all('grade_fallback', grade)],
        extended: [],
        categoryPreference: DIAGNOSTIC_FIRST,
      },
    ];
  } else {
    const mix = dailyMix(count);
    groups = [
      {
        key: 'weak',
        need: mix.weak,
        primary: [
          once('weak', weak, WEAK_SKILL_FIRST_PASS_CAP),
          once('prerequisite', prerequisite),
          once('current_material', current),
          all('weak', weak),
          all('prerequisite', prerequisite),
          all('current_material', current),
          all('grade_fallback', grade),
        ],
        extended: [all('spaced_review', spaced), all('confidence', confidence)],
        categoryPreference: STANDARD_FIRST,
      },
      {
        key: 'spaced',
        need: mix.spaced,
        primary: [
          once('spaced_review', spaced),
          all('spaced_review', spaced),
          all('weak', weak),
          all('prerequisite', prerequisite),
          all('current_material', current),
          all('grade_fallback', grade),
        ],
        extended: [all('confidence', confidence)],
        categoryPreference: STANDARD_FIRST,
      },
      {
        key: 'confidence',
        need: mix.confidence,
        primary: [
          once('confidence', confidence),
          all('confidence', confidence),
          all('spaced_review', spaced),
          all('grade_fallback', grade),
        ],
        extended: [
          all('weak', weak),
          all('prerequisite', prerequisite),
          all('current_material', current),
        ],
        categoryPreference: ACCESSIBLE_FIRST,
      },
    ];
  }

  const picks = selectItems(groups, candidates.value, input.recentlyUsedTemplateKeys, new Set());
  const ordered = groups.flatMap((g) => picks.get(g.key) ?? []);
  if (ordered.length === 0) {
    return err('NO_CANDIDATE_ITEMS', 'No candidate items match the available skills');
  }
  const items: DailySetItem[] = ordered.map((pick) => ({
    templateKey: pick.item.templateKey,
    skill: pick.item.skill,
    category: pick.item.category,
    slot: pick.group,
    source: pick.source,
    reusedRecentTemplate: pick.reusedRecentTemplate,
  }));

  const notes: DailySetNote[] = [];
  if (noHistory) {
    notes.push({ code: 'NO_HISTORY_GRADE_DIAGNOSTIC', count: items.length });
  } else {
    for (const b of countBackfills(ordered, (slot) => PRIMARY_SOURCE[slot])) {
      notes.push({ code: 'BACKFILLED', slot: b.group, source: b.source, count: b.count });
    }
  }
  const reused = items.filter((i) => i.reusedRecentTemplate).length;
  if (reused > 0) notes.push({ code: 'RECENT_TEMPLATE_REUSED', count: reused });
  if (items.length < count)
    notes.push({ code: 'INSUFFICIENT_CANDIDATES', count: count - items.length });

  const slotCount = (slot: DailySlot): number => items.filter((i) => i.slot === slot).length;
  return ok({
    count,
    ...(input.localDate === undefined ? {} : { localDate: input.localDate }),
    mode: noHistory ? 'grade_diagnostic' : 'adaptive',
    items,
    mix: {
      weak: slotCount('weak'),
      spaced: slotCount('spaced'),
      confidence: slotCount('confidence'),
      diagnostic: slotCount('diagnostic'),
    },
    notes,
  });
}
