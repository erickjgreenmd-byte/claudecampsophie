import { describe, expect, it } from 'vitest';
import {
  MAX_RUBRIC_FEEDBACK_ROWS,
  childCriterionLabel,
  childRubricFeedback,
  exampleWordingSpans,
} from '../src/jobs/rubric-feedback.ts';

/** Child-facing rubric feedback for written work (AC_GRADING_03): labels only, fixed wording. */
describe('childCriterionLabel', () => {
  it('keeps short plain labels, trimming whitespace and trailing punctuation', () => {
    expect(childCriterionLabel('  Uses   complete sentences. ')).toBe('Uses complete sentences');
    expect(childCriterionLabel('Explains the character’s choice')).toBe(
      'Explains the character’s choice',
    );
    expect(childCriterionLabel("Doesn't repeat the same word")).toBe(
      "Doesn't repeat the same word",
    );
  });

  it('drops anything that could carry example wording to copy', () => {
    for (const raw of [
      'Topic sentence like "Dogs are loyal"',
      'Starts with “Once upon a time”',
      "Starts with 'Once upon a time'",
      'Uses «quotes»',
      'Line one\nLine two',
      'x'.repeat(81),
      'one two three four five six seven eight nine ten eleven twelve thirteen',
      'See https://example.com',
      'Ask teacher@example.com',
      'www.example.com has ideas',
      'Hidden‮text',
      'Zero​width',
      'ab',
      '',
      // Final lead review (LJA-F1): example wording after a colon, and a first-person sentence the
      // child would write instead of a criterion.
      'Start with: The water cycle has four stages',
      'I stayed inside because it was raining',
      'My dog is my best friend',
      'We went to the park after lunch',
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
  });

  it('rejects non-strings', () => {
    expect(childCriterionLabel(null)).toBeNull();
    expect(childCriterionLabel(42)).toBeNull();
    expect(childCriterionLabel({ toString: () => 'Uses details' })).toBeNull();
  });

  // Round-2 check (CHK-LJA-F1-residual): a label must read as a criterion, not as a sentence the
  // child could copy. It starts with a third-person verb, or it is a short noun phrase.
  it('keeps criterion-shaped labels: a third-person verb first, or a short noun phrase', () => {
    for (const label of [
      'Uses complete sentences',
      'Gives a reason for the opinion',
      'Explains why the character is sad',
      'Uses a verb that is in the past tense',
      'Has a beginning, middle and end',
      'Stays on topic',
      'Shows the steps in order',
      'Includes details from the text',
      'Writes about one season',
      'Uses a because clause',
      'Uses the word bright in a sentence',
      'Uses mice as the plural of mouse', // criterion-shaped: the answer guard is what drops it
      "Doesn't repeat the same word",
      'Does not repeat the same word',
      'Clearly explains the reason',
      'Spelling',
      'Capital letters',
      'Word choice',
      'Clear topic sentence',
      'Correct end punctuation',
      'Use of transition words',
      'Details that support the main idea',
      'A clearly stated main idea',
      'The finished story',
    ]) {
      expect(childCriterionLabel(label), label).toBe(label);
    }
  });

  it('drops completed sentences and instructions that carry wording to copy', () => {
    for (const raw of [
      // The checker's cases: a finished sentence starter, and an example copied from the solution.
      'The dog ran fast because it was scared',
      'Write The lamp is bright at night',
      'Write The sun is very bright today',
      // A sentence behind a criterion verb, a clause it introduces, or a capitalised sentence start.
      'Writes the lamp is bright at night',
      'Explains that the dog was scared',
      'Says it was scared',
      'Gives the reason it rained',
      'Tells that he was hungry',
      'Explains why the dog ran fast because it was scared',
      'Writes The lamp glows at night',
      // Plain sentences and instructions are not criteria.
      'Dogs are loyal',
      'The sun is very bright today',
      'It was raining',
      'She ran to the park',
      'They were happy at the beach',
      'The dog jumped over the log',
      'There are four seasons',
      'The water cycle has four stages',
      'Write a topic sentence',
      'Add a period at the end',
      'Topic sentence with a clear main idea and two details',
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
  });

  // Round-3 check (R2-LJA-F1-subordinate-and-that-bypass): the embedded-question and relative
  // exemptions let a completion or sentence through when the label itself opens with a wh-word, a
  // subordinator or "that", or when "that" comes straight after the lead verb.
  it('drops completions that open with a wh-word, a subordinator or "that", and lead-verb "that" clauses', () => {
    for (const raw of [
      // The checker's cases, all shown to the child before this fix.
      'That was a scary storm',
      'That was the best day ever',
      'When he was scared',
      'If you are sad',
      'When she ran home',
      'Who ate the cake',
      'Why the dog was scared',
      'Where the dog was hiding',
      'What the dog did next',
      'How it was made',
      'Which is why the dog ran',
      'Until the storm stopped',
      'Tells that was the best day',
      'Writes that was scary',
      'Explains that was why he hid',
      'Because of the loud thunder',
      'Because a loud noise scared him',
      'Once upon a time there lived',
      // The checker's other completions and sentences.
      'Because the thunder scared him',
      'When the storm came',
      'When it rains, the dog hides',
      'If it rains the game stops',
      'After the storm passed',
      'Thunder scared the dog',
      'Loud thunder scared the dog',
      'Writes because of the loud thunder',
      'Explains that thunder scared the dog',
      'Uses the sentence thunder scared the dog',
      'Writes a loud noise scared the dog',
      // Other openers, and a pronoun subject, auxiliary or irregular past first.
      'Unless it rains',
      'Whether the dog was scared',
      'Only when the storm came',
      'Even though it rained',
      'Just because it rained',
      'There lived a king',
      'To stay dry',
      'He wondered why the dog was scared',
      'They knew what was coming',
      'Was scared of what he saw',
      'Could tell why the dog hid',
      'Ran home when it got dark',
      // A word named as a word ("Uses he and she correctly") never hides a clause.
      'Uses he, she ran home',
      'Uses was scared',
      'Uses said the dog ran',
      'Uses because of the loud thunder',
      'Writes he and she ran home',
      // A clause after a subordinator, a comma or an adverb, an irregular past, and a lead verb
      // that is also a plural noun but is followed by a reported clause.
      'Hides until the storm stopped',
      'Explains why the dog hid until the storm stopped',
      'Explains clearly that was why he hid',
      'Writes about the dog, that was scared',
      'Lightning struck the tree',
      'Answers that was the best day',
      'Answers that the dog was scared',
      'Quotes that plants need water',
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
  });

  // Round-3 check (R2-LJA-F1-legit-labels-dropped): common K-8 grammar criteria name a pronoun,
  // an auxiliary or "said" as a word; they are not clauses and are kept.
  it('keeps criteria that name a function word as a word, and legitimate embedded or relative clauses', () => {
    for (const label of [
      'Uses he and she correctly',
      'Uses was and were correctly',
      'Uses is and are correctly',
      'Uses their, there and they’re correctly',
      'Uses its and it’s correctly',
      'Uses may and might correctly',
      'Uses can for ability',
      'Uses you to speak to the reader',
      'Uses said with a comma and a capital',
      'Uses strong verbs instead of said',
      'Uses because to join two ideas',
      'Uses a capital A at the start',
      'Rhymes words at the end of lines',
      'Stretches out words to spell them correctly',
      'Hears and writes beginning sounds',
      'Plans before writing',
      'Explains why it matters',
      'Explains what it means',
      'Tells who the main character is',
      'Checks if the answer makes sense',
      'Uses words that paint a picture',
      'Gives reasons that are clear',
      'Uses a topic sentence that states the main idea',
      'Uses the word café correctly',
      'Transitions that connect ideas',
      'Answers that match the question',
      'Uses vocabulary learned this week',
      'Uses a comma before the quoted words',
      'Explains what happened after the storm passed',
    ]) {
      expect(childCriterionLabel(label), label).toBe(label);
    }
  });

  // Round-4 check (R3-RL-1, R3-RL-2; lead policy: fail closed): the opener check looked only at the
  // first word, so an "-ly" word, "maybe"/"not"/"all", a noun or a preposition in front of a
  // clause word brought the completion back. A clause word anywhere now drops the label unless it
  // sits in a fixed criterion idiom, and one straight after a preposition always does.
  it('drops a clause word at any position outside a fixed criterion idiom, and one after a preposition', () => {
    for (const raw of [
      // The checker's A1: an "-ly" word or another lead word before the opener.
      'Probably when he was scared',
      'Especially when she ran home',
      'Exactly when the storm came',
      'Mainly because of the loud thunder',
      'Partly because of the thunder',
      'Especially because of the loud thunder',
      'Probably because of the thunder',
      'Suddenly when the storm came',
      'Finally, when he was scared',
      'Maybe when he was scared',
      'Perhaps because of the thunder',
      'Not because of the thunder',
      'Only just when he was scared',
      'Even just when he was scared',
      'Maybe once upon a time',
      // The checker's A2: a noun phrase with an embedded question or a relative clause.
      'The day when she ran home',
      'A place where she was safe',
      'The moment when thunder struck',
      'Reasons why it was scary',
      'The night when it was dark',
      'The girl who ran home',
      'Something that was scary',
      // A noun phrase holds no embedded question, even behind a question verb.
      'Ways to explain why he hid',
      // The checker's C3: a subordinator after a preposition behind the lead verb.
      'Ends with because of the thunder',
      'Finishes with because of the loud thunder',
      'Completes it with because of the thunder',
      'Writes about because of the thunder',
      'Ends with when the storm came',
      'Adds on because of the thunder',
      'Ends with after the storm',
      'Writes about how he ran home',
      // The checker's A4: a clause word after a verb that does not ask a question, or a relative
      // clause in the past.
      'Writes who ate the cake',
      'Writes what the dog did next',
      'Writes where the dog was hiding',
      'Writes when the storm came',
      'Writes the dog that ran home',
      'Writes the lamp which is bright',
      'Explains which was the best',
      'Describes the girl who ran home',
      // Later in the label, after a noun or an object.
      'The dog hid because of the thunder',
      'Includes a reason because it rained',
      'Tells the reader when the storm came',
      'Gives the reason why he was scared',
      'Stays inside until the rain stops',
      'Writes the lamp glows although it is day',
      'Writes a dog that can fly',
      'All because of the thunder',
      'However it was scary',
      // An "-ly" word before an instruction is a lead adverb too.
      'Neatly write a topic sentence',
      'Carefully write the lamp glows',
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
  });

  // Round-4 check (R3-RL-1 fix c, R3-RL-4): only "," and ";" ended a clause, and words were split
  // on spaces only, so a second sentence after "why." or a sentence written with hyphens was shown.
  it('reads a full stop, bracket, dash or ellipsis as a clause end, and joined words one by one', () => {
    for (const raw of [
      'Explains why. the dog was scared',
      'Explains why? he was scared',
      'Explains how! he ran home',
      'Tells why - the dog was scared',
      'Tells why … he was scared',
      'Tells why (he was scared)',
      'Tells how—he ran home',
      'It-was-raining',
      'The-dog-was-scared',
      'It_was_raining',
      'Because-of-the-loud-thunder',
      'Writes the-lamp-is-bright',
      'The dog was-scared',
      'That.was.scary',
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
  });

  // The fixed idioms (isCriterionShaped doc): each keeps realistic criteria across the six subjects.
  it('keeps criteria whose clause word sits in a fixed idiom', () => {
    for (const label of [
      // An embedded question straight after a question verb, or a list of question words.
      'Explains how the answer was found',
      'Tells which operation to use',
      'Decides whether the answer is reasonable',
      'Estimates how many are in the jar',
      'Figures out what the question asks',
      'Explains how and why the strategy works',
      'Clearly explains why the plant grew',
      'Explains clearly how the pattern grows',
      'Uses a model to show how the fractions compare',
      'Knows when to double the final consonant',
      'Explains the problem and how it was solved',
      'Explains what happened and why',
      'Describes where the river is on the map',
      // A relative "that" or "who" after a noun, with a present-tense verb.
      'Writes an equation that matches the story',
      'Identifies the part of the plant that makes food',
      'Describes the animals that live in the desert',
      'Writes a title that fits the story',
      'Describes a character who changes',
      // A clause word named as a word.
      'Uses a when clause',
      'Answers who, what, when, where and why questions',
      'Joins sentences with because or so',
      'Uses the conjunction because',
      'Uses joining words like because and so',
      'Uses transition words such as however and therefore',
      'Avoids starting sentences with because',
      // "if needed", "when" or "while" before a gerund, "what happens when".
      'Regroups if needed',
      'Uses capital letters where needed',
      'Uses a comma when joining two sentences',
      'Checks spelling while writing',
      'Describes what happens when water freezes',
      // A title's full stop and a hyphenated word are not a clause end.
      'Describes how Dr. King changed history',
      'Explains why Mr. Lee was sad',
      'Shows step-by-step work',
    ]) {
      expect(childCriterionLabel(label), label).toBe(label);
    }
  });

  // Round-3 check (R2-LJA-F1-mixed-script): the word lists are English in Latin letters, so a
  // look-alike letter from another script ("а" Cyrillic) would hide a listed word from the check.
  it('drops a label with a letter that is not a Latin letter, or a Latin look-alike', () => {
    for (const raw of [
      'Dogs аre loyal', // Cyrillic a
      'Writes the lamp іs bright', // Ukrainian i
      'The dog wаs scared', // Cyrillic a
      'Dogs ɑre loyal', // Latin alpha
      'Wrıtes the lamp is bright', // dotless i
      'Uses сapital letters', // Cyrillic es: a harmless label, still refused
      'Собака бежит', // a Cyrillic sentence
      'Dogs àre loyal', // an accent does not hide "are"
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
  });
});

// Round-3 check (R2-LJA-F1-example-span-gaps): example wording in the parent-only solution without
// quotes, in the forms a model writes it, is found so the caller can protect it.
describe('exampleWordingSpans', () => {
  it('finds unquoted example wording after a label, colon or dash, or a cue phrase', () => {
    const lamp = 'The lamp glows at night';
    for (const [source, expected] of [
      ['A good answer: The lamp glows at night.', lamp],
      ['Answer : The lamp glows at night.', lamp],
      ['They could write: The lamp glows at night.', lamp],
      ['Example sentence: The lamp glows at night.', lamp],
      ['Model sentence: The lamp glows at night.', lamp],
      ['Possible sentence: The lamp glows at night.', lamp],
      ['Model paragraph: The lamp glows at night.', lamp],
      ['Answer key: The lamp glows at night.', lamp],
      ['Such as: The lamp glows at night.', lamp],
      ['Example — The lamp glows at night.', lamp],
      ['A strong sentence - The lamp glows at night.', lamp],
      ['Sample response:\nThe lamp glows at night.', lamp],
      ['For example, The lamp glows at night.', lamp],
      ['e.g. The lamp glows at night.', lamp],
      ['A good answer: Mr. Lee’s lamp glows at night.', 'Mr. Lee’s lamp glows at night'],
      [
        'Examples: The lamp glows at night; the stars glow too.',
        'The lamp glows at night; the stars glow too',
      ],
    ] as const) {
      expect(exampleWordingSpans(source), source).toEqual([expected]);
    }
  });

  it('leaves what a grown-up is told to look for, and a plain list of words', () => {
    expect(exampleWordingSpans('Look for: a capital letter.')).toEqual([]);
    expect(exampleWordingSpans('Uses transition words such as first, next and last.')).toEqual([]);
    expect(exampleWordingSpans('Any reason is fine.')).toEqual([]);
  });

  // Round-4 check (R3-RL-5): common model formats were missed, and "sentence", a dash after "Answers
  // will vary" and "e.g." before a list of parts made descriptions of what to accept look like
  // examples, so wiring the helper would have dropped rows the child should see.
  it('finds numbered, bracketed, arrow and "example is" cues', () => {
    const lamp = 'The lamp glows at night';
    for (const [source, expected] of [
      ['Example 1: The lamp glows at night.', lamp],
      ['Sample answer #1: The lamp glows at night.', lamp],
      ['An example would be the lamp glows at night.', 'the lamp glows at night'],
      ['A good example is the lamp glows at night.', 'the lamp glows at night'],
      ['Model answer (for the parent): The lamp glows at night.', lamp],
      ['Ideal response → The lamp glows at night.', lamp],
      ['Ex: The lamp glows at night.', lamp],
      ['One possibility: The lamp glows at night.', lamp],
      ['Something like: The lamp glows at night.', lamp],
      ['eg the lamp glows at night.', 'the lamp glows at night'],
      ['Answers will vary, e.g. the lamp glows at night.', 'the lamp glows at night'],
      [
        'Any sentence with glow works, for example the lamp glows at night.',
        'the lamp glows at night',
      ],
      ['Example: The lamp is 3.5 feet tall.', 'The lamp is 3.5 feet tall'],
      [
        'Example sentence: The lamp glows at 9 p.m. every night.',
        'The lamp glows at 9 p.m. every night',
      ],
    ] as const) {
      expect(exampleWordingSpans(source), source).toEqual([expected]);
    }
  });

  it('leaves a description of what to accept', () => {
    for (const source of [
      'Topic sentence: states an opinion. Closing sentence: restates the opinion.',
      'First sentence - starts with a capital letter and uses glow.',
      'Answers will vary - look for a capital letter, the word glow and a period.',
      'Answers will vary — any complete sentence that uses glow correctly.',
      'Check for sentence parts, e.g. a subject and a verb.',
      'The sentence - uses the word glow correctly.',
      'Response should include: a capital letter and end punctuation.',
      'Writes: a complete sentence.',
      'Writes: correct end punctuation.',
      'A good sentence: has a capital letter and a period.',
      'An example would be a sentence that uses glow as a verb.',
      'The example is correct.',
    ]) {
      expect(exampleWordingSpans(source), source).toEqual([]);
    }
  });

  it('a row that copies a found span is dropped by the answer guard', () => {
    const spans = exampleWordingSpans('Example sentence: The lamp glows at night.');
    const leaks: string[] = [];
    const rows = childRubricFeedback(
      [
        { criterion: 'Writes the lamp glows at night', met: false, note: '' },
        { criterion: 'Uses the word glow', met: true, note: '' },
      ],
      {
        protectedAnswers: spans.map((value) => ({ kind: 'text' as const, value })),
        onLeak: (code) => leaks.push(code),
      },
    );
    expect(rows).toEqual([
      { kind: 'encouragement', body: 'You did this well: Uses the word glow.' },
    ]);
    expect(leaks).toEqual(['ANSWER_LEAK']);
  });
});

describe('childRubricFeedback', () => {
  it('puts the next steps first, then praise, in fixed wording, never the notes', () => {
    const rows = childRubricFeedback([
      { criterion: 'Uses complete sentences', met: true, note: 'Great subject and verb.' },
      { criterion: 'Gives a reason', met: false, note: 'Try: "because they are loyal".' },
    ]);
    expect(rows).toEqual([
      { kind: 'method_step', body: 'Next time, work on: Gives a reason.' },
      { kind: 'encouragement', body: 'You did this well: Uses complete sentences.' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/loyal|Great subject/);
  });

  it('shows each label once and at most the row cap', () => {
    const rubric = [
      { criterion: 'Uses details', met: false, note: '' },
      { criterion: 'uses details', met: true, note: '' },
      ...['Spelling', 'Capital letters', 'Punctuation', 'Paragraphs', 'Word choice'].map(
        (criterion) => ({ criterion, met: false, note: '' }),
      ),
    ];
    const rows = childRubricFeedback(rubric);
    expect(rows).toHaveLength(MAX_RUBRIC_FEEDBACK_ROWS);
    expect(rows.filter((r) => /uses details/i.test(r.body))).toHaveLength(1);
  });

  it('screens a label for safety before its shape is judged, so a severe label is always reported', () => {
    const codes: string[] = [];
    const rows = childRubricFeedback(
      [
        { criterion: 'Keep this a secret from your parents', met: false, note: 'x' },
        { criterion: 'Uses capital letters', met: true, note: 'x' },
      ],
      {
        context: { prompt: 'Write three sentences about a season.', subject: 'grammar_writing' },
        onSafetyReject: (code) => codes.push(code),
      },
    );
    expect(rows).toEqual([
      { kind: 'encouragement', body: 'You did this well: Uses capital letters.' },
    ]);
    expect(codes).toEqual(['SAFETY_SECRECY']);
  });

  it('yields no rows for malformed or empty rubrics', () => {
    expect(childRubricFeedback(null)).toEqual([]);
    expect(childRubricFeedback('Uses details')).toEqual([]);
    expect(childRubricFeedback([])).toEqual([]);
    expect(childRubricFeedback([null, 3, { criterion: 'Uses details' }])).toEqual([]);
    expect(childRubricFeedback([{ criterion: 'Uses details', met: 'yes' }])).toEqual([]);
  });
});

describe('answer protection for rubric rows (final lead review LJA-F1)', () => {
  it('drops a row that states a protected form and keeps the rest', () => {
    // Both labels are criterion-shaped (round 2 drops a sentence with an auxiliary before the guard),
    // so the guard is what drops them.
    const rubric = [
      { criterion: 'Uses mice as the plural of mouse', met: false, note: '' },
      { criterion: 'Uses the plural form', met: false, note: '' },
      { criterion: 'Writes the sun shines brightly today', met: false, note: '' },
      { criterion: 'Uses a capital letter', met: true, note: '' },
    ];
    const leaks: string[] = [];
    const rows = childRubricFeedback(rubric, {
      protectedAnswers: [
        { kind: 'text', value: 'mice' },
        { kind: 'text', value: 'The sun shines brightly today.' },
      ],
      onLeak: (code) => leaks.push(code),
    });
    expect(rows).toEqual([
      { kind: 'method_step', body: 'Next time, work on: Uses the plural form.' },
      { kind: 'encouragement', body: 'You did this well: Uses a capital letter.' },
    ]);
    expect(leaks).toEqual(['ANSWER_LEAK', 'ANSWER_LEAK']);
  });

  it('reads expressions as their value: a label may not state a numeric key as a computation', () => {
    const rows = childRubricFeedback(
      [{ criterion: 'Shows six times seven as the total', met: false, note: '' }],
      { protectedAnswers: [{ kind: 'numeric', value: '42' }] },
    );
    expect(rows).toEqual([]);
  });

  it('with nothing to protect, plain labels still pass', () => {
    expect(
      childRubricFeedback([{ criterion: 'Uses complete sentences', met: true, note: '' }], {
        protectedAnswers: [],
      }),
    ).toEqual([{ kind: 'encouragement', body: 'You did this well: Uses complete sentences.' }]);
  });
});
