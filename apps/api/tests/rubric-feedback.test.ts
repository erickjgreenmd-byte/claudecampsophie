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

  // Round-5 check (R4-RL-G): these round-4 rules survived a mutation because every tested case was
  // also caught by another rule, or used "with".
  it('pins the preposition rule for every preposition and clause word, and the two-word opener skip', () => {
    for (const raw of [
      // A clause word straight after a preposition, where it is also the last word or in an idiom.
      'Writes about why',
      'Stops at when needed',
      // A subordinator that is not a clause word, after a preposition other than "with".
      'Writes about before the storm',
      'Ends on after the storm',
      'Ends in once upon a time',
      // An opener that is not a clause word, behind two lead words.
      'Maybe just after the storm',
      'Not just once upon a time',
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
  });

  // Round-5 check (R4-RL-E, R4-RL-F; lead decision: fail closed): a sentence joined by "/", ",",
  // ";", "+", "·", "|", "~" or "*", or written in CamelCase, was read as one word; the instruction
  // check skipped one lead word only and not "Now" or "First"; and a name in "-ly" ("Sally") was read
  // as a lead adverb, so the sentence after it was judged as a criterion.
  it('reads other joiners and CamelCase as word breaks, skips lead words before an instruction, and reads a capitalised "-ly" word as a name', () => {
    for (const raw of [
      'It/was/raining',
      'The/dog/was/scared',
      'Because/of/the/thunder',
      'Tells why/he was scared',
      'It,was,raining',
      'It;was;raining',
      'It+was+raining',
      'It·was·raining',
      'It|was|raining',
      'It~was~raining',
      'It*was*raining',
      'ItWasRaining',
      'WritesTheLampIsBright',
      'Just neatly write the lamp glows',
      'Maybe just write the lamp glows',
      'Now write the lamp glows',
      'First, write the lamp glows',
      'Next write the lamp glows',
      'Then write the lamp glows',
      'Sally explains why she was sad',
      'Emily tells how she hid',
      'Billy explains why he ran home',
      'Molly describes where she was hiding',
      'Kelly shows how the dog hid',
      'Sally explains why the dog was scared',
      // The fail-closed cost: a criterion that opens with a capitalised "-ly" adverb is judged as a
      // noun phrase, so it may hold no clause and at most six words.
      'Clearly explains why the plant grew',
      'Neatly labels each part of the diagram',
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
    for (const label of [
      'Uses he/she correctly',
      'Uses and/or correctly',
      'Tells who/what happened',
      'Clearly explains the reason',
      'Uses a capital A at the start',
    ]) {
      expect(childCriterionLabel(label), label).toBe(label);
    }
  });

  // Round-5 recheck (R5-RL-CHK-B, R5-RL-CHK-C; lead decision: fail closed): reading a capitalised
  // "-ly" word as a name moved "Carefully writes after the loud thunder" from the lead-verb rules
  // to the noun-phrase rules, which have no check for a subordinator or "that" after the verb; and
  // splitting joined words let through completions that only their joined reading dropped
  // ("TellsWhy it was scary" reads as the idiom "Tells why it was scary"). A label is now dropped
  // when either reading drops it.
  it('drops a label that either reading of a capitalised "-ly" word or of joined words drops', () => {
    for (const raw of [
      // A capitalised "-ly" word read both as a lead adverb and as a name.
      'Carefully writes after the loud thunder',
      'Clearly writes before the storm hit',
      'Neatly writes once upon a time',
      'Clearly writes that is bright',
      'Correctly finishes after the long storm',
      'Quickly writes cause it rained',
      'Clearly shows that is correct',
      'Sally writes after the storm',
      'Holly writes before the bell',
      // Joined words read both joined and split.
      'TellsWhy it was scary',
      'TellsWhy + he was scared',
      'VeryCarefully write the lamp glows',
      'Completes it withScared of thunder',
      'ExplainsWhy she was sad',
      'DescribesWhere she was hiding',
      'Tells how/why he ran home',
      'Writes The catSleeps All Day',
      'Explains who/why she was sad',
    ]) {
      expect(childCriterionLabel(raw), raw).toBeNull();
    }
    for (const label of [
      'Clearly explains the reason',
      'Carefully writes the date',
      // Only a capitalised "-ly" word is read both ways, not any capitalised first word.
      'Graph shows before and after',
      'Uses he/she correctly',
      'Uses and/or correctly',
      'Tells who/what happened',
      'Compares x/y ratios',
    ]) {
      expect(childCriterionLabel(label), label).toBe(label);
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
      // "Clearly explains why the plant grew" is dropped since round 5: a capitalised "-ly" word
      // is read as a name (R4-RL-F), the fail-closed cost; the adverb after the verb is kept.
      'Explains clearly why the plant grew',
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
      'The sentence - uses the word glow correctly.',
      'Response should include: a capital letter and end punctuation.',
      'Writes: a complete sentence.',
      'Writes: correct end punctuation.',
      'An example would be a sentence that uses glow as a verb.',
      'The example is correct.',
    ]) {
      expect(exampleWordingSpans(source), source).toEqual([]);
    }
  });

  // Round-5 check (R4-RL-A, R4-RL-B; lead decision: fail closed): a lower-case criterion verb after
  // the cue, "include"/"contain" after the label word, and a word in "-s" before "e.g." each made
  // the wording count as a description, so a sample completion reached the child word for word.
  it('protects a sample completion that starts with a lower-case verb, "Examples include:" and any wording after "e.g."', () => {
    for (const [source, expected] of [
      ['Sample answer: stays inside and sleeps.', 'stays inside and sleeps'],
      ['Example: finds a bone in the yard.', 'finds a bone in the yard'],
      ['Possible answer: hides under the bed.', 'hides under the bed'],
      ['Example answer: goes to the park.', 'goes to the park'],
      ['A good answer: makes a big mess.', 'makes a big mess'],
      ['Sample response - keeps barking at the door.', 'keeps barking at the door'],
      ['Example 1: opens the door and runs outside.', 'opens the door and runs outside'],
      ['Example: looks for his ball.', 'looks for his ball'],
      ['For example, reads a book by the fire.', 'reads a book by the fire'],
      ['e.g. builds a fort with blankets.', 'builds a fort with blankets'],
      ['Examples include: builds a fort with blankets.', 'builds a fort with blankets'],
      ['Example: Stays inside and sleeps.', 'Stays inside and sleeps'],
      ['Examples include: The lamp glows at night.', 'The lamp glows at night'],
      ['Example includes: The lamp glows at night.', 'The lamp glows at night'],
      ['Examples contain: The lamp glows at night.', 'The lamp glows at night'],
      ['Example answers include: The lamp glows at night.', 'The lamp glows at night'],
      ['Sample answers include - the lamp glows at night.', 'the lamp glows at night'],
      ['Accept complete sentences, e.g. the lamp glows at night.', 'the lamp glows at night'],
      ['Accept any answers, e.g. the lamp glows at night.', 'the lamp glows at night'],
      ['Look for sentences like this, e.g. the lamp glows at night.', 'the lamp glows at night'],
      [
        'Students may write different things, e.g. the lamp glows at night.',
        'the lamp glows at night',
      ],
      ['Answers vary by students e.g. the lamp glows at night.', 'the lamp glows at night'],
      // The fail-closed cost: a description in these forms is protected too, and a row that copies
      // it is dropped (round 4 left these two out).
      ['A good sentence: has a capital letter and a period.', 'has a capital letter and a period'],
      ['Check for sentence parts, e.g. a subject and a verb.', 'a subject and a verb'],
    ] as const) {
      expect(exampleWordingSpans(source), source).toEqual([expected]);
    }
    const spans = exampleWordingSpans('Sample answer: stays inside and sleeps.');
    const leaks: string[] = [];
    const rows = childRubricFeedback(
      [
        { criterion: 'Stays inside and sleeps', met: false, note: '' },
        { criterion: 'Uses a capital letter', met: true, note: '' },
      ],
      {
        protectedAnswers: spans.map((value) => ({ kind: 'text' as const, value })),
        onLeak: (code) => leaks.push(code),
      },
    );
    expect(rows).toEqual([
      { kind: 'encouragement', body: 'You did this well: Uses a capital letter.' },
    ]);
    expect(leaks).toEqual(['ANSWER_LEAK']);
  });

  // Round-5 check (R4-RL-D): "answer", "response" or "sentence" with "is"/"would be", and a closing
  // bracket, "Ex.", an arrow, "=" or a hyphen with no space after it were not cues.
  it('finds "A good answer is", "The answer could be", "Example 1)", "Ex." and arrow or "=" marks', () => {
    for (const [source, expected] of [
      ['A good answer is the lamp glows at night.', 'the lamp glows at night'],
      ['A good answer would be the lamp glows at night.', 'the lamp glows at night'],
      ['A sample answer is the lamp glows at night.', 'the lamp glows at night'],
      ['One possible answer is the lamp glows at night.', 'the lamp glows at night'],
      ['A possible sentence is the lamp glows at night.', 'the lamp glows at night'],
      ['A strong sentence would be the lamp glows at night.', 'the lamp glows at night'],
      ['The answer could be the lamp glows at night.', 'the lamp glows at night'],
      ['A model response is the lamp glows at night.', 'the lamp glows at night'],
      ['Example 1) The lamp glows at night.', 'The lamp glows at night'],
      ['Ex. The lamp glows at night.', 'The lamp glows at night'],
      ['Example 1 -The lamp glows at night.', 'The lamp glows at night'],
      ['Example 1 => The lamp glows at night.', 'The lamp glows at night'],
      ['Example 1 -> The lamp glows at night.', 'The lamp glows at night'],
      ['Example 1 = The lamp glows at night.', 'The lamp glows at night'],
      ['They might say = the lamp glows at night.', 'the lamp glows at night'],
    ] as const) {
      expect(exampleWordingSpans(source), source).toEqual([expected]);
    }
    // A hyphen inside a word is no mark; fewer than three words after "is" are no example.
    expect(exampleWordingSpans('Example-based questions help.')).toEqual([]);
    expect(exampleWordingSpans('The answer is correct.')).toEqual([]);
  });

  // Round-5 recheck (R5-RL-CHK-A): the wider copula cue ("A good answer is ...", "Answers are
  // ...") and the new marks ("=", ")", "->", "ex.") matched earlier in a sentence, and matches did
  // not overlap, so the example that "an example is ..." gave was swallowed into a longer span that
  // was dropped as a description or kept its lead-in; a label copying the example was shown. Every
  // cue is now searched at every start, so an earlier match hides no later one.
  it('finds an example after an earlier cue in the same sentence', () => {
    const example = 'the lamp glows at night';
    const sources: string[] = [
      `A good answer is a sentence that uses glow; an example is ${example}.`,
      `Any sentence is fine if it uses glow; an example would be ${example}.`,
      `The answer is open-ended; a good example is ${example}.`,
      `Answers are varied - an example is ${example}.`,
      `A good answer is one that uses glow; an example is: ${example}.`,
      `Example 1) Sample answer - ${example}.`,
      `Answer = Model answer -> ${example}.`,
      `Example 1) Model answer → ${example}.`,
      `Answers = varied; example → ${example}.`,
      `Accept any sentence (ex. one that uses glow as a verb, e.g. ${example}).`,
      `A good sentence = a sentence using glow; possible sentence - ${example}.`,
    ];
    // The round-5 checker's grid: a lead-in holding the wider copula cue, a joiner, an older cue.
    for (const leadIn of [
      'The answer is open-ended',
      'Answers are varied',
      'A good answer is a sentence that uses glow',
      'Any sentence is fine',
      'The sentence is up to the student',
      'Each response is different',
      'Responses may be different',
      'Answers can be short',
      'A correct response is any sentence with glow as a verb',
      'The best answer would be a full sentence',
    ]) {
      for (const joiner of ['; ', ', and ', ', but ', ' - ', ', so ']) {
        for (const cue of [
          'an example is',
          'a good example is',
          'one example would be',
          'an example might be',
        ]) {
          sources.push(`${leadIn}${joiner}${cue} ${example}.`);
        }
      }
    }
    for (const source of sources) {
      const spans = exampleWordingSpans(source);
      expect(spans, source).toContain(example);
      const leaks: string[] = [];
      const rows = childRubricFeedback(
        [{ criterion: 'Writes the lamp glows at night', met: false, note: '' }],
        {
          protectedAnswers: spans.map((value) => ({ kind: 'text' as const, value })),
          onLeak: (code) => leaks.push(code),
        },
      );
      expect(rows, source).toEqual([]);
      expect(leaks, source).toEqual(['ANSWER_LEAK']);
    }
    expect(
      exampleWordingSpans(
        'Finish the sentence: When it rains, my dog ... A good answer is one that makes sense; an example is stays inside and sleeps.',
      ),
    ).toContain('stays inside and sleeps');
  });

  // Round-5 check (R4-RL-C): the "write"/"say" cue's lookbehind rescanned a run of spaces at every
  // position, so a long run in a rubric note took seconds.
  it('finds a cue in linear time on a long run of spaces', () => {
    for (const gap of [' ', '\t']) {
      const note = `a${gap.repeat(64_000)}b could write: the lamp glows at night.`;
      const started = performance.now();
      expect(exampleWordingSpans(note)).toEqual(['the lamp glows at night']);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });

  // Round-5 recheck (R5F-RL-1): the bounded lookbehind ({1,20}) no longer found a cue after more
  // than 20 blanks, which HEAD found; the cue must work at any gap and stay linear.
  it('finds a "write"/"say" cue after any number of blanks, in linear time', () => {
    for (const gap of [' ', '\t']) {
      for (const n of [1, 21, 500, 64_000]) {
        const note = `Students could${gap.repeat(n)}write: the lamp glows at night.`;
        const started = performance.now();
        expect(exampleWordingSpans(note)).toContain('the lamp glows at night');
        expect(performance.now() - started).toBeLessThan(200);
      }
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

  // Round-5 check (R4-RL-OOA; lead decision: recall first): "Next time, work on: <label>." asks the
  // child to do what a third-person label names, but the screen read only the third person, so a
  // label about self-harm, abuse, secrecy, strangers or personal contact reached the child.
  const GLOW = { prompt: 'Write a sentence using the word glow.', subject: 'grammar_writing' };
  const screened = (criterion: string, context: object = GLOW) => {
    const codes: string[] = [];
    const rows = childRubricFeedback([{ criterion, met: false, note: '' }], {
      context,
      onSafetyReject: (code) => codes.push(code),
    });
    return { rows, codes };
  };

  it('drops a label about self-harm, abuse, secrecy, strangers or personal contact, with a code', () => {
    for (const criterion of [
      // The round-4 checker's labels, all shown to the child before this fix.
      'Wants to hurt himself',
      'Hurts himself',
      'Talks about hurting himself',
      'Cuts himself',
      'Mentions cutting',
      'Keeps it a secret from parents',
      'Keeps secrets from mom',
      'Keeps this a secret',
      'Hides it from parents',
      'Does not tell parents',
      "Doesn't tell a grown-up",
      'Mentions being hit at home',
      'Gets hit at home',
      'Writes about being touched',
      'Meets strangers online',
      'Shares a home address',
      'Sends photos to strangers',
      'Chats with strangers online',
      'Describes abuse at home',
      // The checker's labels that were already dropped, now each with a code.
      'Mentions wanting to die',
      'Wants to die',
      'Keeps it between us',
      'Is hit by dad',
      'Writes about suicide',
      'Mentions self harm',
    ]) {
      const { rows, codes } = screened(criterion);
      expect(rows, criterion).toEqual([]);
      expect(codes, criterion).toHaveLength(1);
      expect(codes[0], criterion).toMatch(/^SAFETY_[A-Z_]+$/);
    }
  });

  it('screens the imperative and first-person readings of a label', () => {
    for (const [criterion, code] of [
      // The imperative: the lead verb in its base form, "yourself", "Don't", after lead words.
      ['Hurts himself', 'SAFETY_SELF_HARM'],
      ['Starves himself', 'SAFETY_SELF_HARM'],
      ['Does not tell parents', 'SAFETY_SECRECY'],
      ["Doesn't tell a grown-up", 'SAFETY_SECRECY'],
      ['Never tells parents', 'SAFETY_SECRECY'],
      ['Sends a selfie to a new friend', 'SAFETY_PERSONAL_CONTACT'],
      // The first person: "I" and the verb ("I am hit by dad", "I want to disappear forever").
      ['Is hit by dad', 'SAFETY_ABUSE'],
      ['Wants to disappear forever', 'SAFETY_SELF_HARM'],
    ] as const) {
      expect(screened(criterion), criterion).toEqual({ rows: [], codes: [code] });
    }
  });

  it('drops a label holding a risk topic word, even where the prompt raises the topic', () => {
    const war = {
      prompt:
        'Read the story about the war. Why did the old soldier die? Who was killed, what weapons were used, and why was the dead horse left behind? Was it a suicide mission?',
      subject: 'reading',
    };
    for (const [criterion, context] of [
      ['Talks about hurting animals', GLOW],
      ['Mentions cutting', GLOW],
      // The criterion is screened as written, so a mark after the word counts as its end.
      ['Mentions cutting.', GLOW],
      ['Talks about cutting, a lot', GLOW],
      ['Cuts his arm', GLOW],
      ['Mentions killing', war],
      ['Explains why the soldier died', war],
      ['Mentions the dead horse', war],
      ['Explains the suicide mission', war],
      ['Mentions a secret', GLOW],
      ['Hides it from parents', GLOW],
      ['Talks to strangers', GLOW],
      ['Shares an address', GLOW],
      ['Shares photos of friends', GLOW],
      ['Mentions being touched', GLOW],
      ['Mentions being hit at home', GLOW],
      ['Mentions being hit hard at home', GLOW],
      ['Mentions a bruise', GLOW],
      ['Describes abuse at home', GLOW],
      ['Names the weapons used', war],
      ['Uses online chat', GLOW],
    ] as const) {
      expect(screened(criterion, context), criterion).toEqual({
        rows: [],
        codes: ['SAFETY_RISK_TOPIC'],
      });
    }
    // Words that only look alike stay shown.
    for (const criterion of [
      'Addresses the prompt',
      'Cuts the shape into halves',
      'Hits the target',
    ]) {
      expect(screened(criterion).rows, criterion).toHaveLength(1);
    }
  });

  // The round-4 fixer's note: the plain-text check ran first, so a severe first-person, long or
  // quoted criterion was dropped without its code.
  it('screens the criterion as written, before the plain-text check, so its code is logged', () => {
    for (const [criterion, code] of [
      ['I want to hurt myself', 'SAFETY_SELF_HARM'],
      ['Keep this a secret from your parents: it is just between us', 'SAFETY_SECRECY'],
      [`Keep this a secret from your parents, ${'and write neatly '.repeat(8)}`, 'SAFETY_SECRECY'],
      ['Says "keep this a secret from your parents"', 'SAFETY_SECRECY'],
    ] as const) {
      expect(screened(criterion), criterion).toEqual({ rows: [], codes: [code] });
    }
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
