import type { ChildPracticeItem, ChildPracticeSet, ChildReviews } from '@pencillift/contracts';

/** Synthetic test data for the learning view models (no real child data). */

export const SET_ID = '33333333-3333-4333-8333-333333333301';
export const ITEM_IDS = [
  '44444444-4444-4444-8444-444444444401',
  '44444444-4444-4444-8444-444444444402',
  '44444444-4444-4444-8444-444444444403',
] as const;

export function item(
  index: number,
  status: ChildPracticeItem['progress']['status'] = 'not_started',
  attempts = 0,
): ChildPracticeItem {
  return {
    id: ITEM_IDS[index] ?? `44444444-4444-4444-8444-4444444444${String(10 + index)}`,
    position: index + 1,
    subjectKey: 'math',
    topic: 'Two-digit addition',
    prompt: {
      text: 'Add the two numbers.',
      choices: null,
      passage: null,
      responseFormat: 'number',
      unitHint: null,
    },
    progress: { status, attempts },
  };
}

export function practiceSet(
  items: ChildPracticeItem[] = [item(0), item(1), item(2)],
  overrides: Partial<ChildPracticeSet> = {},
): ChildPracticeSet {
  return {
    id: SET_ID,
    kind: 'daily',
    status: 'ready',
    subjectKey: null,
    localDate: '2026-09-24',
    reviewWeek: null,
    version: 1,
    optional: false,
    intro: null,
    items,
    ...overrides,
  };
}

export function reviews(): ChildReviews {
  return {
    weekKey: '2026-W39',
    state: 'available',
    sections: [
      {
        subjectKey: 'math',
        displayName: 'Math',
        sets: [
          practiceSet([item(0, 'correct', 1), item(1, 'help_offered', 3)], {
            id: '33333333-3333-4333-8333-333333333311',
            kind: 'thursday_review',
            subjectKey: 'math',
            localDate: null,
            reviewWeek: '2026-W39',
            status: 'completed',
          }),
          practiceSet([item(2)], {
            id: '33333333-3333-4333-8333-333333333312',
            kind: 'top_up',
            subjectKey: 'math',
            localDate: null,
            reviewWeek: '2026-W39',
            version: 2,
            optional: true,
          }),
        ],
      },
      {
        subjectKey: 'reading',
        displayName: 'Reading',
        sets: [
          practiceSet([item(0, 'try_again', 1), item(1)], {
            id: '33333333-3333-4333-8333-333333333321',
            kind: 'thursday_review',
            subjectKey: 'reading',
            localDate: null,
            reviewWeek: '2026-W39',
            status: 'in_progress',
          }),
        ],
      },
      {
        subjectKey: 'science',
        displayName: 'Science',
        sets: [
          practiceSet([item(0), item(1)], {
            id: '33333333-3333-4333-8333-333333333331',
            kind: 'thursday_review',
            subjectKey: 'science',
            localDate: null,
            reviewWeek: '2026-W39',
          }),
        ],
      },
    ],
  };
}
