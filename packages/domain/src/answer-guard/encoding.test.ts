import { describe, expect, it } from 'vitest';
import { base64, choice, hex, numeric, rot13, scan, spelling } from './test-helpers.ts';

// Spec P6 "Do not leak by ... encoding ... rendered math". AC_GRADING_08 "encodings".
describe('AC_GRADING_08 encoded leaks are decoded and re-scanned', () => {
  const FORTY_TWO = numeric('42');

  it.each([
    ['base64 sentence', `Secret: ${base64('The answer is 42')}`],
    [
      'base64url sentence',
      `Secret: ${base64('answer?? 42 >>').replace(/\+/g, '-').replace(/\//g, '_')}`,
    ],
    ['short base64 of the bare value', 'Secret: NDI='],
    ['short hex of the bare value', 'Secret: 3432'],
    ['0x-prefixed hex', 'Secret: 0x3432'],
    ['escaped hex bytes', 'Secret: \\x34\\x32'],
    ['long hex sentence', `Secret: ${hex('answer: 42')}`],
    ['percent-encoding', 'Secret: %34%32'],
    ['percent-encoded sentence', 'Secret: the%20answer%20is%2042'],
    ['double base64', `Secret: ${base64(base64('The answer is 42'))}`],
    ['ROT13 number words', `Psst: ${rot13('the answer is forty-two')}`],
    ['HTML numeric entities', 'Secret: &#52;&#50;'],
    ['HTML markup split', 'Secret: <span>4</span><span>2</span>'],
  ])('flags %s', (_label, content) => {
    const result = scan(content, FORTY_TWO);
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.detector === 'encoding' && f.answerIndex === 0)).toBe(
      true,
    );
  });

  it('reports the decoding chain on findings from decoded text', () => {
    const result = scan(`Secret: ${base64(base64('The answer is 42'))}`, FORTY_TWO);
    expect(result.findings.some((f) => f.via.join('>') === 'base64>base64')).toBe(true);
  });

  it('fails closed when encodings are nested deeper than the decode limit', () => {
    const triple = base64(base64(base64('The answer is 42')));
    const result = scan(`Secret: ${triple}`, FORTY_TWO);
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.technique === 'encoding_depth_exceeded')).toBe(true);
  });

  it.each([
    ['base64', base64('learn')],
    ['hex', hex('learn')],
    ['percent', '%6C%65%61%72%6E'],
    ['ROT13', rot13('learn')],
    ['markup', 'le<b>ar</b>n'],
  ])('flags a %s-wrapped spelling target', (_label, content) => {
    expect(scan(`Hint: ${content}`, spelling('learn')).safe).toBe(false);
  });

  it('flags rendered-math fractions in MathML and HTML entities', () => {
    const half = numeric('1/2');
    expect(scan('<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>', half).safe).toBe(false);
    expect(scan('It is &frac12;.', half).safe).toBe(false);
  });

  it('flags a base64-wrapped multiple-choice answer', () => {
    expect(scan(`Hint: ${base64('The answer is B')}`, choice('b')).safe).toBe(false);
  });
});

describe('AC_GRADING_08 ordinary text is not mistaken for an encoding', () => {
  it.each([
    ['1', 'Use a bar model to compare.'],
    ['8', 'Understanding multiplication takes practice.'],
    ['4', 'Remember to regroup carefully when subtracting.'],
    ['1', 'Or you could draw it.'],
  ])('answer %s: "%s" is safe', (value, content) => {
    expect(scan(content, numeric(value)).findings).toEqual([]);
  });
});
