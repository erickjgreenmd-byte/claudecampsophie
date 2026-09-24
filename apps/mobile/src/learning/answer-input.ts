import type { ChildPromptDto } from '@pencillift/contracts';

/**
 * Child answer entry for practice questions (spec P6, P7). Pure: no react-native, unit-tested.
 * Normalization only removes what a keyboard adds by accident (invisible characters, full-width
 * digits, typographic minus signs, repeated spaces); it never changes letters or capitalization,
 * because spelling and capitalization questions are graded on exactly what the child typed.
 */

export type ResponseFormat = ChildPromptDto['responseFormat'];

/** Same limit as the answer request contract (practiceAnswerRequestSchema). */
export const ANSWER_MAX_LENGTH = 200;

export type NormalizedAnswer =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'blank' | 'too_long' | 'choose' };

// Typographic minus signs and dashes, and the fraction/division slashes (number answers only).
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const SLASHES = /[\u2044\u2215]/g;

/** Zero-width characters, the BOM, bidi marks, the soft hyphen and C0/C1 controls. */
function isInvisible(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    code === 0xfeff
  );
}

function clean(raw: string): string {
  const spaced = raw.normalize('NFKC').replace(/[\t\n\r]/g, ' ');
  let visible = '';
  for (const char of spaced) {
    if (!isInvisible(char.codePointAt(0) ?? 0)) visible += char;
  }
  return visible.replace(/\s+/g, ' ').trim();
}

/** The letter shown next to choice `index` (A, B, C, ...), matching the server's choice letters. */
export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** Normalizes what the child typed (or the choice they tapped) into the text sent for checking. */
export function normalizeAnswerInput(
  raw: string,
  format: ResponseFormat,
  choiceCount = 0,
): NormalizedAnswer {
  let value = clean(raw);
  if (value.length === 0) return { ok: false, reason: format === 'choice' ? 'choose' : 'blank' };
  if (format === 'choice') {
    const letter = /^\(?([A-Za-z])[).]?$/.exec(value)?.[1]?.toUpperCase();
    if (!letter) return { ok: false, reason: 'choose' };
    const index = letter.charCodeAt(0) - 65;
    if (choiceCount > 0 && (index < 0 || index >= choiceCount))
      return { ok: false, reason: 'choose' };
    return { ok: true, value: letter };
  }
  if (format === 'number' || format === 'division') {
    value = value.replace(DASHES, '-').replace(SLASHES, '/');
  }
  if (value.length > ANSWER_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, value };
}

/** What to tell the child when their input can't be sent yet (nothing is counted). */
export function inputProblemMessage(reason: 'blank' | 'too_long' | 'choose'): string {
  switch (reason) {
    case 'blank':
      return 'Type your answer first, then check it.';
    case 'too_long':
      return `That’s a lot of typing! Keep your answer under ${ANSWER_MAX_LENGTH} characters.`;
    case 'choose':
      return 'Tap the choice you pick, then check it.';
  }
}

/** A short instruction for the answer box. It describes the form of an answer, never a value. */
export function inputHint(prompt: Pick<ChildPromptDto, 'responseFormat' | 'unitHint'>): string {
  const unit = prompt.unitHint ? ` Your answer is in ${prompt.unitHint}.` : '';
  switch (prompt.responseFormat) {
    case 'number':
      return `Type a number.${unit}`;
    case 'division':
      return 'Type the answer, then R and the remainder if there is one.';
    case 'word':
      return `Type one word.${unit}`;
    case 'text':
      return `Type your answer.${unit}`;
    case 'choice':
      return 'Tap the choice you pick.';
  }
}

export interface KeyboardSettings {
  readonly keyboardType: 'default' | 'numbers-and-punctuation';
  /** Spelling and capitalization are what is being practiced: the keyboard must not "fix" them. */
  readonly autoCorrect: false;
  readonly autoCapitalize: 'none';
  readonly spellCheck: false;
}

export function keyboardFor(format: ResponseFormat): KeyboardSettings {
  return {
    keyboardType:
      format === 'number' || format === 'division' ? 'numbers-and-punctuation' : 'default',
    autoCorrect: false,
    autoCapitalize: 'none',
    spellCheck: false,
  };
}
