import { describe, expect, it } from 'vitest';
import type { PracticeAnswerResponse } from '@pencillift/contracts';
import { ITEM_IDS, item, practiceSet } from './fixtures.ts';
import {
  applyAnswer,
  firstOpenIndex,
  itemFinished,
  nextOpenIndex,
  positionLabel,
  setProgress,
} from './set-progress.ts';

function response(overrides: Partial<PracticeAnswerResponse> = {}): PracticeAnswerResponse {
  return {
    result: 'correct',
    attemptNumber: 1,
    offerHelp: false,
    itemStatus: 'correct',
    pointsAwarded: 5,
    setCompleted: false,
    ...overrides,
  };
}

describe('practice set progress', () => {
  it('counts solved and help-offered questions as finished, never "try again" ones', () => {
    expect(itemFinished('correct')).toBe(true);
    expect(itemFinished('help_offered')).toBe(true);
    expect(itemFinished('try_again')).toBe(false);
    expect(itemFinished('not_started')).toBe(false);
    const progress = setProgress([
      item(0, 'correct', 1),
      item(1, 'help_offered', 3),
      item(2, 'try_again', 1),
    ]);
    expect(progress).toEqual({
      total: 3,
      finished: 2,
      solved: 1,
      complete: false,
      label: '2 of 3 done',
      fraction: 2 / 3,
    });
  });

  it('an empty set is never "complete"', () => {
    expect(setProgress([]).complete).toBe(false);
    expect(setProgress([]).fraction).toBe(0);
  });

  it('starts at the first unfinished question and moves to the next one, wrapping around', () => {
    const items = [item(0, 'correct'), item(1), item(2, 'try_again')];
    expect(firstOpenIndex(items)).toBe(1);
    expect(nextOpenIndex(items, 1)).toBe(2);
    expect(nextOpenIndex(items, 2)).toBe(1);
    expect(nextOpenIndex([item(0, 'correct'), item(1)], 1)).toBeNull();
    expect(firstOpenIndex([item(0, 'correct'), item(1, 'correct')])).toBe(0);
    expect(positionLabel(1, 5)).toBe('Question 2 of 5');
  });

  it('applies the server’s verdict to one question and marks the set started or completed', () => {
    const set = practiceSet();
    const after = applyAnswer(
      set,
      ITEM_IDS[0],
      response({ result: 'try_again', itemStatus: 'try_again', attemptNumber: 1 }),
    );
    expect(after.status).toBe('in_progress');
    expect(after.items[0]!.progress).toEqual({ status: 'try_again', attempts: 1 });
    expect(after.items[1]).toBe(set.items[1]);
    expect(set.items[0]!.progress.status).toBe('not_started');

    const done = applyAnswer(
      after,
      ITEM_IDS[0],
      response({ attemptNumber: 2, setCompleted: true }),
    );
    expect(done.status).toBe('completed');
    expect(done.items[0]!.progress).toEqual({ status: 'correct', attempts: 2 });
  });

  it('an unchecked (unresolved) answer never lowers the recorded number of tries', () => {
    const set = practiceSet([item(0, 'try_again', 2)], { status: 'in_progress' });
    const after = applyAnswer(
      set,
      ITEM_IDS[0],
      response({
        result: 'unresolved',
        itemStatus: 'try_again',
        attemptNumber: 0,
        pointsAwarded: 0,
      }),
    );
    expect(after.items[0]!.progress).toEqual({ status: 'try_again', attempts: 2 });
    expect(after.status).toBe('in_progress');
  });
});
