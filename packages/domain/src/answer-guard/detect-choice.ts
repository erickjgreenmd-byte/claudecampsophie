// Multiple-choice detector: flags the withheld letter when it is presented as the answer
// (spec P6 "No ... multiple-choice letter ... in hints").

import type { NormalizedAnswer } from './answers.ts';
import type { RawFinding, TextView } from './view.ts';

/**
 * Decision: letters that are also everyday words (English "a", "I"; Spanish "a", "e", "o", "u",
 * "y") count after a cue only when the letter is capitalized (except "I"), wrapped in brackets,
 * quotes or emphasis, or ends the clause ("Pick A.", "the answer is a."). "Pick a strategy"
 * therefore passes, while "Pick A" is blocked. All other letters count whenever cued.
 */
const WORD_LETTERS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
/** Spanish conjunctions; "y es la respuesta" is a sentence, not a letter claim. */
const CONJUNCTION_LETTERS = new Set(['e', 'o', 'u', 'y']);

const CUE_NOUNS = String.raw`(?:answer|answer['\u2019]s|respuesta|option|choice|opcion|letter|letra|inciso)`;
const CUE_ADJECTIVES = String.raw`(?:correct[ao]?|right|best|final|buena)`;
const CUE_VERBS = String.raw`(?:is|was|would\s+be|will\s+be|should\s+be|must\s+be|es|seria|sera)`;
/** "the correct choice is", "la opcion correcta es", "answer:", "pick", "it's", "definitely". */
const CUE = String.raw`(?:(?:(?:the|la|el)\s+)?(?:${CUE_ADJECTIVES}\s+)?${CUE_NOUNS}(?:\s+${CUE_ADJECTIVES})?(?:\s+${CUE_VERBS})?|pick|select|choose|circle|mark|go\s+with|it['\u2019]s|it\s+is|definitely|probably|elige|escoge|selecciona|marca)`;
const OPEN = String.raw`["'\u201C\u2018(\[*_]*`;
const CLOSE = String.raw`["'\u201D\u2019)\]*_]*`;
const TERMINATOR_RE = /^[ \t]*(?:[.,;:!?)\]"'\u201D\u2019\n]|$)/u;

const EN_CARDINALS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const ES_CARDINALS = [
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
];
const EN_ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];
const ES_ORDINALS = [
  'primer[oa]?',
  'segund[oa]',
  'tercer[oa]?',
  'cuart[oa]',
  'quint[oa]',
  'sext[oa]',
  'septim[oa]',
  'octav[oa]',
  'noven[oa]',
  'decim[oa]',
];
const NUMERIC_SUFFIX = ['st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th', 'th'];

interface ChoicePatterns {
  readonly letter: string;
  readonly cued: RegExp;
  readonly bracketed: RegExp;
  readonly closeParen: RegExp;
  readonly declared: RegExp;
  readonly position: readonly RegExp[];
}

function patternsFor(letter: string): ChoicePatterns {
  const L = letter;
  const position: RegExp[] = [];
  const n = letter.charCodeAt(0) - 96;
  if (n >= 1 && n <= 10) {
    const i = n - 1;
    const ordinal = `(?:${EN_ORDINALS[i]}|${ES_ORDINALS[i]}|${n}${NUMERIC_SUFFIX[i]})`;
    const any = `(?:${n}|${EN_CARDINALS[i]}|${ES_CARDINALS[i]}|${ordinal})`;
    position.push(
      new RegExp(
        String.raw`(?<![\p{L}\p{N}])(?:option|choice|opcion)\s*(?:number|no\.?|#|numero)?\s*${any}(?![\p{L}\p{N}])`,
        'giu',
      ),
      new RegExp(
        String.raw`(?<![\p{L}\p{N}])${ordinal}\s+(?:option|choice|opcion)(?![\p{L}\p{N}])`,
        'giu',
      ),
    );
  }
  return {
    letter,
    cued: new RegExp(
      String.raw`(?<![\p{L}\p{N}])${CUE}\s*[:=-]?\s*(?:(?:the|la|el)\s+)?(?:(?:letter|option|choice|opcion|letra)\s+)?(${OPEN})\s*(${L})\s*(${CLOSE})(?![\p{L}\p{N}])`,
      'giu',
    ),
    bracketed: new RegExp(String.raw`(?<![\p{L}\p{N}])[(\[]\s*${L}\s*[)\]]`, 'giu'),
    closeParen: new RegExp(String.raw`(?<![\p{L}\p{N}(\[])${L}\)`, 'giu'),
    declared: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(${OPEN})(${L})(${CLOSE})\s+(?:is|es)\s+(?:(?:the|la|el)\s+)?(?:correct|right|true|best|answer|respuesta|correcta|correcto|buena)(?![\p{L}\p{N}])`,
      'giu',
    ),
    position,
  };
}

function isUpper(c: string): boolean {
  return c !== c.toLowerCase();
}

export function detectChoice(view: TextView, answers: readonly NormalizedAnswer[]): RawFinding[] {
  const findings: RawFinding[] = [];
  const text = view.text;
  for (const answer of answers) {
    for (const letter of answer.choiceLetters) {
      const p = patternsFor(letter);
      const add = (technique: string, start: number, end: number): void => {
        findings.push({
          detector: 'multiple_choice',
          answerIndex: answer.index,
          technique,
          start,
          end,
        });
      };
      for (const m of text.matchAll(p.cued)) {
        const open = m[1] ?? '';
        const found = m[2] ?? '';
        const close = m[3] ?? '';
        const wrapped = open.length > 0 || close.length > 0;
        const end = m.index + m[0].length;
        const terminated = TERMINATOR_RE.test(text.slice(end));
        let flagged: boolean;
        if (!WORD_LETTERS.has(letter) || wrapped) flagged = true;
        else if (letter === 'i') flagged = terminated;
        else flagged = isUpper(found) || terminated;
        if (flagged) add('cued_letter', m.index, end);
      }
      for (const m of text.matchAll(p.bracketed))
        add('bracketed_letter', m.index, m.index + m[0].length);
      for (const m of text.matchAll(p.closeParen))
        add('bracketed_letter', m.index, m.index + m[0].length);
      for (const m of text.matchAll(p.declared)) {
        const wrapped = (m[1] ?? '').length > 0 || (m[3] ?? '').length > 0;
        const found = m[2] ?? '';
        if (CONJUNCTION_LETTERS.has(letter) && !wrapped && !isUpper(found)) continue;
        add('declared_correct', m.index, m.index + m[0].length);
      }
      // A line that is only the letter (optionally bracketed, emphasized or punctuated).
      let offset = 0;
      for (const line of text.split('\n')) {
        const core = line
          .replace(/^[\s*_`>#~\-\u2022\u00B7([{"'\u201C\u2018]+/u, '')
          .replace(/[\s*_`.!:;,)\]}"'\u201D\u2019]+$/u, '');
        if (core.toLowerCase() === letter) add('standalone_letter', offset, offset + line.length);
        offset += line.length + 1;
      }
      for (const re of p.position) {
        for (const m of view.lower.matchAll(re))
          add('option_position', m.index, m.index + m[0].length);
      }
    }
  }
  return findings;
}
