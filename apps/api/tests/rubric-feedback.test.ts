import { describe, expect, it } from 'vitest';
import {
  MAX_RUBRIC_FEEDBACK_ROWS,
  childCriterionLabel,
  childRubricFeedback,
} from '../src/jobs/rubric-feedback.ts';

/** Child-facing rubric feedback for written work (AC_GRADING_03): labels only, fixed wording. */
describe('childCriterionLabel', () => {
  it('keeps short plain labels, trimming whitespace and trailing punctuation', () => {
    expect(childCriterionLabel('  Uses   complete sentences. ')).toBe('Uses complete sentences');
    expect(childCriterionLabel('Explains the character’s choice')).toBe(
      'Explains the character’s choice',
    );
    expect(childCriterionLabel("Doesn't repeat the same word")).toBe(
      "Doesn't repeat the same word",
    );
  });

  it('drops anything that could carry example wording to copy', () => {
    for (const raw of [
      'Topic sentence like "Dogs are loyal"',
      'Starts with “Once upon a time”',
      "Starts with 'Once upon a time'",
      'Uses «quotes»',
      'Line one\nLine two',
      'x'.repeat(81),
      'one two three four five six seven eight nine ten eleven twelve thirteen',
      'See https://example.com',
      'Ask teacher@example.com',
      'www.example.com has ideas',
      'Hidden‮text',
      'Zero​width',
      'ab',
      '',
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
  });

  it('rejects non-strings', () => {
    expect(childCriterionLabel(null)).toBeNull();
    expect(childCriterionLabel(42)).toBeNull();
    expect(childCriterionLabel({ toString: () => 'Uses details' })).toBeNull();
  });
});

describe('childRubricFeedback', () => {
  it('puts the next steps first, then praise, in fixed wording, never the notes', () => {
    const rows = childRubricFeedback([
      { criterion: 'Uses complete sentences', met: true, note: 'Great subject and verb.' },
      { criterion: 'Gives a reason', met: false, note: 'Try: "because they are loyal".' },
    ]);
    expect(rows).toEqual([
      { kind: 'method_step', body: 'Next time, work on: Gives a reason.' },
      { kind: 'encouragement', body: 'You did this well: Uses complete sentences.' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/loyal|Great subject/);
  });

  it('shows each label once and at most the row cap', () => {
    const rubric = [
      { criterion: 'Uses details', met: false, note: '' },
      { criterion: 'uses details', met: true, note: '' },
      ...['Spelling', 'Capital letters', 'Punctuation', 'Paragraphs', 'Word choice'].map(
        (criterion) => ({ criterion, met: false, note: '' }),
      ),
    ];
    const rows = childRubricFeedback(rubric);
    expect(rows).toHaveLength(MAX_RUBRIC_FEEDBACK_ROWS);
    expect(rows.filter((r) => /uses details/i.test(r.body))).toHaveLength(1);
  });

  it('yields no rows for malformed or empty rubrics', () => {
    expect(childRubricFeedback(null)).toEqual([]);
    expect(childRubricFeedback('Uses details')).toEqual([]);
    expect(childRubricFeedback([])).toEqual([]);
    expect(childRubricFeedback([null, 3, { criterion: 'Uses details' }])).toEqual([]);
    expect(childRubricFeedback([{ criterion: 'Uses details', met: 'yes' }])).toEqual([]);
  });
});
