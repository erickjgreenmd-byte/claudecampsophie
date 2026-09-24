// Canonical text form shared by every detector (spec P6: leaks must not hide behind zero-width
// characters, homoglyphs, compatibility forms or rendered-math glyphs).

const VULGAR_FRACTIONS: Readonly<Record<string, string>> = {
  '\u00BC': '1/4',
  '\u00BD': '1/2',
  '\u00BE': '3/4',
  '\u2150': '1/7',
  '\u2151': '1/9',
  '\u2152': '1/10',
  '\u2153': '1/3',
  '\u2154': '2/3',
  '\u2155': '1/5',
  '\u2156': '2/5',
  '\u2157': '3/5',
  '\u2158': '4/5',
  '\u2159': '1/6',
  '\u215A': '5/6',
  '\u215B': '1/8',
  '\u215C': '3/8',
  '\u215D': '5/8',
  '\u215E': '7/8',
  '\u2189': '0/3',
};
const VULGAR_RE = new RegExp(`[${Object.keys(VULGAR_FRACTIONS).join('')}]`, 'gu');

const SUPERSCRIPT_DIGITS = '\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079';
const SUBSCRIPT_DIGITS = '\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089';
// "\u00B9\u2044\u2082" style fractions: NFKC would glue them to a preceding digit ("3\u00B9\u2044\u2082" -> "31/2").
const SCRIPT_FRACTION_RE = new RegExp(
  `([${SUPERSCRIPT_DIGITS}]+)\\s*[\\u2044/\\u2215]\\s*([${SUBSCRIPT_DIGITS}]+)`,
  'gu',
);

function scriptDigits(value: string, alphabet: string): string {
  return [...value].map((c) => String(alphabet.indexOf(c))).join('');
}

/**
 * Superscript digits glued to a base ("6\u00B2", "10\u207B\u00B2", "x\u00B2", "cm\u00B2") are an
 * exponent: NFKC alone would fold "6\u00B2 + 6" into "62 + 6". They are written "^2" first, so the
 * literal digits are still read ("6", "2"), an evaluated expression reads the power (36), and the
 * digit-separator rule still reads "4\u00B2" as a possible 42. A superscript run with no base
 * ("the answer is \u2074\u00B2") is plain digits, as before.
 */
const SUPERSCRIPT_EXPONENT_RE = new RegExp(
  `(?<=[\\p{L}\\p{N})\\]}])(?<![${SUPERSCRIPT_DIGITS}\u207A\u207B])([\u207A\u207B]?)([${SUPERSCRIPT_DIGITS}]+)`,
  'gu',
);

function exponentOf(_match: string, sign: string, digits: string): string {
  return `^${sign === '\u207B' ? '-' : sign === '\u207A' ? '+' : ''}${scriptDigits(digits, SUPERSCRIPT_DIGITS)}`;
}

/**
 * Homoglyphs that render like Latin letters in common fonts. Applied after NFKC, before
 * lowercasing, so both cases are listed. Not exhaustive (documented limitation).
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic
  '\u0410': 'A',
  '\u0430': 'a',
  '\u0412': 'B',
  '\u0432': 'b',
  '\u0415': 'E',
  '\u0435': 'e',
  '\u0401': 'E',
  '\u0451': 'e',
  '\u041A': 'K',
  '\u043A': 'k',
  '\u041C': 'M',
  '\u043C': 'm',
  '\u041D': 'H',
  '\u043D': 'h',
  '\u041E': 'O',
  '\u043E': 'o',
  '\u0420': 'P',
  '\u0440': 'p',
  '\u0421': 'C',
  '\u0441': 'c',
  '\u0422': 'T',
  '\u0442': 't',
  '\u0423': 'Y',
  '\u0443': 'y',
  '\u0425': 'X',
  '\u0445': 'x',
  '\u0405': 'S',
  '\u0455': 's',
  '\u0406': 'I',
  '\u0456': 'i',
  '\u0407': 'I',
  '\u0457': 'i',
  '\u0408': 'J',
  '\u0458': 'j',
  '\u0501': 'd',
  '\u04BB': 'h',
  '\u04BA': 'H',
  '\u04C0': 'I',
  '\u04CF': 'l',
  '\u051A': 'Q',
  '\u051B': 'q',
  '\u051C': 'W',
  '\u051D': 'w',
  '\u0433': 'r',
  '\u043F': 'n',
  '\u042C': 'b',
  '\u044C': 'b',
  // Greek
  '\u0391': 'A',
  '\u03B1': 'a',
  '\u0392': 'B',
  '\u0395': 'E',
  '\u03B5': 'e',
  '\u0396': 'Z',
  '\u0397': 'H',
  '\u0399': 'I',
  '\u03B9': 'i',
  '\u039A': 'K',
  '\u03BA': 'k',
  '\u039C': 'M',
  '\u039D': 'N',
  '\u03BD': 'v',
  '\u039F': 'O',
  '\u03BF': 'o',
  '\u03A1': 'P',
  '\u03C1': 'p',
  '\u03A4': 'T',
  '\u03C4': 't',
  '\u03A5': 'Y',
  '\u03C5': 'u',
  '\u03A7': 'X',
  '\u03C7': 'x',
  '\u03B3': 'y',
  '\u03C9': 'w',
  // Latin look-alikes and small capitals (NFKC leaves these alone)
  '\u0131': 'i',
  '\u0237': 'j',
  '\u0251': 'a',
  '\u0261': 'g',
  '\u1D00': 'a',
  '\u0299': 'b',
  '\u1D04': 'c',
  '\u1D05': 'd',
  '\u1D07': 'e',
  '\u0262': 'g',
  '\u029C': 'h',
  '\u026A': 'i',
  '\u1D0A': 'j',
  '\u1D0B': 'k',
  '\u029F': 'l',
  '\u1D0D': 'm',
  '\u0274': 'n',
  '\u1D0F': 'o',
  '\u1D18': 'p',
  '\u0280': 'r',
  '\uA731': 's',
  '\u1D1B': 't',
  '\u1D1C': 'u',
  '\u1D20': 'v',
  '\u1D21': 'w',
  '\u028F': 'y',
  '\u1D22': 'z',
  // Armenian
  '\u0585': 'o',
  '\u057D': 'u',
  '\u0570': 'h',
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'gu');

// Format characters (Cf: zero-width space/joiners, bidi marks, word joiner, BOM, soft hyphen,
// invisible operators, tag characters) plus invisible "letters" and fillers. Invisible combining
// marks (combining grapheme joiner, variation selectors) are removed with all other marks below.
const INVISIBLE_RE = /[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/gu;
const COMBINING_MARK_RE = /[\p{Mn}\p{Me}]/gu;
const FRACTION_SLASH_RE = /[\u2044\u2215]/gu;
const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu;
const LINE_BREAK_RE = /\r\n?|[\u2028\u2029\u0085\v\f]/gu;
const HORIZONTAL_SPACE_RE = /[^\S\n]+/gu;

const NON_ASCII_DIGIT_RE = /(?![0-9])\p{Nd}/gu;
const DECIMAL_DIGIT_RE = /^\p{Nd}$/u;

/**
 * ASCII value of a decimal digit from any script ("\u0664" Arabic-Indic, "\u096a" Devanagari).
 * NFKC folds fullwidth and mathematical digits but not these (regression RV-answer-guard-11).
 * Every Unicode \p{Nd} run is a whole number of consecutive 0..9 sequences (verified for all 72
 * runs), so the value is the distance from the start of the run, modulo 10. No table needed.
 */
function asciiDigit(c: string): string {
  let cp = c.codePointAt(0) ?? 0;
  let offset = 0;
  while (offset < 100 && DECIMAL_DIGIT_RE.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    offset += 1;
  }
  return String(offset % 10);
}

/**
 * Rendered-math digit grouping (regression RV-answer-guard-3): "1{,}500" and "4{,}2" render as
 * "1,500" and "4,2"; "1\,500" (thin space) renders as "1 500". Applied until stable so nested
 * braces cannot hide the separator.
 */
const LATEX_GROUPING_RE = /\{\s*([,.])\s*\}/gu;
const LATEX_DIGIT_SPACE_RE = /(?<=\d)[ \t]*\\[,;:! ][ \t]*(?=\d)/gu;

function replaceUntilStable(input: string, re: RegExp, replacement: string): string {
  let current = input;
  for (;;) {
    const next = current.replace(re, replacement);
    if (next === current) return next;
    current = next;
  }
}

function singlePass(input: string): string {
  let s = input.replace(SCRIPT_FRACTION_RE, (_m, n: string, d: string) => {
    return ` ${scriptDigits(n, SUPERSCRIPT_DIGITS)}/${scriptDigits(d, SUBSCRIPT_DIGITS)} `;
  });
  s = s.replace(SUPERSCRIPT_EXPONENT_RE, exponentOf);
  s = s.replace(
    VULGAR_RE,
    (c) => ` ${Object.hasOwn(VULGAR_FRACTIONS, c) ? VULGAR_FRACTIONS[c] : c} `,
  );
  s = s.normalize('NFKC');
  s = s.replace(INVISIBLE_RE, '');
  s = s.replace(NON_ASCII_DIGIT_RE, asciiDigit);
  s = replaceUntilStable(s, LATEX_GROUPING_RE, '$1');
  s = s.replace(LATEX_DIGIT_SPACE_RE, ' ');
  s = s.normalize('NFD').replace(COMBINING_MARK_RE, '').normalize('NFC');
  s = s.replace(FRACTION_SLASH_RE, '/').replace(DASH_RE, '-');
  s = s.replace(HOMOGLYPH_RE, (c) => (Object.hasOwn(HOMOGLYPHS, c) ? (HOMOGLYPHS[c] ?? c) : c));
  s = s.replace(LINE_BREAK_RE, '\n').replace(HORIZONTAL_SPACE_RE, ' ');
  return s
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

function fixpoint(input: string, step: (s: string) => string): string {
  let current = input;
  for (let i = 0; i < 6; i++) {
    const next = step(current);
    if (next === current) return next;
    current = next;
  }
  return current;
}

/**
 * Canonical comparison form, case preserved: vulgar fractions -> " n/d", NFKC, format and
 * zero-width characters removed, combining marks removed (accent-insensitive), fraction slash and
 * dashes normalized, homoglyphs mapped to Latin, horizontal whitespace collapsed, line breaks
 * kept (acrostics and list markers are line-based) and empty lines dropped.
 */
export function canonicalizePreservingCase(text: string): string {
  return fixpoint(text, singlePass);
}

/** Canonical lowercase comparison form (see canonicalizePreservingCase). Idempotent. */
export function canonicalize(text: string): string {
  return fixpoint(text, (s) => singlePass(s).toLowerCase());
}
