import { err, ok, type Result } from '../shared/result.ts';
import {
  checkDivisionWithRemainder,
  checkExactText,
  checkMultipleChoice,
  checkNumericAnswer,
  checkSpelling,
  type DivisionExpected,
  type ExactTextExpected,
  type MultipleChoiceOptions,
  type NumericExpected,
  type SpellingExpected,
} from './checks.ts';
import { isBlankAnswer } from './text.ts';
import { isAbsent } from './untrusted.ts';
import { outcome, type GradeOutcome, type GradeVerdict } from './verdicts.ts';

export const ANSWER_KINDS = [
  'numeric',
  'quantity',
  'division_remainder',
  'multiple_choice',
  'spelling',
  'exact_text',
  'open_response',
  'writing',
] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

/**
 * Capture-quality findings from extraction (spec P5: "Detect unreadable/blurred/glare/rotated/
 * cut-off content. Show a retake request rather than guessing"; "Require a source passage ...
 * when an answer depends on missing text"; student answers must not be confused with teacher
 * annotations or answer keys; parents can remap mis-associated work).
 */
export const CAPTURE_ISSUES = [
  'blur',
  'glare',
  'rotated',
  'cut_off',
  'unreadable',
  'missing_passage',
  'answer_source_uncertain',
  'answer_mapping_uncertain',
] as const;
export type CaptureIssue = (typeof CAPTURE_ISSUES)[number];

const RESCAN_ISSUES: ReadonlySet<unknown> = new Set([
  'blur',
  'glare',
  'rotated',
  'cut_off',
  'unreadable',
]);
const KNOWN_ISSUES: ReadonlySet<unknown> = new Set(CAPTURE_ISSUES);

interface QuestionBase {
  /** Transcribed student answer (untrusted data). */
  readonly studentAnswer: string;
  readonly captureIssues?: readonly CaptureIssue[];
}

export type ObjectiveQuestion =
  | (QuestionBase & { readonly kind: 'numeric'; readonly expected: NumericExpected })
  | (QuestionBase & {
      readonly kind: 'quantity';
      readonly expected: NumericExpected & { readonly unit: string };
    })
  | (QuestionBase & { readonly kind: 'division_remainder'; readonly expected: DivisionExpected })
  | (QuestionBase & {
      readonly kind: 'multiple_choice';
      readonly expected: MultipleChoiceOptions & {
        readonly letters: ReadonlySet<string> | readonly string[];
      };
    })
  | (QuestionBase & { readonly kind: 'spelling'; readonly expected: SpellingExpected })
  | (QuestionBase & { readonly kind: 'exact_text'; readonly expected: ExactTextExpected })
  | (QuestionBase & { readonly kind: 'open_response' })
  | (QuestionBase & { readonly kind: 'writing' });

interface CaptureNeeds {
  readonly rescan: boolean;
  readonly sourcePassage: boolean;
  readonly answerSourceUncertain: boolean;
  readonly answerMappingUncertain: boolean;
}

/**
 * Every capture need of one item, not just the one that decides its verdict, so the worksheet can
 * ask for a rescan and a missing passage in the same round. Decision: an issue value outside the
 * known list, or a captureIssues value that is not a list, is a rescan request (fail closed);
 * null/undefined (strict structured outputs' "absent") means no issues.
 */
function captureNeeds(issues: unknown): CaptureNeeds | null {
  if (isAbsent(issues)) return null;
  if (!Array.isArray(issues)) {
    return {
      rescan: true,
      sourcePassage: false,
      answerSourceUncertain: false,
      answerMappingUncertain: false,
    };
  }
  const list: readonly unknown[] = issues;
  if (list.length === 0) return null;
  return {
    rescan: list.some((issue) => RESCAN_ISSUES.has(issue) || !KNOWN_ISSUES.has(issue)),
    sourcePassage: list.includes('missing_passage'),
    answerSourceUncertain: list.includes('answer_source_uncertain'),
    answerMappingUncertain: list.includes('answer_mapping_uncertain'),
  };
}

/**
 * Capture problems win over any grade (AC_CAPTURE_04). Decision: rescan outranks the other issues
 * because nothing else can be judged on an unreadable page.
 */
function captureOutcome(needs: CaptureNeeds | null): GradeOutcome | null {
  if (needs === null) return null;
  if (needs.rescan) return outcome('unresolved', 'NEEDS_RESCAN');
  if (needs.sourcePassage) return outcome('unresolved', 'NEEDS_SOURCE_PASSAGE');
  if (needs.answerSourceUncertain) return outcome('unresolved', 'ANSWER_SOURCE_UNCERTAIN');
  return outcome('unresolved', 'ANSWER_MAPPING_UNCERTAIN');
}

/**
 * Deterministic first-pass grading by answer kind. Open responses are left for semantic grading
 * and writing receives rubric feedback only: neither is forced into a right/wrong judgment
 * (spec P5, AC_GRADING_03). Decision: a blank open response or essay is `unanswered`, which is
 * more precise than asking a model to grade nothing.
 */
export function gradeObjectiveQuestion(question: ObjectiveQuestion): GradeOutcome {
  const capture = captureOutcome(captureNeeds(question.captureIssues));
  if (capture !== null) return capture;
  switch (question.kind) {
    case 'numeric':
    case 'quantity':
      return checkNumericAnswer({
        studentAnswer: question.studentAnswer,
        expected: question.expected,
      });
    case 'division_remainder':
      return checkDivisionWithRemainder(question.studentAnswer, question.expected);
    case 'multiple_choice':
      return checkMultipleChoice(
        question.studentAnswer,
        question.expected.letters,
        isAbsent(question.expected.validLetters)
          ? {}
          : { validLetters: question.expected.validLetters },
      );
    case 'spelling':
      return checkSpelling(question.studentAnswer, question.expected);
    case 'exact_text':
      return checkExactText(question.studentAnswer, question.expected);
    case 'open_response':
      return isBlankAnswer(question.studentAnswer)
        ? outcome('unanswered', 'BLANK')
        : outcome('unresolved', 'NEEDS_SEMANTIC_GRADING');
    case 'writing':
      return isBlankAnswer(question.studentAnswer)
        ? outcome('unanswered', 'BLANK')
        : outcome('rubric', 'RUBRIC_FEEDBACK_ONLY');
  }
}

// =============================================================================================
// Worksheet (multi-question, multi-page) grading
// =============================================================================================

export interface WorksheetItem {
  readonly questionId: string;
  /** 1-based page number in the submission. */
  readonly page: number;
  /** Printed question label ("4", "3a"); numbering may continue across pages. */
  readonly label: string;
  readonly question: ObjectiveQuestion;
}

export interface WorksheetResult extends GradeOutcome {
  readonly questionId: string;
  readonly page: number;
  readonly label: string;
}

export interface WorksheetGrading {
  readonly results: readonly WorksheetResult[];
  readonly counts: Readonly<Record<GradeVerdict, number>>;
  /** At least one item needs a retake (blur, glare, rotation, cut-off, unreadable). */
  readonly needsRescan: boolean;
  /** At least one item depends on a passage/study guide that was not provided. */
  readonly needsSourcePassage: boolean;
}

export const WORKSHEET_ERROR_CODES = [
  'DUPLICATE_QUESTION_ID',
  'INVALID_QUESTION_ID',
  'INVALID_PAGE',
] as const;
export type WorksheetErrorCode = (typeof WORKSHEET_ERROR_CODES)[number];

/**
 * Grades every extracted question independently and keeps each result keyed to its own question
 * (AC_GRADING_01). Results are ordered by page, keeping extraction (reading) order within a page;
 * labels are not re-sorted because "10" and "3a" have no reliable order.
 */
export function gradeWorksheet(
  items: readonly WorksheetItem[],
): Result<WorksheetGrading, WorksheetErrorCode> {
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.questionId !== 'string' || item.questionId.trim() === '') {
      return err('INVALID_QUESTION_ID', 'question id must be a non-empty string');
    }
    if (!Number.isSafeInteger(item.page) || item.page < 1) {
      return err('INVALID_PAGE', 'page must be a positive integer', {
        questionId: item.questionId,
      });
    }
    if (seen.has(item.questionId)) {
      return err('DUPLICATE_QUESTION_ID', 'each question id may appear once', {
        questionId: item.questionId,
      });
    }
    seen.add(item.questionId);
  }
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.page - b.item.page || a.index - b.index)
    .map(({ item }) => item);
  const counts: Record<GradeVerdict, number> = {
    correct: 0,
    incorrect: 0,
    unresolved: 0,
    unanswered: 0,
    rubric: 0,
  };
  const needs = ordered.map((item) => captureNeeds(item.question.captureIssues));
  const results = ordered.map((item): WorksheetResult => {
    const graded = gradeObjectiveQuestion(item.question);
    counts[graded.verdict] += 1;
    return {
      questionId: item.questionId,
      page: item.page,
      label: item.label,
      verdict: graded.verdict,
      reason: graded.reason,
    };
  });
  return ok({
    results,
    counts,
    // From every item's capture needs, not its single deciding reason: an item that is blurred
    // AND depends on a missing passage asks for both at once.
    needsRescan: needs.some((n) => n?.rescan === true),
    needsSourcePassage: needs.some((n) => n?.sourcePassage === true),
  });
}
