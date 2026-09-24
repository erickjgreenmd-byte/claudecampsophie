// Encoding layer (spec P6 "Do not leak by ... encoding ... rendered math"). Finds base64, hex,
// percent-encoding, ROT13 and HTML/MathML markup, decodes them with small local strict decoders
// (no atob/TextDecoder dependency, nothing executed) and hands the decoded text back to the
// scanner for a bounded recursive re-scan.

import type { NormalizedAnswer } from './answers.ts';
import { canonicalizePreservingCase } from './canonicalize.ts';
import type { EncodingKind } from './types.ts';
import { escapeRegExp, type RawFinding, type TextView } from './view.ts';

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function decodeBase64(input: string): Uint8Array | null {
  const s = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/u, '');
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/u.test(s)) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of s) {
    buffer = ((buffer << 6) | B64_ALPHABET.indexOf(c)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64_ALPHABET[(n >> 18) & 63] ?? '';
    out += B64_ALPHABET[(n >> 12) & 63] ?? '';
    out += b1 === undefined ? '=' : (B64_ALPHABET[(n >> 6) & 63] ?? '');
    out += b2 === undefined ? '=' : (B64_ALPHABET[n & 63] ?? '');
  }
  return out;
}

export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/** Strict UTF-8 decoding (no overlongs, surrogates or truncation); null on any error. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  let out = '';
  let i = 0;
  const cont = (k: number): number | null => {
    const b = bytes[k];
    return b !== undefined && (b & 0xc0) === 0x80 ? b & 0x3f : null;
  };
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      const c1 = cont(i + 1);
      if (c1 === null) return null;
      cp = ((b0 & 0x1f) << 6) | c1;
      i += 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      if (c1 === null || c2 === null) return null;
      cp = ((b0 & 0x0f) << 12) | (c1 << 6) | c2;
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) return null;
      i += 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      const c3 = cont(i + 3);
      if (c1 === null || c2 === null || c3 === null) return null;
      cp = ((b0 & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3;
      if (cp < 0x10000 || cp > 0x10ffff) return null;
      i += 4;
    } else {
      return null;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** C0/C1 controls (except tab, LF, CR) or U+FFFD mean the bytes were not text. */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f)) {
      return true;
    }
    if (cp === 0xfffd) return true;
  }
  return false;
}

/** Decoded bytes count as text only if valid UTF-8, free of control characters, and wordy. */
function asText(bytes: Uint8Array | null): string | null {
  if (bytes === null || bytes.length < 2) return null;
  const text = decodeUtf8Strict(bytes);
  if (text === null || hasControl(text) || !/[\p{L}\p{N}]/u.test(text)) return null;
  return text;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return Uint8Array.from(bytes);
}

function percentToBytes(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c === '%' && /^[0-9a-f]{2}$/iu.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c === '+') {
      bytes.push(0x20);
    } else {
      for (const b of encodeUtf8(c)) bytes.push(b);
    }
  }
  return Uint8Array.from(bytes);
}

export interface DecodedCandidate {
  readonly kind: EncodingKind;
  /** Span of the encoded text in the view (for rot13/markup: the whole view). */
  readonly start: number;
  readonly end: number;
  /** Decoded text; raw (not yet canonicalized) unless `canonical` is set. */
  readonly decoded: string;
  /** True when `decoded` has the same offsets as the view (ROT13), so spans map back 1:1. */
  readonly aligned: boolean;
}

const BASE64_RE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{8,}={0,2}(?![A-Za-z0-9+/=_-])/gu;
const HEX_RE = /(?<![0-9a-z])(?:0x)?((?:[0-9a-f]{2}){3,})(?![0-9a-z])/gu;
const HEX_BYTES_RE =
  /(?<![0-9a-z\\])(?:(?:\\x|0x)?[0-9a-f]{2}(?:[\s:,-]+|(?=\\x))){2,}(?:\\x|0x)?[0-9a-f]{2}(?![0-9a-z])/gu;
const PERCENT_RE =
  /(?<![a-z0-9._~!*'()+-])[a-z0-9._~!*'()+-]*(?:%[0-9a-f]{2}[a-z0-9._~!*'()+-]*)+/gu;

/** Base64, hex and percent-encoded spans that decode to text. */
export function findEncodedSpans(view: TextView): DecodedCandidate[] {
  const out: DecodedCandidate[] = [];
  for (const m of view.text.matchAll(BASE64_RE)) {
    const decoded = asText(decodeBase64(m[0]));
    if (decoded !== null) {
      out.push({
        kind: 'base64',
        start: m.index,
        end: m.index + m[0].length,
        decoded,
        aligned: false,
      });
    }
  }
  for (const m of view.lower.matchAll(HEX_RE)) {
    const decoded = asText(hexToBytes(m[1] ?? ''));
    if (decoded !== null) {
      out.push({
        kind: 'hex',
        start: m.index,
        end: m.index + m[0].length,
        decoded,
        aligned: false,
      });
    }
  }
  for (const m of view.lower.matchAll(HEX_BYTES_RE)) {
    const hex = m[0].replace(/\\x|0x|[\s:,-]/gu, '');
    const decoded = asText(hexToBytes(hex));
    if (decoded !== null) {
      out.push({
        kind: 'hex',
        start: m.index,
        end: m.index + m[0].length,
        decoded,
        aligned: false,
      });
    }
  }
  if (!view.lower.includes('%')) return out;
  for (const m of view.lower.matchAll(PERCENT_RE)) {
    const decoded = asText(percentToBytes(m[0]));
    if (decoded !== null && decoded !== m[0]) {
      out.push({
        kind: 'percent',
        start: m.index,
        end: m.index + m[0].length,
        decoded,
        aligned: false,
      });
    }
  }
  return out;
}

function rot13(word: string): string {
  return word.replace(/[a-z]/giu, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/**
 * Decision: ordinary words whose ROT13 image is also an ordinary word ("bar" <-> "one",
 * "try" <-> "gel", "be" <-> "or") are left out of the ROT13 view, so a "bar model" hint is not
 * read as "one". Consequence (documented limitation): these specific words are not decoded.
 */
const ROT13_NATURAL_PAIRS = [
  ['bar', 'one'],
  ['bars', 'ones'],
  ['be', 'or'],
  ['fur', 'she'],
  ['try', 'gel'],
  ['irk', 'vex'],
  ['envy', 'rail'],
  ['ant', 'nag'],
  ['gnat', 'tang'],
  ['sync', 'flap'],
  ['clerk', 'pyrex'],
  ['purely', 'cheryl'],
  ['abjurer', 'nowhere'],
] as const;
const ROT13_NATURAL = new Set<string>(ROT13_NATURAL_PAIRS.flat());

/** ROT13 of every ASCII word, same length as the view (natural-pair words blanked with '_'). */
export function rot13View(view: TextView): DecodedCandidate | null {
  if (!/[a-z]/iu.test(view.text)) return null;
  const decoded = view.text.replace(/[A-Za-z]+/gu, (w) =>
    ROT13_NATURAL.has(w.toLowerCase()) ? '_'.repeat(w.length) : rot13(w),
  );
  return { kind: 'rot13', start: 0, end: view.text.length, decoded, aligned: true };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
  lrm: '',
  rlm: '',
  frac12: '\u00BD',
  frac14: '\u00BC',
  frac34: '\u00BE',
  frac13: '\u2153',
  frac23: '\u2154',
  frac15: '\u2155',
  frac16: '\u2159',
  frac18: '\u215B',
  frasl: '/',
  minus: '-',
  times: '\u00D7',
  divide: '\u00F7',
  percnt: '%',
  sol: '/',
  num: '#',
  period: '.',
  comma: ',',
  colon: ':',
  lpar: '(',
  rpar: ')',
  dollar: '$',
};
const ENTITY_RE = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,15}));/giu;
const MFRAC_RE =
  /<mfrac\b[^<>]{0,200}>\s*<mn\b[^<>]{0,200}>\s*([^<]{1,40}?)\s*<\/mn>\s*<mn\b[^<>]{0,200}>\s*([^<]{1,40}?)\s*<\/mn>\s*<\/mfrac>/giu;
const TAG_RE = /<!--[\s\S]{0,2000}?-->|<\/?[a-z][^<>]{0,500}>/giu;

function decodeEntities(s: string): string {
  return s.replace(
    ENTITY_RE,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      const cp = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : null;
      if (cp !== null)
        return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
          ? String.fromCodePoint(cp)
          : '';
      const key = (name ?? '').toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, key) ? (NAMED_ENTITIES[key] ?? whole) : whole;
    },
  );
}

/** HTML/MathML view: entities decoded (twice, for "&amp;#52;"), <mfrac> as a/b, tags removed. */
export function markupView(view: TextView): DecodedCandidate | null {
  if (!/[<&]/u.test(view.text)) return null;
  let s = decodeEntities(decodeEntities(view.text));
  s = s.replace(MFRAC_RE, (_m, a: string, b: string) => ` ${a}/${b} `);
  s = s.replace(TAG_RE, '');
  const decoded = canonicalizePreservingCase(s);
  if (decoded === view.text) return null;
  return { kind: 'markup', start: 0, end: view.text.length, decoded, aligned: false };
}

/**
 * Short literal forms of each answer searched for directly in base64 and hex, because a value
 * like "42" encodes to fewer characters ("NDI=", "3432") than generic detection can safely
 * treat as encoded text.
 */
export function detectEncodedLiterals(
  view: TextView,
  answers: readonly NormalizedAnswer[],
): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const answer of answers) {
    for (const form of answer.literalForms) {
      const bytes = encodeUtf8(form);
      const padded = encodeBase64(bytes);
      const unpadded = padded.replace(/=+$/u, '');
      const base64Forms = new Set<string>([padded, padded.replace(/\+/g, '-').replace(/\//g, '_')]);
      if (unpadded.length >= 4) {
        base64Forms.add(unpadded);
        base64Forms.add(unpadded.replace(/\+/g, '-').replace(/\//g, '_'));
      }
      for (const b64 of base64Forms) {
        const re = new RegExp(
          `(?<![A-Za-z0-9+/=_-])${escapeRegExp(b64)}(?![A-Za-z0-9+/=_-])`,
          'gu',
        );
        for (const m of view.text.matchAll(re)) {
          findings.push({
            detector: 'encoding',
            answerIndex: answer.index,
            technique: 'encoded_literal',
            start: m.index,
            end: m.index + m[0].length,
            via: ['base64'],
          });
        }
      }
      if (bytes.length >= 2) {
        const pairs = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
        const re = new RegExp(
          `(?<![0-9a-z\\\\])(?:0x|\\\\x)?${pairs.join('(?:[\\s:,-]*(?:\\\\x|0x)?)')}(?![0-9a-z])`,
          'gu',
        );
        for (const m of view.lower.matchAll(re)) {
          findings.push({
            detector: 'encoding',
            answerIndex: answer.index,
            technique: 'encoded_literal',
            start: m.index,
            end: m.index + m[0].length,
            via: ['hex'],
          });
        }
      }
    }
  }
  return findings;
}
