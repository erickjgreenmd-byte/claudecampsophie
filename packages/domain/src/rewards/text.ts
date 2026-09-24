// Untrusted-text helpers for the rewards module. Text is only inspected, never executed or echoed.

/**
 * Code points that render as nothing (Unicode Default_Ignorable_Code_Point): zero-width spaces and
 * joiners, soft hyphens, BOM, and the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0. The
 * fillers are general category Lo, so a plain \p{L} test counts them as letters although they look
 * blank (review finding RV-rewards-1). They are removed before any "does this say something" check.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/** The text with every invisible (default-ignorable) code point removed. */
export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/**
 * Decision: an answer is "meaningful" when, ignoring invisible code points, it contains at least
 * one Unicode letter, number or math symbol. So "7", "x", "½", "π", "<" and "=" count (comparison
 * and fraction questions have one-character answers), while blank, whitespace, zero-width
 * characters, Hangul fillers, punctuation-only ("...", "?") and emoji-only input do not. This is
 * the P9 "rapid empty guesses" gate; timing and the one-award-per-instance cap bound everything
 * else.
 */
const MEANINGFUL_CHARACTER = /[\p{L}\p{N}\p{Sm}]/u;

export function isMeaningfulText(text: string): boolean {
  return MEANINGFUL_CHARACTER.test(withoutInvisible(text));
}

/**
 * Decision: prose written for a person (an adjustment's audit reason) must contain at least one
 * visible Unicode letter or number. Unlike an answer, a math symbol alone ("+", "~", "<>=") says
 * nothing about why points changed, so it is treated as blank (review finding RV-rewards-2).
 */
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

export function hasLetterOrNumber(text: string): boolean {
  return LETTER_OR_NUMBER.test(withoutInvisible(text));
}

/** Length in code points so astral characters are not double-counted against limits. */
export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/** Reads an own property only, so values inherited through the prototype chain are ignored. */
export function ownField(source: object, field: string): unknown {
  return Object.hasOwn(source, field) ? (source as Record<string, unknown>)[field] : undefined;
}

export function isPlainRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
