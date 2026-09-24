// Normalization for the safety screen: bounded, linear-time, no backtracking regexes.
//
// Input → at most MAX_SCREEN_CHARS code units → NFKD with combining marks removed → NFKC →
// format characters (zero-width, bidi) removed, control characters become spaces → a capital "I"
// inside a mixed-case word becomes "1" (so it reads as "i" or "l": "kiII" → "kill") → lowercase →
// Cyrillic/Greek look-alikes, Latin small capitals ("ᴅɪᴇ") and the dotless i folded to Latin →
// apostrophes dropped ("don't" → "dont").
// Then each whitespace-separated chunk that is mostly letters has leetspeak mapped where a symbol
// touches a letter ("k1ll", "$uicide", "h@te"); chunks of numbers and math ("53x", "3/4") are left
// as written. From there several token streams are built, each capped at MAX_SCREEN_TOKENS:
//
//   split   punctuation inside a chunk separates tokens ("sad.i" → "sad", "i")
//   joined  split, with runs of single letters joined ("k i l l" → "kill", "k.i.l.l" → "kill")
//   merged  punctuation inside a chunk removed ("self-harm" → "selfharm", "su.icide" → "suicide")
//   expanded  split and joined with contractions spelled out ("ill" → "i will", "im" → "i am",
//           "id" → "i would", "ive" → "i have", "ima" → "i am going to", "hes" → "he is"), so
//           "I'll kill you" and "I'm being abused" reach the rules' auxiliary words
//
// each for two readings of "1" ("i" and "l"). A chunk ending in . ! ? or ; adds a BOUNDARY token,
// which rules never skip over and negation never looks past ("I can't. I want to die" is not
// negated). Every token has repeated letters collapsed
// ("killlll" → "kil", "kill" → "kil"), and rule words are collapsed the same way, so matching is
// consistent. `compacts` joins a stream's tokens without spaces, with token boundaries recorded, for
// the anchored signatures in lexicon.ts ("su icide", "k ill myself").

/** Bounds for hostile input: text beyond this is not screened and the result says so. */
export const MAX_SCREEN_CHARS = 20_000;
/**
 * Tokens per stream. Real fields are far smaller (a 4,000-character answer is about 800 words);
 * hitting the cap marks the result `truncated`.
 */
export const MAX_SCREEN_TOKENS = 4_000;

/** Lowercase Cyrillic and Greek letters that look like Latin letters. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'b',
  е: 'e',
  ё: 'e',
  з: '3',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ӏ: 'l',
  һ: 'h',
  ɡ: 'g',
  ɑ: 'a',
  α: 'a',
  β: 'b',
  γ: 'y',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
  ϲ: 'c',
  ı: 'i',
  ȷ: 'j',
  ɩ: 'i',
  // Latin small capitals ("ᴡᴀɴᴛ ᴛᴏ ᴅɪᴇ"): not compatibility characters, so NFKC keeps them.
  ᴀ: 'a',
  ʙ: 'b',
  ᴄ: 'c',
  ᴅ: 'd',
  ᴇ: 'e',
  ꜰ: 'f',
  ɢ: 'g',
  ʜ: 'h',
  ɪ: 'i',
  ᴊ: 'j',
  ᴋ: 'k',
  ʟ: 'l',
  ᴍ: 'm',
  ɴ: 'n',
  ᴏ: 'o',
  ᴘ: 'p',
  ǫ: 'q',
  ʀ: 'r',
  ꜱ: 's',
  ᴛ: 't',
  ᴜ: 'u',
  ᴠ: 'v',
  ᴡ: 'w',
  ʏ: 'y',
  ᴢ: 'z',
};

/** Leetspeak symbols ("1" is handled separately: it reads as "i" in one stream, "l" in another). */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
  '+': 't',
  '€': 'e',
};

const APOSTROPHES = /['’‘`´ʼ]/g;
const WORD_CHUNK = /\S+/g;
const LOWER_ASCII = /[a-z]/;
const INNER_CAPITAL_I = /[A-Za-z]I/;
// A capital I right after a letter (the lookbehind reads the original chunk, so "II" is two).
const INNER_CAPITAL_I_GLOBAL = /(?<=[A-Za-z])I/g;
const FORMAT_CHARS = /\p{Cf}/gu;
const CONTROL_CHARS = /\p{Cc}/gu;
const MARKS = /\p{M}/gu;

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch >= 'a' && ch <= 'z';
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isLeet(ch: string | undefined): boolean {
  return ch !== undefined && (ch === '1' || LEET[ch] !== undefined);
}

/** Collapses repeated letters ("killll" → "kil"); digits are kept as written. */
export function collapseRepeats(token: string): string {
  let out = '';
  let prev = '';
  for (const ch of token) {
    if (ch === prev && isLetter(ch)) continue;
    out += ch;
    prev = ch;
  }
  return out;
}

/** Case, Unicode and look-alike folding shared by text and rule words. */
export function foldText(text: string): { text: string; truncated: boolean } {
  const truncated = text.length > MAX_SCREEN_CHARS;
  let s = truncated ? text.slice(0, MAX_SCREEN_CHARS) : text;
  s = s.normalize('NFKD').replace(MARKS, '').normalize('NFKC');
  // Compatibility decomposition can expand a few characters many times; keep the work bounded.
  if (s.length > MAX_SCREEN_CHARS * 2) s = s.slice(0, MAX_SCREEN_CHARS * 2);
  s = s.replace(FORMAT_CHARS, '').replace(CONTROL_CHARS, ' ');
  // A capital "I" after a letter in a word that also has lowercase letters is a disguised "l"
  // ("kiII", "kiIl"): it becomes "1", which the streams read both as "i" and as "l". Words in
  // capitals ("KILL", "HI") and a word-initial "I" ("It", "I") are left alone.
  s = s.replace(WORD_CHUNK, (chunk) =>
    LOWER_ASCII.test(chunk) && INNER_CAPITAL_I.test(chunk)
      ? chunk.replace(INNER_CAPITAL_I_GLOBAL, '1')
      : chunk,
  );
  s = s.toLowerCase();
  let folded = '';
  for (const ch of s) folded += CONFUSABLES[ch] ?? ch;
  return { text: folded.replace(APOSTROPHES, ''), truncated };
}

/**
 * Maps leetspeak inside one chunk. Only chunks with at least two letters and not mostly digits are
 * touched ("k1ll" yes; "53x", "3/4", "10" no). A symbol is mapped only when it touches a letter
 * (or another mapped symbol); "!" only between two letters, so "help!" keeps its punctuation.
 */
function mapLeet(chunk: string, one: 'i' | 'l'): string {
  let letters = 0;
  let digits = 0;
  let symbols = false;
  for (const ch of chunk) {
    if (isLetter(ch)) letters += 1;
    else if (isDigit(ch)) digits += 1;
    if (isLeet(ch)) symbols = true;
  }
  if (!symbols || letters < 2 || digits > letters + 1) return chunk;
  const chars = [...chunk];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    const mapped = ch === '1' ? one : LEET[ch];
    if (mapped === undefined) {
      out += ch;
      continue;
    }
    const prev = chars[i - 1];
    const next = chars[i + 1];
    // The previous character as already mapped, so a run reads left to right ("ki11" → "kill").
    const prevOut = out[out.length - 1];
    const touches =
      ch === '!'
        ? isLetter(prev) && isLetter(next)
        : isLetter(prevOut) || isLetter(next) || (isLeet(prev) && isLeet(next));
    out += touches ? mapped : ch;
  }
  return out;
}

const NON_WORD = /[^a-z0-9]+/;
const SENTENCE_END = /[.!?;]$/;

/** Sentence boundary token (never part of a rule; never included in compact streams). */
export const BOUNDARY = '.';

/** Joins runs of two or more single-letter tokens ("k i l l" → "kill"). */
function joinLetterRuns(tokens: readonly string[]): { tokens: string[]; changed: boolean } {
  const out: string[] = [];
  let run = '';
  let runLength = 0;
  let changed = false;
  const flush = () => {
    if (runLength >= 2) changed = true;
    if (runLength >= 1) out.push(run);
    run = '';
    runLength = 0;
  };
  for (const t of tokens) {
    if (t.length === 1 && isLetter(t)) {
      run += t;
      runLength += 1;
    } else {
      flush();
      out.push(t);
    }
  }
  flush();
  return { tokens: out, changed };
}

/**
 * Contractions spelled out in the `expanded` streams (keys and values are written naturally and
 * collapsed like every token: "ill" is the token "il"). Only unambiguous forms: "hell", "shell",
 * "shed", "well" and "were" are real words and are left alone.
 */
const CONTRACTIONS: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    ill: 'i will',
    im: 'i am',
    id: 'i would',
    ive: 'i have',
    ima: 'i am going to',
    imma: 'i am going to',
    hes: 'he is',
    shes: 'she is',
    hed: 'he would',
    theyre: 'they are',
    theyll: 'they will',
    theyd: 'they would',
    youre: 'you are',
    youll: 'you will',
  }).map(([k, v]) => [collapseRepeats(k), v.split(' ').map(collapseRepeats)] as const),
);

/** Spells out contractions ("im" → "i am"); bounded to one token past the stream cap. */
function expandContractions(tokens: readonly string[]): { tokens: string[]; changed: boolean } {
  const out: string[] = [];
  let changed = false;
  for (const t of tokens) {
    if (out.length > MAX_SCREEN_TOKENS) break;
    const expansion = CONTRACTIONS.get(t);
    if (expansion === undefined) {
      out.push(t);
    } else {
      out.push(...expansion);
      changed = true;
    }
  }
  return { tokens: out, changed };
}

export interface CompactStream {
  /** Tokens joined without separators. */
  readonly text: string;
  /** Offsets where a token starts / ends in `text`. */
  readonly starts: ReadonlySet<number>;
  readonly ends: ReadonlySet<number>;
}

export interface NormalizedText {
  /** Distinct token streams (see the file header); `streams[0]` is the split "1 → i" stream. */
  readonly streams: readonly (readonly string[])[];
  readonly compacts: readonly CompactStream[];
  /** Every token of every stream (for context cues). */
  readonly vocabulary: ReadonlySet<string>;
  readonly truncated: boolean;
}

function compact(tokens: readonly string[]): CompactStream {
  let text = '';
  const starts = new Set<number>();
  const ends = new Set<number>();
  for (const t of tokens) {
    if (t === BOUNDARY) continue;
    starts.add(text.length);
    text += t;
    ends.add(text.length);
  }
  return { text, starts, ends };
}

/** Normalizes text into bounded token streams for matching (exported for tests). */
export function normalizeForScreen(text: string): NormalizedText {
  let tokenCapHit = false;
  const capped = (tokens: string[]): string[] => {
    if (tokens.length <= MAX_SCREEN_TOKENS) return tokens;
    tokenCapHit = true;
    return tokens.slice(0, MAX_SCREEN_TOKENS);
  };
  const folded = foldText(text);
  const chunks = folded.text.split(/\s+/).filter((c) => c.length > 0);
  const hasOne = folded.text.includes('1');
  const streams: string[][] = [];
  const seen = new Set<string>();
  const add = (tokens: string[]) => {
    const key = tokens.join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    streams.push(tokens);
  };
  for (const one of hasOne ? (['i', 'l'] as const) : (['i'] as const)) {
    const split: string[] = [];
    const merged: string[] = [];
    for (const chunk of chunks) {
      const mapped = mapLeet(chunk, one);
      const parts = mapped.split(NON_WORD).filter((p) => p.length > 0);
      for (const p of parts) split.push(collapseRepeats(p));
      if (parts.length > 0) merged.push(collapseRepeats(parts.join('')));
      if (SENTENCE_END.test(mapped)) {
        split.push(BOUNDARY);
        merged.push(BOUNDARY);
      }
      if (split.length > MAX_SCREEN_TOKENS && merged.length > MAX_SCREEN_TOKENS) break;
    }
    add(capped(split));
    const joined = joinLetterRuns(split);
    const joinedTokens = joined.changed ? joined.tokens.map(collapseRepeats) : null;
    if (joinedTokens !== null) add(capped(joinedTokens));
    add(capped(merged));
    for (const base of joinedTokens === null ? [split] : [split, joinedTokens]) {
      const expanded = expandContractions(base);
      if (expanded.changed) add(capped(expanded.tokens));
    }
  }
  const vocabulary = new Set<string>();
  for (const s of streams) for (const t of s) if (t !== BOUNDARY) vocabulary.add(t);
  const compactKeys = new Set<string>();
  const compacts: CompactStream[] = [];
  for (const s of streams) {
    const c = compact(s);
    // Same letters with different word boundaries are different evidence for the signatures.
    const key = `${c.text}|${[...c.starts].join(',')}`;
    if (compactKeys.has(key)) continue;
    compactKeys.add(key);
    compacts.push(c);
  }
  return { streams, compacts, vocabulary, truncated: folded.truncated || tokenCapHit };
}

/** Normalizes one rule word or phrase into tokens the same way as text (no leet mapping). */
export function normalizeRulePhrase(phrase: string): string[] {
  return foldText(phrase)
    .text.split(NON_WORD)
    .filter((p) => p.length > 0)
    .map(collapseRepeats);
}
