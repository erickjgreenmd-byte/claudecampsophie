/**
 * Child-facing rubric feedback for written work (spec P6 "For writing tasks evaluate a rubric and
 * provide feedback"; AC_GRADING_03 "not a false binary grade or generated essay for the child to
 * copy").
 *
 * The grading model's rubric stays parent-only (private.question_solutions). The child gets only
 * the criterion labels, each wrapped in fixed wording: a met criterion is praise, an unmet one is
 * the next thing to work on. The model's free-text notes never reach the child, and a label is
 * used only when it is short plain text: at most 80 characters and 12 words on one line, with no
 * quotation marks, links or email addresses. Anything else is dropped, so a label can never carry
 * an example sentence or paragraph to copy. When no label passes, the child gets no rubric rows and
 * the app asks them to go over the writing with a grown-up.
 */

export const MAX_RUBRIC_FEEDBACK_ROWS = 4;
const MAX_LABEL_CHARS = 80;
const MAX_LABEL_WORDS = 12;

export interface RubricFeedbackRow {
  readonly kind: 'encouragement' | 'method_step';
  readonly body: string;
}

/** A criterion label a child may read, or null when it is not short plain text. */
export function childCriterionLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (/[\r\n]/.test(raw)) return null;
  const label = raw
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?;:,\s]+$/u, '');
  if (label.length < 3 || label.length > MAX_LABEL_CHARS) return null;
  if (label.split(' ').length > MAX_LABEL_WORDS) return null;
  // Quotation marks introduce example wording; links and emails are never child content.
  if (/["“”„«»‹›「」『』]|[‘’'](?=\s|$)|(?:^|\s)[‘'’]/u.test(label)) return null;
  if (/https?:|www\.|@|\/\//iu.test(label)) return null;
  // Control and format characters could hide text (bidi overrides, zero-width joiners).
  if (/[\p{Cc}\p{Cf}]/u.test(label)) return null;
  return label;
}

/**
 * The rubric rows a child sees for one written answer: unmet criteria first (the next step matters
 * most), at most MAX_RUBRIC_FEEDBACK_ROWS, each label once. Invalid input yields no rows.
 */
export function childRubricFeedback(rubric: unknown): RubricFeedbackRow[] {
  if (!Array.isArray(rubric)) return [];
  const next: RubricFeedbackRow[] = [];
  const praise: RubricFeedbackRow[] = [];
  const seen = new Set<string>();
  for (const item of rubric as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const { criterion, met } = item as { criterion?: unknown; met?: unknown };
    if (typeof met !== 'boolean') continue;
    const label = childCriterionLabel(criterion);
    if (label === null) continue;
    const key = label.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    if (met) praise.push({ kind: 'encouragement', body: `You did this well: ${label}.` });
    else next.push({ kind: 'method_step', body: `Next time, work on: ${label}.` });
  }
  return [...next, ...praise].slice(0, MAX_RUBRIC_FEEDBACK_ROWS);
}
