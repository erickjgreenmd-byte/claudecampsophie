// Adversarial review regressions for the question bank (spec P7; AC_LEARNING_05, AC_LEARNING_06).
// Each test states the defect it pins down. Synthetic content only.
import { describe, expect, it } from 'vitest';
import {
  BANK_SUBJECTS,
  bankCoverage,
  gradeBankAnswer,
  generateCandidates,
  parentPassageItems,
  seededRandom,
  validateBankItem,
} from './index.ts';

/** Whole words a missing-letter pattern such as "b _ t" admits from a list. */
function wordsMatchingPattern(promptText: string, words: readonly string[]): string[] {
  const match = /:\s+([A-Za-z_' -]+)$/.exec(promptText);
  if (match === null) return [];
  const letters = match[1]!.trim().split(/\s+/);
  const re = new RegExp(
    `^${letters.map((c) => (c === '_' ? "[a-z'-]" : c.toLowerCase().replace(/[-']/g, '\\$&'))).join('')}$`,
  );
  return words.filter((w) => re.test(w.toLowerCase()));
}

describe('RV-learning-bank-1: teacher-list missing-letter items must have exactly one answer (AC_LEARNING_06)', () => {
  it('never emits a pattern that another word on the same list also completes', () => {
    // A short-vowel word-family list is a typical early-grade teacher list.
    const list = ['bat', 'bit', 'pin', 'pan'];
    const ambiguous: { prompt: string; key: string; alsoFits: string[] }[] = [];
    for (let s = 0; s < 20; s += 1) {
      const items = generateCandidates({
        subjects: ['spelling_vocabulary'],
        grade: 1,
        seed: `review-teacher-list-${s}`,
        material: { spellingLists: [{ id: 'list-1', text: list.join(', ') }] },
      });
      for (const item of items) {
        if (item.templateKey !== 'spelling.teacher_list.missing_letters.v1') continue;
        if (item.answerSpec.kind !== 'spelling') continue;
        const key = item.answerSpec.target;
        const alsoFits = wordsMatchingPattern(item.prompt.text, list).filter(
          (w) => w.toLowerCase() !== key.toLowerCase(),
        );
        // The prompt says "spell one of your spelling words": another list word that fits the
        // pattern is a second correct answer, yet it grades as a misspelling.
        const gradedWrong = alsoFits.filter(
          (w) => gradeBankAnswer(item.answerSpec, w).verdict === 'incorrect',
        );
        if (gradedWrong.length > 0)
          ambiguous.push({ prompt: item.prompt.text, key, alsoFits: gradedWrong });
      }
    }
    expect(ambiguous).toEqual([]);
  });
});

describe('RV-learning-bank-2: parent-passage word recall must not offer a word that appears in the passage (AC_LEARNING_06)', () => {
  it('treats an -es plural in the passage as the word appearing', () => {
    // Every recall distractor except volcano/tornado/cactus appears in this synthetic passage, so the
    // item's three "absent" distractors are exactly those. "Volcanoes" and "tornadoes" DO appear.
    const text =
      'Our class read about wild weather and mountains. Volcanoes and tornadoes can be scary for everyone. ' +
      'A pirate with a trumpet, a giraffe, a penguin, a pancake, a rocket, an umbrella, a lantern, a saddle, ' +
      'a meadow, a compass, a harbor and a blizzard all appear in this silly story. The end came quickly.';
    const offending: { choices: readonly string[]; key: string; present: string[] }[] = [];
    for (let s = 0; s < 5; s += 1) {
      const items = parentPassageItems(seededRandom(`review-passage-${s}`), 'passage-1', text, 3);
      for (const item of items) {
        if (item.templateKey !== 'reading.parent_passage.word_recall.v1') continue;
        if (!validateBankItem(item).ok || item.answerSpec.kind !== 'multiple_choice') continue;
        const choices = item.prompt.choices ?? [];
        const keyIndex = item.answerSpec.validLetters.indexOf(item.answerSpec.letters[0]!);
        const lower = text.toLowerCase();
        const present = choices.filter(
          (c, i) => i !== keyIndex && new RegExp(`\\b${c.toLowerCase()}(s|es)?\\b`).test(lower),
        );
        if (present.length > 0) offending.push({ choices, key: choices[keyIndex]!, present });
      }
    }
    // Actual: "volcano" and "tornado" are offered as words that do NOT appear, so a child who picks
    // one is told "Try again" although the passage says "Volcanoes and tornadoes".
    expect(offending).toEqual([]);
  });
});

describe('RV-learning-bank-3: the coverage report must not claim skills the bank cannot serve at that grade (AC_LEARNING_05)', () => {
  it('every supported skill listed for a grade yields at least one item at that grade', () => {
    const phantom: string[] = [];
    for (let grade = 0; grade <= 8; grade += 1) {
      const produced = new Set<string>();
      for (let s = 0; s < 2; s += 1) {
        for (const item of generateCandidates({
          subjects: [...BANK_SUBJECTS],
          grade,
          seed: `review-coverage-${grade}-${s}`,
        })) {
          produced.add(item.skill);
        }
      }
      for (const subject of bankCoverage(grade).subjects) {
        for (const skill of subject.skills) {
          if (skill.source === 'family_material') continue; // needs the family's own list
          if (!produced.has(skill.skill)) phantom.push(`grade ${grade}: ${skill.skill}`);
        }
      }
    }
    // Actual: kindergarten lists science.earth_space and grade 2 lists reading.main_idea as
    // supported, but no curated item exists at those grades (fake content completion).
    expect(phantom).toEqual([]);
    // 18 full-bank generations (~3 s on a loaded 4-CPU runner); same budget as bank.test.ts.
  }, 60_000);
});
