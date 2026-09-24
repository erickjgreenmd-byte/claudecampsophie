// Untrusted-text helpers for the rewards module. Text is only inspected, never executed or echoed.

/**
 * Decision: an answer or reason is "meaningful" when it contains at least one Unicode letter,
 * number or math symbol. So "7", "x", "½", "π", "<" and "=" count (comparison and fraction
 * questions have one-character answers), while blank, whitespace, zero-width characters,
 * punctuation-only ("...", "?") and emoji-only input do not. This is the P9 "rapid empty guesses"
 * gate; timing and the one-award-per-instance cap bound everything else.
 */
const MEANINGFUL_CHARACTER = /[\p{L}\p{N}\p{Sm}]/u;

export function isMeaningfulText(text: string): boolean {
  return MEANINGFUL_CHARACTER.test(text);
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
