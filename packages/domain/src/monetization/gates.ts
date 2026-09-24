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
 * by a real evidence reference. A boolean, an account key or a tag never passes on its own.
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

/** Evidence references for labeled test fixtures; accepted only in development/test. */
export const FIXTURE_EVIDENCE_PREFIX = 'fixture:';

/** Credential-shaped strings: an API key or secret is not evidence of eligibility (AC_MON_09). */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /^(sk|pk|rk|ak|key|api[_-]?key|secret|token)[-_:][A-Za-z0-9_-]{8,}$/i,
  /^AKIA[A-Z0-9]{12,}$/,
  /^AIza[0-9A-Za-z_-]{20,}$/,
  // Long opaque token with no separators a document/ticket reference would carry.
  /^[A-Za-z0-9+/=]{32,}$/,
];

export type EvidenceQuality = 'real' | 'fixture' | 'invalid';

export function evidenceQuality(reference: string): EvidenceQuality {
  const trimmed = reference.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith(FIXTURE_EVIDENCE_PREFIX)) {
    return trimmed.length - FIXTURE_EVIDENCE_PREFIX.length >= 3 ? 'fixture' : 'invalid';
  }
  if (trimmed.length < 6 || trimmed.length > 300) return 'invalid';
  if (PLACEHOLDER_REFERENCES.has(lower)) return 'invalid';
  if (CREDENTIAL_PATTERNS.some((p) => p.test(trimmed))) return 'invalid';
  if (!/[a-z]/i.test(trimmed)) return 'invalid';
  return 'real';
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
  const quality = evidenceQuality(approval.evidenceRef);
  if (quality === 'invalid') return 'EVIDENCE_INVALID';
  if (quality === 'fixture' && environment !== 'development' && environment !== 'test') {
    return 'FIXTURE_EVIDENCE_OUTSIDE_TEST';
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
        (evidenceQuality(chosen.evidenceRef) === 'fixture' &&
          evidenceQuality(approval.evidenceRef) === 'real') ||
        (evidenceQuality(chosen.evidenceRef) === evidenceQuality(approval.evidenceRef) &&
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
    fixture: chosen !== null && evidenceQuality(chosen.evidenceRef) === 'fixture',
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
 * approved, unexpired `amazon_associates` approval for this exact property with real evidence and a
 * valid publisher tag, plus the global and Amazon switches, yields `amazon_associates`.
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
