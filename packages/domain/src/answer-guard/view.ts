// A canonical view of one piece of text plus the raw finding shape detectors emit.

import { canonicalizePreservingCase } from './canonicalize.ts';
import type { EncodingKind, LeakDetector } from './types.ts';

export interface TextView {
  /** Canonical text, case preserved (multiple-choice letters and base64 are case-sensitive). */
  readonly text: string;
  /** `text` lowercased code point by code point, so offsets are identical in both. */
  readonly lower: string;
}

export interface RawFinding {
  readonly detector: LeakDetector;
  readonly answerIndex: number | null;
  readonly technique: string;
  /** Offsets in the view's canonical text. */
  readonly start: number;
  readonly end: number;
  /** Encoding chain when the detector itself matched encoded content. */
  readonly via?: readonly EncodingKind[];
}

/** Lowercases per code point, keeping a character whose lowercase form changes length. */
export function lowerAligned(text: string): string {
  let out = '';
  for (const c of text) {
    const l = c.toLowerCase();
    out += l.length === c.length ? l : c;
  }
  return out;
}

export function viewOfCanonical(canonicalText: string): TextView {
  return { text: canonicalText, lower: lowerAligned(canonicalText) };
}

export function makeView(raw: string): TextView {
  return viewOfCanonical(canonicalizePreservingCase(raw));
}

const EVIDENCE_PUNCTUATION = new Set(['/', '.', ',', '%', '(', ')', '-', ':', '+', '=', '[', ']']);
const MAX_SHAPE = 24;

/**
 * Masked shape of a matched span: letters -> '*', digits -> '#', whitespace -> ' ', a few
 * structural punctuation marks kept, everything else '~'. Contains no letters or digits, so it can
 * never reproduce a protected answer or the child-facing text.
 */
export function maskedShape(text: string, start: number, end: number): string {
  let shape = '';
  for (const c of text.slice(start, end)) {
    if (/\p{L}/u.test(c)) shape += '*';
    else if (/\p{N}/u.test(c)) shape += '#';
    else if (/\s/u.test(c)) shape += ' ';
    else shape += EVIDENCE_PUNCTUATION.has(c) ? c : '~';
    if (shape.length > MAX_SHAPE) return `[${shape.slice(0, MAX_SHAPE)}~]`;
  }
  return `[${shape}]`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}
