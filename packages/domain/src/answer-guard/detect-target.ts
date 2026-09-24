// Spelling/text target detector (spec P6: no "complete spelling target, completed sentence, or
// essay response in hints"; no leak "by acrostic").

import type { NormalizedAnswer, TextTarget } from './answers.ts';
import { escapeRegExp, type RawFinding, type TextView } from './view.ts';

/** Basic leetspeak substitutes (spec list). "1" may stand for "l" or "i". */
const LEET: Readonly<Record<string, string>> = {
  a: 'a4@',
  e: 'e3',
  i: 'i1',
  l: 'l1',
  o: 'o0',
  s: 's5$',
  t: 't7',
};
const WORD_CHARS = String.raw`\p{L}\p{N}@$`;
const BEFORE = `(?<![${WORD_CHARS}])`;
const AFTER = `(?![${WORD_CHARS}])`;
/** 1-6 non-word characters between single letters: "l-e-a-r-n", "**l**-**e**", newlines. */
const LETTER_SEPARATOR = `[^${WORD_CHARS}]{1,6}`;
/** Between the words of a phrase. */
const WORD_SEPARATOR = `[^${WORD_CHARS}]{1,16}`;

/** Minimum target length (letters) for each letter-level technique; see the Decision below. */
const MIN_SEPARATED = 3;
const MIN_REVERSED = 3;
const MIN_INFLECTION = 4;
const MIN_ACROSTIC_LINES = 3;
const MIN_ACROSTIC_WORDS = 5;
const MIN_COMPACT = 6;
const MAX_LETTER_TECHNIQUES = 40;
const TRIGRAM_THRESHOLD = 0.6;

/*
 * Decision (false-positive budget): letter-level techniques only run where chance matches in
 * ordinary coaching text are rare. Separated letters and reversal need >= 3 letters, inflection
 * ("learning" for "learn") >= 4, line/sentence acrostics >= 3, word acrostics >= 5 (first letters
 * of consecutive words spell short words by chance), and letters split across word boundaries
 * ("be cause") >= 6. Leetspeak matches of targets shorter than 4 letters must contain at least
 * one real letter so that plain numbers ("15") never read as words ("is").
 */

function charClass(c: string): string {
  const alternatives = Object.hasOwn(LEET, c) ? LEET[c] : undefined;
  if (alternatives === undefined) return escapeRegExp(c);
  return `[${alternatives.replace(/[$\\\]^-]/g, '\\$&')}]`;
}

function wordPattern(word: string): string {
  return [...word].map(charClass).join('');
}

interface CompiledTarget {
  readonly target: TextTarget;
  readonly answerIndex: number;
  readonly isWord: boolean;
  readonly phrase: RegExp;
  readonly reversedPhrase: RegExp | null;
  readonly separated: RegExp | null;
  readonly reversedSeparated: RegExp | null;
  readonly inflection: RegExp | null;
  readonly compact: RegExp | null;
}

export type CompiledTargets = readonly CompiledTarget[];

export function compileTargets(answers: readonly NormalizedAnswer[]): CompiledTargets {
  const out: CompiledTarget[] = [];
  for (const answer of answers) {
    for (const target of answer.targets) {
      const letters = target.letters;
      const isWord = target.words.length === 1;
      const letterLevel = letters.length <= MAX_LETTER_TECHNIQUES;
      const reversedWords = [...target.words].reverse().map((w) => [...w].reverse().join(''));
      const reversedLetters = [...letters].reverse().join('');
      out.push({
        target,
        answerIndex: answer.index,
        isWord,
        phrase: new RegExp(
          `${BEFORE}${target.words.map(wordPattern).join(WORD_SEPARATOR)}${AFTER}`,
          'gu',
        ),
        reversedPhrase:
          letters.length >= MIN_REVERSED && reversedLetters !== letters
            ? new RegExp(
                `${BEFORE}${reversedWords.map(wordPattern).join(WORD_SEPARATOR)}${AFTER}`,
                'gu',
              )
            : null,
        separated:
          letterLevel && letters.length >= MIN_SEPARATED
            ? new RegExp(
                `${BEFORE}${[...letters].map(charClass).join(LETTER_SEPARATOR)}${AFTER}`,
                'gu',
              )
            : null,
        reversedSeparated:
          letterLevel && letters.length >= MIN_SEPARATED && reversedLetters !== letters
            ? new RegExp(
                `${BEFORE}${[...reversedLetters].map(charClass).join(LETTER_SEPARATOR)}${AFTER}`,
                'gu',
              )
            : null,
        inflection:
          target.detector === 'spelling' && isWord && letters.length >= MIN_INFLECTION
            ? new RegExp(`${BEFORE}${wordPattern(letters)}\\p{L}{1,4}${AFTER}`, 'gu')
            : null,
        compact:
          letterLevel && letters.length >= MIN_COMPACT
            ? new RegExp(wordPattern(letters), 'gu')
            : null,
      });
    }
  }
  return out;
}

function containsSubstitute(match: string): boolean {
  return /[0-9@$]/u.test(match);
}

function leetAcceptable(match: string, target: TextTarget): boolean {
  return target.letters.length >= 4 || /\p{L}/u.test(match) || !containsSubstitute(match);
}

interface Initial {
  readonly letter: string;
  readonly start: number;
  readonly end: number;
}

/** First letter of each segment matched by `segmentRe`. Non-letter segment starts break runs. */
function initials(text: string, segmentRe: RegExp): Initial[] {
  const out: Initial[] = [];
  for (const m of text.matchAll(segmentRe)) {
    const firstLetter = /\p{L}/u.exec(m[0]);
    if (firstLetter === null) continue;
    out.push({
      letter: firstLetter[0],
      start: m.index + firstLetter.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

function findAcrostic(
  seq: readonly Initial[],
  letters: string,
  allowReverse: boolean,
): { start: number; end: number } | null {
  const joined = seq.map((s) => s.letter).join('');
  const candidates = allowReverse ? [letters, [...letters].reverse().join('')] : [letters];
  for (const candidate of candidates) {
    const at = joined.indexOf(candidate);
    if (at >= 0) {
      const first = seq[at];
      const last = seq[at + candidate.length - 1];
      if (first !== undefined && last !== undefined) return { start: first.start, end: last.end };
    }
  }
  return null;
}

/**
 * Letters spelled out one by one with a naming phrase: "L is for lion", "E as in egg",
 * "A de arbol". Collects the named letters in order.
 */
const LETTER_NAME_RE =
  /(?<![\p{L}\p{N}])(\p{L})["')\]]?\s+(?:is\s+for|as\s+in|like\s+in|for|de|como\s+en|es\s+de)\s+\p{L}/gu;

function letterNames(text: string): Initial[] {
  return [...text.matchAll(LETTER_NAME_RE)].map((m) => ({
    letter: m[1] ?? '',
    start: m.index,
    end: m.index + m[0].length,
  }));
}

function trigrams(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 < words.length; i++)
    out.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

export function detectTargets(view: TextView, compiled: CompiledTargets): RawFinding[] {
  if (compiled.length === 0) return [];
  const text = view.lower;
  const findings: RawFinding[] = [];

  // Lazily built shared structures.
  let compact: { text: string; map: number[] } | null = null;
  let lineInitials: Initial[] | null = null;
  let sentenceInitials: Initial[] | null = null;
  let wordInitials: Initial[] | null = null;
  let letterNameInitials: Initial[] | null = null;
  let textWords: { word: string; start: number; end: number }[] | null = null;

  for (const c of compiled) {
    const { target } = c;
    const detector = target.detector;
    const before = findings.length;
    const add = (technique: string, start: number, end: number): void => {
      findings.push({ detector, answerIndex: c.answerIndex, technique, start, end });
    };

    for (const m of text.matchAll(c.phrase)) {
      if (!leetAcceptable(m[0], target)) continue;
      const technique =
        containsSubstitute(m[0]) && !/[0-9@$]/u.test(target.letters)
          ? 'leetspeak'
          : c.isWord
            ? 'whole_word'
            : 'phrase';
      add(technique, m.index, m.index + m[0].length);
    }
    if (c.reversedPhrase !== null) {
      for (const m of text.matchAll(c.reversedPhrase)) {
        if (leetAcceptable(m[0], target)) add('reversed', m.index, m.index + m[0].length);
      }
    }
    for (const [re, technique] of [
      [c.separated, 'separated_letters'],
      [c.reversedSeparated, 'reversed_separated_letters'],
      [c.inflection, 'inflection'],
    ] as const) {
      if (re === null) continue;
      for (const m of text.matchAll(re)) {
        if (leetAcceptable(m[0], target)) add(technique, m.index, m.index + m[0].length);
      }
    }

    // Acrostics over first letters of lines, sentences and words.
    const letters = target.letters;
    if (/^\p{L}+$/u.test(letters) && letters.length <= MAX_LETTER_TECHNIQUES) {
      if (letters.length >= MIN_ACROSTIC_LINES) {
        lineInitials ??= initials(text, /[^\n]+/gu);
        const hit = findAcrostic(lineInitials, letters, true);
        if (hit !== null) add('acrostic_lines', hit.start, hit.end);
        sentenceInitials ??= initials(text, /[^.!?\n]+/gu);
        const sentenceHit = findAcrostic(sentenceInitials, letters, true);
        if (sentenceHit !== null) add('acrostic_sentences', sentenceHit.start, sentenceHit.end);
      }
      if (letters.length >= MIN_SEPARATED) {
        letterNameInitials ??= letterNames(text);
        const named = findAcrostic(letterNameInitials, letters, true);
        if (named !== null) add('letter_names', named.start, named.end);
      }
      if (letters.length >= MIN_ACROSTIC_WORDS) {
        // Words starting with a digit contribute '#', so a run of initials cannot bridge them.
        wordInitials ??= [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
          letter: /^\p{L}/u.test(m[0]) ? m[0].charAt(0) : '#',
          start: m.index,
          end: m.index + m[0].length,
        }));
        const hit = findAcrostic(wordInitials, letters, false);
        if (hit !== null) add('acrostic_words', hit.start, hit.end);
      }
    }

    // Letters split across word boundaries ("be cause", "photo synthesis").
    if (c.compact !== null && findings.length === before) {
      if (compact === null) {
        let s = '';
        const map: number[] = [];
        let i = 0;
        for (const ch of text) {
          if (/[\p{L}\p{N}@$]/u.test(ch)) {
            s += ch;
            for (let k = 0; k < ch.length; k++) map.push(i + k);
          }
          i += ch.length;
        }
        compact = { text: s, map };
      }
      const current = compact;
      for (const m of current.text.matchAll(c.compact)) {
        if (!leetAcceptable(m[0], target)) continue;
        const start = current.map[m.index] ?? 0;
        const end = (current.map[m.index + m[0].length - 1] ?? start) + 1;
        add('split_letters', start, end);
      }
    }

    // Near-copies of a multi-word answer: >= 60% of its token trigrams appear in the text.
    if (target.words.length >= 4) {
      textWords ??= [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
        word: m[0],
        start: m.index,
        end: m.index + m[0].length,
      }));
      const answerTrigrams = new Set(trigrams(target.words));
      const words = textWords;
      const present = new Map<string, { start: number; end: number }>();
      for (let i = 0; i + 2 < words.length; i++) {
        const a = words[i];
        const b = words[i + 1];
        const d = words[i + 2];
        if (a === undefined || b === undefined || d === undefined) continue;
        const key = `${a.word} ${b.word} ${d.word}`;
        if (answerTrigrams.has(key) && !present.has(key))
          present.set(key, { start: a.start, end: d.end });
      }
      if (answerTrigrams.size > 0 && present.size / answerTrigrams.size >= TRIGRAM_THRESHOLD) {
        const spans = [...present.values()];
        const start = Math.min(...spans.map((s) => s.start));
        const end = Math.max(...spans.map((s) => s.end));
        add('trigram_overlap', start, end);
      }
    }
  }
  return findings;
}
