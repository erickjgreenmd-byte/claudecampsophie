// Input guards for the donations module. Violations are programmer errors (malformed normalized
// facts or bypassed database constraints), so these throw instead of returning a Result.
import { assertCents, type Cents } from '../shared/money.ts';

/**
 * Characters a reader cannot see or that are not text: controls (Cc), format characters such as
 * zero-width spaces/joiners, the word joiner, bidi controls and the soft hyphen (Cf), surrogates,
 * private-use and unassigned code points (Cs/Co/Cn), the remaining default-ignorable code points
 * (e.g. U+3164 HANGUL FILLER) and the line/paragraph separators. `trim()` and `\s` miss most of
 * them (RV-donations-3), so a value made only of them would look empty in an audit log.
 */
const HIDDEN_CHARACTER = /[\p{C}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;
const HIDDEN_CHARACTERS = new RegExp(HIDDEN_CHARACTER.source, 'gu');
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** 1..128 characters, no whitespace or hidden characters (UUIDs, provider ids, `fam_…`). */
const ID_RE = /^[^\s\p{C}\p{Default_Ignorable_Code_Point}]{1,128}$/u;

export function isWellFormedId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export function assertId(value: string, label: string): string {
  if (!isWellFormedId(value)) {
    throw new RangeError(
      `${label} must be 1-128 characters without whitespace, control or invisible characters`,
    );
  }
  return value;
}

/** True when the text contains any character from HIDDEN_CHARACTER. */
export function containsHiddenCharacters(text: string): boolean {
  return HIDDEN_CHARACTER.test(text);
}

/**
 * True when the text, ignoring hidden characters, contains at least one letter or digit, i.e. it
 * shows something a person can read back (whitespace, U+2800 BRAILLE BLANK or punctuation alone
 * cannot identify anything).
 */
export function hasReadableContent(text: string): boolean {
  return LETTER_OR_DIGIT.test(text.replace(HIDDEN_CHARACTERS, ''));
}

export function assertInstant(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date`);
  }
  return value;
}

export function assertNonNegativeCents(value: number, label: string): Cents {
  assertCents(value, label);
  if (value < 0) throw new RangeError(`${label} must not be negative, received ${value}`);
  return value;
}
