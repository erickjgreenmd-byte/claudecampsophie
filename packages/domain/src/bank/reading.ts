// Original reading passages with literal and inference questions (spec P7 "original reading
// passages"). Every passage and question below was written for PencilLift; nothing is copied from
// published texts. Parent-supplied passages get only questions whose keys can be checked
// deterministically (order of events, word recall); inference questions on a family's own passage
// need AI generation plus review and are listed as unsupported in the coverage report.
import type { RandomSource } from '../shared/random.ts';
import { buildItem, choices, firstValid, prompt } from './build.ts';
import { pick, shuffle } from './random.ts';
import type { BankCategory, BankItem } from './types.ts';

interface PassageQuestion {
  readonly id: string;
  readonly skill:
    | 'reading.literal_detail'
    | 'reading.inference'
    | 'reading.main_idea'
    | 'reading.vocabulary_in_context'
    | 'reading.sequence';
  readonly stem: string;
  readonly correct: string;
  readonly distractors: readonly [string, string, string];
  readonly explanation: string;
}

interface Passage {
  readonly id: string;
  readonly title: string;
  readonly gradeMin: number;
  readonly gradeMax: number;
  readonly text: string;
  readonly questions: readonly PassageQuestion[];
}

export const PASSAGES: readonly Passage[] = [
  {
    id: 'red_kite',
    title: 'The Red Kite',
    gradeMin: 0,
    gradeMax: 1,
    text: 'Nora has a red kite. The wind is strong today. Nora runs up the hill. The kite goes up, up, up! It flies over the trees. Then the wind stops. The kite floats down. Nora picks it up and smiles.',
    questions: [
      {
        id: 'color',
        skill: 'reading.literal_detail',
        stem: 'What color is Nora’s kite?',
        correct: 'Red',
        distractors: ['Blue', 'Yellow', 'Green'],
        explanation: 'The first sentence says Nora has a red kite.',
      },
      {
        id: 'where',
        skill: 'reading.literal_detail',
        stem: 'Where does Nora run?',
        correct: 'Up the hill',
        distractors: ['Into the house', 'Down to the lake', 'Across the street'],
        explanation: 'The story says “Nora runs up the hill.”',
      },
      {
        id: 'after',
        skill: 'reading.sequence',
        stem: 'What happens after the wind stops?',
        correct: 'The kite floats down.',
        distractors: [
          'Nora runs up the hill.',
          'The kite flies over the trees.',
          'The wind gets strong.',
        ],
        explanation: 'Right after “the wind stops,” the story says “The kite floats down.”',
      },
      {
        id: 'feel',
        skill: 'reading.inference',
        stem: 'How does Nora feel at the end of the story?',
        correct: 'Happy',
        distractors: ['Angry', 'Scared', 'Bored'],
        explanation: 'Nora smiles at the end, which shows she is happy.',
      },
    ],
  },
  {
    id: 'pip_garden',
    title: 'Pip Plants a Garden',
    gradeMin: 1,
    gradeMax: 2,
    text: 'Pip the hedgehog wanted a garden. First, he dug small holes in the soft dirt. Next, he dropped one seed into each hole. Then he covered the seeds and gave them water. Every morning Pip checked his garden. After many days, tiny green sprouts poked out of the ground. Pip clapped his paws. “My garden is growing!” he said.',
    questions: [
      {
        id: 'first',
        skill: 'reading.sequence',
        stem: 'What did Pip do first?',
        correct: 'He dug small holes.',
        distractors: ['He gave the seeds water.', 'He checked his garden.', 'He clapped his paws.'],
        explanation: 'The story uses the word “First” before Pip digs the holes.',
      },
      {
        id: 'sprouts',
        skill: 'reading.literal_detail',
        stem: 'What poked out of the ground?',
        correct: 'Tiny green sprouts',
        distractors: ['Big red flowers', 'Small brown rocks', 'Long yellow worms'],
        explanation: 'The story says “tiny green sprouts poked out of the ground.”',
      },
      {
        id: 'vocab',
        skill: 'reading.vocabulary_in_context',
        stem: 'In the story, what are “sprouts”?',
        correct: 'New little plants',
        distractors: ['Loud noises', 'Rain clouds', 'Garden tools'],
        explanation: 'Sprouts come up from planted seeds, so they are new little plants.',
      },
      {
        id: 'clap',
        skill: 'reading.inference',
        stem: 'Why did Pip clap his paws?',
        correct: 'He was glad his seeds were growing.',
        distractors: ['He was cold.', 'He wanted the rain to stop.', 'He dropped a seed.'],
        explanation: 'Pip claps right when he sees the sprouts and says his garden is growing.',
      },
    ],
  },
  {
    id: 'rainy_fort',
    title: 'The Rainy Day Fort',
    gradeMin: 2,
    gradeMax: 3,
    text: 'Rain tapped on the windows all Saturday morning. Jamal and his little sister, Tess, could not play outside. “Let’s build a fort,” Jamal said. They pulled the cushions off the couch and leaned them together. Tess brought two blankets to make a roof. Jamal found a flashlight so they could see inside. When the fort was finished, they crawled in and read comic books until lunch. By the afternoon, the sun was out, but Tess wanted to stay in the fort a little longer.',
    questions: [
      {
        id: 'why_inside',
        skill: 'reading.literal_detail',
        stem: 'Why couldn’t Jamal and Tess play outside?',
        correct: 'It was raining.',
        distractors: ['It was too dark.', 'They were sick.', 'It was snowing.'],
        explanation: 'The story begins with rain tapping on the windows all morning.',
      },
      {
        id: 'roof',
        skill: 'reading.literal_detail',
        stem: 'What did Tess use to make the roof?',
        correct: 'Two blankets',
        distractors: ['Couch cushions', 'A flashlight', 'Comic books'],
        explanation: '“Tess brought two blankets to make a roof.”',
      },
      {
        id: 'flashlight',
        skill: 'reading.inference',
        stem: 'Why did Jamal get a flashlight?',
        correct: 'So they could see inside the fort',
        distractors: [
          'So they could find the couch',
          'So Tess could read outside',
          'Because the rain stopped',
        ],
        explanation: 'The story says he found it “so they could see inside.”',
      },
      {
        id: 'tess_feels',
        skill: 'reading.inference',
        stem: 'How does Tess most likely feel about the fort?',
        correct: 'She likes it and does not want to leave yet.',
        distractors: [
          'She thinks it is scary.',
          'She is bored of it.',
          'She wants to take it apart right away.',
        ],
        explanation: 'Even after the sun comes out, Tess wants to stay in the fort longer.',
      },
    ],
  },
  {
    id: 'bee_dance',
    title: 'How Honeybees Share Directions',
    gradeMin: 3,
    gradeMax: 4,
    text: 'When a honeybee finds a patch of flowers full of nectar, she flies back to the hive to tell the other bees. But bees cannot speak, so how do they share directions? They dance! The bee moves in a figure-eight pattern and wiggles her body in the middle of the eight. The direction of the wiggle shows which way to fly, compared to the sun. The length of the wiggle shows how far away the flowers are: a longer wiggle means the flowers are farther away. Other bees watch closely, then fly off to find the food.',
    questions: [
      {
        id: 'main',
        skill: 'reading.main_idea',
        stem: 'What is this passage mostly about?',
        correct: 'How honeybees use a dance to share where food is',
        distractors: [
          'How honeybees build their hives',
          'Why flowers make nectar',
          'How to keep bees away from a picnic',
        ],
        explanation: 'Every sentence explains the dance bees use to show where flowers are.',
      },
      {
        id: 'longer',
        skill: 'reading.literal_detail',
        stem: 'What does a longer wiggle tell the other bees?',
        correct: 'The flowers are farther away.',
        distractors: [
          'The flowers are very close.',
          'The hive is in danger.',
          'It is time to sleep.',
        ],
        explanation: 'The passage says “a longer wiggle means the flowers are farther away.”',
      },
      {
        id: 'patch',
        skill: 'reading.vocabulary_in_context',
        stem: 'In the passage, what does the word “patch” mean?',
        correct: 'A small area',
        distractors: ['A loud buzz', 'A kind of honey', 'A group of bees'],
        explanation: 'A “patch of flowers” is a small area where flowers grow.',
      },
      {
        id: 'watch',
        skill: 'reading.inference',
        stem: 'Why do the other bees watch the dancing bee closely?',
        correct: 'To learn where to find the food',
        distractors: [
          'To learn a new song',
          'To see who dances best',
          'To guard the hive from the dancer',
        ],
        explanation: 'After watching, the bees “fly off to find the food.”',
      },
    ],
  },
  {
    id: 'gull_rock',
    title: 'The Lantern on Gull Rock',
    gradeMin: 4,
    gradeMax: 5,
    text: 'Every evening, Mira climbed the ninety-two steps of the lighthouse on Gull Rock with her grandfather. Her job was to polish the thick glass around the lantern while he trimmed the wick. One stormy night, the power went out across the whole island. Down in the harbor, a fishing boat was still out on the dark water. Grandfather’s hands shook as he struck match after match in the wind. Mira cupped her hands around the flame until the wick caught. The lantern blazed, and a long beam swept across the waves. An hour later, the fishing boat bumped safely against the dock, and its crew waved their caps toward the tower.',
    questions: [
      {
        id: 'job',
        skill: 'reading.literal_detail',
        stem: 'What was Mira’s job in the lighthouse?',
        correct: 'Polishing the glass around the lantern',
        distractors: [
          'Trimming the wick',
          'Steering the fishing boat',
          'Counting visitors on the steps',
        ],
        explanation: '“Her job was to polish the thick glass around the lantern.”',
      },
      {
        id: 'caps',
        skill: 'reading.inference',
        stem: 'Why did the crew wave their caps toward the tower?',
        correct: 'To thank the keepers for the light that guided them',
        distractors: [
          'To ask for more matches',
          'Because they wanted to climb the steps',
          'To warn Mira about the storm',
        ],
        explanation: 'The boat reached the dock safely after the beam swept across the waves.',
      },
      {
        id: 'first',
        skill: 'reading.sequence',
        stem: 'Which event happened first?',
        correct: 'The power went out across the island.',
        distractors: [
          'Mira cupped her hands around the flame.',
          'The lantern blazed.',
          'The fishing boat bumped against the dock.',
        ],
        explanation: 'The power failure starts the problem; the other events follow it.',
      },
      {
        id: 'blazed',
        skill: 'reading.vocabulary_in_context',
        stem: 'In the passage, what does the word “blazed” mean?',
        correct: 'Burned brightly',
        distractors: ['Broke apart', 'Went dark', 'Spun slowly'],
        explanation: 'After the wick caught, the lantern “blazed” and sent out a long beam.',
      },
    ],
  },
  {
    id: 'desert_animals',
    title: 'Staying Cool in the Desert',
    gradeMin: 5,
    gradeMax: 6,
    text: 'Deserts can be scorching during the day and surprisingly cold at night. Many desert animals survive by changing when they are active. Instead of hunting in the midday heat, they rest in burrows or shady cracks and come out after sunset. These animals are called nocturnal. Other animals have bodies that help them handle heat. The fennec fox has very large ears that release heat from its body, a little like the radiator in a car. The kangaroo rat rarely drinks at all; it gets most of the water it needs from the seeds it eats. In a place where water and shade are hard to find, these adaptations make the difference between struggling and thriving.',
    questions: [
      {
        id: 'main',
        skill: 'reading.main_idea',
        stem: 'Which sentence best states the main idea of the passage?',
        correct:
          'Desert animals have behaviors and body features that help them survive heat and dryness.',
        distractors: [
          'Fennec foxes are the largest animals in the desert.',
          'Deserts are hot during both the day and the night.',
          'Kangaroo rats must drink water many times a day.',
        ],
        explanation:
          'The passage gives examples of behaviors (being nocturnal) and body features (large ears, getting water from seeds) that help animals survive.',
      },
      {
        id: 'nocturnal',
        skill: 'reading.vocabulary_in_context',
        stem: 'Based on the passage, “nocturnal” animals are animals that',
        correct: 'are active at night',
        distractors: ['live only in trees', 'eat only plants', 'sleep all winter'],
        explanation: 'The animals come out after sunset, and “these animals are called nocturnal.”',
      },
      {
        id: 'radiator',
        skill: 'reading.inference',
        stem: 'Why does the author compare the fennec fox’s ears to a car’s radiator?',
        correct: 'Both help get rid of extra heat.',
        distractors: ['Both are made of metal.', 'Both make loud sounds.', 'Both help find water.'],
        explanation:
          'The ears “release heat from its body,” which is what a radiator does for an engine.',
      },
      {
        id: 'water',
        skill: 'reading.literal_detail',
        stem: 'Where does the kangaroo rat get most of its water?',
        correct: 'From the seeds it eats',
        distractors: ['From rivers', 'From rain puddles', 'From cactus flowers'],
        explanation:
          'The passage says it “gets most of the water it needs from the seeds it eats.”',
      },
    ],
  },
  {
    id: 'seed_library',
    title: 'A Library for Seeds',
    gradeMin: 6,
    gradeMax: 8,
    text: 'In some places around the world, scientists have built libraries that hold seeds instead of books. These seed banks store samples of crops such as wheat, rice, and beans in cold, dry vaults. Keeping seeds cold and dry slows them down, so many can stay alive for decades. Why go to all this trouble? Farmers today grow only a small number of crop varieties, and diseases, droughts, or wars can wipe out local plants. If a variety disappears from farms, a seed bank may still hold a sample that can be planted again. In that way, a seed bank works like a backup copy of a computer file: most of the time no one needs it, but when something goes wrong, it can save what would otherwise be lost.',
    questions: [
      {
        id: 'central',
        skill: 'reading.main_idea',
        stem: 'What is the central idea of the passage?',
        correct: 'Seed banks protect crop varieties so they can be replanted if they are lost.',
        distractors: [
          'Seed banks are libraries where people borrow books about farming.',
          'Farmers should stop growing wheat and rice.',
          'Computers are the best way to store seeds.',
        ],
        explanation:
          'The passage explains what seed banks store and why: to replant varieties that disappear.',
      },
      {
        id: 'varieties',
        skill: 'reading.vocabulary_in_context',
        stem: 'As used in the passage, “varieties” most nearly means',
        correct: 'different kinds',
        distractors: ['large farms', 'weather reports', 'loud arguments'],
        explanation: 'Crop “varieties” are different kinds of a crop.',
      },
      {
        id: 'cold',
        skill: 'reading.inference',
        stem: 'Why are the seeds kept cold and dry?',
        correct: 'It helps them stay alive for a long time.',
        distractors: [
          'It makes them grow faster inside the vault.',
          'It keeps farmers from planting them.',
          'It changes them into new crops.',
        ],
        explanation:
          'Cold and dry conditions “slow them down, so many can stay alive for decades.”',
      },
      {
        id: 'backup',
        skill: 'reading.inference',
        stem: 'Why does the author compare a seed bank to a backup copy of a computer file?',
        correct: 'To explain that it saves something in case the original is lost',
        distractors: [
          'To show that seeds are stored on computers',
          'To argue that computers matter more than farms',
          'To describe how seeds are planted',
        ],
        explanation:
          'A backup is rarely needed but saves what would otherwise be lost, just like a seed bank.',
      },
    ],
  },
  {
    id: 'second_draft',
    title: 'The Second Draft',
    gradeMin: 7,
    gradeMax: 8,
    text: 'Priya stared at the red marks on her essay. Her teacher, Mr. Okafor, had circled almost every paragraph and written the same question in the margins: “What do you really think?” She had spent the whole weekend on the essay, and she had used every fact she could find about ocean plastic. Her first reaction was to crumple the page. Instead, she read her introduction again, slowly. It sounded like an encyclopedia, not like her. That evening she started over, beginning with the afternoon she had spent picking up bottle caps on the beach with her cousin. The facts were still there, but now they had a reason to be there.',
    questions: [
      {
        id: 'teacher',
        skill: 'reading.inference',
        stem: 'What did Mr. Okafor most likely want Priya to add to her essay?',
        correct: 'Her own ideas and experiences',
        distractors: ['More facts from an encyclopedia', 'Fewer paragraphs', 'Neater handwriting'],
        explanation:
          'His note asks “What do you really think?”, and her new draft starts from her own experience.',
      },
      {
        id: 'change',
        skill: 'reading.inference',
        stem: 'Which phrase best describes how Priya changes in the passage?',
        correct: 'From frustrated to determined',
        distractors: ['From bored to sleepy', 'From calm to angry', 'From confident to confused'],
        explanation: 'She first wants to crumple the page, then rereads it and starts over.',
      },
      {
        id: 'beach',
        skill: 'reading.literal_detail',
        stem: 'What experience did Priya use to begin her new draft?',
        correct: 'Picking up bottle caps on the beach with her cousin',
        distractors: [
          'Reading an encyclopedia about oceans',
          'Talking with Mr. Okafor after class',
          'Crumpling her first essay',
        ],
        explanation:
          'She began “with the afternoon she had spent picking up bottle caps on the beach with her cousin.”',
      },
      {
        id: 'margins',
        skill: 'reading.vocabulary_in_context',
        stem: 'In the passage, the “margins” are',
        correct: 'the blank edges around the writing on a page',
        distractors: [
          'the grades on a report card',
          'the paragraphs in the middle of the essay',
          'the red pens the teacher uses',
        ],
        explanation:
          'The teacher wrote his question in the margins, the empty space at the edges of the page.',
      },
    ],
  },
];

export function passageItems(
  random: RandomSource,
  grade: number,
  category: BankCategory,
  skill?: string,
): BankItem[] {
  const out: BankItem[] = [];
  for (const passage of PASSAGES) {
    // Accessible items come from passages one band below the child's grade.
    const target = category === 'accessible' ? Math.max(0, grade - 1) : grade;
    if (target < passage.gradeMin || target > passage.gradeMax) continue;
    for (const q of passage.questions) {
      if (skill !== undefined && q.skill !== skill) continue;
      const item = firstValid(() => {
        const setup = choices(random, q.correct, q.distractors);
        return buildItem({
          templateKey: `reading.${passage.id}.${q.id}.v1`,
          subject: 'reading',
          skill: q.skill,
          gradeMin: passage.gradeMin,
          gradeMax: passage.gradeMax,
          category,
          prompt: prompt(q.stem, 'choice', {
            choices: setup.choices,
            passage: { title: passage.title, text: passage.text },
          }),
          answerSpec: setup.spec,
          explanation: q.explanation,
          distractor: setup.wrongLetter,
          params: { passage: passage.id, q: q.id },
        });
      });
      if (item !== null) out.push(item);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Parent-supplied passages (the family's own study material)
// ------------------------------------------------------------------------------------------------

/** Grade-level words used as "not in the passage" distractors for word-recall questions. */
const RECALL_DISTRACTORS = [
  'volcano',
  'pancake',
  'trumpet',
  'blizzard',
  'giraffe',
  'rocket',
  'umbrella',
  'pirate',
  'cactus',
  'lantern',
  'penguin',
  'tornado',
  'saddle',
  'meadow',
  'compass',
  'harbor',
];

/** Sentences of 20..160 characters that occur exactly once (so "which comes first" is exact). */
function sentencesOf(text: string): string[] {
  const all = (text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["”’']?/g) ?? []).map((s) => s.trim());
  const counts = new Map<string, number>();
  for (const s of all) counts.set(s.toLowerCase(), (counts.get(s.toLowerCase()) ?? 0) + 1);
  return all.filter((s) => s.length >= 20 && s.length <= 160 && counts.get(s.toLowerCase()) === 1);
}

export const MAX_PARENT_PASSAGE_LENGTH = 4000;

/**
 * Deterministically checkable questions on a parent-supplied passage: which of three sentences
 * comes first, and which word appears in the passage. Keys are computed from the text itself.
 */
export function parentPassageItems(
  random: RandomSource,
  passageId: string,
  rawText: string,
  grade: number,
): BankItem[] {
  const text = rawText.replace(/\s+/g, ' ').trim().slice(0, MAX_PARENT_PASSAGE_LENGTH);
  if (text.length < 80) return [];
  const passage = { title: 'Your reading passage', text };
  const sentences = sentencesOf(text);
  const out: BankItem[] = [];
  if (sentences.length >= 3) {
    const indices = shuffle(
      random,
      sentences.map((_, i) => i),
    )
      .slice(0, 3)
      .sort((a, b) => a - b);
    const picked = indices.map((i) => sentences[i] as string);
    const unique = new Set(picked.map((s) => s.toLowerCase()));
    if (unique.size === 3) {
      const [first, ...rest] = picked as [string, string, string];
      const setup = choices(random, first, rest);
      out.push(
        buildItem({
          templateKey: 'reading.parent_passage.sequence.v1',
          subject: 'reading',
          skill: 'reading.sequence',
          gradeMin: Math.min(8, Math.max(0, grade)),
          gradeMax: Math.min(8, Math.max(0, grade)),
          category: 'standard',
          prompt: prompt('Which of these sentences comes first in the passage?', 'choice', {
            choices: setup.choices,
            passage,
          }),
          answerSpec: setup.spec,
          explanation:
            'Compare where each sentence appears in the passage; the correct one appears earliest.',
          distractor: setup.wrongLetter,
          params: { passageId, indices },
          source: 'parent_passage',
          license: 'Family-supplied study material',
        }),
      );
    }
  }
  const lower = ` ${text.toLowerCase().replace(/[^a-z\s]/g, ' ')} `;
  const words = [...new Set(lower.split(/\s+/).filter((w) => w.length >= 5 && w.length <= 12))];
  const absent = RECALL_DISTRACTORS.filter(
    (w) => !lower.includes(` ${w} `) && !lower.includes(`${w}s `),
  );
  if (words.length > 0 && absent.length >= 3) {
    const word = pick(random, words);
    const setup = choices(random, word, shuffle(random, absent).slice(0, 3));
    out.push(
      buildItem({
        templateKey: 'reading.parent_passage.word_recall.v1',
        subject: 'reading',
        skill: 'reading.literal_detail',
        gradeMin: Math.min(8, Math.max(0, grade)),
        gradeMax: Math.min(8, Math.max(0, grade)),
        category: 'accessible',
        prompt: prompt('Which of these words appears in the passage?', 'choice', {
          choices: setup.choices,
          passage,
        }),
        answerSpec: setup.spec,
        explanation: 'Scan the passage for each word; only one of them appears in it.',
        distractor: setup.wrongLetter,
        params: { passageId, word },
        source: 'parent_passage',
        license: 'Family-supplied study material',
      }),
    );
  }
  return out;
}
