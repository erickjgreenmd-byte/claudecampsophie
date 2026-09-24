// Skill taxonomy of the bank: stable skill keys, grade ranges, prerequisites and the keywords used
// to map free-text evidence (homework skill labels, teacher test scope, taught notes) onto bank
// skills. Keyword matching is transparent and deterministic; it is not a curriculum classifier.
import type { AnswerSpecKind, BankSubject } from './types.ts';

export interface SkillDefinition {
  readonly skill: string;
  readonly subject: BankSubject;
  readonly label: string;
  readonly gradeMin: number;
  readonly gradeMax: number;
  readonly prerequisites: readonly string[];
  /** Lower-case keywords/phrases; a match in free text maps the text to this skill. */
  readonly keywords: readonly string[];
  readonly answerKinds: readonly AnswerSpecKind[];
  /** Where the items come from. */
  readonly source: 'generated' | 'curated' | 'family_material';
}

const S = (d: SkillDefinition): SkillDefinition => Object.freeze(d);

export const SKILLS: readonly SkillDefinition[] = [
  // ------------------------------------------------------------------------------------ math
  S({
    skill: 'math.add_sub_within_20',
    subject: 'math',
    label: 'Adding and subtracting within 20',
    gradeMin: 0,
    gradeMax: 2,
    prerequisites: [],
    keywords: [
      'addition facts',
      'subtraction facts',
      'within 20',
      'within 10',
      'number bonds',
      'plus',
      'minus',
    ],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.place_value',
    subject: 'math',
    label: 'Place value',
    gradeMin: 1,
    gradeMax: 4,
    prerequisites: [],
    keywords: [
      'place value',
      'digit',
      'ones place',
      'tens place',
      'hundreds',
      'thousands',
      'expanded form',
    ],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.addition_regrouping',
    subject: 'math',
    label: 'Addition with regrouping',
    gradeMin: 2,
    gradeMax: 4,
    prerequisites: ['math.place_value'],
    keywords: [
      'regroup',
      'carrying',
      'carry',
      'multi-digit addition',
      'two-digit addition',
      'three-digit addition',
      'addition',
    ],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.subtraction_regrouping',
    subject: 'math',
    label: 'Subtraction with regrouping',
    gradeMin: 2,
    gradeMax: 4,
    prerequisites: ['math.place_value'],
    keywords: ['borrow', 'borrowing', 'subtraction', 'subtract', 'multi-digit subtraction'],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.multiplication_facts',
    subject: 'math',
    label: 'Multiplication facts',
    gradeMin: 3,
    gradeMax: 5,
    prerequisites: [],
    keywords: [
      'multiplication',
      'multiply',
      'times table',
      'times tables',
      'product',
      'multiplying',
    ],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.division_remainders',
    subject: 'math',
    label: 'Division with remainders',
    gradeMin: 3,
    gradeMax: 6,
    prerequisites: ['math.multiplication_facts'],
    keywords: ['division', 'divide', 'dividing', 'remainder', 'quotient', 'long division'],
    answerKinds: ['division_remainder'],
    source: 'generated',
  }),
  S({
    skill: 'math.fractions_compare',
    subject: 'math',
    label: 'Comparing fractions',
    gradeMin: 3,
    gradeMax: 5,
    prerequisites: [],
    keywords: [
      'compare fractions',
      'comparing fractions',
      'greater fraction',
      'equivalent fractions',
      'fractions',
    ],
    answerKinds: ['multiple_choice'],
    source: 'generated',
  }),
  S({
    skill: 'math.fractions_add_like',
    subject: 'math',
    label: 'Adding fractions with like denominators',
    gradeMin: 3,
    gradeMax: 5,
    prerequisites: ['math.fractions_compare'],
    keywords: [
      'like denominators',
      'same denominator',
      'adding fractions',
      'fraction addition',
      'add fractions',
    ],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.fractions_add_unlike',
    subject: 'math',
    label: 'Adding fractions with unlike denominators',
    gradeMin: 4,
    gradeMax: 7,
    prerequisites: ['math.fractions_add_like', 'math.multiplication_facts'],
    keywords: ['unlike denominators', 'different denominators', 'common denominator'],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.decimals',
    subject: 'math',
    label: 'Decimals',
    gradeMin: 4,
    gradeMax: 7,
    prerequisites: ['math.place_value'],
    keywords: ['decimal', 'decimals', 'tenths', 'hundredths'],
    answerKinds: ['numeric', 'multiple_choice'],
    source: 'generated',
  }),
  S({
    skill: 'math.measurement_conversion',
    subject: 'math',
    label: 'Measurement unit conversion',
    gradeMin: 3,
    gradeMax: 7,
    prerequisites: ['math.multiplication_facts'],
    keywords: [
      'convert',
      'conversion',
      'measurement',
      'units',
      'centimeters',
      'meters',
      'inches',
      'feet',
      'grams',
      'kilograms',
      'liters',
      'minutes',
    ],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.word_problems',
    subject: 'math',
    label: 'Word problems',
    gradeMin: 1,
    gradeMax: 6,
    prerequisites: ['math.add_sub_within_20'],
    keywords: ['word problem', 'word problems', 'story problem', 'story problems'],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.area_perimeter',
    subject: 'math',
    label: 'Area and perimeter of rectangles',
    gradeMin: 3,
    gradeMax: 6,
    prerequisites: ['math.multiplication_facts'],
    keywords: ['area', 'perimeter', 'rectangle'],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.one_step_equations',
    subject: 'math',
    label: 'One-step equations',
    gradeMin: 6,
    gradeMax: 8,
    prerequisites: ['math.multiplication_facts'],
    keywords: ['equation', 'equations', 'solve for', 'variable', 'algebra'],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  S({
    skill: 'math.percent_of',
    subject: 'math',
    label: 'Percent of a number',
    gradeMin: 6,
    gradeMax: 8,
    prerequisites: ['math.decimals', 'math.multiplication_facts'],
    keywords: ['percent', 'percentage', 'percents'],
    answerKinds: ['numeric'],
    source: 'generated',
  }),
  // ------------------------------------------------------------------------- grammar_writing
  S({
    skill: 'grammar.parts_of_speech',
    subject: 'grammar_writing',
    label: 'Parts of speech',
    gradeMin: 2,
    gradeMax: 8,
    prerequisites: [],
    keywords: [
      'noun',
      'nouns',
      'verb',
      'verbs',
      'adjective',
      'adjectives',
      'adverb',
      'adverbs',
      'parts of speech',
    ],
    answerKinds: ['multiple_choice'],
    source: 'generated',
  }),
  S({
    skill: 'grammar.punctuation',
    subject: 'grammar_writing',
    label: 'Punctuation',
    gradeMin: 1,
    gradeMax: 5,
    prerequisites: [],
    keywords: [
      'punctuation',
      'end mark',
      'end marks',
      'question mark',
      'period',
      'comma',
      'commas',
    ],
    answerKinds: ['multiple_choice'],
    source: 'generated',
  }),
  S({
    skill: 'grammar.subject_verb_agreement',
    subject: 'grammar_writing',
    label: 'Subject-verb agreement',
    gradeMin: 2,
    gradeMax: 6,
    prerequisites: ['grammar.parts_of_speech'],
    keywords: ['subject-verb', 'subject verb', 'agreement', 'verb tense'],
    answerKinds: ['multiple_choice'],
    source: 'generated',
  }),
  S({
    skill: 'grammar.capitalization',
    subject: 'grammar_writing',
    label: 'Capitalization',
    gradeMin: 1,
    gradeMax: 4,
    prerequisites: [],
    keywords: [
      'capital',
      'capitals',
      'capitalization',
      'capitalize',
      'proper noun',
      'proper nouns',
    ],
    answerKinds: ['multiple_choice'],
    source: 'generated',
  }),
  S({
    skill: 'grammar.plural_nouns',
    subject: 'grammar_writing',
    label: 'Plural nouns',
    gradeMin: 1,
    gradeMax: 4,
    prerequisites: [],
    keywords: ['plural', 'plurals', 'irregular plural'],
    answerKinds: ['exact_text'],
    source: 'generated',
  }),
  // ---------------------------------------------------------------------------------- reading
  S({
    skill: 'reading.literal_detail',
    subject: 'reading',
    label: 'Finding details in a passage',
    gradeMin: 0,
    gradeMax: 8,
    prerequisites: [],
    keywords: ['details', 'key details', 'recall', 'comprehension', 'reading comprehension'],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'reading.inference',
    subject: 'reading',
    label: 'Making inferences',
    gradeMin: 1,
    gradeMax: 8,
    prerequisites: ['reading.literal_detail'],
    keywords: ['inference', 'infer', 'inferring', 'draw conclusions', 'conclusion'],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'reading.main_idea',
    subject: 'reading',
    label: 'Main idea',
    gradeMin: 2,
    gradeMax: 8,
    prerequisites: ['reading.literal_detail'],
    keywords: ['main idea', 'central idea', 'summary', 'summarize', "author's purpose", 'theme'],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'reading.vocabulary_in_context',
    subject: 'reading',
    label: 'Word meaning from context',
    gradeMin: 1,
    gradeMax: 8,
    prerequisites: [],
    keywords: ['context clues', 'vocabulary in context', 'word meaning'],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'reading.sequence',
    subject: 'reading',
    label: 'Order of events',
    gradeMin: 0,
    gradeMax: 6,
    prerequisites: ['reading.literal_detail'],
    keywords: ['sequence', 'order of events', 'sequencing', 'first next last', 'retell'],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  // ---------------------------------------------------------------------- spelling_vocabulary
  S({
    skill: 'spelling.teacher_list',
    subject: 'spelling_vocabulary',
    label: "This week's spelling words",
    gradeMin: 0,
    gradeMax: 8,
    prerequisites: [],
    keywords: ['spelling list', 'spelling words', 'spelling test', 'word list'],
    answerKinds: ['spelling', 'multiple_choice'],
    source: 'family_material',
  }),
  S({
    skill: 'spelling.grade_words',
    subject: 'spelling_vocabulary',
    label: 'Grade-level spelling',
    gradeMin: 1,
    gradeMax: 6,
    prerequisites: [],
    keywords: ['spelling', 'spell', 'misspelled'],
    answerKinds: ['spelling', 'multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'vocabulary.word_meaning',
    subject: 'spelling_vocabulary',
    label: 'Vocabulary meanings',
    gradeMin: 2,
    gradeMax: 8,
    prerequisites: [],
    keywords: ['vocabulary', 'definition', 'definitions', 'meaning', 'synonym', 'synonyms'],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'vocabulary.homophones',
    subject: 'spelling_vocabulary',
    label: 'Homophones',
    gradeMin: 2,
    gradeMax: 5,
    prerequisites: [],
    keywords: ['homophone', 'homophones', 'sound-alike'],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  // ---------------------------------------------------------------------------------- science
  S({
    skill: 'science.life_science',
    subject: 'science',
    label: 'Life science',
    gradeMin: 0,
    gradeMax: 8,
    prerequisites: [],
    keywords: [
      'plants',
      'animals',
      'life cycle',
      'habitat',
      'food chain',
      'cells',
      'body',
      'organs',
      'ecosystem',
      'photosynthesis',
    ],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'science.earth_space',
    subject: 'science',
    label: 'Earth and space science',
    gradeMin: 0,
    gradeMax: 8,
    prerequisites: [],
    keywords: [
      'weather',
      'water cycle',
      'planets',
      'solar system',
      'rocks',
      'seasons',
      'earth',
      'moon',
      'earthquake',
      'erosion',
    ],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'science.physical_science',
    subject: 'science',
    label: 'Physical science',
    gradeMin: 0,
    gradeMax: 8,
    prerequisites: [],
    keywords: [
      'matter',
      'solid',
      'liquid',
      'gas',
      'force',
      'forces',
      'magnet',
      'magnets',
      'energy',
      'sound',
      'light',
      'motion',
    ],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  // --------------------------------------------------------------------------- social_studies
  S({
    skill: 'social_studies.geography',
    subject: 'social_studies',
    label: 'Geography and maps',
    gradeMin: 0,
    gradeMax: 8,
    prerequisites: [],
    keywords: [
      'map',
      'maps',
      'continent',
      'continents',
      'ocean',
      'oceans',
      'compass',
      'latitude',
      'longitude',
      'geography',
    ],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'social_studies.civics',
    subject: 'social_studies',
    label: 'Civics and government',
    gradeMin: 0,
    gradeMax: 8,
    prerequisites: [],
    keywords: [
      'government',
      'constitution',
      'laws',
      'rules',
      'citizen',
      'citizenship',
      'branches',
      'vote',
      'voting',
      'mayor',
    ],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'social_studies.history',
    subject: 'social_studies',
    label: 'History',
    gradeMin: 1,
    gradeMax: 8,
    prerequisites: [],
    keywords: ['history', 'timeline', 'ancient', 'revolution', 'colonies', 'civilization'],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
  S({
    skill: 'social_studies.economics',
    subject: 'social_studies',
    label: 'Economics',
    gradeMin: 1,
    gradeMax: 8,
    prerequisites: [],
    keywords: [
      'economics',
      'goods',
      'services',
      'needs and wants',
      'money',
      'budget',
      'supply',
      'demand',
      'trade',
      'consumer',
      'producer',
    ],
    answerKinds: ['multiple_choice'],
    source: 'curated',
  }),
];

const BY_SKILL = new Map(SKILLS.map((s) => [s.skill, s]));

export function skillDefinition(skill: string): SkillDefinition | undefined {
  return BY_SKILL.get(skill);
}

export function skillLabel(skill: string): string {
  return BY_SKILL.get(skill)?.label ?? 'Practice';
}

export function skillsForSubject(subject: BankSubject): readonly SkillDefinition[] {
  return SKILLS.filter((s) => s.subject === subject);
}

/** One level of prerequisites for `prioritizeSkills` / Thursday review composition. */
export function prerequisiteMap(): ReadonlyMap<string, readonly string[]> {
  return new Map(SKILLS.map((s) => [s.skill, s.prerequisites]));
}

/** Clamps a child grade (0..12) into the bank's K-8 launch range. */
export function bankGrade(grade: number): number {
  if (!Number.isFinite(grade)) return 0;
  return Math.min(8, Math.max(0, Math.round(grade)));
}

/** Skills whose grade range covers `grade` (after clamping), in taxonomy order. */
export function skillsForGrade(subject: BankSubject, grade: number): readonly SkillDefinition[] {
  const g = bankGrade(grade);
  return skillsForSubject(subject).filter((s) => s.gradeMin <= g && g <= s.gradeMax);
}

function normalizeText(text: string): string {
  return ` ${text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9%'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

/**
 * Maps free text (a homework skill label, a teacher's test scope note, taught notes) to bank skills
 * of `subject`. Decision: whole-word keyword matching; skills are ordered by their longest matching
 * keyword (the most specific match first: "fraction addition" is fraction addition, not
 * multi-digit addition), then taxonomy order. Unmatched text maps to nothing (never guessed).
 */
export function matchSkills(subject: BankSubject, text: string): string[] {
  const haystack = normalizeText(text);
  if (haystack.trim().length === 0) return [];
  const matched: { skill: string; length: number; order: number }[] = [];
  skillsForSubject(subject).forEach((def, order) => {
    if (def.source === 'family_material') return;
    let length = 0;
    for (const kw of def.keywords) {
      const needle = normalizeText(kw).trim();
      if (haystack.includes(` ${needle} `)) length = Math.max(length, needle.length);
    }
    if (length > 0) matched.push({ skill: def.skill, length, order });
  });
  return matched.sort((a, b) => b.length - a.length || a.order - b.order).map((m) => m.skill);
}

/**
 * The bank skill a recorded attempt belongs to: the skill itself when it is a bank skill, else the
 * first keyword match, else null (evidence without bank practice).
 */
export function bankSkillFor(subject: string, skill: string): string | null {
  const def = BY_SKILL.get(skill);
  if (def !== undefined) return def.subject === subject ? skill : null;
  if (!SKILLS.some((s) => s.subject === subject)) return null;
  return matchSkills(subject as BankSubject, skill)[0] ?? null;
}
