// Original grammar and writing-conventions items (spec P7 "parameterized ... grammar"): parts of
// speech, punctuation, subject-verb agreement, capitalization and plural nouns. All sentences are
// written for PencilLift. Writing itself (paragraphs, essays) is rubric feedback only and is listed
// as unsupported for generated practice in the coverage report.
import { buildItem, choices, prompt } from './build.ts';
import type { GenContext } from './math.ts';
import { pick, shuffle } from './random.ts';
import type { BankItem } from './types.ts';

type Pos = 'noun' | 'verb' | 'adjective' | 'adverb';

interface TaggedSentence {
  readonly id: string;
  readonly text: string;
  readonly gradeMin: number;
  readonly words: Readonly<Partial<Record<Pos, readonly string[]>>>;
}

const TAGGED: readonly TaggedSentence[] = [
  {
    id: 'puppy',
    text: 'The playful puppy chased a red ball.',
    gradeMin: 2,
    words: { noun: ['puppy', 'ball'], verb: ['chased'], adjective: ['playful', 'red'] },
  },
  {
    id: 'owl',
    text: 'A sleepy owl blinked slowly at the moon.',
    gradeMin: 2,
    words: { noun: ['owl', 'moon'], verb: ['blinked'], adjective: ['sleepy'], adverb: ['slowly'] },
  },
  {
    id: 'baker',
    text: 'The baker carefully sliced the warm bread.',
    gradeMin: 3,
    words: {
      noun: ['baker', 'bread'],
      verb: ['sliced'],
      adjective: ['warm'],
      adverb: ['carefully'],
    },
  },
  {
    id: 'river',
    text: 'The icy river flowed quietly past the old mill.',
    gradeMin: 3,
    words: {
      noun: ['river', 'mill'],
      verb: ['flowed'],
      adjective: ['icy', 'old'],
      adverb: ['quietly'],
    },
  },
  {
    id: 'team',
    text: 'Our team cheered loudly after the long game.',
    gradeMin: 3,
    words: { noun: ['team', 'game'], verb: ['cheered'], adjective: ['long'], adverb: ['loudly'] },
  },
  {
    id: 'kite',
    text: 'A bright kite soared high above the green hill.',
    gradeMin: 2,
    words: { noun: ['kite', 'hill'], verb: ['soared'], adjective: ['bright', 'green'] },
  },
  {
    id: 'turtle',
    text: 'The tiny turtle crawled steadily toward the pond.',
    gradeMin: 3,
    words: {
      noun: ['turtle', 'pond'],
      verb: ['crawled'],
      adjective: ['tiny'],
      adverb: ['steadily'],
    },
  },
  {
    id: 'chef',
    text: 'The busy chef quickly stirred the thick soup.',
    gradeMin: 4,
    words: {
      noun: ['chef', 'soup'],
      verb: ['stirred'],
      adjective: ['busy', 'thick'],
      adverb: ['quickly'],
    },
  },
  {
    id: 'storm',
    text: 'A fierce storm shook the wooden cabin.',
    gradeMin: 4,
    words: { noun: ['storm', 'cabin'], verb: ['shook'], adjective: ['fierce', 'wooden'] },
  },
  {
    id: 'scientist',
    text: 'The curious scientist examined the strange rock closely.',
    gradeMin: 5,
    words: {
      noun: ['scientist', 'rock'],
      verb: ['examined'],
      adjective: ['curious', 'strange'],
      adverb: ['closely'],
    },
  },
  {
    id: 'crowd',
    text: 'The eager crowd waited patiently outside the museum.',
    gradeMin: 5,
    words: {
      noun: ['crowd', 'museum'],
      verb: ['waited'],
      adjective: ['eager'],
      adverb: ['patiently'],
    },
  },
  {
    id: 'explorer',
    text: 'The brave explorer finally reached the frozen summit.',
    gradeMin: 6,
    words: {
      noun: ['explorer', 'summit'],
      verb: ['reached'],
      adjective: ['brave', 'frozen'],
      adverb: ['finally'],
    },
  },
];

const POS_QUESTION: Readonly<Record<Pos, string>> = {
  noun: 'a noun (a person, place, thing, or idea)',
  verb: 'a verb (an action word)',
  adjective: 'an adjective (a word that describes a noun)',
  adverb: 'an adverb (a word that tells how, when, or where)',
};

function partsOfSpeech(ctx: GenContext): BankItem {
  const { random } = ctx;
  const pool = TAGGED.filter((s) => s.gradeMin <= Math.max(2, ctx.grade));
  const sentence = pick(random, pool);
  const allowed: Pos[] =
    ctx.grade >= 4 && ctx.category !== 'accessible'
      ? ['noun', 'verb', 'adjective', 'adverb']
      : ['noun', 'verb', 'adjective'];
  const asked = pick(
    random,
    allowed.filter((p) => (sentence.words[p]?.length ?? 0) > 0),
  );
  const correct = pick(random, sentence.words[asked] ?? []);
  const others = (['noun', 'verb', 'adjective', 'adverb'] as const)
    .filter((p) => p !== asked)
    .flatMap((p) => sentence.words[p] ?? []);
  const distractors = shuffle(random, others).slice(0, 3);
  const setup = choices(random, correct, distractors);
  return buildItem({
    templateKey: 'grammar.parts_of_speech.v1',
    subject: 'grammar_writing',
    skill: 'grammar.parts_of_speech',
    gradeMin: Math.max(2, sentence.gradeMin),
    gradeMax: 8,
    category: ctx.category,
    prompt: prompt(
      `Read the sentence: “${sentence.text}” Which word is ${POS_QUESTION[asked]}?`,
      'choice',
      {
        choices: setup.choices,
      },
    ),
    answerSpec: setup.spec,
    explanation: `“${correct}” is ${POS_QUESTION[asked].split(' (')[0]} in this sentence; the other choices are other parts of speech.`,
    distractor: setup.wrongLetter,
    params: { sentence: sentence.id, asked, correct },
  });
}

interface EndMarkSentence {
  readonly id: string;
  readonly body: string;
  readonly mark: '.' | '?';
  readonly gradeMin: number;
}

const END_MARKS: readonly EndMarkSentence[] = [
  { id: 'jacket', body: 'Where did you put my blue jacket', mark: '?', gradeMin: 1 },
  { id: 'lunch', body: 'What should we pack for lunch', mark: '?', gradeMin: 1 },
  { id: 'bus', body: 'Is the bus late again today', mark: '?', gradeMin: 1 },
  { id: 'library', body: 'Can we visit the library after school', mark: '?', gradeMin: 1 },
  { id: 'cat', body: 'The cat is sleeping on the warm windowsill', mark: '.', gradeMin: 1 },
  { id: 'garden', body: 'We planted three rows of beans in the garden', mark: '.', gradeMin: 1 },
  { id: 'rain', body: 'It rained all morning, so we played a board game', mark: '.', gradeMin: 2 },
  { id: 'map', body: 'My sister drew a map of our neighborhood', mark: '.', gradeMin: 1 },
  { id: 'planet', body: 'How far away is the nearest planet', mark: '?', gradeMin: 2 },
  { id: 'soccer', body: 'Our soccer practice starts at four o’clock', mark: '.', gradeMin: 2 },
];

interface CommaList {
  readonly id: string;
  readonly correct: string;
  readonly wrong: readonly [string, string];
  readonly gradeMin: number;
}

const COMMA_LISTS: readonly CommaList[] = [
  {
    id: 'fruit',
    correct: 'We packed apples, grapes, and pears for the picnic.',
    wrong: [
      'We packed, apples grapes and pears for the picnic.',
      'We packed apples grapes, and, pears for the picnic.',
    ],
    gradeMin: 3,
  },
  {
    id: 'colors',
    correct: 'The flag was red, white, and blue.',
    wrong: ['The flag, was red white and blue.', 'The flag was red white, and, blue.'],
    gradeMin: 3,
  },
  {
    id: 'date',
    correct: 'The fair opens on June 5, 2027, at noon.',
    wrong: ['The fair opens on, June 5 2027 at noon.', 'The fair, opens on June, 5 2027 at noon.'],
    gradeMin: 4,
  },
  {
    id: 'city',
    correct: 'My cousin lives in Denver, Colorado.',
    wrong: ['My cousin lives, in Denver Colorado.', 'My cousin, lives in Denver Colorado.'],
    gradeMin: 3,
  },
];

function punctuation(ctx: GenContext): BankItem {
  const { random } = ctx;
  const lists = COMMA_LISTS.filter((c) => c.gradeMin <= ctx.grade);
  if (lists.length > 0 && ctx.category !== 'accessible' && pick(random, [0, 1, 2]) === 0) {
    const list = pick(random, lists);
    const setup = choices(random, list.correct, list.wrong);
    return buildItem({
      templateKey: 'grammar.punctuation.commas.v1',
      subject: 'grammar_writing',
      skill: 'grammar.punctuation',
      gradeMin: Math.max(3, list.gradeMin),
      gradeMax: 5,
      category: ctx.category,
      prompt: prompt('Which sentence uses commas correctly?', 'choice', { choices: setup.choices }),
      answerSpec: setup.spec,
      explanation: `Commas separate items in a list, parts of a date, and a city from its state: “${list.correct}”`,
      distractor: setup.wrongLetter,
      params: { list: list.id },
    });
  }
  const pool = END_MARKS.filter((s) => s.gradeMin <= Math.max(1, ctx.grade));
  const s = pick(random, pool);
  const correct = `${s.body}${s.mark}`;
  const wrongMark = s.mark === '?' ? '.' : '?';
  const setup = choices(random, correct, [`${s.body}${wrongMark}`, `${s.body},`]);
  return buildItem({
    templateKey: 'grammar.punctuation.end_marks.v1',
    subject: 'grammar_writing',
    skill: 'grammar.punctuation',
    gradeMin: 1,
    gradeMax: 5,
    category: ctx.category,
    prompt: prompt('Which sentence has the correct end mark?', 'choice', {
      choices: setup.choices,
    }),
    answerSpec: setup.spec,
    explanation:
      s.mark === '?'
        ? 'The sentence asks something, so it ends with a question mark.'
        : 'The sentence tells something, so it ends with a period.',
    distractor: setup.wrongLetter,
    params: { sentence: s.id },
  });
}

interface AgreementFrame {
  readonly id: string;
  readonly before: string;
  readonly after: string;
  readonly correct: string;
  readonly wrong: readonly string[];
  readonly gradeMin: number;
  readonly why: string;
}

const AGREEMENT: readonly AgreementFrame[] = [
  {
    id: 'dogs',
    before: 'The dogs',
    after: 'in the yard every morning.',
    correct: 'run',
    wrong: ['runs', 'is running'],
    gradeMin: 2,
    why: '“Dogs” is plural, so the verb is “run”.',
  },
  {
    id: 'bird',
    before: 'A little bird',
    after: 'outside my window.',
    correct: 'sings',
    wrong: ['sing', 'are singing'],
    gradeMin: 2,
    why: '“Bird” is singular, so the verb is “sings”.',
  },
  {
    id: 'friends',
    before: 'My friends',
    after: 'to the pool on Saturdays.',
    correct: 'go',
    wrong: ['goes', 'is going'],
    gradeMin: 2,
    why: '“Friends” is plural, so the verb is “go”.',
  },
  {
    id: 'teacher',
    before: 'Our teacher',
    after: 'a story after lunch.',
    correct: 'reads',
    wrong: ['read', 'are reading'],
    gradeMin: 2,
    why: '“Teacher” is singular, so the verb is “reads”.',
  },
  {
    id: 'boxes',
    before: 'The boxes in the hallway',
    after: 'heavy.',
    correct: 'are',
    wrong: ['is', 'was being'],
    gradeMin: 3,
    why: 'The subject is “boxes” (plural), not “hallway”, so the verb is “are”.',
  },
  {
    id: 'basket',
    before: 'The basket of oranges',
    after: 'on the table.',
    correct: 'is',
    wrong: ['are', 'were'],
    gradeMin: 4,
    why: 'The subject is “basket” (singular), not “oranges”, so the verb is “is”.',
  },
  {
    id: 'each',
    before: 'Each of the players',
    after: 'a water bottle.',
    correct: 'has',
    wrong: ['have', 'are having'],
    gradeMin: 5,
    why: '“Each” is singular, so the verb is “has”.',
  },
  {
    id: 'neither',
    before: 'Neither my brother nor my sister',
    after: 'spinach.',
    correct: 'likes',
    wrong: ['like', 'are liking'],
    gradeMin: 6,
    why: 'With “neither ... nor”, the verb agrees with the nearer subject, “sister” (singular).',
  },
  {
    id: 'kids',
    before: 'The kids on the bus',
    after: 'songs on the way home.',
    correct: 'sing',
    wrong: ['sings', 'is singing'],
    gradeMin: 3,
    why: 'The subject is “kids” (plural), so the verb is “sing”.',
  },
  {
    id: 'she',
    before: 'She',
    after: 'her bike to school.',
    correct: 'rides',
    wrong: ['ride', 'are riding'],
    gradeMin: 2,
    why: '“She” is singular, so the verb is “rides”.',
  },
];

function subjectVerbAgreement(ctx: GenContext): BankItem {
  const { random } = ctx;
  const frame = pick(
    random,
    AGREEMENT.filter((f) => f.gradeMin <= Math.max(2, ctx.grade)),
  );
  const setup = choices(random, frame.correct, frame.wrong);
  return buildItem({
    templateKey: 'grammar.subject_verb_agreement.v1',
    subject: 'grammar_writing',
    skill: 'grammar.subject_verb_agreement',
    gradeMin: Math.max(2, frame.gradeMin),
    gradeMax: 6,
    category: ctx.category,
    prompt: prompt(
      `Choose the verb that completes the sentence: “${frame.before} ____ ${frame.after}”`,
      'choice',
      {
        choices: setup.choices,
      },
    ),
    answerSpec: setup.spec,
    explanation: frame.why,
    distractor: setup.wrongLetter,
    params: { frame: frame.id },
  });
}

interface CapitalFrame {
  readonly id: string;
  readonly correct: string;
  readonly wrong: readonly [string, string];
  readonly gradeMin: number;
  readonly why: string;
}

const CAPITALS: readonly CapitalFrame[] = [
  {
    id: 'monday',
    correct: 'On Monday we visited Aunt Rosa.',
    wrong: ['on Monday we visited aunt Rosa.', 'On monday we visited Aunt rosa.'],
    gradeMin: 1,
    why: 'Sentences begin with a capital letter, and days and names are proper nouns.',
  },
  {
    id: 'lake',
    correct: 'My family camped near Lake Tahoe in July.',
    wrong: [
      'my family camped near lake Tahoe in july.',
      'My Family camped near Lake tahoe in July.',
    ],
    gradeMin: 2,
    why: 'Names of places and months are capitalized; common nouns like “family” are not.',
  },
  {
    id: 'dog',
    correct: 'Our dog Pepper loves to swim.',
    wrong: ['our dog pepper loves to swim.', 'Our Dog pepper loves to swim.'],
    gradeMin: 1,
    why: 'A pet’s name is a proper noun; “dog” is a common noun.',
  },
  {
    id: 'texas',
    correct: 'Grandpa drove from Texas to Ohio.',
    wrong: ['grandpa drove from texas to Ohio.', 'Grandpa drove from Texas to ohio.'],
    gradeMin: 2,
    why: 'State names are proper nouns and start with capital letters.',
  },
  {
    id: 'i',
    correct: 'Sam and I read a book about Mars.',
    wrong: ['Sam and i read a book about mars.', 'sam and I read a book about Mars.'],
    gradeMin: 1,
    why: 'The word “I”, names of people and names of planets are capitalized.',
  },
  {
    id: 'river',
    correct: 'We learned about the Nile River on Friday.',
    wrong: [
      'We learned about the nile river on Friday.',
      'we learned about the Nile River on friday.',
    ],
    gradeMin: 3,
    why: 'Names of rivers and days of the week are proper nouns.',
  },
  {
    id: 'school',
    correct: 'Next year I will go to Maple Street School.',
    wrong: [
      'Next year i will go to maple street school.',
      'next Year I will go to Maple Street school.',
    ],
    gradeMin: 3,
    why: 'The full name of a school is a proper noun, and “I” is always capitalized.',
  },
  {
    id: 'holiday',
    correct: 'We bake bread every Thanksgiving in November.',
    wrong: [
      'We bake bread every thanksgiving in november.',
      'we bake Bread every Thanksgiving in November.',
    ],
    gradeMin: 2,
    why: 'Holidays and months are capitalized; “bread” is a common noun.',
  },
];

function capitalization(ctx: GenContext): BankItem {
  const { random } = ctx;
  const frame = pick(
    random,
    CAPITALS.filter((f) => f.gradeMin <= Math.max(1, ctx.grade)),
  );
  const setup = choices(random, frame.correct, frame.wrong);
  return buildItem({
    templateKey: 'grammar.capitalization.v1',
    subject: 'grammar_writing',
    skill: 'grammar.capitalization',
    gradeMin: Math.max(1, frame.gradeMin),
    gradeMax: 4,
    category: ctx.category,
    prompt: prompt('Which sentence uses capital letters correctly?', 'choice', {
      choices: setup.choices,
    }),
    answerSpec: setup.spec,
    explanation: frame.why,
    distractor: setup.wrongLetter,
    params: { frame: frame.id },
  });
}

interface PluralWord {
  readonly singular: string;
  readonly plural: string;
  readonly gradeMin: number;
}

const PLURALS: readonly PluralWord[] = [
  { singular: 'box', plural: 'boxes', gradeMin: 1 },
  { singular: 'baby', plural: 'babies', gradeMin: 2 },
  { singular: 'leaf', plural: 'leaves', gradeMin: 2 },
  { singular: 'child', plural: 'children', gradeMin: 2 },
  { singular: 'mouse', plural: 'mice', gradeMin: 2 },
  { singular: 'bus', plural: 'buses', gradeMin: 1 },
  { singular: 'wish', plural: 'wishes', gradeMin: 1 },
  { singular: 'tooth', plural: 'teeth', gradeMin: 2 },
  { singular: 'city', plural: 'cities', gradeMin: 2 },
  { singular: 'knife', plural: 'knives', gradeMin: 3 },
  { singular: 'foot', plural: 'feet', gradeMin: 2 },
  { singular: 'fox', plural: 'foxes', gradeMin: 1 },
  { singular: 'berry', plural: 'berries', gradeMin: 2 },
  { singular: 'goose', plural: 'geese', gradeMin: 3 },
  { singular: 'puppy', plural: 'puppies', gradeMin: 2 },
  { singular: 'bench', plural: 'benches', gradeMin: 2 },
  { singular: 'wolf', plural: 'wolves', gradeMin: 3 },
];

function pluralNouns(ctx: GenContext): BankItem {
  const { random } = ctx;
  const word = pick(
    random,
    PLURALS.filter((w) => w.gradeMin <= Math.max(1, ctx.grade)),
  );
  return buildItem({
    templateKey: 'grammar.plural_nouns.v1',
    subject: 'grammar_writing',
    skill: 'grammar.plural_nouns',
    gradeMin: Math.max(1, word.gradeMin),
    gradeMax: 4,
    category: ctx.category,
    prompt: prompt(`Write the plural of the word “${word.singular}” (more than one).`, 'word'),
    answerSpec: { kind: 'exact_text', accepted: [word.plural], alternates: [] },
    explanation: `The plural of “${word.singular}” is “${word.plural}”.`,
    // Adding a plain "s" is the common slip for these words.
    distractor: `${word.singular}s`,
    params: { word: word.singular },
  });
}

export const GRAMMAR_GENERATORS: Readonly<Record<string, (ctx: GenContext) => BankItem>> = {
  'grammar.parts_of_speech': partsOfSpeech,
  'grammar.punctuation': punctuation,
  'grammar.subject_verb_agreement': subjectVerbAgreement,
  'grammar.capitalization': capitalization,
  'grammar.plural_nouns': pluralNouns,
};
