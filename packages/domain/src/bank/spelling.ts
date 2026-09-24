// Spelling and vocabulary practice (spec P7 "teacher-provided vocabulary"; "Honor teacher spelling
// lists"). Teacher lists produce missing-letter and choose-the-correct-spelling items; a small
// original grade-level list (with PencilLift-written clues and sentences) is the fallback.
import type { RandomSource } from '../shared/random.ts';
import { buildItem, choices, prompt } from './build.ts';
import type { GenContext } from './math.ts';
import { pick, shuffle } from './random.ts';
import type { BankItem } from './types.ts';

interface FallbackWord {
  readonly word: string;
  readonly clue: string;
  /** Sentence with the word replaced by "____". */
  readonly sentence: string;
  readonly gradeMin: number;
  readonly gradeMax: number;
}

export const FALLBACK_WORDS: readonly FallbackWord[] = [
  {
    word: 'jump',
    clue: 'to push off the ground with your legs',
    sentence: 'Can you ____ over the puddle?',
    gradeMin: 1,
    gradeMax: 2,
  },
  {
    word: 'sleep',
    clue: 'to rest with your eyes closed',
    sentence: 'The baby will ____ after lunch.',
    gradeMin: 1,
    gradeMax: 2,
  },
  {
    word: 'green',
    clue: 'the color of grass',
    sentence: 'Frogs are often ____.',
    gradeMin: 1,
    gradeMax: 2,
  },
  {
    word: 'happy',
    clue: 'feeling glad',
    sentence: 'The puppy looks ____ when we come home.',
    gradeMin: 1,
    gradeMax: 2,
  },
  {
    word: 'friend',
    clue: 'someone you like and trust',
    sentence: 'My ____ saved me a seat on the bus.',
    gradeMin: 1,
    gradeMax: 3,
  },
  {
    word: 'little',
    clue: 'small',
    sentence: 'A ____ mouse hid under the chair.',
    gradeMin: 1,
    gradeMax: 2,
  },
  {
    word: 'because',
    clue: 'for the reason that',
    sentence: 'We stayed inside ____ it was raining.',
    gradeMin: 1,
    gradeMax: 3,
  },
  {
    word: 'water',
    clue: 'a clear liquid we drink',
    sentence: 'Plants need sunlight and ____.',
    gradeMin: 1,
    gradeMax: 2,
  },
  {
    word: 'school',
    clue: 'a place where children learn',
    sentence: 'Our ____ has a big library.',
    gradeMin: 1,
    gradeMax: 3,
  },
  {
    word: 'night',
    clue: 'the dark time after the sun sets',
    sentence: 'Owls hunt at ____.',
    gradeMin: 1,
    gradeMax: 2,
  },
  {
    word: 'bridge',
    clue: 'something built to cross over a river or road',
    sentence: 'We walked across the ____ to the other side of the river.',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'island',
    clue: 'land with water all around it',
    sentence: 'The ship sailed to a small ____.',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'favorite',
    clue: 'liked best',
    sentence: 'Soup is my ____ lunch on cold days.',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'library',
    clue: 'a place where you can borrow books',
    sentence: 'I borrowed three books from the ____.',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'neighbor',
    clue: 'a person who lives next door',
    sentence: 'Our ____ waters our plants when we travel.',
    gradeMin: 3,
    gradeMax: 5,
  },
  {
    word: 'thought',
    clue: 'an idea in your mind',
    sentence: 'She had a ____ about how to fix the kite.',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'through',
    clue: 'in one side and out the other',
    sentence: 'The train went ____ the tunnel.',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'enough',
    clue: 'as much as you need',
    sentence: 'Do we have ____ chairs for everyone?',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'caught',
    clue: 'grabbed something that was thrown',
    sentence: 'The goalie ____ the ball with both hands.',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'kitchen',
    clue: 'the room where food is cooked',
    sentence: 'Dad is baking bread in the ____.',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'whistle',
    clue: 'a high sound made by blowing',
    sentence: 'The coach blew her ____ to start the game.',
    gradeMin: 3,
    gradeMax: 4,
  },
  {
    word: 'necessary',
    clue: 'needed',
    sentence: 'A helmet is ____ when you ride a bike.',
    gradeMin: 5,
    gradeMax: 6,
  },
  {
    word: 'separate',
    clue: 'to keep apart',
    sentence: 'Please ____ the red blocks from the blue ones.',
    gradeMin: 5,
    gradeMax: 6,
  },
  {
    word: 'environment',
    clue: 'the natural world around us',
    sentence: 'Recycling helps protect the ____.',
    gradeMin: 5,
    gradeMax: 6,
  },
  {
    word: 'rhythm',
    clue: 'a regular, repeated beat',
    sentence: 'We clapped to the ____ of the song.',
    gradeMin: 5,
    gradeMax: 6,
  },
  {
    word: 'Wednesday',
    clue: 'the day after Tuesday',
    sentence: 'Art class meets every ____ afternoon.',
    gradeMin: 4,
    gradeMax: 6,
  },
  {
    word: 'definitely',
    clue: 'without any doubt',
    sentence: 'I will ____ finish my project by Friday.',
    gradeMin: 5,
    gradeMax: 6,
  },
  {
    word: 'beautiful',
    clue: 'very pretty',
    sentence: 'The sunset over the lake was ____.',
    gradeMin: 4,
    gradeMax: 6,
  },
  {
    word: 'occasion',
    clue: 'a special event',
    sentence: 'A birthday is a happy ____.',
    gradeMin: 5,
    gradeMax: 6,
  },
  {
    word: 'restaurant',
    clue: 'a place where you buy and eat meals',
    sentence: 'We ate noodles at a new ____.',
    gradeMin: 5,
    gradeMax: 6,
  },
  {
    word: 'February',
    clue: 'the second month of the year',
    sentence: 'Groundhog Day is in ____.',
    gradeMin: 4,
    gradeMax: 6,
  },
  {
    word: 'privilege',
    clue: 'a special right or advantage',
    sentence: 'Staying up late is a ____ on weekends.',
    gradeMin: 5,
    gradeMax: 6,
  },
];

/** Words with more than one accepted spelling: the variants are accepted and never distractors. */
const KNOWN_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  favorite: ['favourite'],
  neighbor: ['neighbour'],
  color: ['colour'],
  gray: ['grey'],
  grey: ['gray'],
  theater: ['theatre'],
  center: ['centre'],
  traveling: ['travelling'],
  judgment: ['judgement'],
  donut: ['doughnut'],
  doughnut: ['donut'],
  catalog: ['catalogue'],
  canceled: ['cancelled'],
  jewelry: ['jewellery'],
  ax: ['axe'],
  axe: ['ax'],
  okay: ['ok'],
};

export function acceptedVariants(word: string): readonly string[] {
  return KNOWN_VARIANTS[word.toLowerCase()] ?? [];
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowel = (c: string | undefined): boolean => c !== undefined && VOWELS.has(c);
const isConsonant = (c: string | undefined): boolean =>
  c !== undefined && /[a-z]/.test(c) && !VOWELS.has(c);

/**
 * Plausible misspellings by transparent rules: doubled/undoubled consonants, ie/ei swaps, a dropped
 * silent e, vowel substitutions, swapped neighbours and common sound spellings. Never returns the
 * word itself or one of its accepted variants.
 */
export function misspellings(word: string): string[] {
  const w = word.toLowerCase();
  const out = new Set<string>();
  const letters = [...w];
  for (let i = 1; i < letters.length; i += 1) {
    if (letters[i] === letters[i - 1] && isConsonant(letters[i])) {
      out.add(w.slice(0, i) + w.slice(i + 1));
    }
  }
  for (let i = 1; i < letters.length - 1; i += 1) {
    if (isVowel(letters[i - 1]) && isConsonant(letters[i]) && isVowel(letters[i + 1])) {
      out.add(w.slice(0, i) + (letters[i] ?? '') + w.slice(i));
    }
  }
  if (w.includes('ie')) out.add(w.replace('ie', 'ei'));
  if (w.includes('ei')) out.add(w.replace('ei', 'ie'));
  if (w.endsWith('e') && w.length > 4) out.add(w.slice(0, -1));
  const swaps: Readonly<Record<string, string>> = { a: 'e', e: 'i', i: 'e', o: 'u', u: 'o' };
  for (let i = 1; i < letters.length - 1; i += 1) {
    const c = letters[i] ?? '';
    const to = swaps[c];
    if (to !== undefined) out.add(w.slice(0, i) + to + w.slice(i + 1));
  }
  for (let i = 1; i < letters.length - 2; i += 1) {
    if (letters[i] !== letters[i + 1]) {
      out.add(w.slice(0, i) + (letters[i + 1] ?? '') + (letters[i] ?? '') + w.slice(i + 2));
    }
  }
  if (w.includes('ph')) out.add(w.replace('ph', 'f'));
  if (w.includes('ck')) out.add(w.replace('ck', 'k'));
  if (w.includes('tion')) out.add(w.replace('tion', 'shun'));
  if (w.includes('ough')) out.add(w.replace('ough', 'uff'));
  if (w.includes('igh')) out.add(w.replace('igh', 'ite'));
  const variants = new Set(acceptedVariants(w));
  return [...out].filter((m) => m !== w && m.length >= 2 && !variants.has(m));
}

/** Matches the case style of the target (e.g. "Wednesday" -> "Wensday"). */
function styled(target: string, text: string): string {
  return target[0] === target[0]?.toUpperCase() ? text[0]?.toUpperCase() + text.slice(1) : text;
}

/** "b e _ u t _ f u l": hides about a third of the letters (never the first). */
export function missingLetterPattern(random: RandomSource, word: string): string | null {
  const letters = [...word];
  if (letters.length < 3) return null;
  const hideCount = Math.max(1, Math.min(letters.length - 2, Math.round(letters.length / 3)));
  const positions = shuffle(random, letters.map((_, i) => i).slice(1)).slice(0, hideCount);
  const hidden = new Set(positions);
  return letters.map((c, i) => (hidden.has(i) ? '_' : c)).join(' ');
}

function spellingSpec(word: string): BankItem['answerSpec'] {
  return { kind: 'spelling', target: word, alternates: [...acceptedVariants(word)] };
}

// ------------------------------------------------------------------------------------------------
// Fallback grade-level words
// ------------------------------------------------------------------------------------------------

function fallbackPool(grade: number, accessible: boolean): FallbackWord[] {
  const g = Math.max(1, Math.min(6, accessible ? grade - 1 : grade));
  const pool = FALLBACK_WORDS.filter((w) => w.gradeMin <= g && g <= w.gradeMax);
  return pool.length > 0 ? pool : FALLBACK_WORDS.filter((w) => w.gradeMin <= 2);
}

function gradeWordItem(ctx: GenContext): BankItem {
  const { random } = ctx;
  const entry = pick(random, fallbackPool(ctx.grade, ctx.category === 'accessible'));
  const mode = pick(random, ['cloze', 'missing', 'choose'] as const);
  const base = {
    subject: 'spelling_vocabulary' as const,
    skill: 'spelling.grade_words',
    gradeMin: Math.max(1, entry.gradeMin),
    gradeMax: Math.min(6, Math.max(entry.gradeMax, entry.gradeMin)),
    category: ctx.category,
  };
  const wrong = styled(entry.word, pick(random, misspellings(entry.word)));
  if (mode === 'cloze') {
    return buildItem({
      ...base,
      templateKey: 'spelling.grade_words.cloze.v1',
      prompt: prompt(`Write the missing word: “${entry.sentence}” (Clue: ${entry.clue})`, 'word'),
      answerSpec: spellingSpec(entry.word),
      explanation: `The missing word is “${entry.word}”.`,
      distractor: wrong,
      params: { word: entry.word, mode },
    });
  }
  if (mode === 'missing') {
    const pattern = missingLetterPattern(random, entry.word) ?? entry.word;
    return buildItem({
      ...base,
      templateKey: 'spelling.grade_words.missing_letters.v1',
      prompt: prompt(
        `Fill in the missing letters and write the whole word. It means “${entry.clue}”:  ${pattern}`,
        'word',
      ),
      answerSpec: spellingSpec(entry.word),
      explanation: `The word is “${entry.word}”.`,
      distractor: wrong,
      params: { word: entry.word, mode, pattern },
    });
  }
  const options = shuffle(random, misspellings(entry.word))
    .slice(0, 3)
    .map((m) => styled(entry.word, m));
  const setup = choices(random, entry.word, options);
  return buildItem({
    ...base,
    templateKey: 'spelling.grade_words.choose.v1',
    prompt: prompt(
      `Which is the correct spelling of the word that means “${entry.clue}”?`,
      'choice',
      {
        choices: setup.choices,
      },
    ),
    answerSpec: setup.spec,
    explanation: `The correct spelling is “${entry.word}”.`,
    distractor: setup.wrongLetter,
    params: { word: entry.word, mode },
  });
}

// ------------------------------------------------------------------------------------------------
// Teacher spelling lists (the family's own material)
// ------------------------------------------------------------------------------------------------

export const MAX_SPELLING_LIST_WORDS = 40;

/** Parses a teacher list: words separated by commas, semicolons, new lines or spaces. */
export function parseSpellingList(text: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of text.normalize('NFKC').split(/[\s,;]+/)) {
    const word = raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (!/^[A-Za-z][A-Za-z'-]{1,24}$/.test(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
    if (words.length >= MAX_SPELLING_LIST_WORDS) break;
  }
  return words;
}

/** Bounded redraws for a teacher-list pattern that no other list word completes. */
const MAX_PATTERN_DRAWS = 8;

/** True when `candidate` fills every blank of `pattern` ("b _ t") and matches its shown letters. */
function completesPattern(pattern: string, candidate: string): boolean {
  const shown = pattern.split(' ');
  const letters = [...candidate];
  if (shown.length !== letters.length) return false;
  return shown.every((c, i) => c === '_' || c.toLowerCase() === letters[i]?.toLowerCase());
}

/**
 * A missing-letter pattern for `word` that no OTHER word on the same list also completes (review
 * finding RV-learning-bank-1): "spell one of your spelling words: b _ t" is ambiguous on the list
 * "bat, bit", because "bat" would be graded as a misspelling. Redraws a bounded number of times;
 * null (no missing-letter item) when every draw is ambiguous.
 */
function unambiguousPattern(
  random: RandomSource,
  word: string,
  list: readonly string[],
): string | null {
  const others = list.filter((w) => w.toLowerCase() !== word.toLowerCase());
  for (let draw = 0; draw < MAX_PATTERN_DRAWS; draw += 1) {
    const pattern = missingLetterPattern(random, word);
    if (pattern === null) return null;
    if (!others.some((w) => completesPattern(pattern, w))) return pattern;
  }
  return null;
}

/**
 * Items for one teacher-list word. Decision: prompts say "one of your spelling words" and a
 * choose-the-spelling distractor may never be another word on the same list, so the question has
 * exactly one right answer even when a misspelling happens to be a real English word; for the same
 * reason a missing-letter pattern is never one that another list word also completes.
 */
export function teacherWordItems(
  random: RandomSource,
  word: string,
  list: readonly string[],
  grade: number,
): BankItem[] {
  const g = Math.min(8, Math.max(0, grade));
  const onList = new Set(list.map((w) => w.toLowerCase()));
  const base = {
    subject: 'spelling_vocabulary' as const,
    skill: 'spelling.teacher_list',
    gradeMin: g,
    gradeMax: g,
    source: 'teacher_list' as const,
    license: 'Family-supplied study material',
  };
  const wrongs = misspellings(word).filter((m) => !onList.has(m));
  if (wrongs.length === 0) return [];
  const items: BankItem[] = [];
  const pattern = unambiguousPattern(random, word, list);
  if (pattern !== null) {
    items.push(
      buildItem({
        ...base,
        templateKey: 'spelling.teacher_list.missing_letters.v1',
        category: 'standard',
        prompt: prompt(
          `Fill in the missing letters to spell one of your spelling words, then write the whole word:  ${pattern}`,
          'word',
        ),
        answerSpec: spellingSpec(word),
        explanation: `The spelling word is “${word}”.`,
        distractor: styled(word, pick(random, wrongs)),
        params: { word: word.toLowerCase(), pattern },
      }),
    );
  }
  if (wrongs.length >= 2) {
    const options = shuffle(random, wrongs)
      .slice(0, Math.min(3, wrongs.length))
      .map((m) => styled(word, m));
    const setup = choices(random, word, options);
    items.push(
      buildItem({
        ...base,
        templateKey: 'spelling.teacher_list.choose.v1',
        category: 'accessible',
        prompt: prompt(
          'Which of these is one of your spelling words, spelled correctly?',
          'choice',
          {
            choices: setup.choices,
          },
        ),
        answerSpec: setup.spec,
        explanation: `“${word}” is the spelling word; the others are misspellings.`,
        distractor: setup.wrongLetter,
        params: { word: word.toLowerCase(), mode: 'choose' },
      }),
    );
  }
  return items;
}

// ------------------------------------------------------------------------------------------------
// Vocabulary meanings and homophones
// ------------------------------------------------------------------------------------------------

interface VocabWord {
  readonly word: string;
  readonly meaning: string;
  readonly band: 'lower' | 'middle' | 'upper';
}

const VOCAB: readonly VocabWord[] = [
  { word: 'enormous', meaning: 'very large', band: 'lower' },
  { word: 'fragile', meaning: 'easy to break', band: 'lower' },
  { word: 'gloomy', meaning: 'dark and sad', band: 'lower' },
  { word: 'swift', meaning: 'very fast', band: 'lower' },
  { word: 'damp', meaning: 'a little wet', band: 'lower' },
  { word: 'timid', meaning: 'shy and easily frightened', band: 'lower' },
  { word: 'gather', meaning: 'to bring things together', band: 'lower' },
  { word: 'wander', meaning: 'to walk around without a plan', band: 'lower' },
  { word: 'reluctant', meaning: 'not wanting to do something', band: 'middle' },
  { word: 'abundant', meaning: 'more than enough', band: 'middle' },
  { word: 'cautious', meaning: 'careful to avoid danger', band: 'middle' },
  { word: 'vivid', meaning: 'bright and clear', band: 'middle' },
  { word: 'ancient', meaning: 'very, very old', band: 'middle' },
  { word: 'predict', meaning: 'to say what will happen before it happens', band: 'middle' },
  { word: 'migrate', meaning: 'to move to a new place when the seasons change', band: 'middle' },
  { word: 'sturdy', meaning: 'strong and not easily broken', band: 'middle' },
  { word: 'meticulous', meaning: 'very careful about small details', band: 'upper' },
  { word: 'benevolent', meaning: 'kind and wanting to help others', band: 'upper' },
  { word: 'ambiguous', meaning: 'having more than one possible meaning', band: 'upper' },
  { word: 'resilient', meaning: 'able to recover quickly from difficulty', band: 'upper' },
  { word: 'scarce', meaning: 'hard to find because there is not much of it', band: 'upper' },
  { word: 'candid', meaning: 'honest and direct', band: 'upper' },
  { word: 'obsolete', meaning: 'no longer used because something newer exists', band: 'upper' },
  { word: 'tedious', meaning: 'long, slow, and boring', band: 'upper' },
];

function vocabBand(grade: number): VocabWord['band'] {
  return grade <= 3 ? 'lower' : grade <= 5 ? 'middle' : 'upper';
}

function wordMeaning(ctx: GenContext): BankItem {
  const { random } = ctx;
  const band = vocabBand(ctx.category === 'accessible' ? ctx.grade - 2 : ctx.grade);
  const pool = VOCAB.filter((v) => v.band === band);
  const entry = pick(random, pool);
  const others = shuffle(
    random,
    pool.filter((v) => v.word !== entry.word).map((v) => v.meaning),
  ).slice(0, 3);
  const setup = choices(random, entry.meaning, others);
  const range = band === 'lower' ? [2, 3] : band === 'middle' ? [4, 5] : [6, 8];
  return buildItem({
    templateKey: 'vocabulary.word_meaning.v1',
    subject: 'spelling_vocabulary',
    skill: 'vocabulary.word_meaning',
    gradeMin: range[0] ?? 2,
    gradeMax: range[1] ?? 8,
    category: ctx.category,
    prompt: prompt(`What does the word “${entry.word}” mean?`, 'choice', {
      choices: setup.choices,
    }),
    answerSpec: setup.spec,
    explanation: `“${entry.word}” means ${entry.meaning}.`,
    distractor: setup.wrongLetter,
    params: { word: entry.word },
  });
}

interface HomophoneFrame {
  readonly id: string;
  readonly sentence: string;
  readonly correct: string;
  readonly wrong: readonly string[];
  readonly why: string;
}

const HOMOPHONES: readonly HomophoneFrame[] = [
  {
    id: 'see',
    sentence: 'We could ____ the ocean from our window.',
    correct: 'see',
    wrong: ['sea'],
    why: '“See” means to look with your eyes; “sea” is a body of salt water.',
  },
  {
    id: 'sea',
    sentence: 'The ____ was full of fish and waves.',
    correct: 'sea',
    wrong: ['see'],
    why: '“Sea” is a large body of salt water.',
  },
  {
    id: 'knew',
    sentence: 'I ____ the way to the park.',
    correct: 'knew',
    wrong: ['new'],
    why: '“Knew” is the past of “know”; “new” means not old.',
  },
  {
    id: 'new',
    sentence: 'She wore her ____ sneakers to school.',
    correct: 'new',
    wrong: ['knew'],
    why: '“New” means not old.',
  },
  {
    id: 'their',
    sentence: 'The kids hung ____ coats on the hooks.',
    correct: 'their',
    wrong: ['there', 'they’re'],
    why: '“Their” shows that something belongs to them.',
  },
  {
    id: 'there',
    sentence: 'Put the books over ____ on the shelf.',
    correct: 'there',
    wrong: ['their', 'they’re'],
    why: '“There” names a place.',
  },
  {
    id: 'theyre',
    sentence: '____ going to the park after lunch.',
    correct: 'They’re',
    wrong: ['Their', 'There'],
    why: '“They’re” is short for “they are”.',
  },
  {
    id: 'its',
    sentence: 'The dog wagged ____ tail.',
    correct: 'its',
    wrong: ['it’s'],
    why: '“Its” shows belonging; “it’s” means “it is”.',
  },
  {
    id: 'two',
    sentence: 'I have ____ apples in my basket.',
    correct: 'two',
    wrong: ['to', 'too'],
    why: '“Two” is the number.',
  },
  {
    id: 'to',
    sentence: 'We walked ____ the store.',
    correct: 'to',
    wrong: ['two', 'too'],
    why: '“To” shows direction.',
  },
  {
    id: 'too',
    sentence: 'My little brother wants to come ____.',
    correct: 'too',
    wrong: ['to', 'two'],
    why: '“Too” means also.',
  },
  {
    id: 'blew',
    sentence: 'The wind ____ the leaves off the tree.',
    correct: 'blew',
    wrong: ['blue'],
    why: '“Blew” is the past of “blow”; “blue” is a color.',
  },
  {
    id: 'hear',
    sentence: 'Can you ____ the birds singing?',
    correct: 'hear',
    wrong: ['here'],
    why: '“Hear” is what you do with your ears.',
  },
  {
    id: 'here',
    sentence: 'Please come over ____ and sit down.',
    correct: 'here',
    wrong: ['hear'],
    why: '“Here” names this place.',
  },
];

function homophones(ctx: GenContext): BankItem {
  const { random } = ctx;
  const frame = pick(random, HOMOPHONES);
  const setup = choices(random, frame.correct, frame.wrong);
  return buildItem({
    templateKey: 'vocabulary.homophones.v1',
    subject: 'spelling_vocabulary',
    skill: 'vocabulary.homophones',
    gradeMin: 2,
    gradeMax: 5,
    category: ctx.category,
    prompt: prompt(`Which word completes the sentence? “${frame.sentence}”`, 'choice', {
      choices: setup.choices,
    }),
    answerSpec: setup.spec,
    explanation: frame.why,
    distractor: setup.wrongLetter,
    params: { frame: frame.id },
  });
}

export const SPELLING_GENERATORS: Readonly<Record<string, (ctx: GenContext) => BankItem>> = {
  'spelling.grade_words': gradeWordItem,
  'vocabulary.word_meaning': wordMeaning,
  'vocabulary.homophones': homophones,
};
