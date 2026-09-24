import { describe, expect, it } from 'vitest';
import type { PracticeAnswerResponse } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  ASK_GROWN_UP_COPY,
  answerFeedback,
  childLearningError,
  completionCopy,
  finishedItemFeedback,
  methodSteps,
  reviewStateCopy,
  todayStateCopy,
  type AnswerFeedback,
} from './result-copy.ts';

function response(overrides: Partial<PracticeAnswerResponse>): PracticeAnswerResponse {
  return {
    result: 'correct',
    attemptNumber: 1,
    offerHelp: false,
    itemStatus: 'correct',
    pointsAwarded: 0,
    setCompleted: false,
    ...overrides,
  };
}

/** Words that must never appear in child copy: discouraging, diagnostic, or answer-revealing. */
const FORBIDDEN_CHILD_COPY =
  /\b(wrong|fail(ed|ure)?|bad|stupid|dumb|diagnos\w*|master(ed|y)?|answer key|solution|the answer is|correct answer)\b/i;

const NOW = new Date('2026-09-24T18:00:00.000Z');
const time = (iso: string) => iso.slice(11, 16);

function allCopy(): string[] {
  const feedback: AnswerFeedback[] = [
    answerFeedback(response({ pointsAwarded: 5 })),
    answerFeedback(response({ attemptNumber: 3 })),
    answerFeedback(response({ result: 'try_again', itemStatus: 'try_again', pointsAwarded: 2 })),
    answerFeedback(response({ result: 'try_again', itemStatus: 'try_again', attemptNumber: 2 })),
    answerFeedback(
      response({
        result: 'try_again',
        itemStatus: 'help_offered',
        attemptNumber: 3,
        offerHelp: true,
      }),
    ),
    answerFeedback(response({ result: 'unresolved', itemStatus: 'help_offered', offerHelp: true })),
    answerFeedback(response({ result: 'unresolved', itemStatus: 'not_started', attemptNumber: 0 })),
    finishedItemFeedback('correct'),
    finishedItemFeedback('help_offered'),
  ];
  const states = [
    todayStateCopy({ state: 'preparing', releaseAt: null }, NOW, time),
    todayStateCopy({ state: 'paused', releaseAt: null }, NOW, time),
    todayStateCopy({ state: 'not_scheduled', releaseAt: '2026-09-24T19:30:00.000Z' }, NOW, time),
    todayStateCopy({ state: 'not_scheduled', releaseAt: null }, NOW, time),
    reviewStateCopy('preparing')!,
    reviewStateCopy('not_scheduled')!,
  ];
  return [
    ...feedback.flatMap((f) => [f.title, f.message, f.a11yLabel]),
    ...states.flatMap((s) => [s.title, s.message]),
    ...[
      'math',
      'reading',
      'spelling_vocabulary',
      'grammar_writing',
      'science',
      'social_studies',
      'custom',
    ].flatMap((s) => [...methodSteps(s)]),
    ASK_GROWN_UP_COPY,
    ...(['daily', 'thursday_review', 'top_up'] as const).flatMap((k) => {
      const c = completionCopy(k, 12);
      return [c.title, c.message];
    }),
  ];
}

describe('child practice feedback copy (spec P6)', () => {
  it('shows "Correct" with an icon and accessible text, plus any points earned', () => {
    const f = answerFeedback(response({ pointsAwarded: 5 }));
    expect(f).toMatchObject({ tone: 'correct', icon: '✓', title: 'Correct', canRetry: false });
    expect(f.message).toMatch(/You earned 5 points/);
    expect(f.a11yLabel).toMatch(/^Correct\./);
    expect(answerFeedback(response({ pointsAwarded: 0 })).message).not.toMatch(/point/);
  });

  it('shows "Try again" with an icon and accessible text and lets the child retry', () => {
    const f = answerFeedback(response({ result: 'try_again', itemStatus: 'try_again' }));
    expect(f).toMatchObject({ tone: 'try_again', icon: '↻', title: 'Try again', canRetry: true });
    expect(f.a11yLabel).toMatch(/^Try again\./);
    expect(f.showHelpOptions).toBe(false);
  });

  it('after three unsuccessful tries offers method practice or a grown-up, without a lockout', () => {
    const third = answerFeedback(
      response({
        result: 'try_again',
        itemStatus: 'help_offered',
        attemptNumber: 3,
        offerHelp: true,
      }),
    );
    expect(third).toMatchObject({ title: 'Try again', showHelpOptions: true, canRetry: false });
    expect(third.message).toMatch(/practice the method, or ask a grown-up/i);
    expect(third.message).toMatch(/next question/);
    const later = answerFeedback(
      response({ result: 'unresolved', offerHelp: true, itemStatus: 'help_offered' }),
    );
    expect(later).toMatchObject({ tone: 'help', showHelpOptions: true, canRetry: false });
    expect(finishedItemFeedback('help_offered').showHelpOptions).toBe(true);
  });

  it('unreadable input asks for a clearer answer and can be retried (nothing was counted)', () => {
    const f = answerFeedback(
      response({ result: 'unresolved', itemStatus: 'try_again', attemptNumber: 1 }),
    );
    expect(f).toMatchObject({ tone: 'unclear', canRetry: true, showHelpOptions: false });
    expect(f.message).toMatch(/ask a grown-up to review this/);
  });

  it('method steps are general: no digits, so they cannot carry a question’s answer', () => {
    for (const subject of [
      'math',
      'reading',
      'spelling_vocabulary',
      'grammar_writing',
      'science',
      'social_studies',
      'custom',
    ]) {
      const steps = methodSteps(subject);
      expect(steps.length).toBeGreaterThanOrEqual(3);
      for (const step of steps) expect(step).not.toMatch(/\d/);
    }
  });

  it('no child copy is discouraging, diagnostic or answer-revealing', () => {
    for (const text of allCopy()) expect(text, text).not.toMatch(FORBIDDEN_CHILD_COPY);
  });

  it('pauses and missed days never threaten points', () => {
    expect(todayStateCopy({ state: 'paused', releaseAt: null }, NOW, time).message).toMatch(
      /points are safe/,
    );
    for (const text of allCopy()) expect(text).not.toMatch(/lose|lost|expire|streak/i);
  });

  it('today’s states: preparing, paused, opens later, nothing now', () => {
    expect(todayStateCopy({ state: 'preparing', releaseAt: null }, NOW, time).title).toBe(
      'Getting your practice ready',
    );
    expect(
      todayStateCopy({ state: 'not_scheduled', releaseAt: '2026-09-24T19:30:00.000Z' }, NOW, time)
        .message,
    ).toBe('Today’s practice opens at 19:30.');
    expect(
      todayStateCopy({ state: 'not_scheduled', releaseAt: '2026-09-24T17:30:00.000Z' }, NOW, time)
        .title,
    ).toBe('No practice right now');
    expect(reviewStateCopy('available')).toBeNull();
  });

  it('error copy is calm and never shows raw server text', () => {
    expect(childLearningError(new ApiRequestError('NETWORK', 'raw', 0))).toMatch(/offline/);
    expect(childLearningError(new ApiRequestError('RATE_LIMITED', 'raw', 429))).toMatch(
      /little break/,
    );
    expect(childLearningError(new ApiRequestError('UNAUTHENTICATED', 'raw', 401))).toMatch(
      /grown-up/,
    );
    expect(
      childLearningError(new ApiRequestError('INTERNAL', 'stack trace here', 500)),
    ).not.toMatch(/stack/);
    expect(childLearningError(new Error('boom'))).toBe('Something went wrong. Let’s try again.');
  });
});
