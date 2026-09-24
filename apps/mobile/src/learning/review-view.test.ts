import { describe, expect, it } from 'vitest';
import { item, practiceSet, reviews } from './fixtures.ts';
import { buildReviewView, findReviewSet, replaceReviewSet } from './review-view.ts';

describe('weekly review sections (spec P8)', () => {
  it('organizes the review into subject sections the child can finish separately', () => {
    const view = buildReviewView(reviews());
    expect(view.sections.map((s) => s.title)).toEqual(['Math', 'Reading', 'Science']);
    const [math, reading, science] = view.sections;
    expect(math!.complete).toBe(true);
    expect(math!.sets.map((s) => [s.label, s.statusLabel, s.actionLabel, s.progressLabel])).toEqual(
      [
        ['Weekly review', '✓ Done', 'Look again', '2 of 2 done'],
        ['Extra practice (optional)', 'Optional', 'Start', '0 of 1 done'],
      ],
    );
    expect(reading!.complete).toBe(false);
    expect(reading!.sets[0]!.statusLabel).toBe('Not started');
    expect(science!.sets[0]!.a11yLabel).toBe(
      'Start: Science weekly review, 2 questions, 0 of 2 done',
    );
    expect(view.summary).toBe('1 of 3 subjects done');
    expect(view.allDone).toBe(false);
  });

  it('an unfinished optional top-up never blocks finishing the review', () => {
    const data = reviews();
    data.sections = data.sections.slice(0, 1);
    const view = buildReviewView(data);
    expect(view.allDone).toBe(true);
    expect(view.summary).toBe('1 of 1 subject done');
  });

  it('shows "Keep going" once a question is finished, and hides empty sets', () => {
    const data = reviews();
    data.sections[1]!.sets[0] = {
      ...data.sections[1]!.sets[0]!,
      items: [item(0, 'correct', 1), item(1)],
    };
    data.sections[2]!.sets[0] = { ...data.sections[2]!.sets[0]!, items: [] };
    const view = buildReviewView(data);
    expect(view.sections.map((s) => s.title)).toEqual(['Math', 'Reading']);
    expect(view.sections[1]!.sets[0]!.statusLabel).toBe('Keep going');
  });

  it('finds and replaces a set after an answer updates it', () => {
    const data = reviews();
    const id = data.sections[1]!.sets[0]!.id;
    const found = findReviewSet(data, id);
    expect(found?.subjectKey).toBe('reading');
    const updated = replaceReviewSet(data, { ...found!, status: 'completed' });
    expect(findReviewSet(updated, id)?.status).toBe('completed');
    expect(findReviewSet(data, id)?.status).toBe('in_progress');
    expect(findReviewSet(data, practiceSet().id)).toBeNull();
  });
});
