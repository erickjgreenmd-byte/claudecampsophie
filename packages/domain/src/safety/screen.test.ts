import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AI_ALLOWED,
  AI_ALLOWED_PASS2,
  AI_ALLOWED_PASS3,
  AI_SEVERE,
  AI_SEVERE_PASS2,
  AI_ALLOWED_PASS4,
  AI_SEVERE_PASS3,
  AI_SEVERE_PASS4,
  CHILD_SEVERE,
  CHILD_SEVERE_PASS2,
  CHILD_SEVERE_PASS3,
  CHILD_SEVERE_PASS4,
  CHILD_SEVERE_PASS5,
  CHILD_SEVERE_PASS6,
  CHILD_SEVERE_PASS7,
  EDUCATIONAL,
  EVERYDAY_NONE,
  EVERYDAY_NOT_SEVERE,
  EVERYDAY_NOT_SEVERE_PASS2,
  EVERYDAY_NOT_SEVERE_PASS3,
  EVERYDAY_NOT_SEVERE_PASS4,
  EVERYDAY_NOT_SEVERE_PASS5,
  EVERYDAY_NOT_SEVERE_PASS6,
  PROMPT_NOT_SEVERE_PASS4,
  PROMPT_NOT_SEVERE_PASS5,
  PROMPT_NOT_HELD_PASS7,
  PROMPT_NOT_SEVERE_PASS6,
  REVIEWER_CLEARED_PASS5,
  REVIEWER_CLEARED_PASS6,
  REVIEWER_CLEARED_PASS7,
} from './corpus.ts';
import * as lexicon from './lexicon.ts';
import { NORMALIZATION_TABLES } from './normalize.ts';
import {
  FAMILY_HOLD_CATEGORIES,
  HOUSEHOLD_SENSITIVE_CATEGORIES,
  MAX_SCREEN_CHARS,
  SAFETY_RULES,
  SAFETY_SCREEN_VERSION,
  SEVERE_SAFETY_CATEGORIES,
  householdSensitive,
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

describe('pass 3: first-person tier-B words, body parts, plans, threats, model output', () => {
  for (const c of CHILD_SEVERE_PASS3) {
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
  for (const c of EVERYDAY_NOT_SEVERE_PASS3) {
    it(`not severe: ${describeCase(c.text)}${c.subject ? ` (${c.subject})` : ''}`, () => {
      const result = screenQuestion({
        prompt: c.prompt ?? null,
        answer: c.text,
        subject: c.subject ?? null,
        ageBand: '8-10',
      });
      expect(result.level).not.toBe('severe');
    });
  }
  for (const c of AI_SEVERE_PASS3) {
    it(`model output ${c.category}: ${describeCase(c.text)}`, () => {
      const result = screenModelOutput([c.text], {
        ageBand: '8-10',
        context: { prompt: c.prompt ?? null, subject: c.subject ?? null },
      });
      expect(result.level).toBe('severe');
      expect(result.categories).toContain(c.category);
    });
  }
  for (const c of AI_ALLOWED_PASS3) {
    it(`model output allowed: ${describeCase(c.text)}`, () => {
      const result = screenModelOutput([c.text], {
        ageBand: '8-10',
        context: { prompt: c.prompt ?? null, subject: c.subject ?? null },
      });
      expect(result.level).not.toBe('severe');
    });
  }

  it('a first-person tier-B hit is reported with its own code, never as educational', () => {
    const result = screenQuestion({
      prompt: 'What is the theme?',
      answer: 'suicide is the only way out for me',
      subject: 'reading',
      ageBand: '8-10',
    });
    expect(result.codes).toContain('SELF_HARM_TERM_FIRST_PERSON');
    expect(result.codes).not.toContain('SELF_HARM_TERM_EDUCATIONAL');
  });
});

describe('pass 4: prompts, opinion frames, "I\'ll", narrowed rules, "mammal", names', () => {
  for (const c of PROMPT_NOT_SEVERE_PASS4) {
    it(`printed prompt not severe: ${describeCase(c.prompt)} (${c.subject})`, () => {
      const result = screenQuestion({ ...c, ageBand: '8-10' });
      expect(result.level).not.toBe('severe');
      // The prompt's tier-B word is still a topic (educational), never dropped.
      expect(result.level).toBe('sensitive_educational');
    });
  }
  for (const c of CHILD_SEVERE_PASS4) {
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
  for (const c of EVERYDAY_NOT_SEVERE_PASS4) {
    it(`not severe: ${describeCase(c.text)}${c.subject ? ` (${c.subject})` : ''}`, () => {
      const result = screenQuestion({
        prompt: c.prompt ?? null,
        answer: c.text,
        subject: c.subject ?? null,
        ageBand: '8-10',
      });
      expect(result.level).not.toBe('severe');
    });
  }
  for (const c of AI_SEVERE_PASS4) {
    it(`model output ${c.category}: ${describeCase(c.text)}`, () => {
      const result = screenModelOutput([c.text], {
        ageBand: '8-10',
        context: { prompt: c.prompt ?? null, subject: c.subject ?? null },
      });
      expect(result.level).toBe('severe');
      expect(result.categories).toContain(c.category);
    });
  }
  for (const c of AI_ALLOWED_PASS4) {
    it(`model output allowed: ${describeCase(c.text)}`, () => {
      const result = screenModelOutput([c.text], {
        ageBand: '8-10',
        context: { prompt: c.prompt ?? null, subject: c.subject ?? null },
      });
      expect(result.level).not.toBe('severe');
    });
  }

  it('a printed prompt is screened by every rule, but without the child first-person override', () => {
    // The same sentence is the child's own statement as an answer and a topic as a printed prompt.
    const sentence = 'In our unit we discuss why our family members commit suicide.';
    expect(
      screenQuestion({ prompt: 'Name one.', answer: sentence, subject: 'reading', ageBand: '8-10' })
        .codes,
    ).toContain('SELF_HARM_TERM_FIRST_PERSON');
    const asPrompt = screenQuestion({
      prompt: sentence,
      answer: 'the king',
      subject: 'reading',
      ageBand: '8-10',
    });
    expect(asPrompt.codes).toContain('SELF_HARM_TERM_EDUCATIONAL');
    expect(asPrompt.codes).not.toContain('SELF_HARM_TERM_FIRST_PERSON');
  });
});

describe('pass 5: exclusions are whole idioms, Roman numerals, "ill", holders, frames', () => {
  const screen = (c: { text: string; subject?: string; prompt?: string }) =>
    screenQuestion({
      prompt: c.prompt ?? null,
      answer: c.text,
      subject: c.subject ?? null,
      ageBand: '8-10',
    });
  for (const c of CHILD_SEVERE_PASS5) {
    it(`${c.categories.join('+')}: ${describeCase(c.text)}${c.subject ? ` (${c.subject})` : ''}`, () => {
      const result = screen(c);
      expect(result.level).toBe('severe');
      expect(result.categories).toEqual([...c.categories].sort(byCategory));
    });
  }
  for (const c of EVERYDAY_NOT_SEVERE_PASS5) {
    it(`not severe: ${describeCase(c.text)}${c.subject ? ` (${c.subject})` : ''}`, () => {
      expect(screen(c).level).not.toBe('severe');
    });
  }
  for (const c of PROMPT_NOT_SEVERE_PASS5) {
    it(`printed prompt not severe: ${describeCase(c.prompt)} (${c.subject})`, () => {
      const result = screenQuestion({ ...c, ageBand: '8-10' });
      expect(result.level).toBe('sensitive_educational');
    });
  }
  for (const c of REVIEWER_CLEARED_PASS5) {
    // Documented false matches (index.ts KNOWN LIMITS): a reviewer clears them (runbook 5.1).
    it(`stays severe until a reviewer clears it: ${describeCase(c.text)}`, () => {
      expect(screen(c).level).toBe('severe');
    });
  }

  it('an exclusion tail never survives a deliberate word later in the sentence', () => {
    // The accident tail alone excludes; "on purpose" or "to die" after it voids the exclusion.
    expect(screen({ text: 'I cut myself again on the paper' }).level).not.toBe('severe');
    expect(screen({ text: 'I cut myself again on the paper on purpose' }).codes).toContain(
      'SELF_HARM_AGAIN',
    );
    expect(screen({ text: 'I ate poison berries in Minecraft' }).level).not.toBe('severe');
    expect(screen({ text: 'I ate poison berries in Minecraft to die' }).codes).toContain(
      'SELF_HARM_SWALLOWED',
    );
  });

  it('the only-way-out rule reads the child’s answer, never the printed prompt', () => {
    const sentence = 'Suicide is the only way out.';
    expect(
      screenQuestion({
        prompt: 'What is the theme?',
        answer: sentence,
        subject: 'reading',
        ageBand: '8-10',
      }).codes,
    ).toContain('SELF_HARM_ONLY_WAY_OUT');
    expect(
      screenQuestion({ prompt: sentence, answer: 'the theme', subject: 'reading', ageBand: '8-10' })
        .codes,
    ).not.toContain('SELF_HARM_ONLY_WAY_OUT');
  });
});

describe('pass 6: recall first (a lone "I", "ill", wrists, notes, endorsement guards)', () => {
  const screen = (c: { text: string; subject?: string; prompt?: string }) =>
    screenQuestion({
      prompt: c.prompt ?? null,
      answer: c.text,
      subject: c.subject ?? null,
      ageBand: '8-10',
    });
  for (const c of CHILD_SEVERE_PASS6) {
    it(`${c.categories.join('+')}: ${describeCase(c.text)}${c.subject ? ` (${c.subject})` : ''}`, () => {
      const result = screen(c);
      expect(result.level).toBe('severe');
      expect(result.categories).toEqual([...c.categories].sort(byCategory));
    });
  }
  for (const c of EVERYDAY_NOT_SEVERE_PASS6) {
    it(`not severe: ${describeCase(c.text)}${c.subject ? ` (${c.subject})` : ''}`, () => {
      expect(screen(c).level).not.toBe('severe');
    });
  }
  for (const c of PROMPT_NOT_SEVERE_PASS6) {
    it(`printed prompt not severe: ${describeCase(c.prompt)} (${c.subject})`, () => {
      expect(screenQuestion({ ...c, ageBand: '8-10' }).level).not.toBe('severe');
    });
  }
  for (const c of REVIEWER_CLEARED_PASS6) {
    // Documented over-escalation (index.ts KNOWN LIMITS): a reviewer clears it (runbook 5.1).
    it(`stays severe until a reviewer clears it: ${describeCase(c.text)}`, () => {
      expect(screen(c).level).toBe('severe');
    });
  }

  it('the endorsement rules read the child’s answer, never the printed prompt', () => {
    const sentence = 'Touching private parts is our secret.';
    expect(
      screenQuestion({
        prompt: 'What is a safe touch?',
        answer: `He says ${sentence}`,
        subject: 'science',
        ageBand: '8-10',
      }).codes,
    ).toContain('SEXUAL_ABUSE_ENDORSED');
    const asPrompt = screenQuestion({
      prompt: `He says ${sentence} What should you do?`,
      answer: 'tell a trusted adult',
      subject: 'science',
      ageBand: '8-10',
    });
    expect(asPrompt.codes).not.toContain('SEXUAL_ABUSE_ENDORSED');
    expect(asPrompt.level).not.toBe('severe');
  });

  it('a lone "I" is a numeral only in a printed prompt’s exact idioms', () => {
    const answer = 'In World War I, many soldiers were victims of abuse';
    expect(
      screenQuestion({ prompt: 'Why?', answer, subject: 'social_studies', ageBand: '8-10' }).codes,
    ).toContain('ABUSE_VICTIM_OF');
    expect(
      screenQuestion({
        prompt: `${answer}. Why?`,
        answer: 'war',
        subject: 'social_studies',
        ageBand: '8-10',
      }).codes,
    ).not.toContain('ABUSE_VICTIM_OF');
    // A margin note in capitals or after a saint's name keeps its first person in a prompt too.
    for (const prompt of [
      'PART I WANT TO DIE',
      'At St. Mary I want to die',
      'Prince George I will kill you',
    ]) {
      expect(
        screenQuestion({ prompt, answer: 'ok', subject: 'reading', ageBand: '8-10' }).level,
      ).toBe('severe');
    }
    // Round 5 (CHK4-CS-4/5): an abuse note merged into the printed prompt is not read for a
    // household-sensitive code (index.ts KNOWN LIMITS); the same words as the child's answer are.
    for (const note of ['PART I WAS RAPED', 'At St. Mary I was abused']) {
      const asPrompt = screenQuestion({
        prompt: note,
        answer: 'ok',
        subject: 'reading',
        ageBand: '8-10',
      });
      expect(householdSensitive(asPrompt.categories)).toBe(false);
      const asAnswer = screenQuestion({
        prompt: 'Why?',
        answer: note,
        subject: 'reading',
        ageBand: '8-10',
      });
      expect(asAnswer.level).toBe('severe');
      expect(householdSensitive(asAnswer.categories)).toBe(true);
    }
  });
});

describe('pass 7: recall first, no household-sensitive code from a printed prompt (round 5, CHK4-CS-1..9)', () => {
  // Owner decision (2026-09-25): FAMILY_HOLD_CATEGORIES is empty, so the printed-prompt rule is
  // keyed on the fixed HOUSEHOLD_SENSITIVE_CATEGORIES (abuse, sexual, secrecy). These cases prove
  // it kept working after the hold list was emptied: a hold-keyed rule would now read every prompt.
  it('the rule is keyed on a fixed set, not on the (empty) hold list', () => {
    expect(FAMILY_HOLD_CATEGORIES).toEqual([]);
    expect(HOUSEHOLD_SENSITIVE_CATEGORIES).toEqual(['abuse', 'sexual', 'secrecy']);
  });
  const screen = (c: { text: string; subject?: string; prompt?: string }) =>
    screenQuestion({
      prompt: c.prompt ?? null,
      answer: c.text,
      subject: c.subject ?? null,
      ageBand: '8-10',
    });
  for (const c of CHILD_SEVERE_PASS7) {
    it(`${c.categories.join('+')}: ${describeCase(c.text)}${c.subject ? ` (${c.subject})` : ''}`, () => {
      const result = screen(c);
      expect(result.level).toBe('severe');
      expect(result.categories).toEqual([...c.categories].sort(byCategory));
    });
  }
  for (const c of PROMPT_NOT_HELD_PASS7) {
    it(`printed prompt carries no abuse, sexual or secrecy code: ${describeCase(c.prompt)} (${c.subject})`, () => {
      const result = screenQuestion({
        prompt: c.prompt,
        answer: c.answer,
        subject: c.subject,
        ageBand: '8-10',
      });
      expect(householdSensitive(result.categories)).toBe(false);
      for (const category of HOUSEHOLD_SENSITIVE_CATEGORIES) {
        expect(result.categories).not.toContain(category);
      }
      if (c.contact) expect(result.categories).toEqual(['personal_contact']);
      else expect(result.level).not.toBe('severe');
    });
  }
  for (const c of REVIEWER_CLEARED_PASS7) {
    // Documented over-escalation (index.ts KNOWN LIMITS): a reviewer clears it (runbook 5.1).
    it(`stays severe until a reviewer clears it: ${describeCase(c.text)}`, () => {
      expect(screen(c).level).toBe('severe');
    });
  }

  it('no abuse, sexual or secrecy code ever comes from a printed prompt; self-harm, violence and contact still do', () => {
    // One sentence per household-sensitive category, and the same words as the child's own answer.
    const sentences = [
      'My dad hits me',
      'He touches my private parts',
      'He told me not to tell anyone',
      'He says sex is our game',
      'I was raped',
      'Our little secret',
    ];
    for (const sentence of sentences) {
      const asPrompt = screenQuestion({
        prompt: `Read: "${sentence}." Why?`,
        answer: 'ok',
        subject: 'reading',
        ageBand: '8-10',
      });
      expect(householdSensitive(asPrompt.categories), sentence).toBe(false);
      const asAnswer = screenQuestion({
        prompt: 'Why?',
        answer: sentence,
        subject: 'reading',
        ageBand: '8-10',
      });
      expect(asAnswer.level, sentence).toBe('severe');
      expect(householdSensitive(asAnswer.categories), sentence).toBe(true);
    }
    for (const [prompt, category] of [
      ['Read: "I want to die," said the boy. Why?', 'self_harm'],
      ['Read: "I will kill you," said the boy. Why?', 'violence'],
    ] as const) {
      const result = screenQuestion({ prompt, answer: 'ok', subject: 'reading', ageBand: '8-10' });
      expect(result.categories).toEqual([category]);
    }
    // The prompt's household-sensitive tier-B word is still reported as a topic ("child abuse" in a
    // rights lesson).
    const rights = screenQuestion({
      prompt: 'Why is child abuse against the law?',
      answer: 'it hurts kids',
      subject: 'math',
      ageBand: '8-10',
    });
    expect(rights.level).toBe('sensitive_educational');
    expect(rights.topics).toContain('sexual_violence_topic');
  });

  it('a phrase that names the child is held by no guard; a negation right before it cancels it', () => {
    for (const text of [
      'He says if anyone asks, sex is our secret',
      'My coach is a bully and says touching private parts is our secret',
      'Nobody knows he touches my private parts',
      'Not safe he touches me at night',
    ]) {
      expect(screen({ text }).level).toBe('severe');
    }
    // The same lesson words hold a phrase that does not name the child.
    expect(
      screen({ text: 'If someone says touching private parts is a game, tell' }).level,
    ).not.toBe('severe');
    expect(screen({ text: 'He said sex is not our secret' }).level).not.toBe('severe');
    expect(screen({ text: 'I would never cut myself.' }).level).not.toBe('severe');
    expect(screen({ text: 'I will try not to cut myself' }).level).not.toBe('severe');
  });
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

  it('spells out a caregiver noun with "\'ll" but never reads "mammal" or "papal" as one', () => {
    const streams = (text: string) => normalizeForScreen(text).streams.map((s) => s.join(' '));
    expect(streams('my dad’ll hurt me')).toContain('my dad wil hurt me');
    for (const text of ['a mammal will touch me', 'the papal guard will hurt me']) {
      expect(streams(text).join(' | ')).not.toMatch(/\b(?:mama|papa) wil\b/);
    }
  });

  it('writes a Roman numeral in a numeral context as a number, and keeps the pronoun "I"', () => {
    const first = (text: string) => normalizeForScreen(text).streams[0]!.join(' ');
    const printed = (text: string) =>
      normalizeForScreen(text, undefined, true).streams[0]!.join(' ');
    expect(first('World War II ended')).toBe('world war 2 ended');
    expect(first('world war ii ended')).toBe('world war 2 ended');
    expect(first('In Act III, Hamlet')).toBe('in act 3 hamlet');
    expect(first('Pope John Paul II spoke')).toBe('pope john paul 2 spoke');
    expect(first('Mom I want to die')).toBe('mom i want to die');
    expect(first('Henry I will kill you')).toBe('henry i wil kil you');
    expect(first('II want to die')).toBe('i want to die');
    expect(first('the war. II want to die')).toBe('the war . i want to die');
    // Round 4 (CHK3-CS-1): a lone "I" is the child's pronoun, whatever comes before it.
    expect(first('Queen Elizabeth I ruled')).toBe('quen elizabeth i ruled');
    expect(first('World War I ended')).toBe('world war i ended');
    expect(first('In St. Louis I was abused')).toBe('in st . louis i was abused');
    expect(first('LAST SEASON I WAS ABUSED')).toBe('last season i was abused');
    expect(first('Act I, scene 2')).toBe('act i scene 2');
    // A printed prompt reads it as a numeral in three exact idioms only.
    expect(printed('World War I ended')).toBe('world war 1 ended');
    expect(printed('In Act I, Romeo')).toBe('in act 1 romeo');
    expect(printed('Queen Elizabeth I ruled')).toBe('quen elizabeth 1 ruled');
    expect(printed('PART I WAS RAPED')).toBe('part i was raped');
    expect(printed('At St. Mary I was abused')).toBe('at st . mary i was abused');
    expect(printed('Prince George I will')).toBe('prince george i wil');
  });

  it('reads "I\'ll" as "I will", and a bare "ill" as "I will" only before a verb', () => {
    const joined = (text: string) => normalizeForScreen(text).streams.map((s) => s.join(' '));
    expect(joined('I’ll be there')[0]).toBe('i wil be there');
    expect(joined('Ill do it')).toContain('i wil do it');
    expect(joined('so ill end it all')).toContain('so i wil end it al');
    // Round 4 (CHK3-CS-2): the word before "ill" never vetoes a verb after it.
    expect(joined('I hate you ill kill you')).toContain('i hate you i wil kil you');
    expect(joined('I cant do this ill end it all')).toContain('i cant do this i wil end it al');
    expect(joined('ill kms')).toContain('i wil kms');
    expect(joined('the ill take medicine')).toContain('the i wil take medicine');
    for (const adjective of [
      'it can make you ill',
      'no ill will',
      'ill with fever',
      'he spoke ill of the king',
      'ill health',
    ]) {
      expect(joined(adjective).join(' | ')).not.toMatch(/\bi wil\b/);
    }
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
    // Pass 3: every tier-B occurrence is checked for a first person; `*` slots; mixed "1" reading.
    ['tier-B soup', 'suicide rape '.repeat(1_500)],
    ['tier-B soup with a first person at the end', `${'suicide rape '.repeat(1_500)}my`],
    ['named threats', 'i will kill riley '.repeat(1_100)],
    ['wish death', 'i hope sam dies '.repeat(1_200)],
    ['mixed 1 reading', 'k1ll myse1f wi11 '.repeat(1_100)],
    ['contractions before verbs', 'hell hurt shed kill dadll '.repeat(750)],
    // Pass 4: frames and "ill" are checked at every first-person candidate.
    ['frames and ill', 'i think we should stop in our class he was so ill suicide '.repeat(350)],
    // Pass 5: void windows after every excluded match, Roman numerals, holder guards.
    ['excluded then voided', 'i cut my wrist on the paper '.repeat(700)],
    ['exclusion windows', 'i ate poison berries berries '.repeat(700)],
    ['roman numerals', 'King Henry III World War II Act I '.repeat(600)],
    ['holders', 'to cleopatra teens think suicide is the answer '.repeat(420)],
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

  it('the version names the rules: changing a rule, a vocabulary or normalization needs a bump', () => {
    // RV-child-safety-14: reports carry screen_version so a reviewer can tune the exact rules that
    // fired. A digest of the rule data, the normalizer's tables (contractions, "'ll" nouns,
    // look-alikes, leetspeak, boundaries; CHK-CS-7) and the normalizer's and screen's output on
    // fixed probes is pinned per version, so an edit without a new SAFETY_SCREEN_VERSION (and a
    // new pin) fails here.
    const probes = [
      'I wi11 k1ll myse1f',
      "I'll he'll she'd imma hes",
      'k.i.l.l m y s e l f su icide',
      'I ᴡᴀɴᴛ ᴛᴏ ᴅɪᴇ dıe kiII',
      'No, quiero morir. Ya no.',
      '$uicide h@te 12 × 7 = 84; 3/4',
      'In our unit I think Romeo committed suicide. Suicide is the only way out, Ill do it. He was mentally ill.',
      'World War II, Act III, Queen Elizabeth I. Mom I want to die seriously. I’ll kill Art’s team.',
      'I ate poison berries in Minecraft to die. To Cleopatra, suicide is the answer. I wonder if.',
      'In St. Louis I was abused. I hate you ill kill you. To Mom, suicide is the answer. He says sex is our game. I will slit my wrists in the kitchen.',
      'Im not ok, dying is the only way out. He said it is a rule, sex is our secret. Im not ok, he touches my private parts. Be careful not to hurt yourself.',
      'He says if anyone asks, sex is our secret. I will try to cut myself. I cut my wrist on paper. I dont think I can stay alive much longer. Read: "My dad hits me." I cant take it anymore.',
    ];
    // Rule rationale (`doc`) is left out: rewording an explanation does not change what fires.
    const withoutDocs = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map((v: unknown) =>
            typeof v === 'object' && v !== null ? { ...v, doc: undefined } : v,
          )
        : value;
    const material = JSON.stringify({
      lexicon: Object.entries(lexicon)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [name, withoutDocs(value)]),
      normalization: NORMALIZATION_TABLES,
      normalized: probes.map((p) => normalizeForScreen(p).streams),
      screened: probes.map((p) => screenText(p, { ageBand: '8-10' }).codes),
      // Frames, "I'll" and the prompt path need an educational context to show.
      inContext: probes.map(
        (p) => screenQuestion({ prompt: p, answer: p, subject: 'reading', ageBand: '8-10' }).codes,
      ),
    });
    const digest = createHash('sha256').update(material).digest('hex');
    // A new version adds a line here (never edit an existing one).
    const PINNED: Readonly<Record<string, string>> = {
      // v3 as committed in 441eb6a (rounds 1-4: whole-idiom exclusions, Roman numerals, "ill",
      // holders, frames, a lone "I", wrists, notes, endorsement guards, quote words, negation only
      // across NEGATION_BRIDGES, the body-safety guard stops at a first person).
      'safety-screen.v3': '37bf323ff22cb481404fb4c1d7ce74285543ef7dcdb973c73c1f803943df7a42',
      // v4, round 5 (CHK4-CS-1..9): no abuse, sexual or secrecy code from a printed prompt (keyed
      // on the fixed HOUSEHOLD_SENSITIVE_CATEGORIES since the 2026-09-25 owner decision emptied the
      // hold list; the rules did not change, so the digest did not), no guard on a phrase that
      // names the child, no quote words, round-4 holders, wrist accident tails or body-safety
      // guard, bridges only "to" and adverbs, "try to", restored "can stay alive", canonical
      // first-person rules.
      'safety-screen.v4': '3d033122878f9b97710466c3c3bc2e2b8786db7a5ab96ce77536f68cb2b36a35',
    };
    expect({ version: SAFETY_SCREEN_VERSION, digest }).toEqual({
      version: SAFETY_SCREEN_VERSION,
      digest: PINNED[SAFETY_SCREEN_VERSION],
    });
  });

  it('codes never carry the screened text', () => {
    const result = screenText('my dad hits me', { ageBand: '8-10', source: 'child' });
    for (const code of result.codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(code.toLowerCase()).not.toContain('dad hits');
    }
  });
});
