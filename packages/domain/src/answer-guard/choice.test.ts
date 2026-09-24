import { describe, expect, it } from 'vitest';
import { choice, scan } from './test-helpers.ts';

function flagged(content: string, letter: string): boolean {
  const result = scan(content, choice(letter));
  return !result.safe && result.findings.some((f) => f.answerIndex === 0);
}

// Spec P6: no multiple-choice letter in hints. AC_GRADING_07.
describe('AC_GRADING_07 multiple-choice detector flags the withheld letter presented as an answer', () => {
  it.each([
    ['The answer is B.'],
    ['the answer is b'],
    ['Answer: B'],
    ['I think it is (b).'],
    ['[B] is the one.'],
    ['b) 12 apples'],
    ['Option B looks good.'],
    ['Choice b fits.'],
    ['Pick B!'],
    ['Circle letter b.'],
    ['B is correct.'],
    ['b is the right answer'],
    ['Think it over.\nB\nYou can do it!'],
    ['Think it over.\n**B.**'],
    ['La respuesta es la b.'],
    ['Elige la opcion B.'],
    ['Pick the second option.'],
    ['Go with option 2.'],
    ['The correct choice is B.'],
    ["It's B!"],
    ['Definitely B.'],
    ['La opcion correcta es la B.'],
    ['The answer is \u0412.'], // Cyrillic capital Ve looks like B
    ['The answer is \u200BB.'],
  ])('flags "%s" for answer b', (content) => {
    expect(flagged(content, 'b')).toBe(true);
  });

  it.each([
    ['Pick A.', 'a'],
    ['The answer is a.', 'a'],
    ['Choose (a) here.', 'a'],
    ['The answer is I.', 'i'],
    ['Option E is it.', 'e'],
  ])('flags "%s" for an answer that is also an English/Spanish word', (content, letter) => {
    expect(flagged(content, letter)).toBe(true);
  });

  it('accepts the value in "(B)" or "Option B" form and normalizes it to the letter', () => {
    expect(flagged('The answer is B.', '(B)')).toBe(true);
    expect(flagged('The answer is B.', 'Option B')).toBe(true);
  });

  it('protects option text given as an alternate (numeric and text)', () => {
    expect(scan('It is 12.', choice('b', ['12'])).safe).toBe(false);
    expect(scan('It is the blue whale.', choice('b', ['blue whale'])).safe).toBe(false);
  });
});

describe('AC_GRADING_07 multiple-choice detector leaves ordinary words alone', () => {
  it.each([
    ['Be sure to compare both numbers before you begin.', 'b'],
    ['Remember to label the base and the height.', 'b'],
    ['Pick a strategy that makes sense to you.', 'a'],
    ['Think about a number that is a multiple of 3.', 'a'],
    ['Compare each choice carefully.', 'c'],
    ['Draw a diagram for each option.', 'd'],
    ['I think you can do it!', 'i'],
    ['Compare two options before choosing.', 'b'],
    ['Suma y es la respuesta correcta.', 'y'],
  ])('"%s" is safe for answer %s', (content, letter) => {
    const result = scan(content, choice(letter));
    expect(result.findings).toEqual([]);
  });
});
