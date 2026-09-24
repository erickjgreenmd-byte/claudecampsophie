// Independent adversarial review of the answer-leak guard (spec P6, P3 last paragraph, P12 payload
// validation, E4 "Answer protection"; AC_GRADING_06/07/08, AC_MON_02). Each test reproduces a
// confirmed fail-open path and is expected to FAIL until the defect is fixed. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { findForbiddenFields, guardChildContent, scanForLeaks } from './index.ts';
import { choice, numeric, scan, spelling } from './test-helpers.ts';

function leaks(content: string, answer: Parameters<typeof scan>[1]): boolean {
  return !scan(content, answer).safe;
}

function base64Bytes(bytes: Buffer): string {
  return bytes.toString('base64');
}

describe('answer-guard adversarial review', () => {
  // P6 "No original problem's final numeric value ... in hints"; P12 "fail closed". A numeric
  // literal longer than MAX_DIGITS (40) is silently dropped by parseLiteral, so zero padding hides
  // the exact value instead of failing closed.
  it('[RV-answer-guard-1] zero-padded numerals longer than 40 digits still leak the value', () => {
    expect(leaks(`The answer is ${'0'.repeat(43)}42.`, numeric('42'))).toBe(true);
    expect(leaks(`The answer is 7.${'0'.repeat(45)} exactly.`, numeric('7'))).toBe(true);
    expect(leaks(`It is about 0.${'3'.repeat(45)}`, numeric('1/3'))).toBe(true);
  });

  // P6 "Do not leak by ... encoding"; AC_GRADING_08 "encodings ... do not leak solutions". Decoded
  // bytes that are not strictly valid, control-free UTF-8 are discarded (asText returns null), so
  // one appended invalid byte, a NUL, or UTF-16 encoding hides the answer from every detector.
  it('[RV-answer-guard-2] encodings padded with an invalid or control byte are not skipped', () => {
    const answer = numeric('42');
    const withFf = Buffer.concat([Buffer.from('The answer is 42', 'utf8'), Buffer.from([0xff])]);
    expect(leaks('Secret: %34%32%FF', answer)).toBe(true);
    expect(leaks(`Secret: ${base64Bytes(withFf)}`, answer)).toBe(true);
    expect(leaks(`Secret: ${withFf.toString('hex')}`, answer)).toBe(true);
    expect(leaks(`Secret: ${base64Bytes(Buffer.from('The answer is 42\u0000'))}`, answer)).toBe(
      true,
    );
    expect(
      leaks(`Secret: ${base64Bytes(Buffer.from('The answer is 42', 'utf16le'))}`, answer),
    ).toBe(true);
    const learnFf = Buffer.concat([Buffer.from('learn', 'utf8'), Buffer.from([0xff])]);
    expect(leaks(`Hint: ${base64Bytes(learnFf)}`, spelling('learn'))).toBe(true);
  });

  // P6 "Do not leak by ... rendered math". \cfrac (KaTeX/MathJax) and the {,} digit-grouping idiom
  // render (and read, even as plain text) as the fraction/number, but are not parsed.
  it('[RV-answer-guard-3] LaTeX \\cfrac and {,} digit grouping are read as numbers', () => {
    expect(leaks('Look: $\\cfrac{1}{2}$', numeric('1/2'))).toBe(true);
    expect(leaks('The total is $1{,}500$.', numeric('1500'))).toBe(true);
    expect(leaks('La respuesta es $4{,}2$.', numeric('4.2'))).toBe(true);
  });

  // Fail-closed decision ("every plausible reading ... including locale-ambiguous ones") is applied
  // to child text but not to the protected answer: maximalMentions drops the alt-locale reading of
  // the answer, so a Spanish-locale key "1.500" (1500) protects only 1.5.
  it('[RV-answer-guard-4] a locale-ambiguous protected answer protects every reading', () => {
    expect(leaks('La respuesta es 1500.', numeric('1.500'))).toBe(true);
    expect(leaks('The answer is 1.5.', numeric('1,500'))).toBe(true);
  });

  // P6 "No ... multiple-choice letter ... in hints". Common answer-key label phrasings present the
  // withheld letter as the answer but match no cue.
  it.each([['Correct: B'], ['It must be B.'], ['B would be correct.']])(
    '[RV-answer-guard-5] multiple-choice reveal "%s" is flagged',
    (content) => {
      expect(leaks(content, choice('b'))).toBe(true);
    },
  );

  // P5: "Private result contains correct answer, concise teachable worked solution, rubric,
  // misconception, evidence and grading provenance"; AC_GRADING_06 no withheld fields in child
  // payloads. The project's own CHILD_FORBIDDEN_HOMEWORK_KEYS lists these, the guard does not.
  it.each([['misconception'], ['gradingProvenance'], ['grading_provenance']])(
    '[RV-answer-guard-6] private grading-result key "%s" is a forbidden child field',
    (key) => {
      expect(findForbiddenFields({ hint: 'ok', [key]: 'x' })).toHaveLength(1);
    },
  );

  // AC_GRADING_06 "no withheld key/solution fields"; P3 "No answer keys in child network
  // responses ... hidden UI fields". A multiple-choice key stored as an index passes both checks.
  it('[RV-answer-guard-7] a multiple-choice answer key given by index is blocked', () => {
    const packet = {
      question: 'Which number is greatest?',
      options: ['12', '15', '18'],
      correctOptionIndex: 2,
    };
    expect(findForbiddenFields(packet).length).toBeGreaterThan(0);
    expect(guardChildContent({ packet, answers: [choice('c')] }).decision).toBe('block');
  });

  // AC_MON_02 "Child and unknown-role sessions receive no commercial placement DTO, affiliate tag,
  // advertiser asset". Shapes copied from packages/contracts/src/monetization.ts (sponsorCardSchema,
  // placementResponseSchema, resourceItemSchema) carry no key in FORBIDDEN_KEY_FRAGMENTS.
  it('[RV-answer-guard-8] the P16 sponsor placement and Amazon resource DTOs are not child-safe', () => {
    const placementResponse = {
      card: {
        serveToken: 'q3Zr8vK1xY7mN2pL5tW9aB4cD6eF0gH1iJ2kL3mN4oP',
        placement: 'adult_dashboard',
        label: 'Sponsored by Riley Books',
        headline: 'Fun workbooks',
        body: 'Practice at home',
        ctaLabel: 'Learn more',
        destinationHost: 'rileybooks.example',
        imageAssetRef: null,
        whyShown: 'Because you browse math resources',
      },
      reason: 'served',
    };
    expect(findForbiddenFields(placementResponse).length).toBeGreaterThan(0);
    const resources = {
      mode: 'amazon_associates',
      commercialHidden: false,
      items: [
        {
          id: '123e4567-e89b-42d3-a456-426614174000',
          title: 'Grade 3 math workbook',
          description: 'Practice pages',
          kind: 'workbook',
          mode: 'amazon_associates',
          merchant: 'amazon',
          disclosure: 'As an Amazon Associate we earn from qualifying purchases.',
          price: null,
          availability: 'available',
          imageAssetRef: null,
        },
      ],
    };
    expect(guardChildContent({ packet: resources, answers: [numeric('42')] }).decision).toBe(
      'block',
    );
  });

  // P6 "Do not leak by ... shortened URLs"; AC_MON_02. The WHATWG URL parser maps U+3002 and U+FF61
  // to '.', so "bit。ly/..." is a working bit.ly link, but NFKC leaves U+3002 alone.
  it('[RV-answer-guard-9] ideographic full stops in a shortener URL are detected', () => {
    expect(new URL('https://bit。ly/3abc').hostname).toBe('bit.ly');
    expect(leaks('Go to bit。ly/3abc for help.', numeric('7'))).toBe(true);
    expect(leaks('Go to bit｡ly/3abc for help.', numeric('7'))).toBe(true);
  });

  // Requirement: "any URL/domain/shortener pattern ... in child text is a finding". The domain and
  // "*.ly/" rules depend on a fixed TLD allow-list, so well-known shorteners on other TLDs pass.
  it.each([['bit.do/xyz1'], ['linktr.ee/helper'], ['shorte.st/abc']])(
    '[RV-answer-guard-10] shortener link "%s" is a URL finding',
    (link) => {
      const result = scanForLeaks(`Go to ${link} now.`, [numeric('7')]);
      expect(result.findings.some((f) => f.detector === 'url')).toBe(true);
    },
  );

  // P6 "translated text"; numeric requirement "extract every number representation (digits ...)".
  // NFKC does not fold other-script decimal digits (\p{Nd}), and the parsers only read [0-9].
  it('[RV-answer-guard-11] non-ASCII decimal digits are read as numbers', () => {
    expect(leaks('The answer is ٤٢.', numeric('42'))).toBe(true);
    expect(leaks('The answer is ४२.', numeric('42'))).toBe(true);
  });

  // P3 "No answer keys in child network responses"; walk() claims JSON semantics and fails closed
  // on values JSON cannot carry faithfully, but arrays are walked by index only: an own toJSON or
  // extra own property changes what JSON.stringify sends without being scanned.
  it('[RV-answer-guard-12] arrays whose serialization differs from their elements fail closed', () => {
    const steps = Object.assign(['Think about groups of ten.'], {
      toJSON: () => ['The answer is 42'],
    });
    const packet = { steps };
    expect(JSON.stringify(packet)).toContain('42');
    expect(guardChildContent({ packet, answers: [numeric('42')] }).decision).toBe('block');
    const keyed = Object.assign(['Add the ones first.'], { answerKey: '42' });
    expect(findForbiddenFields({ steps: keyed }).length).toBeGreaterThan(0);
  });

  // P4 "Keep operational logs payload-free"; GuardReason is documented as payload-free. Leak-finding
  // paths redact a key that carries the answer, but FORBIDDEN_FIELD paths print raw key names.
  it('[RV-answer-guard-13] forbidden-field reason paths never contain the protected value', () => {
    const decision = guardChildContent({
      packet: { hints: { learn: { rubric: 'x' } } },
      answers: [spelling('learn')],
    });
    expect(decision.decision).toBe('block');
    expect(JSON.stringify(decision)).not.toContain('learn');
  });

  // Numeric requirement "a over b"; English "a in b" is the counterpart of the supported Spanish
  // "a de cada b" ("3 de cada 4" is flagged, "3 in 4" is not).
  it('[RV-answer-guard-14] English "a in b" fraction phrasing is read as a/b', () => {
    expect(leaks('There is a 1 in 2 chance.', numeric('1/2'))).toBe(true);
    expect(leaks('About 3 in 4 marbles are red.', numeric('3/4'))).toBe(true);
  });

  // P6 final numeric value; numeric requirement "English number words". "5th" is flagged but the
  // ordinal word for the same value is not read at all.
  it('[RV-answer-guard-15] ordinal number words disclose the value like "5th" does', () => {
    expect(leaks('Sam finished 5th.', numeric('5'))).toBe(true);
    expect(leaks('Sam finished fifth.', numeric('5'))).toBe(true);
  });

  // P6 "No ... complete spelling target". A contraction's letters written without the apostrophe
  // match no technique (the phrase rule needs a separator; inflection/compact need one word/6+).
  it('[RV-answer-guard-16] a contraction spelling target without its apostrophe is flagged', () => {
    expect(leaks('Write dont on your paper.', spelling("don't"))).toBe(true);
  });
});
