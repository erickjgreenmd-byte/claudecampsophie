import { randomInt, type RandomSource } from '../shared/random.ts';
import { err, ok, type Result } from '../shared/result.ts';

/**
 * P17 promo codes: Crockford base32, 10 data symbols (50 bits from an injected cryptographic
 * RandomSource) plus one Crockford mod-37 check symbol. Stored and compared only in normalized
 * form (11 uppercase symbols, no separators), displayed as `XXXXX-XXXXX-C`.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Check symbols: the 32 data symbols, then `*~$=U` for values 32..36 (Crockford). */
export const CROCKFORD_CHECK_ALPHABET = `${CROCKFORD_ALPHABET}*~$=U`;
export const PROMO_CODE_DATA_LENGTH = 10;
export const PROMO_CODE_LENGTH = PROMO_CODE_DATA_LENGTH + 1;

export const PROMO_CODE_ERROR_CODES = ['CODE_INVALID_FORMAT', 'CODE_CHECKSUM_MISMATCH'] as const;
export type PromoCodeErrorCode = (typeof PROMO_CODE_ERROR_CODES)[number];

export interface GeneratedPromoCode {
  /** Canonical form stored under the unique constraint, e.g. `ABCDEFGHJKX`. */
  readonly normalized: string;
  /** Human-friendly grouping, e.g. `ABCDE-FGHJK-X`. */
  readonly display: string;
}

export interface GeneratePromoCodeOptions {
  /** Normalized codes that already exist (e.g. in this campaign batch or the database). */
  readonly exclude?: ReadonlySet<string>;
  /** Redraw limit on collision before giving up (programmer error / broken RandomSource). */
  readonly maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 16;
/**
 * Decision: raw input longer than this is rejected before any processing. A grouped code with
 * generous spacing is well under 40 characters; this bounds work done on untrusted input.
 */
const MAX_RAW_INPUT_LENGTH = 64;
/** Only ASCII letters, digits, the check-only symbols and separators are ever considered. */
const RAW_ALLOWED = /^[0-9A-Za-z*~$= \t\r\n-]*$/;
const SEPARATORS = /[ \t\r\n-]/g;
const NORMALIZED_RE = /^[0-9A-HJKMNP-TV-Z]{10}[0-9A-HJKMNP-TV-Z*~$=U]$/;

function dataValue(symbol: string): number {
  const value = CROCKFORD_ALPHABET.indexOf(symbol);
  if (value < 0) throw new RangeError(`Not a Crockford data symbol: ${symbol}`);
  return value;
}

/** Crockford mod-37 check symbol for a string of data symbols (value computed incrementally). */
export function crockfordCheckSymbol(data: string): string {
  let remainder = 0;
  for (const symbol of data) remainder = (remainder * 32 + dataValue(symbol)) % 37;
  const check = CROCKFORD_CHECK_ALPHABET[remainder];
  if (check === undefined) throw new Error('unreachable: remainder out of range');
  return check;
}

/** Groups a normalized code for display. Throws on anything that is not a valid normalized code. */
export function formatPromoCode(normalized: string): string {
  if (!NORMALIZED_RE.test(normalized) || !hasValidCheck(normalized)) {
    throw new RangeError('formatPromoCode expects a valid normalized promo code');
  }
  return `${normalized.slice(0, 5)}-${normalized.slice(5, 10)}-${normalized.slice(10)}`;
}

function hasValidCheck(normalized: string): boolean {
  return crockfordCheckSymbol(normalized.slice(0, PROMO_CODE_DATA_LENGTH)) === normalized.slice(10);
}

/**
 * One fresh code. Each data symbol is `randomInt(32)`, which is unbiased (256 % 32 === 0) and draws
 * from the injected RandomSource only. Pass `cryptoRandom` in production.
 */
export function generatePromoCode(
  random: RandomSource,
  opts: GeneratePromoCodeOptions = {},
): GeneratedPromoCode {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let data = '';
    for (let i = 0; i < PROMO_CODE_DATA_LENGTH; i += 1) {
      data += CROCKFORD_ALPHABET[randomInt(32, random)] ?? '';
    }
    const normalized = data + crockfordCheckSymbol(data);
    if (opts.exclude?.has(normalized)) continue;
    return { normalized, display: formatPromoCode(normalized) };
  }
  throw new Error(
    `Could not draw a distinct promo code in ${maxAttempts} attempts; the RandomSource is broken`,
  );
}

/**
 * `count` distinct codes (individual-code campaigns). Uniqueness across campaigns is enforced by the
 * database unique constraint; pass already-stored codes in `exclude` to avoid a retry round trip.
 */
export function generatePromoCodes(
  random: RandomSource,
  count: number,
  opts: GeneratePromoCodeOptions = {},
): GeneratedPromoCode[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('count must be a non-negative integer');
  }
  const taken = new Set(opts.exclude ?? []);
  const codes: GeneratedPromoCode[] = [];
  while (codes.length < count) {
    const code = generatePromoCode(random, {
      exclude: taken,
      ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
    });
    taken.add(code.normalized);
    codes.push(code);
  }
  return codes;
}

/**
 * Normalizes untrusted user entry to the canonical stored form, or explains why it cannot be a code.
 * Uppercases ASCII only, strips spaces/hyphens, maps O->0 and I/L->1, rejects U (and the check-only
 * symbols) in data positions, and verifies the check symbol.
 *
 * Decision: the Crockford check alphabet (`*~$=U`) is accepted in the final position, matching the
 * `promo_codes.code_normalized` constraint. Non-ASCII input is rejected before case folding, so
 * look-alikes such as dotless i or long s cannot fold into valid symbols.
 */
export function normalizePromoCode(input: string): Result<string, PromoCodeErrorCode> {
  const invalid = () =>
    err(
      'CODE_INVALID_FORMAT',
      'Enter the 11-character code exactly as shown (letters and digits).',
    );
  if (
    typeof input !== 'string' ||
    input.length > MAX_RAW_INPUT_LENGTH ||
    !RAW_ALLOWED.test(input)
  ) {
    return invalid();
  }
  const compact = input
    .replace(SEPARATORS, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (compact.length !== PROMO_CODE_LENGTH || !NORMALIZED_RE.test(compact)) return invalid();
  if (!hasValidCheck(compact)) {
    return err('CODE_CHECKSUM_MISMATCH', 'This code has a typo; please check each character.');
  }
  return ok(compact);
}
