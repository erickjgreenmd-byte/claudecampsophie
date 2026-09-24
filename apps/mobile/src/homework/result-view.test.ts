import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_STATUSES,
  GRADED_VERDICTS,
  childAssignmentDetailResponseSchema,
  type ChildAssignmentDetailResponse,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  buildResultView,
  childLoadMessage,
  findForbiddenKeys,
  statusView,
  verdictView,
} from './result-view.ts';

const AT = '2026-09-24T15:00:00.000Z';
const Q1 = 'e19e0f1a-2b3c-4d4e-9f6a-7b8c9d0e1f2a';
const Q2 = 'f2af1a2b-3c4d-4e5f-8a7b-8c9d0e1f2a3b';
const Q3 = '03b02b3c-4d5e-4f6a-9b8c-9d0e1f2a3b4c';
const F1 = '14c13c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function detail(
  status: ChildAssignmentDetailResponse['assignment']['status'],
): ChildAssignmentDetailResponse {
  return childAssignmentDetailResponseSchema.parse({
    assignment: {
      id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
      subjectId: null,
      status,
      pageCount: 1,
      createdAt: AT,
      updatedAt: AT,
    },
    questions: [
      {
        id: Q1,
        questionNumber: '1',
        promptText: 'What is 3/4 + 1/8?',
        studentAnswerText: '4/12',
        verdict: 'incorrect',
        feedback: [{ id: F1, kind: 'hint', body: 'Try finding a common denominator first.' }],
      },
      {
        id: Q2,
        questionNumber: '2',
        promptText: 'What is 2 + 5?',
        studentAnswerText: '7',
        verdict: 'correct',
        feedback: [],
      },
      {
        id: Q3,
        questionNumber: '3',
        promptText: 'Spell the word.',
        studentAnswerText: null,
        verdict: 'unresolved',
        feedback: [],
      },
    ],
  });
}

describe('verdict copy for children (spec P6)', () => {
  it('uses exactly the approved words with an icon and accessible text', () => {
    expect(verdictView('correct', '1')).toEqual({
      title: 'Correct',
      icon: '✓',
      tone: 'success',
      accessibilityLabel: 'Question 1: Correct',
    });
    expect(verdictView('incorrect', '2')).toMatchObject({
      title: 'Try again',
      icon: '↻',
      tone: 'retry',
    });
    expect(verdictView('unresolved', '3').title).toBe('Let’s get a clearer picture');
    expect(verdictView('needs_parent_review', '4').title).toBe('Ask a grown-up to review this');
    expect(verdictView(null, '5')).toMatchObject({ title: 'Still checking', tone: 'pending' });
  });

  it('never relies on colour alone: every verdict has a distinct icon and a text label', () => {
    const views = GRADED_VERDICTS.map((v) => verdictView(v, '1'));
    for (const v of views) {
      expect(v.icon.length).toBeGreaterThan(0);
      expect(v.accessibilityLabel).toContain(v.title);
    }
    expect(new Set(views.map((v) => v.icon)).size).toBeGreaterThanOrEqual(5);
  });

  it('every assignment state has calm, honest copy', () => {
    for (const s of ASSIGNMENT_STATUSES) {
      const view = statusView(s);
      expect(view.title.length).toBeGreaterThan(0);
      expect(`${view.title} ${view.body}`).not.toMatch(/fail|error|wrong|bad/i);
    }
    expect(statusView('needs_rescan').title).toBe('Let’s get a clearer picture');
    expect(statusView('needs_parent_review').title).toBe('Ask a grown-up to review this');
    expect(statusView('ready').showResults).toBe(true);
    expect(statusView('checking').showResults).toBe(false);
  });
});

describe('result view (AC_GRADING_06)', () => {
  it('shows the child’s own answer, the verdict and hints — never an answer key', () => {
    const view = buildResultView(detail('ready'));
    expect(view.questions.map((q) => [q.label, q.yourAnswer, q.verdict.title])).toEqual([
      ['Question 1', '4/12', 'Try again'],
      ['Question 2', '7', 'Correct'],
      ['Question 3', 'You left this one blank', 'Let’s get a clearer picture'],
    ]);
    expect(view.questions[0]!.hints).toEqual(['Try finding a common denominator first.']);
    expect(view.summary).toBe('1 correct · 1 to try again · 1 to check');
    expect(findForbiddenKeys(view)).toEqual([]);
  });

  it('shows no verdicts while the scan is still being checked', () => {
    const view = buildResultView(detail('checking'));
    expect(view.questions.every((q) => q.verdict.title === 'Still checking')).toBe(true);
    expect(view.questions.every((q) => q.hints.length === 0)).toBe(true);
    expect(view.summary).toBeNull();
  });

  it('detects forbidden answer-key fields anywhere in a payload', () => {
    expect(
      findForbiddenKeys({ a: [{ b: { correctAnswer: 'x' } }], route: 'escalated' }).sort(),
    ).toEqual(['correctAnswer', 'route']);
    // The strict contract rejects such a payload before it could be rendered.
    const leaked = {
      ...detail('ready'),
      questions: [{ ...detail('ready').questions[0], workedSolution: 'x' }],
    };
    expect(childAssignmentDetailResponseSchema.safeParse(leaked).success).toBe(false);
  });
});

describe('load errors', () => {
  it('explains offline, unpaired and missing states calmly', () => {
    expect(childLoadMessage(new ApiRequestError('NETWORK', 'raw', 0))).toMatch(/offline/);
    expect(childLoadMessage(new ApiRequestError('UNAUTHENTICATED', 'raw', 401))).toMatch(
      /grown-up/,
    );
    expect(childLoadMessage(new ApiRequestError('NOT_FOUND', 'raw', 404))).toMatch(/couldn’t find/);
    expect(childLoadMessage(new ApiRequestError('INTERNAL', 'raw', 500))).not.toContain('raw');
  });
});
