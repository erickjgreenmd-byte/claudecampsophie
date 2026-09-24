import { describe, expect, it } from 'vitest';
import {
  AI_ALLOWED,
  AI_ALLOWED_PASS2,
  AI_SEVERE,
  AI_SEVERE_PASS2,
  CHILD_SEVERE,
  CHILD_SEVERE_PASS2,
  EDUCATIONAL,
  EVERYDAY_NONE,
  EVERYDAY_NOT_SEVERE,
  EVERYDAY_NOT_SEVERE_PASS2,
} from './corpus.ts';
import {
  MAX_SCREEN_CHARS,
  SAFETY_RULES,
  SAFETY_SCREEN_VERSION,
  SEVERE_SAFETY_CATEGORIES,
  normalizeForScreen,
  screenModelOutput,
  screenQuestion,
  screenText,
} from './index.ts';

// AC_SECURITY_02 / spec P4: deterministic first-layer screen for severe-risk content in K-8 child
// text and child-facing AI output. Synthetic corpus only (corpus.ts).

const describeCase = (text: string) => JSON.stringify(text).slice(0, 80);
const byCategory = (a: string, b: string) =>
  SEVERE_SAFETY_CATEGORIES.indexOf(a as never) - SEVERE_SAFETY_CATEGORIES.indexOf(b as never);

describe('child text: severe-risk statements (true positives, with obfuscations)', () => {
  for (const c of CHILD_SEVERE) {
    it(`${c.category}: ${describeCase(c.text)}`, () => {
      const result = screenText(c.text, {
        ageBand: '8-10',
        source: 'child',
        ...(c.subject || c.prompt
          ? { context: { subject: c.subject ?? null, prompt: c.prompt ?? null } }
          : {}),
      });
      expect(result.level).toBe('severe');
      expect(result.categories).toContain(c.category);
      expect(result.codes.length).toBeGreaterThan(0);
    });
  }

  it('covers every child-facing severe category with at least three cases', () => {
    const counts = new Map<string, number>();
    for (const c of CHILD_SEVERE) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    for (const category of [
      'self_harm',
      'abuse',
      'violence',
      'sexual',
      'secrecy',
      'personal_contact',
    ]) {
      expect(counts.get(category) ?? 0).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('educational context is sensitive, not severe, and does not block tutoring', () => {
  for (const c of EDUCATIONAL) {
    it(`${c.topic}: ${describeCase(c.text)}`, () => {
      const result = screenText(c.text, {
        ageBand: '11-13',
        source: 'child',
        context: { subject: c.subject, prompt: c.prompt },
      });
      expect(result.level).toBe('sensitive_educational');
      expect(result.categories).toEqual([]);
      expect(result.topics).toContain(c.topic);
    });
  }

  it('the same question-level screen treats the prompt as context', () => {
    const q = screenQuestion({
      prompt: 'What was the Holocaust?',
      answer: 'Millions of Jewish people were killed in the Holocaust.',
      subject: 'social_studies',
      ageBand: '11-13',
    });
    expect(q.level).toBe('sensitive_educational');
  });

  it('a bare tier-B term outside an educational context is severe', () => {
    expect(screenText('suicide', { ageBand: '8-10', source: 'child' }).level).toBe('severe');
    expect(
      screenText('suicide', {
        ageBand: '8-10',
        source: 'child',
        context: { subject: 'math', prompt: '12 × 7 =' },
      }).level,
    ).toBe('severe');
    expect(
      screenText('Romeo committed suicide.', {
        ageBand: '14-18',
        source: 'child',
        context: { subject: 'reading', prompt: 'How does the play end?' },
      }).level,
    ).toBe('sensitive_educational');
  });
});

describe('everyday K-8 homework is not flagged', () => {
  for (const text of EVERYDAY_NONE) {
    it(`none: ${describeCase(text)}`, () => {
      const result = screenText(text, { ageBand: '8-10', source: 'child' });
      expect(result).toMatchObject({ level: 'none', categories: [], topics: [] });
    });
  }
  for (const text of EVERYDAY_NOT_SEVERE) {
    it(`not severe: ${describeCase(text)}`, () => {
      const result = screenText(text, { ageBand: '8-10', source: 'child' });
      expect(result.level).not.toBe('severe');
    });
  }
});

describe('child-facing model output (moderation after generation)', () => {
  for (const c of AI_SEVERE) {
    it(`${c.category}: ${describeCase(c.text)}`, () => {
      const result = screenModelOutput([c.text], {
        ageBand: '8-10',
        context: { prompt: c.prompt ?? null, subject: c.subject ?? null },
      });
      expect(result.level).toBe('severe');
      expect(result.categories).toContain(c.category);
    });
  }
  for (const c of AI_ALLOWED) {
    it(`allowed: ${describeCase(c.text)}`, () => {
      const result = screenModelOutput([c.text], {
        ageBand: '8-10',
        context: { prompt: c.prompt ?? null, subject: c.subject ?? null },
      });
      expect(result.level).not.toBe('severe');
    });
  }

  it('companion, diagnosis and secrecy checks apply to model output, not to a child’s own words', () => {
    // A child may truthfully write "I have ADHD" or "I love you mom"; neither is a risk statement.
    expect(screenText('I have ADHD', { ageBand: '8-10', source: 'child' }).level).toBe('none');
    expect(screenText('I love you mom', { ageBand: '8-10', source: 'child' }).level).toBe('none');
    expect(
      screenText('Don’t tell your parents about the surprise', {
        ageBand: '8-10',
        source: 'child',
      }).level,
    ).toBe('none');
    expect(
      screenModelOutput(['Don’t tell your parents about the surprise'], {
        ageBand: '8-10',
        context: {},
      }).categories,
    ).toContain('secrecy');
  });

  it('a practice intro or story context may not introduce any sensitive topic', () => {
    const intro = screenModelOutput(['Today the soldiers go to war with their guns!'], {
      ageBand: '5-7',
      context: {},
    });
    expect(intro.level).toBe('severe');
    expect(intro.categories).toEqual(['ungrounded_topic']);
  });
});

describe('pass 2: contractions, first-person disclosures, caregiver threats, homoglyphs', () => {
  // Each case is screened the way the scan job screens an answer: in the context of its printed
  // question and subject (screenQuestion), so an educational subject can never soften it.
  for (const c of CHILD_SEVERE_PASS2) {
    it(`${c.categories.join('+')}: ${describeCase(c.text)}${c.subject ? ` (${c.subject})` : ''}`, () => {
      const result = screenQuestion({
        prompt: c.prompt ?? null,
        answer: c.text,
        subject: c.subject ?? null,
        ageBand: '8-10',
      });
      expect(result.level).toBe('severe');
      expect(result.categories).toEqual([...c.categories].sort(byCategory));
    });
  }
  for (const c of EVERYDAY_NOT_SEVERE_PASS2) {
    it(`not severe: ${describeCase(c.text)}`, () => {
      const result = screenQuestion({
        prompt: c.prompt ?? null,
        answer: c.text,
        subject: c.subject ?? null,
        ageBand: '8-10',
      });
      expect(result.level).not.toBe('severe');
    });
  }
  for (const c of AI_SEVERE_PASS2) {
    it(`model output ${c.category}: ${describeCase(c.text)}`, () => {
      const result = screenModelOutput([c.text], {
        ageBand: '8-10',
        context: { prompt: c.prompt ?? null, subject: c.subject ?? null },
      });
      expect(result.level).toBe('severe');
      expect(result.categories).toContain(c.category);
    });
  }
  for (const c of AI_ALLOWED_PASS2) {
    it(`model output allowed: ${describeCase(c.text)}`, () => {
      const result = screenModelOutput([c.text], {
        ageBand: '8-10',
        context: { prompt: c.prompt ?? null, subject: c.subject ?? null },
      });
      expect(result.level).not.toBe('severe');
    });
  }
});

describe('normalization', () => {
  it('folds case, NFKC, homoglyphs, leetspeak, inner punctuation, spacing and repeats', () => {
    const streams = (text: string) => normalizeForScreen(text).streams.map((s) => s.join(' '));
    expect(streams('KiLL')).toContain('kil');
    expect(streams('k1ll')).toContain('kil');
    expect(streams('k.i.l.l')).toContain('kil');
    expect(streams('k i l l')).toContain('kil');
    expect(streams('killlllll')).toContain('kil');
    expect(streams('ｋｉｌｌ')).toContain('kil');
    expect(streams('kіll')).toContain('kil'); // Cyrillic i
    expect(streams('ki​ll')).toContain('kil');
    expect(streams('don’t')).toContain('dont');
  });

  it('leaves numbers and math alone', () => {
    const joined = normalizeForScreen('Sam ate 3 cookies; 12 × 7 = 84; 53x + 2').streams.map((s) =>
      s.join(' '),
    );
    // "." marks a sentence boundary (a chunk ending in . ! ? or ;).
    expect(joined[0]).toBe('sam ate 3 cokies . 12 7 84 . 53x 2');
  });
});

describe('bounded cost on hostile input', () => {
  const hostile: readonly [string, string][] = [
    ['repeated first person', 'i '.repeat(10_000)],
    ['repeated trigger phrase', 'i want to '.repeat(2_000)],
    ['spaced letters', 'k i l l '.repeat(2_500)],
    ['one giant word', 'a'.repeat(20_000)],
    ['leet soup', '1!|@$0'.repeat(3_500)],
    ['combining marks', 'é̂̃̄'.repeat(4_000)],
    ['zero width', '​'.repeat(20_000)],
    ['mixed punctuation', 'k.i-l_l*m.y.s.e.l.f '.repeat(1_000)],
    ['over the cap', `${'benign words '.repeat(3_000)}I want to die`],
    // Pass 2: the reported-threat slot has hundreds of alternatives keyed by "said"/"says"/...
    ['reported threats', 'my dad said he would '.repeat(950)],
    ['contractions', 'im ill id ive imma hes '.repeat(900)],
    ['inner capital I', 'kiII '.repeat(4_000)],
    ['bare kms', '. '.repeat(9_990) + 'kms'],
  ];
  for (const [name, text] of hostile) {
    it(`${name} (${text.length} chars) stays fast`, () => {
      const started = performance.now();
      const result = screenText(text, { ageBand: '8-10', source: 'child' });
      const ai = screenModelOutput([text], { ageBand: '8-10', context: { prompt: text } });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(750);
      expect(['none', 'sensitive_educational', 'severe']).toContain(result.level);
      expect(['none', 'sensitive_educational', 'severe']).toContain(ai.level);
    });
  }

  it('reports truncation instead of silently screening part of the text', () => {
    const long = `${'benign words '.repeat(3_000)}I want to die`;
    expect(long.length).toBeGreaterThan(MAX_SCREEN_CHARS);
    expect(screenText(long, { ageBand: '8-10', source: 'child' }).truncated).toBe(true);
    expect(screenText('Sam ate 3 cookies', { ageBand: '8-10', source: 'child' }).truncated).toBe(
      false,
    );
  });
});

describe('rules are documented and stable', () => {
  it('every rule has a unique code, a category or topic and a written rationale', () => {
    const ids = SAFETY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of SAFETY_RULES) {
      expect(rule.id).toMatch(/^[A-Z][A-Z0-9_]{2,60}$/);
      expect(rule.doc.length).toBeGreaterThan(15);
      if (rule.kind === 'severe') {
        expect(SEVERE_SAFETY_CATEGORIES).toContain(rule.category);
      }
    }
    expect(SAFETY_SCREEN_VERSION).toMatch(/^safety-screen\.v\d+$/);
  });

  it('codes never carry the screened text', () => {
    const result = screenText('my dad hits me', { ageBand: '8-10', source: 'child' });
    for (const code of result.codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(code.toLowerCase()).not.toContain('dad hits');
    }
  });
});
