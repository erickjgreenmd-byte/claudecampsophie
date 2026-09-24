import { err, ok, type Result } from '../shared/result.ts';
import { isValidPublisherTag } from './gates.ts';
import type { Merchant, MerchantMode } from './types.ts';

/**
 * Outbound merchant links (spec P16.3, AC_MON_12). Links are rebuilt from a validated canonical form:
 * every query parameter, fragment, path slug and `ref=` segment is dropped, so nothing we or an admin
 * pasted can carry a family/child/session identifier, and the only parameter ever added is the
 * approved publisher-level tag in `amazon_associates` mode.
 */

/** Hosts an Amazon catalog URL may use (amazon.com marketplace, en-US). */
export const AMAZON_HOSTS: readonly string[] = ['www.amazon.com', 'amazon.com'];

/**
 * Owner-reviewed hosts for non-Amazon merchant links. Empty until the owner approves a merchant in a
 * reviewed change, so `other` merchant links fail closed (the resource falls back to its
 * educational description).
 */
export const OTHER_MERCHANT_HOSTS: readonly string[] = [];

/** Query parameters that indicate a pasted affiliate/tracking link (never silently re-used). */
const AFFILIATE_PARAMS = new Set([
  'tag',
  'linkcode',
  'linkid',
  'ascsubtag',
  'creative',
  'creativeasin',
  'camp',
  'ref_',
  'th_tag',
]);

const ASIN_RE = /^[A-Z0-9]{10}$/;

export type LinkErrorCode =
  | 'URL_INVALID'
  | 'URL_NOT_HTTPS'
  | 'URL_HAS_CREDENTIALS'
  | 'URL_HAS_PORT'
  | 'HOST_NOT_ALLOWLISTED'
  | 'NOT_A_PRODUCT_URL'
  | 'AFFILIATE_PARAMS_PRESENT'
  | 'LINKS_DISABLED'
  | 'NO_MERCHANT_URL'
  | 'TAG_INVALID';

function parseHttps(raw: string): Result<URL, LinkErrorCode> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000 || /\s/.test(raw)) {
    return err('URL_INVALID', 'Enter a complete https:// link');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err('URL_INVALID', 'Enter a complete https:// link');
  }
  if (url.protocol !== 'https:') return err('URL_NOT_HTTPS', 'Links must use https://');
  if (url.username !== '' || url.password !== '') {
    return err('URL_HAS_CREDENTIALS', 'Links must not contain a user name or password');
  }
  if (url.port !== '') return err('URL_HAS_PORT', 'Links must use the default https port');
  return ok(url);
}

function extractAsin(pathname: string): string | null {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment === 'dp' && segments[i + 1] !== undefined) {
      const asin = segments[i + 1]!.toUpperCase();
      return ASIN_RE.test(asin) ? asin : null;
    }
    if (segment === 'gp' && segments[i + 1] === 'product' && segments[i + 2] !== undefined) {
      const asin = segments[i + 2]!.toUpperCase();
      return ASIN_RE.test(asin) ? asin : null;
    }
  }
  return null;
}

/**
 * Canonical amazon.com product URL (`https://www.amazon.com/dp/<ASIN>`) for the reviewed catalog.
 * A pasted affiliate link (tag/linkCode/ascsubtag…) is refused rather than silently cleaned, so a
 * foreign or arbitrary tag can never be mistaken for an approved one.
 */
export function canonicalAmazonProductUrl(raw: string): Result<string, LinkErrorCode> {
  const parsed = parseHttps(raw);
  if (!parsed.ok) return parsed;
  const url = parsed.value;
  if (!AMAZON_HOSTS.includes(url.hostname.toLowerCase())) {
    return err('HOST_NOT_ALLOWLISTED', 'Amazon resources must link to an amazon.com product page');
  }
  for (const key of url.searchParams.keys()) {
    if (AFFILIATE_PARAMS.has(key.toLowerCase())) {
      return err(
        'AFFILIATE_PARAMS_PRESENT',
        'Remove the affiliate/tracking tag; PencilLift adds only its approved tag',
      );
    }
  }
  const asin = extractAsin(url.pathname);
  if (asin === null) {
    return err('NOT_A_PRODUCT_URL', 'Use a product page link containing /dp/<ASIN>');
  }
  return ok(`https://www.amazon.com/dp/${asin}`);
}

/** Canonical non-Amazon merchant URL: owner-allowlisted host, path only (no query or fragment). */
export function canonicalOtherMerchantUrl(
  raw: string,
  allowedHosts: readonly string[] = OTHER_MERCHANT_HOSTS,
): Result<string, LinkErrorCode> {
  const parsed = parseHttps(raw);
  if (!parsed.ok) return parsed;
  const url = parsed.value;
  const host = url.hostname.toLowerCase();
  if (AMAZON_HOSTS.includes(host)) {
    return err('HOST_NOT_ALLOWLISTED', 'Amazon links must use the Amazon merchant type');
  }
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    return err('HOST_NOT_ALLOWLISTED', 'This merchant website is not on the reviewed allowlist');
  }
  return ok(`https://${host}${url.pathname}`);
}

export interface OutboundItem {
  readonly merchant: Merchant;
  readonly merchantUrl: string | null;
}

/**
 * The URL opened after a deliberate adult tap. Rebuilt from the canonical form; in
 * `amazon_associates` mode the approved publisher-level tag is the only parameter added. It never
 * accepts a family, child, session or learning input, so none can reach the merchant.
 */
export function buildOutboundUrl(
  item: OutboundItem,
  mode: MerchantMode,
  tag: string | null,
  otherHosts: readonly string[] = OTHER_MERCHANT_HOSTS,
): Result<string, LinkErrorCode> {
  if (mode === 'education_only') {
    return err('LINKS_DISABLED', 'Outbound links are not available here');
  }
  if (item.merchant === 'none' || item.merchantUrl === null) {
    return err('NO_MERCHANT_URL', 'This resource has no merchant link');
  }
  if (item.merchant === 'other') return canonicalOtherMerchantUrl(item.merchantUrl, otherHosts);
  const canonical = canonicalAmazonProductUrl(item.merchantUrl);
  if (!canonical.ok) return canonical;
  if (mode !== 'amazon_associates') return canonical;
  if (!isValidPublisherTag(tag)) {
    return err('TAG_INVALID', 'The approved publisher tag is missing or malformed');
  }
  return ok(`${canonical.value}?tag=${encodeURIComponent(tag)}`);
}
