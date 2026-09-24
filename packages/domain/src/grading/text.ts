/**
 * Text normalization shared by the deterministic checkers. All inputs are untrusted transcription
 * or model output (spec P5): these helpers only transform strings and never interpret them as code.
 */

/**
 * Invisible format characters (soft hyphen, zero-width space/joiners, bidi marks, word joiner,
 * BOM). They render as nothing, so a transcription containing them must grade exactly like the
 * visible text.
 */
const INVISIBLE_FORMAT_CHARS = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_FORMAT_CHARS, '');
}

/** True when the answer is empty after compatibility normalization and invisible-char removal. */
export function isBlankAnswer(text: string): boolean {
  return stripInvisible(text.normalize('NFKC')).trim() === '';
}

/** Curly/prime quotes to ASCII so ’ and ' compare equal. */
export function foldQuotes(text: string): string {
  return text.replace(/[‘’‚‛ʼ′＇]/g, "'").replace(/[“”„‟″＂]/g, '"');
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
