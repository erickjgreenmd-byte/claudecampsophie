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
//           "I'll kill you" and "I'm being abused" reach the rules' auxiliary words. "hell",
//           "shell" and "shed" are words, so "he'll", "she'll" and "she'd" are spelled out only
//           before a verb ("he'll hurt me", not "the hell hound"), and a caregiver noun with "'ll"
//           ("dad'll") becomes "dad will" (RV-child-safety-4)
//
// each for two readings of "1" ("i" and "l"), plus a mixed reading when the screen passes its rule
// vocabulary: each chunk takes the reading whose words the rules know ("k1ll myse1f" → "kill
// myself"; RV-child-safety-3). A chunk ending in . ! ? or ; adds a BOUNDARY token, and so does a
// "no," / "nope," / "nah," interjection ("No, quiero morir" is not a negated "no quiero morir";
// RV-child-safety-13). Rules never skip a BOUNDARY and negation never looks past it ("I can't. I
// want to die" is not negated). Every token has repeated letters collapsed
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

const collapsedSet = (words: string): ReadonlySet<string> =>
  new Set(words.split(' ').map(collapseRepeats));

/**
 * Round 3 (CHK2-CS-2): Roman numerals. "II" and "III" collapse to the token "i", so "World War
 * II", "Act III" and "Queen Elizabeth II" read as the child's first person. A numeral of two or
 * more letters is written as its number instead ("World War 2") when the word before it takes a
 * numeral (any case: "war ii", "Act III", "part ii") or, in capitals, is any capitalized word
 * ("Henry III", "John Paul II").
 * Round 4 (CHK3-CS-1): a lone "I" is never a numeral in the child's own text: it is the pronoun
 * ("In St. Louis I was abused", "LAST SEASON I WAS ABUSED", "Mom I want to die"). "World War I" or
 * "Act I" before a tier-B word therefore escalates, and a reviewer clears it (runbook 5.1). Only a
 * printed prompt (`printed`), which is the worksheet's text, reads a lone capital "I" as a numeral,
 * and only in three exact idioms: "World War I", a section word written with one capital ("Act I",
 * "Part I", "Chapter I"; not "PART I" in capitals) and a monarch's or pope's title with a name
 * ("Queen Elizabeth I"; not "St. Louis I" or "Prince George I"). Without it a worksheet's "In World
 * War I, many soldiers were victims of abuse" reads as a held first-person disclosure.
 */
const NUMBERED_WORDS = collapsedSet(
  'war act part chapter book volume vol scene section episode season article amendment phase stage canto psalm unit lesson level round',
);
/** Printed prompts only: a Titlecase section word before a lone "I" ("Act I", "Chapter I"). */
const PRINTED_SECTION_WORDS = collapsedSet(
  'act part chapter scene book volume canto psalm article amendment',
);
/** Printed prompts only: a title before a name before a lone "I" ("Queen Elizabeth I"). */
const PRINTED_REGNAL_TITLES = collapsedSet('king queen pope emperor empress tsar czar pharaoh');
const ROMAN_NUMERAL = /^(X{0,3})(IX|IV|V?I{0,3})$/i;
const ROMAN_VALUES: Readonly<Record<string, number>> = { I: 1, V: 5, X: 10 };
const CHUNK_PARTS = /^([^\p{L}\p{N}]*)(\p{L}+)([^\p{L}\p{N}]*)$/u;
const TITLECASE = /^\p{Lu}\p{Ll}+$/u;

function romanValue(numeral: string): number {
  let total = 0;
  const upper = numeral.toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    const v = ROMAN_VALUES[upper[i]!]!;
    const next = ROMAN_VALUES[upper[i + 1] ?? ''] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}

/**
 * Rewrites Roman numerals in a numeral context as numbers (one linear pass over the chunks). A lone
 * letter is left as written, except a capital "I" in one of the printed-prompt idioms above.
 */
function numberRomanNumerals(s: string, printed: boolean): string {
  let prev: { word: string; ends: boolean } | null = null;
  let prevPrev: { word: string } | null = null;
  return s.replace(WORD_CHUNK, (chunk) => {
    const parts = CHUNK_PARTS.exec(chunk);
    const word = parts?.[2] ?? '';
    let out = chunk;
    if (parts && word.length > 0 && ROMAN_NUMERAL.test(word) && prev !== null && !prev.ends) {
      const before = collapseRepeats(prev.word.toLowerCase());
      const capital = /^\p{Lu}/u.test(prev.word);
      const isNumeral =
        word.length > 1
          ? NUMBERED_WORDS.has(before) || (word === word.toUpperCase() && capital)
          : printed &&
            word === 'I' &&
            ((before === 'war' && prevPrev?.word.toLowerCase() === 'world') ||
              (TITLECASE.test(prev.word) && PRINTED_SECTION_WORDS.has(before)) ||
              (capital &&
                prevPrev !== null &&
                TITLECASE.test(prevPrev.word) &&
                PRINTED_REGNAL_TITLES.has(collapseRepeats(prevPrev.word.toLowerCase()))));
      if (isNumeral) out = `${parts[1]}${romanValue(word)}${parts[3]}`;
    }
    prevPrev = prev === null ? null : { word: prev.word };
    prev = {
      word: parts?.[2] ?? chunk.replace(/[^\p{L}]/gu, ''),
      ends: /[.!?;]$/.test(chunk),
    };
    return out;
  });
}

/** "I'll" with an apostrophe is always "I will" (CHK2-CS-3); a bare "ill" needs a verb after it. */
const I_WILL_APOSTROPHE = /(^|[^\p{L}\p{N}])i['’‘`´ʼ]l+(?![\p{L}\p{N}])/gu;

/**
 * Case, Unicode and look-alike folding shared by text and rule words. `printed`: the text is a
 * printed prompt (a lone "I" in "World War I" is a numeral there; numberRomanNumerals).
 */
export function foldText(text: string, printed = false): { text: string; truncated: boolean } {
  const truncated = text.length > MAX_SCREEN_CHARS;
  let s = truncated ? text.slice(0, MAX_SCREEN_CHARS) : text;
  s = s.normalize('NFKD').replace(MARKS, '').normalize('NFKC');
  // Compatibility decomposition can expand a few characters many times; keep the work bounded.
  if (s.length > MAX_SCREEN_CHARS * 2) s = s.slice(0, MAX_SCREEN_CHARS * 2);
  s = s.replace(FORMAT_CHARS, '').replace(CONTROL_CHARS, ' ');
  s = numberRomanNumerals(s, printed);
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
  folded = folded.replace(I_WILL_APOSTROPHE, '$1i will');
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
/** "No," as an interjection ends a clause: "No, quiero morir" / "No, I want to die". */
const INTERJECTION = /^(?:no|nope|nah)[,:]$/;

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
 * collapsed like every token). Only unambiguous forms here: "hell", "shell" and "shed" are real
 * words and are spelled out only before a verb (below); "ill" is the adjective unless it reads as
 * "I will" (illReadsAsIWill); "well" and "were" are left alone. "I'll" with an apostrophe is
 * already "i will" (foldText).
 */
const CONTRACTIONS: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
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

const collapsedWords = (words: string): string[] => words.split(' ').map(collapseRepeats);

/**
 * "he'll", "she'll" and "she'd" lose their apostrophes and read as the words "hell", "shell" and
 * "shed"; they are spelled out only when a verb follows ("she'll hurt me", "she'd hurt me").
 */
const CONTRACTIONS_BEFORE_VERB: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({ hell: 'he will', shell: 'she will', shed: 'she would' }).map(
    ([k, v]) => [collapseRepeats(k), collapsedWords(v)] as const,
  ),
);
const CONTRACTION_VERBS: ReadonlySet<string> = new Set(
  collapsedWords(
    'kill hurt beat hit punch kick slap choke strangle stab shoot burn drown poison punish touch rape abuse send take find know get come make do never always really be go tell say leave lock starve smack whip spank throw push shove attack murder bring try give let hate not',
  ),
);
/**
 * A caregiver noun with "'ll" ("dad'll" → "dadll" → "dad will"). A key must not be an English word
 * once its letters are collapsed: "mama'll" and "papa'll" read "mamal" and "papal", which are also
 * "mammal" and "papal", so they are left out (CHK-CS-6: "a mammal will hurt me" read as "a mama
 * will will hurt me").
 */
const NOUN_WILL: ReadonlyMap<string, readonly string[]> = new Map(
  'dad daddy mom mommy father mother stepdad stepmom uncle aunt brother sister grandpa grandma teacher coach babysitter'
    .split(' ')
    .map((noun) => [`${collapseRepeats(noun)}l`, [collapseRepeats(noun), 'wil']] as const),
);

/** "ill" and "I'll" without an apostrophe, once collapsed. */
export const ILL = collapseRepeats('ill');
/**
 * Round 3 (CHK2-CS-3): a bare "ill" is "I'll" only on positive evidence, a verb or a will-shaped
 * adverb right after it ("Ill do it", "ill be dead soon", "Ill never tell", "ill kms"), and stays
 * the adjective when no such word follows ("make you ill", "ill with fever", "ill will", "ill
 * health"). Round 4 (CHK3-CS-2): the word before "ill" never vetoes that reading. A run-on puts
 * any word there ("I hate you ill kill you", "I cant do this ill end it all", "I promise that ill
 * end my life"), so "People who are ill do not ...", "the ill take medicine" and "mentally ill do
 * ..." read "I will" too; with a tier-B word in the sentence they escalate and a reviewer clears
 * them (runbook 5.1; index.ts KNOWN LIMITS).
 */
export const ILL_VERBS: ReadonlySet<string> = collapsedSet(
  'be do go get end commit take try kill hurt die cut jump overdose starve hang run stop keep tell say let give show make have hit punch kick stab shoot burn drown poison bomb blow slit slash swallow drink eat bring murder attack beat choke strangle suffocate smash destroy bleed rape touch send find come meet call text see miss sneak carry use leave never always really probably prob prolly still just definitely totally actually literally seriously finally also even not ' +
    // Round 4: self-harm verbs and slang, and wishes ("ill kms", "ill wish i was dead"). Not "off"
    // or "feel": collapsed, they are "of" and "fell" ("He spoke ill of the king").
    'kms kys od unalive punish wish want wanna gonna need disappear sleep fight throw push put sit lie self harm',
);

/** Whether the bare "ill" at `i` reads as "I will" (see ILL_VERBS). */
export function illReadsAsIWill(tokens: readonly string[], i: number): boolean {
  if (tokens[i] !== ILL) return false;
  const next = tokens[i + 1];
  return next !== undefined && ILL_VERBS.has(next);
}

/**
 * Every normalization table, for the screen's version digest (screen.test.ts; CHK-CS-7): editing
 * one changes what the rules see, so it needs a new SAFETY_SCREEN_VERSION like a rule does.
 */
export const NORMALIZATION_TABLES = {
  maxScreenChars: MAX_SCREEN_CHARS,
  maxScreenTokens: MAX_SCREEN_TOKENS,
  confusables: CONFUSABLES,
  leet: LEET,
  apostrophes: APOSTROPHES.source,
  innerCapitalI: INNER_CAPITAL_I_GLOBAL.source,
  sentenceEnd: SENTENCE_END.source,
  interjection: INTERJECTION.source,
  nonWord: NON_WORD.source,
  contractions: [...CONTRACTIONS],
  contractionsBeforeVerb: [...CONTRACTIONS_BEFORE_VERB],
  contractionVerbs: [...CONTRACTION_VERBS],
  nounWill: [...NOUN_WILL],
  illVerbs: [...ILL_VERBS],
  iWillApostrophe: I_WILL_APOSTROPHE.source,
  numberedWords: [...NUMBERED_WORDS],
  printedSectionWords: [...PRINTED_SECTION_WORDS],
  printedRegnalTitles: [...PRINTED_REGNAL_TITLES],
  titlecase: TITLECASE.source,
  romanNumeral: ROMAN_NUMERAL.source,
} as const;

const I_WILL: readonly string[] = collapsedWords('i will');

/** Spells out contractions ("im" → "i am"); bounded to one token past the stream cap. */
function expandContractions(tokens: readonly string[]): { tokens: string[]; changed: boolean } {
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < tokens.length; i += 1) {
    if (out.length > MAX_SCREEN_TOKENS) break;
    const t = tokens[i]!;
    const next = tokens[i + 1];
    const expansion =
      CONTRACTIONS.get(t) ??
      (illReadsAsIWill(tokens, i) ? I_WILL : undefined) ??
      NOUN_WILL.get(t) ??
      (next !== undefined && CONTRACTION_VERBS.has(next)
        ? CONTRACTIONS_BEFORE_VERB.get(t)
        : undefined);
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

/** The words of one mapped chunk, as the streams read them. */
function chunkWords(mapped: string): string[] {
  return mapped
    .split(NON_WORD)
    .filter((p) => p.length > 0)
    .map(collapseRepeats);
}

const ALL_DIGITS = /^[0-9]+$/;

/**
 * The mixed reading of "1": per chunk, the "l" reading when the "i" reading has a word the rules
 * do not know and every word of the "l" reading is known ("myse1f" → "myself"), else the "i"
 * reading. Null when it equals one of the uniform readings.
 */
function mixedReading(chunks: readonly string[], known: ReadonlySet<string>): string[] | null {
  const isKnown = (w: string) => known.has(w) || ALL_DIGITS.test(w);
  const out: string[] = [];
  let usesI = false;
  let usesL = false;
  for (const chunk of chunks) {
    const asI = mapLeet(chunk, 'i');
    const asL = mapLeet(chunk, 'l');
    if (asI === asL) {
      out.push(asI);
    } else if (!chunkWords(asI).every(isKnown) && chunkWords(asL).every(isKnown)) {
      out.push(asL);
      usesL = true;
    } else {
      out.push(asI);
      usesI = true;
    }
  }
  return usesI && usesL ? out : null;
}

/**
 * Normalizes text into bounded token streams for matching (exported for tests). `known` is the
 * screen's rule vocabulary; with it, a text that uses "1" for both "i" and "l" also gets a mixed
 * reading. `printed`: the text is a printed prompt, not the child's words (foldText).
 */
export function normalizeForScreen(
  text: string,
  known?: ReadonlySet<string>,
  printed = false,
): NormalizedText {
  let tokenCapHit = false;
  const capped = (tokens: string[]): string[] => {
    if (tokens.length <= MAX_SCREEN_TOKENS) return tokens;
    tokenCapHit = true;
    return tokens.slice(0, MAX_SCREEN_TOKENS);
  };
  const folded = foldText(text, printed);
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
  const readings: (readonly string[])[] = [chunks.map((c) => mapLeet(c, 'i'))];
  if (hasOne) {
    readings.push(chunks.map((c) => mapLeet(c, 'l')));
    const mixed = known === undefined ? null : mixedReading(chunks, known);
    if (mixed !== null) readings.push(mixed);
  }
  for (const reading of readings) {
    const split: string[] = [];
    const merged: string[] = [];
    for (const mapped of reading) {
      const parts = mapped.split(NON_WORD).filter((p) => p.length > 0);
      for (const p of parts) split.push(collapseRepeats(p));
      if (parts.length > 0) merged.push(collapseRepeats(parts.join('')));
      if (SENTENCE_END.test(mapped) || INTERJECTION.test(mapped)) {
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
