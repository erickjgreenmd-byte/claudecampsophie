import { describe, expect, it } from 'vitest';
import { practiceAnswerRequestSchema } from '@pencillift/contracts';
import {
  ANSWER_MAX_LENGTH,
  choiceLetter,
  inputHint,
  inputProblemMessage,
  keyboardFor,
  normalizeAnswerInput,
} from './answer-input.ts';

describe('practice answer input normalization', () => {
  it('trims, collapses spaces and drops invisible characters without touching letters', () => {
    expect(normalizeAnswerInput('  1 \u200B 1/4 \n', 'number')).toEqual({
      ok: true,
      value: '1 1/4',
    });
    // Capitalization and spelling are what is practiced: never changed.
    expect(normalizeAnswerInput(' The Dog ran. ', 'text')).toEqual({
      ok: true,
      value: 'The Dog ran.',
    });
    expect(normalizeAnswerInput('recieve', 'word')).toEqual({ ok: true, value: 'recieve' });
  });

  it('maps keyboard look-alikes in number answers: full-width digits, minus signs, fraction slash', () => {
    expect(normalizeAnswerInput('１２', 'number')).toEqual({ ok: true, value: '12' });
    expect(normalizeAnswerInput('\u22125', 'number')).toEqual({ ok: true, value: '-5' });
    expect(normalizeAnswerInput('3\u20444', 'number')).toEqual({ ok: true, value: '3/4' });
    expect(normalizeAnswerInput('½', 'number')).toEqual({ ok: true, value: '1/2' });
    expect(normalizeAnswerInput('7 R 2', 'division')).toEqual({ ok: true, value: '7 R 2' });
    // A dash inside words is left alone.
    expect(normalizeAnswerInput('well\u2013known', 'text')).toEqual({
      ok: true,
      value: 'well\u2013known',
    });
  });

  it('blank input is never sent (and never counts as a try)', () => {
    expect(normalizeAnswerInput('   \u200B ', 'number')).toEqual({ ok: false, reason: 'blank' });
    expect(normalizeAnswerInput('', 'word')).toEqual({ ok: false, reason: 'blank' });
    expect(normalizeAnswerInput('', 'choice', 4)).toEqual({ ok: false, reason: 'choose' });
  });

  it('keeps answers within the request contract limit', () => {
    expect(normalizeAnswerInput('a'.repeat(ANSWER_MAX_LENGTH + 1), 'text')).toEqual({
      ok: false,
      reason: 'too_long',
    });
    const ok = normalizeAnswerInput('a'.repeat(ANSWER_MAX_LENGTH), 'text');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(
        practiceAnswerRequestSchema.safeParse({
          answer: ok.value,
          idempotencyKey: '0f8fad5b-d9cb-469f-a165-70867728950e',
        }).success,
      ).toBe(true);
    }
  });

  it('choices send exactly one valid letter', () => {
    expect(normalizeAnswerInput('b', 'choice', 4)).toEqual({ ok: true, value: 'B' });
    expect(normalizeAnswerInput('(c)', 'choice', 4)).toEqual({ ok: true, value: 'C' });
    expect(normalizeAnswerInput('D.', 'choice', 4)).toEqual({ ok: true, value: 'D' });
    expect(normalizeAnswerInput('E', 'choice', 4)).toEqual({ ok: false, reason: 'choose' });
    expect(normalizeAnswerInput('A and B', 'choice', 4)).toEqual({ ok: false, reason: 'choose' });
    expect([0, 1, 2, 3, 4].map(choiceLetter)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('hints describe the form of an answer, never a value', () => {
    expect(inputHint({ responseFormat: 'number', unitHint: 'cm' })).toBe(
      'Type a number. Your answer is in cm.',
    );
    expect(inputHint({ responseFormat: 'division', unitHint: null })).toMatch(
      /R and the remainder/,
    );
    expect(inputHint({ responseFormat: 'choice', unitHint: null })).toBe(
      'Tap the choice you pick.',
    );
    for (const format of ['number', 'division', 'word', 'text', 'choice'] as const) {
      expect(inputHint({ responseFormat: format, unitHint: null })).not.toMatch(/\d/);
    }
    for (const reason of ['blank', 'too_long', 'choose'] as const) {
      expect(inputProblemMessage(reason)).not.toMatch(/wrong|fail/i);
    }
  });

  it('the keyboard never auto-corrects or auto-capitalizes practice answers', () => {
    for (const format of ['number', 'division', 'word', 'text', 'choice'] as const) {
      expect(keyboardFor(format)).toMatchObject({
        autoCorrect: false,
        autoCapitalize: 'none',
        spellCheck: false,
      });
    }
    expect(keyboardFor('number').keyboardType).toBe('numbers-and-punctuation');
    expect(keyboardFor('word').keyboardType).toBe('default');
  });
});
