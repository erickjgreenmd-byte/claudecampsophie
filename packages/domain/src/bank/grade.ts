// Server-side grading of bank/practice items with the deterministic safe checks (spec P5/P6).
// Used both for self-validation of generated items and for grading a child's submitted answer.
import type { ProtectedAnswer } from '../answer-guard/index.ts';
import {
  checkDivisionWithRemainder,
  checkExactText,
  checkMultipleChoice,
  checkNumericAnswer,
  checkSpelling,
  parseMathAnswerDetailed,
  parseQuantityDetailed,
  type CheckResult,
} from '../grading/index.ts';
import type { AnswerSpec } from './types.ts';

/** A leading "x =" / "n =" that equation answers commonly carry. */
const VARIABLE_PREFIX = /^\s*[a-z]\s*=\s*/i;

/**
 * Grades a child's answer against a private spec. Decision: an unevaluated arithmetic expression
 * ("47 + 38" typed back for "What is 47 + 38?") is `unresolved`, never correct: it restates the
 * question. Equivalent values (6/8 for 3/4, "1 1/4" for 5/4) are correct.
 */
export function gradeBankAnswer(spec: AnswerSpec, studentAnswer: string): CheckResult {
  switch (spec.kind) {
    case 'numeric': {
      const answer = studentAnswer.replace(VARIABLE_PREFIX, '');
      const detailed =
        spec.unit === null ? parseMathAnswerDetailed(answer) : parseQuantityDetailed(answer);
      if (detailed.ok && detailed.value.form.kind === 'expression') {
        return { verdict: 'unresolved', reason: 'UNSUPPORTED_EXPRESSION' };
      }
      const keys = [spec.value, ...spec.alternates];
      let first: CheckResult | null = null;
      for (const value of keys) {
        const result = checkNumericAnswer({
          studentAnswer: answer,
          expected:
            spec.unit === null
              ? { value }
              : { value, unit: spec.unit, acceptEquivalentUnits: false },
        });
        if (result.verdict === 'correct') return result;
        first ??= result;
      }
      return first ?? { verdict: 'unresolved', reason: 'INVALID_ANSWER_KEY' };
    }
    case 'division_remainder':
      return checkDivisionWithRemainder(studentAnswer, {
        quotient: spec.quotient,
        remainder: spec.remainder,
        divisor: spec.divisor,
      });
    case 'multiple_choice':
      return checkMultipleChoice(studentAnswer, spec.letters, { validLetters: spec.validLetters });
    case 'spelling':
      return checkSpelling(studentAnswer, {
        target: spec.target,
        acceptedVariants: spec.alternates,
      });
    case 'exact_text':
      return checkExactText(studentAnswer, {
        accepted: [...spec.accepted, ...spec.alternates],
        strict: true,
      });
  }
}

/** The canonical key as text (parent answer key display and self-validation input). */
export function keyAnswerText(spec: AnswerSpec): string {
  switch (spec.kind) {
    case 'numeric':
      return spec.unit === null ? spec.value : `${spec.value} ${spec.unit}`;
    case 'division_remainder':
      return `${spec.quotient} R ${spec.remainder}`;
    case 'multiple_choice':
      return spec.letters[0] ?? '';
    case 'spelling':
      return spec.target;
    case 'exact_text':
      return spec.accepted[0] ?? '';
  }
}

/** Protected answers for the leak guard: every form of the key the child must not be shown. */
export function protectedAnswersFor(spec: AnswerSpec): ProtectedAnswer[] {
  switch (spec.kind) {
    case 'numeric':
      return [
        {
          kind: 'numeric',
          value: spec.value,
          ...(spec.alternates.length > 0 ? { alternates: [...spec.alternates] } : {}),
        },
      ];
    case 'division_remainder':
      return [
        { kind: 'numeric', value: String(spec.quotient) },
        { kind: 'text', value: `${spec.quotient} R ${spec.remainder}` },
      ];
    case 'multiple_choice':
      return spec.letters.map((letter) => ({ kind: 'multiple_choice' as const, value: letter }));
    case 'spelling':
      return [
        {
          kind: 'spelling',
          value: spec.target,
          ...(spec.alternates.length > 0 ? { alternates: [...spec.alternates] } : {}),
        },
      ];
    case 'exact_text': {
      const [value, ...rest] = [...spec.accepted, ...spec.alternates];
      if (value === undefined) return [];
      const single = /^[\p{L}'-]+$/u.test(value);
      return [
        {
          kind: single ? 'spelling' : 'text',
          value,
          ...(rest.length > 0 ? { alternates: rest } : {}),
        },
      ];
    }
  }
}

/** Letters A.. for `count` choices. */
export function choiceLetters(count: number): string[] {
  return Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i));
}
