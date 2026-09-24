import type {
  ChildPracticeItem,
  ChildPracticeSet,
  PracticeAnswerResponse,
} from '@pencillift/contracts';

/**
 * Progress through one practice set, one question at a time (spec P7, P8). Pure and unit-tested.
 * A question is finished when it is solved or when help was offered after three tries; the set is
 * complete when every question is finished (the server's rule), so no child is ever stuck.
 */

export type ItemStatus = ChildPracticeItem['progress']['status'];

export function itemFinished(status: ItemStatus): boolean {
  return status === 'correct' || status === 'help_offered';
}

export interface SetProgress {
  readonly total: number;
  readonly finished: number;
  readonly solved: number;
  readonly complete: boolean;
  /** "2 of 5 done" */
  readonly label: string;
  /** 0..1 for a progress bar. */
  readonly fraction: number;
}

export function setProgress(items: readonly Pick<ChildPracticeItem, 'progress'>[]): SetProgress {
  const total = items.length;
  const finished = items.filter((i) => itemFinished(i.progress.status)).length;
  const solved = items.filter((i) => i.progress.status === 'correct').length;
  return {
    total,
    finished,
    solved,
    complete: total > 0 && finished === total,
    label: `${finished} of ${total} done`,
    fraction: total === 0 ? 0 : finished / total,
  };
}

/** Where to start: the first question not finished yet (or the first one if all are). */
export function firstOpenIndex(items: readonly Pick<ChildPracticeItem, 'progress'>[]): number {
  const index = items.findIndex((i) => !itemFinished(i.progress.status));
  return index === -1 ? 0 : index;
}

/** The next unfinished question after `current` (wrapping around), or null when none is left. */
export function nextOpenIndex(
  items: readonly Pick<ChildPracticeItem, 'progress'>[],
  current: number,
): number | null {
  for (let step = 1; step <= items.length; step++) {
    const index = (current + step) % items.length;
    if (index === current) break;
    if (!itemFinished(items[index]!.progress.status)) return index;
  }
  return null;
}

/** "Question 2 of 5" */
export function positionLabel(index: number, total: number): string {
  return `Question ${index + 1} of ${total}`;
}

/** The set after the server answered one submission (the server's status is authoritative). */
export function applyAnswer(
  set: ChildPracticeSet,
  itemId: string,
  response: PracticeAnswerResponse,
): ChildPracticeSet {
  const items = set.items.map((item) =>
    item.id === itemId
      ? {
          ...item,
          progress: {
            status: response.itemStatus,
            attempts: Math.max(item.progress.attempts, response.attemptNumber),
          },
        }
      : item,
  );
  const status: ChildPracticeSet['status'] = response.setCompleted
    ? 'completed'
    : set.status === 'ready'
      ? 'in_progress'
      : set.status;
  return { ...set, status, items };
}
