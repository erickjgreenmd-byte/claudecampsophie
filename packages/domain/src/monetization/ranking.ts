import { OTHER_MERCHANT_HOSTS } from './links.ts';
import {
  FREE_RESOURCE_KINDS,
  type Merchant,
  type MerchantMode,
  type ResourceAvailability,
  type ResourceKind,
  type ResourceStatus,
  type ResourceSubject,
} from './types.ts';

/**
 * Educational relevance ranking for the reviewed resource catalog (spec P10, P16.3, AC_MON_08).
 * The input type deliberately has no commission, fee, sponsor or bid field: commercial terms cannot
 * change a relevance score. Scores use skill overlap, grade fit, catalog availability and budget
 * (free options win ties), never merchant economics.
 */
export interface RankableResource {
  readonly id: string;
  readonly stableKey: string;
  readonly subjects: readonly ResourceSubject[];
  readonly skills: readonly string[];
  readonly gradeMin: number;
  readonly gradeMax: number;
  readonly kind: ResourceKind;
  readonly availability: ResourceAvailability;
  readonly status: ResourceStatus;
}

export interface ResourceQuery {
  readonly subject?: ResourceSubject | undefined;
  readonly grade?: number | undefined;
  readonly skills?: readonly string[] | undefined;
}

export interface RankedResource<T extends RankableResource> {
  readonly item: T;
  readonly relevance: number;
}

/** Pure relevance score for one reviewed, approved resource, or null when it does not fit. */
export function relevanceScore(item: RankableResource, query: ResourceQuery): number | null {
  if (item.status !== 'approved' || item.availability === 'unavailable') return null;
  if (query.subject !== undefined && !item.subjects.includes(query.subject)) return null;
  if (query.grade !== undefined && (query.grade < item.gradeMin || query.grade > item.gradeMax)) {
    return null;
  }
  const wanted = new Set((query.skills ?? []).map((s) => s.toLowerCase()));
  const skillMatches = item.skills.filter((s) => wanted.has(s.toLowerCase())).length;
  const gradeFit = query.grade === undefined ? 0 : Math.max(0, 3 - (item.gradeMax - item.gradeMin));
  const budget = FREE_RESOURCE_KINDS.includes(item.kind) ? 1 : 0;
  const availability = item.availability === 'unknown' ? -1 : 0;
  return skillMatches * 10 + gradeFit + budget + availability;
}

export function rankResources<T extends RankableResource>(
  items: readonly T[],
  query: ResourceQuery,
): RankedResource<T>[] {
  const ranked: RankedResource<T>[] = [];
  for (const item of items) {
    // Only the RankableResource fields are read; extra (e.g. commercial) fields are ignored.
    const relevance = relevanceScore(
      {
        id: item.id,
        stableKey: item.stableKey,
        subjects: item.subjects,
        skills: item.skills,
        gradeMin: item.gradeMin,
        gradeMax: item.gradeMax,
        kind: item.kind,
        availability: item.availability,
        status: item.status,
      },
      query,
    );
    if (relevance !== null) ranked.push({ item, relevance });
  }
  return ranked.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      (a.item.stableKey < b.item.stableKey ? -1 : a.item.stableKey > b.item.stableKey ? 1 : 0),
  );
}

export interface ItemModeContext {
  /**
   * True when the recommendation was derived from a child's learning data. Such recommendations are
   * never affiliate-linked (spec P16.3): at most a plain link.
   */
  readonly personalized: boolean;
  readonly otherHosts?: readonly string[];
}

/** The mode a single catalog item is shown in, given the property's resolved merchant mode. */
export function effectiveItemMode(
  propertyMode: MerchantMode,
  item: { readonly merchant: Merchant; readonly merchantUrl: string | null },
  ctx: ItemModeContext,
): MerchantMode {
  if (propertyMode === 'education_only') return 'education_only';
  if (item.merchant === 'none' || item.merchantUrl === null) return 'education_only';
  if (item.merchant === 'other') {
    let host: string | null;
    try {
      host = new URL(item.merchantUrl).hostname.toLowerCase();
    } catch {
      host = null;
    }
    const allowed = (ctx.otherHosts ?? OTHER_MERCHANT_HOSTS).map((h) => h.toLowerCase());
    return host !== null && allowed.includes(host) ? 'plain_link' : 'education_only';
  }
  if (propertyMode === 'amazon_associates' && ctx.personalized) return 'plain_link';
  return propertyMode;
}
