import { describe, expect, it } from 'vitest';
import { scan, spelling, text } from './test-helpers.ts';

function techniques(content: string, answer = spelling('learn')): string[] {
  return scan(content, answer).findings.map((f) => f.technique);
}

// Spec P6: no "complete spelling target, completed sentence, or essay response in hints", and
// no leak "by acrostic". AC_GRADING_07.
describe('AC_GRADING_07 spelling target "learn" is flagged however it is disguised', () => {
  it.each([
    ['whole word', 'You will learn it.'],
    ['upper case', 'LEARN'],
    ['hyphen-separated letters', 'Spell it l-e-a-r-n.'],
    ['space-separated letters', 'Spell it l e a r n.'],
    ['dot-separated letters', 'Spell it l.e.a.r.n'],
    ['one letter per line', 'l\ne\na\nr\nn'],
    ['markdown-wrapped letters', '**L**-**E**-**A**-**R**-**N**'],
    ['reversed', 'Backwards it is nrael.'],
    ['reversed and separated', 'n-r-a-e-l'],
    ['leetspeak 3', 'l3arn'],
    ['leetspeak 1 and 4', '1e4rn'],
    ['leetspeak @', 'le@rn'],
    ['inflected form', 'Keep learning!'],
    ['zero-width split', 'le\u200Barn'],
    ['homoglyph', 'l\u0435arn'],
  ])('flags %s', (_label, content) => {
    expect(scan(content, spelling('learn')).safe).toBe(false);
  });

  it('flags an acrostic over the first letters of lines', () => {
    const acrostic =
      'Look at the first sound.\nEvery letter matters.\nAsk for help.\nRead it aloud.\nNever give up.';
    expect(techniques(acrostic)).toContain('acrostic_lines');
  });

  it('flags an acrostic over the first letters of sentences', () => {
    const acrostic = 'Look closely. Each sound helps. Always sound it out. Read slowly. Nice work.';
    expect(techniques(acrostic)).toContain('acrostic_sentences');
  });

  it('flags an acrostic over the first letters of consecutive words', () => {
    expect(techniques('Listen, every afternoon Riley narrates.')).toContain('acrostic_words');
  });

  it('flags a spelling given as letter names ("L is for lion")', () => {
    const content = 'L is for lion, E is for egg, A is for ant, R is for rain, N is for nest.';
    expect(techniques(content)).toContain('letter_names');
  });

  it('flags a long target split across a space', () => {
    expect(scan('Say be cause slowly.', spelling('because')).safe).toBe(false);
  });

  it('protects accepted alternate spellings', () => {
    expect(scan('Write colour.', spelling('color', ['colour'])).safe).toBe(false);
  });
});

describe('AC_GRADING_07 spelling detector passes ordinary coaching', () => {
  it.each([
    ['learn', 'Sound it out slowly and clap each part.'],
    ['learn', 'Clear, early handwriting helps.'],
    ['cat', 'Look at each category of animals.'],
    ['ship', 'Say the first sound, then the last sound.'],
  ])('target %s: "%s" is safe', (target, content) => {
    expect(scan(content, spelling(target)).findings).toEqual([]);
  });
});

describe('AC_GRADING_07 text answers (completed sentences)', () => {
  const answer = text('The mitochondria is the powerhouse of the cell');

  it('flags full normalized phrase containment regardless of punctuation and case', () => {
    expect(scan('Remember: THE mitochondria is... the powerhouse of the cell!', answer).safe).toBe(
      false,
    );
  });

  it('flags >= 60% token-trigram overlap with a near copy', () => {
    const result = scan('So mitochondria is the powerhouse of the cell, right?', answer);
    expect(result.findings.map((f) => f.technique)).toContain('trigram_overlap');
  });

  it('flags the sentence written backwards', () => {
    const reversed = [...'the mitochondria is the powerhouse of the cell'].reverse().join('');
    expect(scan(reversed, answer).safe).toBe(false);
  });

  it('passes a method hint that shares a few words', () => {
    expect(scan('Think about which part of the cell makes energy.', answer).findings).toEqual([]);
  });

  it('treats a single-word text answer like a spelling target', () => {
    expect(scan('It is photo synthesis.', text('photosynthesis')).safe).toBe(false);
    expect(scan('It is ph0t0synthesis.', text('photosynthesis')).safe).toBe(false);
  });
});
