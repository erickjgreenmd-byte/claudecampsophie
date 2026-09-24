// Neighboring cases for the RV-answer-guard-1..16 fixes: variants that must now be caught, and
// ordinary coaching that the chosen rules must keep releasing (spec P6, P12 fail closed, P4
// payload-free logs; AC_GRADING_06/07/08, AC_MON_02). Synthetic data only (Riley, Sam).
import { describe, expect, it } from 'vitest';
import { findForbiddenFields, guardChildContent, scanChildPacket } from './index.ts';
import { choice, numeric, scan, spelling } from './test-helpers.ts';

function leaks(content: string, answer: Parameters<typeof scan>[1]): boolean {
  return !scan(content, answer).safe;
}

function techniques(content: string, answer: Parameters<typeof scan>[1]): string[] {
  return scan(content, answer).findings.map((f) => f.technique);
}

describe('RV-1 neighbors: numerals past the exact-comparison bound', () => {
  it('reads tiny values with long leading fraction zeros exactly (no fail-closed needed)', () => {
    const tiny = `0.${'0'.repeat(45)}5`;
    expect(techniques(`It is ${tiny}.`, numeric('7'))).toEqual([]);
    expect(techniques(`It is ${tiny}.`, numeric(tiny))).toContain('decimal');
  });

  it('fails closed (LIMIT_EXCEEDED) on a numeral with more than 40 significant digits', () => {
    const decision = guardChildContent({
      packet: { hint: `Count to ${'9'.repeat(41)}.` },
      answers: [numeric('7')],
    });
    expect(decision.decision).toBe('block');
    expect(decision.reasons.map((r) => r.code)).toContain('LIMIT_EXCEEDED');
  });

  it('does not fail closed on long numerals when no numeric answer is protected', () => {
    expect(scan(`Count to ${'9'.repeat(41)}.`, spelling('learn')).findings).toEqual([]);
  });

  it('reads zero-padded digit tokens inside number phrases', () => {
    expect(leaks(`It has ${'0'.repeat(45)}4 tens and 2 ones.`, numeric('42'))).toBe(true);
  });
});

describe('RV-2 neighbors: recovered encodings', () => {
  it.each([
    ['hex of a spelling target + 0xFF', Buffer.from('learnÿ', 'latin1').toString('hex')],
    ['UTF-16BE base64', Buffer.from('learn', 'utf16le').swap16().toString('base64')],
    ['base64 with a NUL between words', Buffer.from('learn\u0000it', 'latin1').toString('base64')],
  ])('flags %s', (_label, content) => {
    expect(leaks(`Hint: ${content}`, spelling('learn'))).toBe(true);
  });

  it('keeps ordinary words that happen to be valid base64 out of recovery', () => {
    for (const content of [
      'Migrations are forward-only.',
      'Monetization ships later.',
      'Show the billed/estimated cost.',
    ]) {
      expect(scan(content, numeric('2')).findings).toEqual([]);
    }
  });
});

describe('RV-3 neighbors: rendered-math digit grouping', () => {
  it.each([
    ['LaTeX thin space', 'It is $1\\,500$.', '1500'],
    ['nested grouping braces', 'It is $1{{,}}500$.', '1500'],
    ['\\tfrac', 'It is $\\tfrac{1}{2}$.', '1/2'],
    ['\\cfrac with alignment', 'It is $\\cfrac[l]{1}{2}$.', '1/2'],
    ['\\nicefrac', 'It is \\nicefrac{3}{4}.', '3/4'],
  ])('flags %s', (_label, content, value) => {
    expect(leaks(content, numeric(value))).toBe(true);
  });
});

describe('RV-4 neighbors: every reading of the protected answer', () => {
  it('protects both readings of a Spanish-thousands key with a decimal part', () => {
    expect(leaks('La respuesta es 1500,5.', numeric('1.500,5'))).toBe(true);
  });

  it('still protects the plain reading', () => {
    expect(leaks('The answer is 1500.', numeric('1,500'))).toBe(true);
    expect(leaks('The answer is 1.5.', numeric('1.500'))).toBe(true);
  });
});

describe('RV-5 neighbors: multiple-choice reveals and the pronoun "I"', () => {
  it.each([['Right = C'], ['It has to be C.'], ["C's correct."], ['Debe ser la C.']])(
    'flags "%s" for answer c',
    (content) => {
      expect(leaks(content, choice('c'))).toBe(true);
    },
  );

  it.each([
    ['I would be happy to help you try again!', 'i'],
    ['I will be right here if you need me.', 'i'],
    ['It is a good idea to check your work.', 'a'],
    ['It must be a number bigger than 10.', 'a'],
    ['Right: let us try another way.', 'l'],
    ['Best: take your time and read slowly.', 't'],
  ])('"%s" is safe for answer %s', (content, letter) => {
    expect(scan(content, choice(letter)).findings).toEqual([]);
  });

  it('still flags a wrapped "I" declared correct', () => {
    expect(leaks('"I" would be correct.', choice('i'))).toBe(true);
  });
});

describe('RV-6/7/8 neighbors: forbidden keys match the contracts, not ordinary child fields', () => {
  it.each([
    'uncertainty',
    'disagreement',
    'route',
    'evidence',
    'correctChoice',
    'correct_letter',
    'destinationUrl',
    'merchantUrl',
    'impressionCap',
  ])('flags "%s"', (key) => {
    expect(findForbiddenFields({ hint: 'ok', [key]: 'x' })).toHaveLength(1);
  });

  it('allows truthful correctness feedback and child progress fields', () => {
    const dto = {
      correct: true,
      isCorrect: false,
      correctCount: 3,
      routeName: 'practice',
      evidenceOfEffort: 'You kept trying!',
      aiDisclosure: 'A computer helper wrote this hint.',
      steps: [{ kind: 'hint', text: 'Count the tens first.' }],
    };
    expect(findForbiddenFields(dto)).toEqual([]);
  });
});

describe('RV-9/10 neighbors: link shapes', () => {
  it.each([['Go to linktr。ee/helper'], ['See rileybooks.shop.example.zz/page'], ['Visit bit.do']])(
    'flags "%s"',
    (content) => {
      expect(scan(content, numeric('7')).findings.some((f) => f.detector === 'url')).toBe(true);
    },
  );

  it.each([['It is 3.5/7 of the strip.'], ['Use km/h for speed.'], ['Mr./Mrs. Lee said hi.']])(
    '"%s" is not a URL',
    (content) => {
      expect(scan(content, numeric('9')).findings).toEqual([]);
    },
  );
});

describe('RV-11 neighbors: other-script digits', () => {
  it.each([
    ['Arabic-Indic fraction', '١/٢', '1/2'],
    ['Bengali digits', '৪২', '42'],
    ['Thai digits', '๔๒', '42'],
    ['Tai Tham Tham digits (adjacent run)', '᪔᪒', '42'],
  ])('reads %s', (_label, digits, value) => {
    expect(leaks(`The answer is ${digits}.`, numeric(value))).toBe(true);
  });
});

describe('RV-12 neighbors: arrays serialized differently from their elements', () => {
  it('fails closed on an array subclass', () => {
    class Steps extends Array<string> {}
    const steps = new Steps();
    steps.push('Count the ones.');
    const result = scanChildPacket({ steps }, [numeric('42')]);
    expect(result.findings.map((f) => f.technique)).toContain('unsupported_value');
  });

  it('scans a string stored under an extra array key', () => {
    const steps = Object.assign(['Count the ones.'], { note: 'The answer is 42' });
    expect(guardChildContent({ packet: { steps }, answers: [numeric('42')] }).decision).toBe(
      'block',
    );
  });

  it('still releases a plain array of safe hints', () => {
    const packet = { steps: ['Count the ones.', 'Then count the tens.'] };
    expect(guardChildContent({ packet, answers: [numeric('42')] }).decision).toBe('release');
  });
});

describe('RV-13 neighbors: payload-free forbidden-field paths', () => {
  it('redacts a leaking key that is itself forbidden', () => {
    const decision = guardChildContent({
      packet: { hint: 'ok', answerKey_learn: 'x' },
      answers: [spelling('learn')],
    });
    expect(decision.reasons.map((r) => r.code)).toContain('FORBIDDEN_FIELD');
    expect(JSON.stringify(decision)).not.toContain('learn');
  });

  it('keeps plain schema names in forbidden paths', () => {
    const decision = guardChildContent({
      packet: { hints: { rubric: 'x' } },
      answers: [spelling('learn')],
    });
    expect(decision.reasons.find((r) => r.code === 'FORBIDDEN_FIELD')?.path).toBe('$.hints.rubric');
  });
});

describe('RV-14 neighbors: "a in b" is read in its ratio sense only', () => {
  it('reads number words and mixed forms', () => {
    expect(leaks('There is a one in two chance.', numeric('1/2'))).toBe(true);
    expect(leaks('About 1 in four marbles are red.', numeric('1/4'))).toBe(true);
    expect(leaks('Odds are one in a million.', numeric('1/1000000'))).toBe(true);
  });

  it('does not read a restated division ("12 in 3 rows") as its quotient', () => {
    expect(scan('Put 12 in 3 rows and count one row.', numeric('4')).findings).toEqual([]);
    expect(scan('Split twelve in three equal groups.', numeric('4')).findings).toEqual([]);
  });
});

describe('RV-15 neighbors: ordinal words', () => {
  it.each([
    ['compound', 'She was twenty-first in line.', '21'],
    ['Spanish', 'Sam llego quinto.', '5'],
    ['Spanish fraction "la cuarta parte"', 'Es la cuarta parte.', '1/4'],
    ['Spanish "tres cuartas partes"', 'Son tres cuartas partes.', '3/4'],
    ['a lone sequencing adverb', 'Third, add the tens.', '3'],
  ])('reads %s', (_label, content, value) => {
    expect(leaks(content, numeric(value))).toBe(true);
  });

  it.each([
    ['First, count the tens.\nSecond, count the ones.\nThird, add them.', '3'],
    ['Primero, cuenta.\nSegundo, suma.\nTercero, revisa.', '3'],
    ['Add the ones first, then the tens.', '1'],
    ['Wait a second, then try again.', '2'],
    ['Mira el cuarto dibujo.', '4'],
    ['Count the fifths on the strip.', '5'],
  ])('"%s" is safe for answer %s', (content, value) => {
    expect(scan(content, numeric(value)).findings).toEqual([]);
  });
});

describe('RV-16 neighbors: multi-word targets written together', () => {
  it('flags the joined, reversed and leetspeak forms', () => {
    expect(leaks('Write icecream here.', spelling('ice cream'))).toBe(true);
    expect(leaks('Backwards: tnod.', spelling("don't"))).toBe(true);
    expect(leaks('Write d0nt.', spelling("don't"))).toBe(true);
  });

  it('does not match a longer word that merely starts with the letters', () => {
    expect(scan('The donut shop is closed.', spelling("don't")).findings).toEqual([]);
  });
});
