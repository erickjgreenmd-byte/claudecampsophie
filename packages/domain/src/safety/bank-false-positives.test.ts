import { describe, expect, it } from 'vitest';
import {
  BANK_SUBJECTS,
  DEFAULT_CONTEXTS,
  FALLBACK_WORDS,
  PASSAGES,
  SCIENCE_ITEMS,
  SOCIAL_STUDIES_ITEMS,
  WORD_PROBLEM_TEMPLATES,
  generateCandidates,
  renderWordProblem,
  type BankItem,
} from '../bank/index.ts';
import { screenModelOutput, screenText, type SafetyScreen } from './index.ts';

// False-positive measurement on the repo's own synthetic question bank (AC_SECURITY_02): every
// prompt, choice, passage, explanation and story context a child can be shown must screen as
// non-severe, both as if the child had written it and as grounded model output.

interface Sample {
  readonly where: string;
  readonly text: string;
  readonly subject: string;
  readonly prompt: string;
}

function itemSamples(item: BankItem): Sample[] {
  const where = item.instanceKey;
  const context = { subject: item.subject, prompt: item.prompt.text };
  const out: Sample[] = [{ where: `${where}:prompt`, text: item.prompt.text, ...context }];
  for (const choice of item.prompt.choices ?? [])
    out.push({ where: `${where}:choice`, text: choice, ...context });
  if (item.prompt.passage) {
    out.push({ where: `${where}:passage-title`, text: item.prompt.passage.title, ...context });
    out.push({ where: `${where}:passage`, text: item.prompt.passage.text, ...context });
  }
  out.push({ where: `${where}:explanation`, text: item.explanation, ...context });
  return out;
}

function bankSamples(): Sample[] {
  const samples: Sample[] = [];
  for (let grade = 0; grade <= 8; grade += 1) {
    for (const seed of ['fp-a', 'fp-b', 'fp-c']) {
      const items = generateCandidates({
        subjects: BANK_SUBJECTS,
        grade,
        seed: `${seed}-${grade}`,
        perSkill: { standard: 3, accessible: 2, diagnostic: 1 },
      });
      for (const item of items) samples.push(...itemSamples(item));
    }
  }
  for (const f of [...SCIENCE_ITEMS, ...SOCIAL_STUDIES_ITEMS]) {
    const context = { subject: f.subject, prompt: f.stem };
    for (const text of [f.stem, f.correct, ...f.distractors, f.explanation])
      samples.push({ where: `fact:${f.id}`, text, ...context });
  }
  for (const p of PASSAGES) {
    samples.push({ where: `passage:${p.id}`, text: p.text, subject: 'reading', prompt: p.title });
    for (const q of p.questions) {
      for (const text of [q.stem, q.correct, ...q.distractors, q.explanation])
        samples.push({
          where: `passage:${p.id}:${q.id}`,
          text,
          subject: 'reading',
          prompt: q.stem,
        });
    }
  }
  for (const w of FALLBACK_WORDS) {
    for (const text of [w.word, w.clue, w.sentence])
      samples.push({
        where: `spelling:${w.word}`,
        text,
        subject: 'spelling_vocabulary',
        prompt: '',
      });
  }
  for (const context of DEFAULT_CONTEXTS) {
    for (const template of WORD_PROBLEM_TEMPLATES) {
      const rendered = renderWordProblem(template, [12, 4], context);
      samples.push({
        where: `story:${template}:${context.name}`,
        text: rendered.text,
        subject: 'math',
        prompt: rendered.text,
      });
    }
  }
  return samples;
}

describe('false-positive rate on the synthetic question bank', () => {
  const samples = bankSamples();

  it('screens a large sample of the bank', () => {
    expect(samples.length).toBeGreaterThan(2_000);
  });

  it('0 severe when the bank text is screened as a child’s own words', () => {
    const severe: { where: string; codes: readonly string[] }[] = [];
    let sensitive = 0;
    for (const s of samples) {
      const result: SafetyScreen = screenText(s.text, {
        ageBand: '8-10',
        source: 'child',
        context: { subject: s.subject, prompt: s.prompt },
      });
      if (result.level === 'severe') severe.push({ where: s.where, codes: result.codes });
      if (result.level === 'sensitive_educational') sensitive += 1;
    }
    expect(severe).toEqual([]);
    // Sensitive topics never block anything; the bank is written for children and has few.
    expect(sensitive / samples.length).toBeLessThan(0.02);
  });

  it('0 severe when the bank text is screened as grounded model output', () => {
    const severe: { where: string; codes: readonly string[] }[] = [];
    for (const s of samples) {
      const result = screenModelOutput([s.text], {
        ageBand: '8-10',
        context: { subject: s.subject, prompt: `${s.prompt}\n${s.text}` },
      });
      if (result.level === 'severe') severe.push({ where: s.where, codes: result.codes });
    }
    expect(severe).toEqual([]);
  });

  it('0 severe for the shipped story contexts as AI-style intros with no context', () => {
    for (const context of DEFAULT_CONTEXTS) {
      const text = `${context.name} collects ${context.things} at the ${context.place}.`;
      expect(screenModelOutput([text], { ageBand: '5-7', context: {} }).level).toBe('none');
    }
  });
});
