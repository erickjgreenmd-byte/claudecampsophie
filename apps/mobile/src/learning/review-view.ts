import type { ChildPracticeSet, ChildReviews } from '@pencillift/contracts';
import { setProgress } from './set-progress.ts';

/**
 * The weekly review as short subject sections the child can finish separately (spec P8). Pure and
 * unit-tested. Optional extra practice (late-scan top-ups) is labeled optional and never counts
 * against finishing the review.
 */

export interface ReviewSetView {
  readonly id: string;
  readonly label: string;
  readonly optional: boolean;
  readonly questionCount: number;
  readonly progressLabel: string;
  readonly statusLabel: string;
  readonly actionLabel: string;
  readonly a11yLabel: string;
  readonly complete: boolean;
}

export interface ReviewSectionView {
  readonly subjectKey: string;
  readonly title: string;
  readonly sets: readonly ReviewSetView[];
  readonly complete: boolean;
}

export interface ReviewView {
  readonly sections: readonly ReviewSectionView[];
  /** "2 of 4 subjects done" (required sections only). */
  readonly summary: string | null;
  readonly allDone: boolean;
}

function setView(set: ChildPracticeSet, subject: string): ReviewSetView {
  const progress = setProgress(set.items);
  const complete = set.status === 'completed' || progress.complete;
  const optional = set.optional || set.kind === 'top_up';
  const label = optional ? 'Extra practice (optional)' : 'Weekly review';
  const questionCount = set.items.length;
  const statusLabel = complete
    ? '✓ Done'
    : progress.finished > 0
      ? 'Keep going'
      : optional
        ? 'Optional'
        : 'Not started';
  const actionLabel = complete ? 'Look again' : progress.finished > 0 ? 'Keep going' : 'Start';
  return {
    id: set.id,
    label,
    optional,
    questionCount,
    progressLabel: progress.label,
    statusLabel,
    actionLabel,
    a11yLabel: `${actionLabel}: ${subject} ${label.toLowerCase()}, ${questionCount} ${
      questionCount === 1 ? 'question' : 'questions'
    }, ${progress.label}`,
    complete,
  };
}

export function buildReviewView(data: ChildReviews): ReviewView {
  const sections = data.sections
    .filter((s) => s.sets.some((set) => set.items.length > 0))
    .map((section) => {
      const sets = section.sets
        .filter((set) => set.items.length > 0)
        .map((set) => setView(set, section.displayName));
      const required = sets.filter((s) => !s.optional);
      return {
        subjectKey: section.subjectKey,
        title: section.displayName,
        sets,
        complete: (required.length > 0 ? required : sets).every((s) => s.complete),
      };
    });
  const required = sections.filter((s) => s.sets.some((set) => !set.optional));
  const done = required.filter((s) => s.complete).length;
  return {
    sections,
    summary:
      required.length > 0
        ? `${done} of ${required.length} ${required.length === 1 ? 'subject' : 'subjects'} done`
        : null,
    allDone: required.length > 0 && done === required.length,
  };
}

/** Finds a set anywhere in the review (after a reload the object identity changes). */
export function findReviewSet(data: ChildReviews, setId: string): ChildPracticeSet | null {
  for (const section of data.sections) {
    const set = section.sets.find((s) => s.id === setId);
    if (set) return set;
  }
  return null;
}

/** The review with one set replaced (after an answer updated its progress). */
export function replaceReviewSet(data: ChildReviews, set: ChildPracticeSet): ChildReviews {
  return {
    ...data,
    sections: data.sections.map((section) => ({
      ...section,
      sets: section.sets.map((s) => (s.id === set.id ? set : s)),
    })),
  };
}
