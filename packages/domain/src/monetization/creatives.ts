/**
 * Sponsor creative validation (spec P16.1, P16.5, AC_MON_06). Creatives are plain owner-approved
 * text plus an optional first-party, licensed image asset: no HTML, scripts, event handlers,
 * embedded links, remote images or tracking pixels, and the call to action must go to an https
 * destination on the sponsor's reviewed domain allowlist.
 */

export interface CreativeInput {
  readonly headline: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly destinationUrl: string;
  /** First-party asset key in our own storage (never a URL). */
  readonly imageAssetRef: string | null;
  /** Reference to the image license/permission record. */
  readonly imageLicenseRef: string | null;
}

export type CreativeProblemCode =
  | 'HEADLINE_LENGTH'
  | 'BODY_LENGTH'
  | 'CTA_LENGTH'
  | 'MARKUP_NOT_ALLOWED'
  | 'EMBEDDED_LINK'
  | 'TRACKING_PIXEL'
  | 'DESTINATION_INVALID'
  | 'DESTINATION_NOT_HTTPS'
  | 'DESTINATION_NOT_ALLOWLISTED'
  | 'IMAGE_REF_INVALID'
  | 'IMAGE_LICENSE_REQUIRED';

export interface CreativeProblem {
  readonly code: CreativeProblemCode;
  readonly field: keyof CreativeInput;
}

export const CREATIVE_LIMITS = { headline: 80, body: 240, ctaLabel: 24 } as const;

/** First-party asset key, e.g. "sponsors/3f2a/logo-v2.png": never a scheme or host. */
export const FIRST_PARTY_ASSET_KEY = /^[a-z0-9][a-z0-9/_.-]{2,200}$/;

const MARKUP_PATTERNS: readonly RegExp[] = [
  /[<>]/,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:/i,
  /\bon[a-z]+\s*=/i,
  /&(#\d+|#x[0-9a-f]+|[a-z]{2,8});/i,
  /\{\{|\}\}|\$\{/,
];

/** Markup that could execute or render if a destination were ever interpolated into a page. */
const URL_MARKUP_PATTERNS: readonly RegExp[] = [
  /[<>"'`]/,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:/i,
];

const LINK_PATTERN = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|app|ly)\b\/)/i;

/** Remote image / beacon markers (tracking pixels, 1x1 gifs, analytics beacons). */
const PIXEL_PATTERN =
  /(\.(gif|png|jpe?g|webp|svg)(\?|$)|1x1|\bpixel\b|\bbeacon\b|\/track(ing)?\b|\/collect\b|\butm_[a-z]+=)/i;

const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain);
}

function hostAllowed(host: string, allowedDomains: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowedDomains.some((d) => {
    const domain = d.toLowerCase();
    return h === domain || h.endsWith(`.${domain}`);
  });
}

function textProblems(
  field: 'headline' | 'body' | 'ctaLabel',
  value: string,
  max: number,
  lengthCode: CreativeProblemCode,
): CreativeProblem[] {
  const out: CreativeProblem[] = [];
  const trimmed = value.trim();
  if (trimmed.length === 0 || value.length > max) out.push({ code: lengthCode, field });
  if (MARKUP_PATTERNS.some((p) => p.test(value))) out.push({ code: 'MARKUP_NOT_ALLOWED', field });
  if (PIXEL_PATTERN.test(value) && /https?:|www\./i.test(value)) {
    out.push({ code: 'TRACKING_PIXEL', field });
  } else if (LINK_PATTERN.test(value)) {
    out.push({ code: 'EMBEDDED_LINK', field });
  }
  return out;
}

/** Returns every problem (empty = acceptable for human review; review is still required). */
export function validateCreative(
  input: CreativeInput,
  allowedDomains: readonly string[],
): CreativeProblem[] {
  const problems: CreativeProblem[] = [
    ...textProblems('headline', input.headline, CREATIVE_LIMITS.headline, 'HEADLINE_LENGTH'),
    ...textProblems('body', input.body, CREATIVE_LIMITS.body, 'BODY_LENGTH'),
    ...textProblems('ctaLabel', input.ctaLabel, CREATIVE_LIMITS.ctaLabel, 'CTA_LENGTH'),
  ];

  const destination = input.destinationUrl;
  let url: URL | null = null;
  if (destination.length > 500 || /\s/.test(destination)) {
    problems.push({ code: 'DESTINATION_INVALID', field: 'destinationUrl' });
  } else {
    try {
      url = new URL(destination);
    } catch {
      problems.push({ code: 'DESTINATION_INVALID', field: 'destinationUrl' });
    }
  }
  if (url !== null) {
    if (url.protocol !== 'https:') {
      problems.push({ code: 'DESTINATION_NOT_HTTPS', field: 'destinationUrl' });
    } else if (url.username !== '' || url.password !== '' || url.port !== '') {
      problems.push({ code: 'DESTINATION_INVALID', field: 'destinationUrl' });
    } else if (
      !isValidDomain(url.hostname.toLowerCase()) ||
      !hostAllowed(url.hostname, allowedDomains.filter(isValidDomain))
    ) {
      problems.push({ code: 'DESTINATION_NOT_ALLOWLISTED', field: 'destinationUrl' });
    }
    if (URL_MARKUP_PATTERNS.some((p) => p.test(decodeURIComponentSafe(destination)))) {
      problems.push({ code: 'MARKUP_NOT_ALLOWED', field: 'destinationUrl' });
    }
  }

  if (input.imageAssetRef !== null) {
    const ref = input.imageAssetRef;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) {
      // A URL here would make clients fetch a remote (advertiser-controlled) asset.
      problems.push({ code: 'TRACKING_PIXEL', field: 'imageAssetRef' });
    } else if (!FIRST_PARTY_ASSET_KEY.test(ref) || ref.includes('..')) {
      problems.push({ code: 'IMAGE_REF_INVALID', field: 'imageAssetRef' });
    }
    if (input.imageLicenseRef === null || input.imageLicenseRef.trim().length < 6) {
      problems.push({ code: 'IMAGE_LICENSE_REQUIRED', field: 'imageLicenseRef' });
    }
  }
  return problems;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
