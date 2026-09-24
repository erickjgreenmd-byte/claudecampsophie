import { describe, expect, it } from 'vitest';
import { gradeWorksheet, type WorksheetItem } from './index.ts';

// Synthetic two-page worksheet for Riley. Numbering continues across pages (page 2 starts at 4)
// and the extractor delivered items out of page order.
const ITEMS: WorksheetItem[] = [
  {
    questionId: 'q-4',
    page: 2,
    label: '4',
    question: { kind: 'numeric', studentAnswer: '', expected: { value: '12' } },
  },
  {
    questionId: 'q-1',
    page: 1,
    label: '1',
    question: { kind: 'numeric', studentAnswer: '3/4', expected: { value: '0.75' } },
  },
  {
    questionId: 'q-2',
    page: 1,
    label: '2',
    question: { kind: 'numeric', studentAnswer: '1,5', expected: { value: '1.5' } },
  },
  {
    questionId: 'q-3',
    page: 1,
    label: '3',
    question: { kind: 'multiple_choice', studentAnswer: '(c)', expected: { letters: ['B'] } },
  },
  {
    questionId: 'q-5',
    page: 2,
    label: '5',
    question: {
      kind: 'quantity',
      studentAnswer: '5 ft 3 in',
      expected: { value: '63', unit: 'in', requireUnit: true },
    },
  },
  {
    questionId: 'q-6',
    page: 2,
    label: '6',
    question: {
      kind: 'spelling',
      studentAnswer: 'necessary',
      expected: { target: 'necessary' },
      captureIssues: ['glare'],
    },
  },
  {
    questionId: 'q-7',
    page: 2,
    label: '7',
    question: { kind: 'writing', studentAnswer: 'Sam and I built a kite.' },
  },
];

describe('AC_GRADING_01: mixed-correctness homework maps each answer to its own question', () => {
  it('grades each question independently and keeps its identity, page and label', () => {
    const result = gradeWorksheet(ITEMS);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.results).toEqual([
      { questionId: 'q-1', page: 1, label: '1', verdict: 'correct', reason: 'EXACT_MATCH' },
      { questionId: 'q-2', page: 1, label: '2', verdict: 'unresolved', reason: 'AMBIGUOUS_FORMAT' },
      { questionId: 'q-3', page: 1, label: '3', verdict: 'incorrect', reason: 'CHOICE_MISMATCH' },
      { questionId: 'q-4', page: 2, label: '4', verdict: 'unanswered', reason: 'BLANK' },
      { questionId: 'q-5', page: 2, label: '5', verdict: 'correct', reason: 'EXACT_MATCH' },
      { questionId: 'q-6', page: 2, label: '6', verdict: 'unresolved', reason: 'NEEDS_RESCAN' },
      { questionId: 'q-7', page: 2, label: '7', verdict: 'rubric', reason: 'RUBRIC_FEEDBACK_ONLY' },
    ]);
    expect(result.value.counts).toEqual({
      correct: 2,
      incorrect: 1,
      unresolved: 2,
      unanswered: 1,
      rubric: 1,
    });
  });

  it('flags rescan and missing-passage needs at worksheet level (AC_CAPTURE_04)', () => {
    const result = gradeWorksheet(ITEMS);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.needsRescan).toBe(true);
    expect(result.value.needsSourcePassage).toBe(false);

    const passage = gradeWorksheet([
      {
        questionId: 'r-1',
        page: 1,
        label: '1',
        question: {
          kind: 'open_response',
          studentAnswer: 'The fox was hungry.',
          captureIssues: ['missing_passage'],
        },
      },
    ]);
    if (!passage.ok) throw new Error(passage.error.code);
    expect(passage.value.needsRescan).toBe(false);
    expect(passage.value.needsSourcePassage).toBe(true);
    expect(passage.value.results[0]).toMatchObject({ verdict: 'unresolved' });
  });

  it('keeps extraction order within a page (labels like 10 and 3a are not re-sorted)', () => {
    const result = gradeWorksheet([
      {
        questionId: 'a',
        page: 1,
        label: '10',
        question: { kind: 'open_response', studentAnswer: 'x' },
      },
      {
        questionId: 'b',
        page: 1,
        label: '3a',
        question: { kind: 'open_response', studentAnswer: 'y' },
      },
    ]);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.results.map((r) => r.questionId)).toEqual(['a', 'b']);
  });

  it('rejects duplicate question ids instead of cross-mapping answers', () => {
    const result = gradeWorksheet([ITEMS[0]!, { ...ITEMS[1]!, questionId: 'q-4' }]);
    expect(result.ok ? 'ok' : result.error.code).toBe('DUPLICATE_QUESTION_ID');
  });

  it('rejects invalid page numbers', () => {
    const result = gradeWorksheet([{ ...ITEMS[0]!, page: 0 }]);
    expect(result.ok ? 'ok' : result.error.code).toBe('INVALID_PAGE');
  });
});
