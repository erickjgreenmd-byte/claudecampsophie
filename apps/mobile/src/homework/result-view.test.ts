import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_STATUSES,
  GRADED_VERDICTS,
  childAssignmentDetailResponseSchema,
  type ChildAssignmentDetailResponse,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { childSafetyMessage } from '@pencillift/domain/safety';
import {
  buildResultView,
  childLoadMessage,
  findForbiddenKeys,
  SAFETY_NOTICE_TITLE,
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

describe('written work (AC_GRADING_03)', () => {
  const F2 = '25d24d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
  function writing(feedback: { id: string; kind: 'hint'; body: string }[]) {
    return childAssignmentDetailResponseSchema.parse({
      assignment: {
        id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
        subjectId: null,
        status: 'ready',
        pageCount: 1,
        createdAt: AT,
        updatedAt: AT,
      },
      questions: [
        {
          id: Q1,
          questionNumber: '1',
          promptText: 'Write two sentences about your favourite season.',
          studentAnswerText: 'I like autumn. The leaves turn orange.',
          verdict: 'rubric',
          feedback,
        },
      ],
    });
  }

  it('never promises feedback the child can’t see: with none sent, a grown-up goes over it', () => {
    // The rubric itself is parent-only (never in a child DTO); the child only gets guarded hints.
    const view = buildResultView(writing([]));
    const q = view.questions[0]!;
    expect(q.hints).toEqual([]);
    expect(q.verdict.title).not.toMatch(/feedback/i);
    expect(q.verdict).toMatchObject({ title: 'Ask a grown-up to go over your writing', icon: '★' });
    expect(q.verdict.title).not.toMatch(/correct|wrong|try again/i);
    expect(view.summary).not.toMatch(/feedback/);
    expect(findForbiddenKeys(view)).toEqual([]);
  });

  it('says feedback is ready only when guarded feedback was actually sent', () => {
    const view = buildResultView(
      writing([{ id: F2, kind: 'hint', body: 'Add one more reason for your choice.' }]),
    );
    const q = view.questions[0]!;
    expect(q.verdict).toMatchObject({ title: 'Feedback is ready', icon: '★', tone: 'info' });
    expect(q.hints).toEqual(['Add one more reason for your choice.']);
    expect(view.summary).toBe('1 with feedback');
  });
});

describe('safety template (spec P4; AC_SECURITY_02)', () => {
  const SAFETY_ID = '36e35e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f';
  const HINT_ID = '47f46f7a-8b9c-4d0e-9f2a-3b4c5d6e7f80';
  // The body comes from the reviewed template; the screen only renders it.
  const BODY = childSafetyMessage(['self_harm'], '8-10');

  function flagged(
    status: ChildAssignmentDetailResponse['assignment']['status'],
    feedback: { id: string; kind: 'safety' | 'hint'; body: string }[],
  ) {
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
          promptText: 'Why do plants need sunlight?',
          studentAnswerText: 'synthetic answer',
          verdict: 'incorrect',
          feedback,
        },
        {
          id: Q2,
          questionNumber: '2',
          promptText: 'What is 2 + 5?',
          studentAnswerText: '7',
          verdict: 'correct',
          feedback: [],
        },
      ],
    });
  }

  it('renders the safety template as its own calm notice, not as a hint or a “Try again”', () => {
    const view = buildResultView(flagged('ready', [{ id: SAFETY_ID, kind: 'safety', body: BODY }]));
    const q = view.questions[0]!;
    expect(q.safety).toEqual({
      title: 'Let’s talk with a grown-up',
      body: BODY,
      feedbackId: SAFETY_ID,
      accessibilityLabel: `Question 1: Let’s talk with a grown-up. ${BODY}`,
    });
    expect(q.hints).toEqual([]);
    expect(q.verdict).toMatchObject({ title: 'Let’s talk with a grown-up', tone: 'help' });
    expect(q.verdict.title).not.toMatch(/try again|wrong|correct/i);
    expect(view.questions[1]!.safety).toBeNull();
    // A child in distress does not need a score line next to the notice.
    expect(view.summary).toBeNull();
    expect(findForbiddenKeys(view)).toEqual([]);
  });

  it('puts the template in the header and body the results screen already renders', () => {
    // results.tsx renders status.title as the page header and status.body under it, so the child
    // sees the help lines (988 / Childhelp / 911) even before a per-question card is wired.
    const view = buildResultView(flagged('ready', [{ id: SAFETY_ID, kind: 'safety', body: BODY }]));
    expect(view.status).toEqual({
      title: 'Let’s talk with a grown-up',
      body: BODY,
      showResults: true,
      inProgress: false,
    });
    expect(view.status.body).toContain('988');
    expect(view.status.body).toContain('911');
    const plain = buildResultView(flagged('ready', []));
    expect(plain.status.title).toBe('Your results are ready');
  });

  it('shows every distinct template once when several answers were flagged', () => {
    const abuse = childSafetyMessage(['abuse'], '8-10');
    const parsed = flagged('needs_parent_review', [{ id: SAFETY_ID, kind: 'safety', body: BODY }]);
    const detail = {
      ...parsed,
      questions: [
        parsed.questions[0]!,
        {
          ...parsed.questions[1]!,
          feedback: [{ id: HINT_ID, kind: 'safety' as const, body: abuse }],
        },
      ],
    };
    const view = buildResultView(detail);
    expect(view.status.title).toBe('Let’s talk with a grown-up');
    expect(view.status.body).toBe(`${BODY}\n\n${abuse}`);
    expect(view.status.body).toContain('988');
    expect(view.status.body).toContain('1-800-422-4453');
  });

  it('hides coaching from an earlier transcription next to the safety notice', () => {
    const view = buildResultView(
      flagged('ready', [
        { id: HINT_ID, kind: 'hint', body: 'Try again slowly.' },
        { id: SAFETY_ID, kind: 'safety', body: BODY },
      ]),
    );
    expect(view.questions[0]!.hints).toEqual([]);
    expect(view.questions[0]!.safety?.body).toBe(BODY);
  });

  it('shows the notice whatever the scan status: it does not wait for grading (RV-child-safety-5)', () => {
    // The scan job files the template before any grading call, so a scan still being checked, or
    // one whose grading failed for good, can carry it. The help lines are shown; results are not.
    for (const status of ['checking', 'verifying', 'failed_final', 'failed_retryable'] as const) {
      const view = buildResultView(
        flagged(status, [{ id: SAFETY_ID, kind: 'safety', body: BODY }]),
      );
      expect(view.questions[0]!.safety?.body, status).toBe(BODY);
      expect(view.status.title, status).toBe(SAFETY_NOTICE_TITLE);
      expect(view.status.body, status).toBe(BODY);
      expect(view.status.showResults, status).toBe(false);
      expect(view.status.inProgress, status).toBe(statusView(status).inProgress);
      expect(view.questions[1]!.verdict.title, status).toBe('Still checking');
      expect(view.summary, status).toBeNull();
    }
    // A hint is never shown before results are, even next to no notice.
    const hinted = buildResultView(flagged('checking', [{ id: HINT_ID, kind: 'hint', body: 'x' }]));
    expect(hinted.questions[0]!.hints).toEqual([]);
    expect(hinted.questions[0]!.safety).toBeNull();
    expect(hinted.questions[0]!.verdict.title).toBe('Still checking');
  });

  it('the notice copy never claims an alert and never asks for secrecy', () => {
    const view = buildResultView(flagged('ready', [{ id: SAFETY_ID, kind: 'safety', body: BODY }]));
    const text = JSON.stringify(view.questions[0]!.safety);
    expect(text).not.toMatch(/alerted|notified|we told|told your|secret between/i);
    expect(SAFETY_NOTICE_TITLE).toBe('Let’s talk with a grown-up');
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
