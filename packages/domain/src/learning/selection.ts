// Shared, deterministic item selection for daily sets and Thursday reviews (spec P7, P8).
//
// A composition is a list of slot groups (e.g. weak / spaced / confidence). Each group fills its
// slots by walking an ordered chain of stages; a stage is a skill list with a source label and a
// per-skill cap, visited round-robin so the most urgent skills come first and several skills are
// covered before any is repeated. Selection runs in four phases:
//   A. fresh templates only, each group's primary chain;
//   B. fresh templates only, the chain extended with every other relevant list;
//   C. recently used templates allowed, primary chain;
//   D. recently used templates allowed, extended chain.
// So a recently used template is chosen only when no unused fresh template exists for any skill
// the composition could legitimately use, and a template is never used twice in one composition.
import { err, ok, type Result } from '../shared/result.ts';
import { isValidIdentifier } from './evidence.ts';

export const ITEM_CATEGORIES = ['standard', 'accessible', 'diagnostic'] as const;
/**
 * `accessible` items are the easier, confidence-building variants; `diagnostic` items are brief
 * grade-level placement questions for a child with no history.
 */
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export interface CandidateItem {
  /** Reusable, nonpersonal bank template key (P7). */
  readonly templateKey: string;
  readonly skill: string;
  readonly category: ItemCategory;
}

/** Stage caps: `Infinity` for "as many as needed". */
export interface SelectionStage<S extends string> {
  readonly source: S;
  readonly skills: readonly string[];
  /** A skill is taken in this stage only while its total count in the composition is below this. */
  readonly cap: number;
}

export interface SelectionGroup<G extends string, S extends string> {
  readonly key: G;
  readonly need: number;
  readonly primary: readonly SelectionStage<S>[];
  readonly extended: readonly SelectionStage<S>[];
  readonly categoryPreference: readonly ItemCategory[];
}

export interface SelectionPick<G extends string, S extends string, I extends CandidateItem> {
  readonly group: G;
  readonly source: S;
  readonly item: I;
  readonly reusedRecentTemplate: boolean;
}

export function isItemCategory(value: unknown): value is ItemCategory {
  return typeof value === 'string' && (ITEM_CATEGORIES as readonly string[]).includes(value);
}

/** Order-preserving de-duplication of a skill list; entries must be identifiers. */
export function uniqueSkills(skills: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const skill of skills) {
    if (!isValidIdentifier(skill)) throw new RangeError('Skill lists must contain identifiers');
    if (!seen.has(skill)) {
      seen.add(skill);
      out.push(skill);
    }
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates untrusted candidate items; keeps the first occurrence of each template key.
 * `extraIdentifierFields` lists further required identifier fields (e.g. `subject`).
 */
export function normalizeCandidates<I extends CandidateItem>(
  candidates: readonly I[],
  extraIdentifierFields: readonly (keyof I & string)[] = [],
): Result<readonly I[], 'INVALID_CANDIDATE'> {
  const seen = new Set<string>();
  const out: I[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const value: unknown = candidate;
    if (
      !isPlainRecord(value) ||
      !isValidIdentifier(value['templateKey']) ||
      !isValidIdentifier(value['skill']) ||
      !isItemCategory(value['category']) ||
      extraIdentifierFields.some((field) => !isValidIdentifier(value[field]))
    ) {
      return err('INVALID_CANDIDATE', 'Candidate items need a template key, skill and category', {
        index,
      });
    }
    if (seen.has(candidate.templateKey)) continue;
    seen.add(candidate.templateKey);
    out.push(candidate);
  }
  return ok(out);
}

const PHASES = [
  { allowRecent: false, extended: false },
  { allowRecent: false, extended: true },
  { allowRecent: true, extended: false },
  { allowRecent: true, extended: true },
] as const;

/**
 * Runs the four-phase selection. `used` is shared across calls so a multi-section composition
 * (the Thursday review) never repeats a template between sections. Returns picks per group, in
 * pick order.
 */
export function selectItems<G extends string, S extends string, I extends CandidateItem>(
  groups: readonly SelectionGroup<G, S>[],
  candidates: readonly I[],
  recentlyUsed: ReadonlySet<string>,
  used: Set<string>,
): ReadonlyMap<G, readonly SelectionPick<G, S, I>[]> {
  const bySkill = new Map<string, { item: I; index: number }[]>();
  for (const [index, item] of candidates.entries()) {
    const list = bySkill.get(item.skill) ?? [];
    list.push({ item, index });
    bySkill.set(item.skill, list);
  }
  const skillCounts = new Map<string, number>();
  const picks = new Map<G, SelectionPick<G, S, I>[]>(groups.map((g) => [g.key, []]));

  const pickFor = (
    skill: string,
    allowRecent: boolean,
    preference: readonly ItemCategory[],
  ): I | undefined => {
    let best: { item: I; rank: readonly [number, number, number] } | undefined;
    for (const { item, index } of bySkill.get(skill) ?? []) {
      if (used.has(item.templateKey)) continue;
      const recent = recentlyUsed.has(item.templateKey);
      if (recent && !allowRecent) continue;
      const categoryRank = preference.indexOf(item.category);
      const rank = [
        recent ? 1 : 0,
        categoryRank === -1 ? preference.length : categoryRank,
        index,
      ] as const;
      if (
        best === undefined ||
        rank[0] < best.rank[0] ||
        (rank[0] === best.rank[0] &&
          (rank[1] < best.rank[1] || (rank[1] === best.rank[1] && rank[2] < best.rank[2])))
      ) {
        best = { item, rank };
      }
    }
    return best?.item;
  };

  for (const phase of PHASES) {
    for (const group of groups) {
      const list = picks.get(group.key);
      if (list === undefined) continue;
      const stages = phase.extended ? [...group.primary, ...group.extended] : group.primary;
      for (const stage of stages) {
        let progress = true;
        while (list.length < group.need && progress) {
          progress = false;
          for (const skill of stage.skills) {
            if (list.length >= group.need) break;
            if ((skillCounts.get(skill) ?? 0) >= stage.cap) continue;
            const item = pickFor(skill, phase.allowRecent, group.categoryPreference);
            if (item === undefined) continue;
            used.add(item.templateKey);
            skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
            list.push({
              group: group.key,
              source: stage.source,
              item,
              reusedRecentTemplate: recentlyUsed.has(item.templateKey),
            });
            progress = true;
          }
        }
      }
    }
  }
  return picks;
}

/** Counts picks whose source differs from the group's primary source, in first-seen order. */
export function countBackfills<G extends string, S extends string>(
  picks: readonly { readonly group: G; readonly source: S }[],
  primarySource: (group: G) => S,
): readonly { readonly group: G; readonly source: S; readonly count: number }[] {
  const counts = new Map<string, { group: G; source: S; count: number }>();
  for (const pick of picks) {
    if (pick.source === primarySource(pick.group)) continue;
    const key = `${pick.group}\u0000${pick.source}`;
    const entry = counts.get(key);
    if (entry === undefined) counts.set(key, { group: pick.group, source: pick.source, count: 1 });
    else entry.count += 1;
  }
  return [...counts.values()];
}
