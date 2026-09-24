import type {
  ApprovalStatus,
  MerchantMode,
  MonetizationEnvironment,
  MonetizationPlatform,
  MonetizationProvider,
  MonetizationSwitches,
  SwitchKey,
} from './types.ts';

/**
 * Policy and provider gates (spec P16.2, P16.3, AC_MON_09/10/14). A monetization path is enabled only
 * when the owner's global and provider switches are on AND a recorded approval exists for the exact
 * provider, platform, property and locale, is approved, reviewed in the past, unexpired and backed
 * by a real evidence reference. A boolean, an account key or a tag never passes on its own, and a
 * mobile Amazon approval must also record its permitted linking tool/API.
 */

export interface MonetizationApproval {
  readonly id: string;
  readonly provider: MonetizationProvider;
  readonly platform: MonetizationPlatform;
  readonly propertyIdentifier: string;
  readonly locale: string;
  readonly status: ApprovalStatus;
  readonly policyReviewedAt: Date;
  readonly expiresAt: Date;
  readonly evidenceRef: string;
  /** Amazon publisher-level tag issued under this approval; null for other providers. */
  readonly publisherTag: string | null;
  /**
   * Reference to the recorded determination of which Amazon-permitted linking tool/API this
   * property may use (spec P16.3 "approved-mobile-app and permitted-linking-tool requirements",
   * AC_MON_10). Required for `amazon_associates` on iOS/Android; always null for other providers.
   */
  readonly linkingToolRef: string | null;
}

/** The deployed property a request is served from (bundle id / package name / web origin). */
export interface MonetizationProperty {
  readonly platform: MonetizationPlatform;
  readonly identifier: string;
  readonly locale: string;
}

export interface GateContext {
  readonly environment: MonetizationEnvironment;
  readonly property: MonetizationProperty;
  readonly approvals: readonly MonetizationApproval[];
  readonly switches: MonetizationSwitches;
  readonly now: Date;
}

export type GateReason =
  | 'GLOBAL_SWITCH_OFF'
  | 'PROVIDER_SWITCH_OFF'
  | 'NO_NETWORK_ADAPTER'
  | 'NO_APPROVAL'
  | 'APPROVAL_NOT_APPROVED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_REVIEW_IN_FUTURE'
  | 'EVIDENCE_INVALID'
  | 'FIXTURE_EVIDENCE_OUTSIDE_TEST'
  | 'TAG_MISSING'
  | 'TAG_INVALID'
  | 'LINKING_TOOL_MISSING'
  | 'LINKING_TOOL_INVALID'
  | 'LINKS_NOT_PERMITTED';

/** Values that look like switches or stubs, not policy evidence (same spirit as packages/ai gate). */
const PLACEHOLDER_REFERENCES = new Set([
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'ok',
  'okay',
  'enabled',
  'disabled',
  'approved',
  'granted',
  'eligible',
  'pending',
  'unknown',
  'none',
  'null',
  'undefined',
  'n/a',
  'na',
  'tbd',
  'todo',
  'test',
  'testing',
  'fixture',
  'mock',
  'placeholder',
  'evidence',
]);

/**
 * Words that state a status, a boolean, a switch, a provider, a platform or a credential kind, and
 * so identify no document, ticket or letter. A reference made only of these words (in any
 * punctuation, casing or serialization: `Approved.`, `amazon_associates=true`,
 * `{"approved":true}`) is not evidence (RV-MON-08). Mirrored by app.monetization_reference_ok()
 * in supabase/migrations/0640_monetization.sql; keep the two lists identical.
 */
export const NON_IDENTIFYING_WORDS: ReadonlySet<string> = new Set([
  // booleans, statuses and placeholders
  ...[...PLACEHOLDER_REFERENCES].filter((w) => /^[a-z]+$/.test(w)),
  'y',
  'n',
  'a',
  '0',
  '1',
  'nil',
  'enable',
  'disable',
  'approve',
  'approval',
  'grant',
  'eligibility',
  'verified',
  'confirmed',
  'accepted',
  'allowed',
  'active',
  'live',
  'done',
  'complete',
  'completed',
  'pass',
  'passed',
  'valid',
  'checked',
  'reviewed',
  'review',
  'status',
  'flag',
  'set',
  'value',
  // filler
  'is',
  'was',
  'has',
  'been',
  'by',
  'the',
  'and',
  'for',
  'of',
  'to',
  'in',
  'it',
  'we',
  'are',
  'our',
  'all',
  'see',
  // providers, programs, platforms and credential kinds
  'amazon',
  'associate',
  'associates',
  'affiliate',
  'program',
  'programme',
  'account',
  'sponsor',
  'direct',
  'network',
  'ad',
  'ads',
  'provider',
  'ios',
  'android',
  'web',
  'app',
  'apps',
  'mobile',
  'site',
  'website',
  'store',
  'tag',
  'tracking',
  'id',
  'publisher',
  'key',
  'api',
  'client',
  'secret',
  'token',
  'policy',
]);

/** Evidence references for labeled test fixtures; accepted only in development/test. */
export const FIXTURE_EVIDENCE_PREFIX = 'fixture:';

/** Credential-shaped strings: an API key or secret is not evidence of eligibility (AC_MON_09). */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /^(sk|pk|rk|ak|key|api[_-]?key|secret|token)[-_:][A-Za-z0-9_-]{8,}$/i,
  /^(AKIA|ASIA)[A-Z0-9]{12,}$/,
  /^AIza[0-9A-Za-z_-]{20,}$/,
  // Amazon (Login with Amazon / SP-API / Alexa) client ids, client secrets and account ids.
  /^amzn1\./i,
  // JSON Web Token.
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^xox[abprs]-/i,
  /^bearer\s/i,
  // A credential pasted as an assignment ("client_id=...", "api key: ...").
  /\b(client[\s_-]?(id|secret)|api[\s_-]?key|access[\s_-]?key|secret[\s_-]?key|password|passwd|token)\s*[:=]/i,
  // Long opaque token with no separators a document/ticket reference would carry.
  /^[A-Za-z0-9+/=]{32,}$/,
];

/**
 * Amazon tracking-id shape used on its own ("pencillift-20", "my-store-21"): letter-led segments
 * and a marketplace suffix. A tag identifies an Associates account, never the eligibility of a
 * property (AC_MON_10: an arbitrary tag or generic Associates account does not pass readiness).
 */
const BARE_TRACKING_ID = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*-2[0-9]$/i;

export type EvidenceQuality = 'real' | 'fixture' | 'invalid';

export interface EvidenceContext {
  /** The approval's own publisher tag: evidence that is (only) this tag is not evidence. */
  readonly publisherTag?: string | null;
}

/**
 * Classifies a recorded evidence reference (spec P16.2: "a boolean, account key or fixture does
 * not establish eligibility"). `real` only means it has the shape of a document/ticket/letter
 * reference; the owner still verifies the evidence itself.
 */
export function evidenceQuality(reference: string, context: EvidenceContext = {}): EvidenceQuality {
  const trimmed = reference.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith(FIXTURE_EVIDENCE_PREFIX)) {
    return trimmed.length - FIXTURE_EVIDENCE_PREFIX.length >= 3 ? 'fixture' : 'invalid';
  }
  if (trimmed.length < 6 || trimmed.length > 300) return 'invalid';
  if (PLACEHOLDER_REFERENCES.has(lower)) return 'invalid';
  // A serialized object or array is data, not a reference to where the evidence is kept.
  if (/^[[{]/.test(trimmed)) return 'invalid';
  if (CREDENTIAL_PATTERNS.some((p) => p.test(trimmed))) return 'invalid';
  if (!/[a-z]/i.test(trimmed)) return 'invalid';
  if (BARE_TRACKING_ID.test(trimmed)) return 'invalid';
  let rest = lower;
  const tag = context.publisherTag?.trim().toLowerCase();
  if (tag) rest = rest.split(tag).join(' ');
  const words = rest.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  if (words.every((w) => NON_IDENTIFYING_WORDS.has(w))) return 'invalid';
  return 'real';
}

/** Evidence quality of an approval record, judged against its own publisher tag. */
export function approvalEvidenceQuality(
  approval: Pick<MonetizationApproval, 'evidenceRef' | 'publisherTag'>,
): EvidenceQuality {
  return evidenceQuality(approval.evidenceRef, { publisherTag: approval.publisherTag });
}

/** Platforms where Amazon's approved-mobile-app and permitted-linking-tool rules apply. */
export const AMAZON_MOBILE_PLATFORMS: readonly MonetizationPlatform[] = ['ios', 'android'];

/** Whether `approval` must record a permitted Amazon linking tool/API (spec P16.3, AC_MON_10). */
export function requiresLinkingTool(
  approval: Pick<MonetizationApproval, 'provider' | 'platform'>,
): boolean {
  return (
    approval.provider === 'amazon_associates' && AMAZON_MOBILE_PLATFORMS.includes(approval.platform)
  );
}

/** Quality of the recorded linking-tool reference (null when none is recorded). */
export function linkingToolQuality(
  approval: Pick<MonetizationApproval, 'linkingToolRef' | 'publisherTag'>,
): EvidenceQuality | null {
  if (approval.linkingToolRef === null || approval.linkingToolRef.trim() === '') return null;
  return evidenceQuality(approval.linkingToolRef, { publisherTag: approval.publisherTag });
}

/** True when any reference the approval relies on is a labeled development/test fixture. */
function isFixtureApproval(approval: MonetizationApproval): boolean {
  return (
    approvalEvidenceQuality(approval) === 'fixture' ||
    (requiresLinkingTool(approval) && linkingToolQuality(approval) === 'fixture')
  );
}

/** Amazon publisher-level tag shape, e.g. "pencillift-20" (store suffix required). */
export const PUBLISHER_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}-\d{2}$/i;

export function isValidPublisherTag(tag: string | null | undefined): tag is string {
  return typeof tag === 'string' && PUBLISHER_TAG_PATTERN.test(tag);
}

function switchOn(switches: MonetizationSwitches, key: SwitchKey): boolean {
  return switches[key] === true;
}

export interface ProviderGateResult {
  readonly enabled: boolean;
  readonly reasons: readonly GateReason[];
  readonly approval: MonetizationApproval | null;
  /** True when the matching approval is a labeled fixture (development/test only). */
  readonly fixture: boolean;
}

function approvalProblem(
  approval: MonetizationApproval,
  environment: MonetizationEnvironment,
  now: Date,
): GateReason | null {
  if (approval.status !== 'approved') {
    return approval.status === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_NOT_APPROVED';
  }
  if (approval.expiresAt.getTime() <= now.getTime()) return 'APPROVAL_EXPIRED';
  if (approval.policyReviewedAt.getTime() > now.getTime()) return 'APPROVAL_REVIEW_IN_FUTURE';
  const testing = environment === 'development' || environment === 'test';
  const quality = approvalEvidenceQuality(approval);
  if (quality === 'invalid') return 'EVIDENCE_INVALID';
  if (quality === 'fixture' && !testing) return 'FIXTURE_EVIDENCE_OUTSIDE_TEST';
  // Mobile affiliate links: appending a tag is not a permitted linking mechanism by itself. The
  // approval must record which Amazon-permitted linking tool/API applies to this property.
  if (requiresLinkingTool(approval)) {
    const linking = linkingToolQuality(approval);
    if (linking === null) return 'LINKING_TOOL_MISSING';
    if (linking === 'invalid') return 'LINKING_TOOL_INVALID';
    if (linking === 'fixture' && !testing) return 'FIXTURE_EVIDENCE_OUTSIDE_TEST';
  }
  return null;
}

/**
 * Whether `provider` may run on this property right now. `ad_network` is always disabled: this build
 * ships no third-party ad SDK/adapter (spec P16.2), whatever the switches or records say.
 */
export function providerGate(provider: MonetizationProvider, ctx: GateContext): ProviderGateResult {
  const reasons: GateReason[] = [];
  if (!switchOn(ctx.switches, 'global')) reasons.push('GLOBAL_SWITCH_OFF');
  if (!switchOn(ctx.switches, `provider:${provider}`)) reasons.push('PROVIDER_SWITCH_OFF');
  if (provider === 'ad_network') reasons.push('NO_NETWORK_ADAPTER');

  const matching = ctx.approvals.filter(
    (a) =>
      a.provider === provider &&
      a.platform === ctx.property.platform &&
      a.propertyIdentifier === ctx.property.identifier &&
      a.locale === ctx.property.locale,
  );
  let chosen: MonetizationApproval | null = null;
  let firstProblem: GateReason | null = null;
  for (const approval of matching) {
    const problem = approvalProblem(approval, ctx.environment, ctx.now);
    if (problem === null) {
      // Prefer real evidence over a fixture, then the latest expiry (deterministic).
      if (
        chosen === null ||
        (isFixtureApproval(chosen) && !isFixtureApproval(approval)) ||
        (isFixtureApproval(chosen) === isFixtureApproval(approval) &&
          approval.expiresAt.getTime() > chosen.expiresAt.getTime())
      ) {
        chosen = approval;
      }
    } else {
      firstProblem ??= problem;
    }
  }
  if (chosen === null) reasons.push(firstProblem ?? 'NO_APPROVAL');
  return {
    enabled: reasons.length === 0,
    reasons,
    approval: reasons.length === 0 ? chosen : null,
    fixture: chosen !== null && isFixtureApproval(chosen),
  };
}

export interface MerchantModeInput extends GateContext {
  /**
   * Whether plain outbound merchant links are permitted for this property/locale at all (e.g. the
   * catalog only holds amazon.com URLs, so other locales fall back to education_only).
   */
  readonly linksPermitted: boolean;
}

export interface MerchantModeResult {
  readonly mode: MerchantMode;
  /** Why a richer mode was not selected (empty for amazon_associates). */
  readonly reasons: readonly GateReason[];
  /** Publisher-level tag, only in amazon_associates mode. */
  readonly tag: string | null;
  /** The amazon_associates approval is a labeled test fixture (never counts as live). */
  readonly fixture: boolean;
}

/**
 * Server-side merchant mode per property/platform/locale (spec P16.3, AC_MON_09/10). Only an
 * approved, unexpired `amazon_associates` approval for this exact property with real evidence, a
 * valid publisher tag and (on iOS/Android) a recorded permitted linking tool/API, plus the global
 * and Amazon switches, yields `amazon_associates`.
 */
export function resolveMerchantMode(input: MerchantModeInput): MerchantModeResult {
  if (!input.linksPermitted) {
    return { mode: 'education_only', reasons: ['LINKS_NOT_PERMITTED'], tag: null, fixture: false };
  }
  const gate = providerGate('amazon_associates', input);
  const reasons: GateReason[] = [...gate.reasons];
  let tag: string | null = null;
  if (gate.enabled && gate.approval) {
    if (gate.approval.publisherTag === null || gate.approval.publisherTag.trim() === '') {
      reasons.push('TAG_MISSING');
    } else if (!isValidPublisherTag(gate.approval.publisherTag)) {
      reasons.push('TAG_INVALID');
    } else {
      tag = gate.approval.publisherTag;
    }
  }
  if (reasons.length === 0 && tag !== null) {
    return { mode: 'amazon_associates', reasons: [], tag, fixture: gate.fixture };
  }
  return { mode: 'plain_link', reasons, tag: null, fixture: false };
}
