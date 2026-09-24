// Self-validation of bank items (spec P7 "validated answers"; AC_LEARNING_06: invalid, unsolvable or
// ambiguous generated items never reach the child). An item is emitted only when:
//   1. its own key grades `correct` with the deterministic safe checks,
//   2. a plausible wrong answer grades `incorrect` (for multiple choice: every other letter),
//   3. a multiple-choice key is exactly one valid letter and the choices are distinct,
//   4. the child-facing prompt passes the answer-leak guard with the key as protected answer.
import { guardChildContent } from '../answer-guard/index.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { choiceLetters, gradeBankAnswer, keyAnswerText, protectedAnswersFor } from './grade.ts';
import { BANK_MAX_GRADE, BANK_MIN_GRADE, isBankSubject, type BankItem } from './types.ts';

export const BANK_VALIDATION_ERROR_CODES = [
  'INVALID_SHAPE',
  'KEY_NOT_CORRECT',
  'DISTRACTOR_NOT_INCORRECT',
  'INVALID_CHOICES',
  'KEY_LEAKED',
] as const;
export type BankValidationErrorCode = (typeof BANK_VALIDATION_ERROR_CODES)[number];

export const MAX_PROMPT_TEXT_LENGTH = 600;
export const MAX_PASSAGE_LENGTH = 6000;
export const MAX_CHOICE_LENGTH = 200;

/**
 * Decision: duplicate detection is case-sensitive, because capitalization items legitimately offer
 * choices that differ only in capital letters.
 */
function normalizeChoiceText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function shapeProblem(item: BankItem): string | null {
  if (!isBankSubject(item.subject)) return 'unknown subject';
  if (
    !Number.isInteger(item.gradeMin) ||
    !Number.isInteger(item.gradeMax) ||
    item.gradeMin < BANK_MIN_GRADE ||
    item.gradeMax > BANK_MAX_GRADE ||
    item.gradeMin > item.gradeMax
  ) {
    return 'grade range';
  }
  const text = item.prompt.text.trim();
  if (text.length === 0 || text.length > MAX_PROMPT_TEXT_LENGTH) return 'prompt length';
  const passage = item.prompt.passage;
  if (
    passage !== null &&
    (passage.text.trim().length === 0 || passage.text.length > MAX_PASSAGE_LENGTH)
  ) {
    return 'passage length';
  }
  if (item.skill.trim().length === 0 || item.templateKey.trim().length === 0) return 'keys';
  if (item.explanation.trim().length === 0) return 'explanation';
  return null;
}

function choicesProblem(item: BankItem): string | null {
  const spec = item.answerSpec;
  const choices = item.prompt.choices;
  if (spec.kind !== 'multiple_choice') {
    return choices === null && item.prompt.responseFormat !== 'choice'
      ? null
      : 'choices on non-choice item';
  }
  if (choices === null || item.prompt.responseFormat !== 'choice') return 'missing choices';
  if (choices.length < 2 || choices.length > 5) return 'choice count';
  const letters = choiceLetters(choices.length);
  if (
    spec.validLetters.length !== letters.length ||
    spec.validLetters.some((l, i) => l !== letters[i])
  ) {
    return 'valid letters';
  }
  if (spec.letters.length !== 1 || !letters.includes(spec.letters[0] ?? '')) return 'key letter';
  const normalized = choices.map(normalizeChoiceText);
  if (normalized.some((c) => c.length === 0 || c.length > MAX_CHOICE_LENGTH)) return 'choice text';
  if (new Set(normalized).size !== normalized.length) return 'duplicate choices';
  return null;
}

/**
 * Validates one item. Returns the item unchanged on success; the error code says which rule
 * failed (details carry no answer text).
 */
export function validateBankItem(item: BankItem): Result<BankItem, BankValidationErrorCode> {
  const shape = shapeProblem(item);
  if (shape !== null) return err('INVALID_SHAPE', `Item shape is invalid: ${shape}`);
  const choice = choicesProblem(item);
  if (choice !== null) return err('INVALID_CHOICES', `Item choices are invalid: ${choice}`);

  const spec = item.answerSpec;
  if (gradeBankAnswer(spec, keyAnswerText(spec)).verdict !== 'correct') {
    return err('KEY_NOT_CORRECT', 'The answer key does not grade as correct');
  }
  if (spec.kind === 'multiple_choice') {
    for (const letter of spec.validLetters) {
      if (letter === spec.letters[0]) continue;
      if (gradeBankAnswer(spec, letter).verdict !== 'incorrect') {
        return err('DISTRACTOR_NOT_INCORRECT', 'A wrong choice does not grade as incorrect');
      }
    }
  }
  if (gradeBankAnswer(spec, item.distractor).verdict !== 'incorrect') {
    return err('DISTRACTOR_NOT_INCORRECT', 'The distractor does not grade as incorrect');
  }

  // The prompt IS the problem statement, so it necessarily contains an expression equal to its own
  // key ("What is 6 × 7?"): expression reading is switched off here, and only here. Everything
  // child-facing that is not a problem statement (hints, intros, examples) keeps the default (on).
  const decision = guardChildContent({
    packet: item.prompt,
    answers: protectedAnswersFor(spec),
    options: { evaluateExpressions: false },
  });
  if (decision.decision !== 'release') {
    return err('KEY_LEAKED', 'The child prompt reveals or may reveal its own answer', {
      reasons: decision.reasons.map((r) => r.code),
    });
  }
  return ok(item);
}

/** Keeps only valid items (the bank never emits an item that failed validation). */
export function keepValid(items: readonly BankItem[]): BankItem[] {
  return items.filter((item) => validateBankItem(item).ok);
}
