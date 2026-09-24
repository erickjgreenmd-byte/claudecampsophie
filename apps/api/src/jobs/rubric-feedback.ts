/**
 * Child-facing rubric feedback for written work (spec P6 "For writing tasks evaluate a rubric and
 * provide feedback"; AC_GRADING_03 "not a false binary grade or generated essay for the child to
 * copy").
 *
 * The grading model's rubric stays parent-only (private.question_solutions). The child gets only
 * the criterion labels, each wrapped in fixed wording: a met criterion is praise, an unmet one is
 * the next thing to work on. The model's free-text notes never reach the child, and a label is
 * used only when it is short plain text: at most 80 characters and 12 words on one line, with no
 * quotation marks, colon, first-person words (a sentence the child would write, not a criterion),
 * links or email addresses. It must also read as a criterion: a third-person verb first ("Uses
 * details") or a short noun phrase ("Capital letters"), with no clause of its own after that, so a
 * completed sentence ("The dog ran fast because it was scared") or an instruction with wording to
 * copy ("Write The lamp is bright at night") is not shown (isCriterionShaped). Anything else is
 * dropped, so a label can never carry an example sentence or paragraph to copy. When no label
 * passes, the child gets no rubric rows and the app asks them to go over the writing with a
 * grown-up.
 *
 * Answer protection (spec P6 "no complete spelling target, completed sentence, or essay response";
 * E4: a model instruction is not proof): the caller passes the protected forms of the private key
 * and of any example wording in the parent-only solution, and each row passes the answer-leak guard
 * against them, expressions read as their value. A row the guard blocks is dropped (LJA-F1).
 *
 * Moderation after generation (spec P4; AC_SECURITY_02): a label is model output, so each one also
 * passes the child-safety screen for model output, grounded in the writing prompt and subject. A
 * label that screens severe (companion persona, secrecy, contact, a sensitive topic the prompt did
 * not raise, ...) is dropped; the caller is told a code, never the label.
 */
import {
  guardChildContent,
  MAX_PROTECTED_ANSWERS,
  type ProtectedAnswer,
} from '@pencillift/domain/answer-guard';
import {
  screenModelOutput,
  type SafetyAgeBand,
  type ScreenContext,
} from '@pencillift/domain/safety';

export const MAX_RUBRIC_FEEDBACK_ROWS = 4;
const MAX_LABEL_CHARS = 80;
const MAX_LABEL_WORDS = 12;

export interface RubricFeedbackRow {
  readonly kind: 'encouragement' | 'method_step';
  readonly body: string;
}

/**
 * A criterion label a child may read, or null when it is not short plain text or does not read as
 * a criterion (a completed sentence or an instruction with wording to copy; see isCriterionShaped).
 */
export function childCriterionLabel(raw: unknown): string | null {
  const label = plainLabel(raw);
  return label !== null && isCriterionShaped(label) ? label : null;
}

/** The label as short plain text, or null (length, quotes, colon, first person, links, controls). */
function plainLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (/[\r\n]/.test(raw)) return null;
  const label = raw
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?;:,\s]+$/u, '');
  if (label.length < 3 || label.length > MAX_LABEL_CHARS) return null;
  if (label.split(' ').length > MAX_LABEL_WORDS) return null;
  // Quotation marks introduce example wording; links and emails are never child content.
  if (/["“”„«»‹›「」『』]|[‘’'](?=\s|$)|(?:^|\s)[‘'’]/u.test(label)) return null;
  if (/https?:|www\.|@|\/\//iu.test(label)) return null;
  // A colon introduces example wording ("Start with: The water cycle has four stages").
  if (/[:：]/u.test(label)) return null;
  // First person is the child's own sentence, not a criterion ("I stayed inside because ...").
  if (/(?<![\p{L}\p{N}])(?:i|me|my|mine|myself|we|us|our|ours)(?![\p{L}\p{N}])/iu.test(label))
    return null;
  // Control and format characters could hide text (bidi overrides, zero-width joiners).
  if (/[\p{Cc}\p{Cf}]/u.test(label)) return null;
  return label;
}

// ---- criterion shape (round-2 check CHK-LJA-F1-residual; round-3 checks R2-LJA-F1-*) ---------

/** A set of lower-case words written as one space-separated list. */
function wordSet(list: string): ReadonlySet<string> {
  return new Set(list.trim().split(/\s+/u));
}

/** Verbs a criterion may start with, in the base form; the label uses the third person ("Uses"). */
const CRITERION_VERBS: readonly string[] = [
  ...wordSet(`
    add address agree analyse analyze answer apply argue arrange ask attempt avoid begin blend
    break build calculate capitalise capitalize check choose circle cite clarify close combine
    compare complete conclude connect consider contain contrast convert copy correct count create
    decide define demonstrate describe determine develop discuss distinguish draft draw edit
    elaborate emphasise emphasize end engage estimate evaluate expand explain explore express
    figure fill find finish fix focus follow form give go group hear highlight hook identify
    illustrate include indent infer interpret introduce justify keep know label lead leave link
    list look maintain make mark match measure mention model move name note notice offer open
    order organise organize overuse pace paraphrase
    persuade pick place plan predict present proofread prove provide punctuate put quote read
    recall recognise recognize record recount reference reflect relate remain remember repeat
    reread report represent respond restate retell revise rhyme round segment select separate
    sequence share show sign simplify solve sort sound space spell start state stay stick stretch
    structure summarise summarize support take tell transition try underline understand use vary
    work wrap write
  `),
];

/** Lead verbs that may name words as words ("Uses he and she correctly", "Spells was and were"). */
const NAMING_VERBS: ReadonlySet<string> = new Set(
  ['avoid', 'capitalise', 'capitalize', 'include', 'overuse', 'repeat', 'spell', 'use'].flatMap(
    (verb) => [verb, thirdPerson(verb)],
  ),
);

function thirdPerson(verb: string): string {
  if (/(?:s|sh|ch|x|z|o)$/.test(verb)) return `${verb}es`;
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
}

const THIRD_PERSON_VERBS: ReadonlySet<string> = new Set([
  'has',
  ...CRITERION_VERBS.map(thirdPerson),
]);

/** Adverbs a criterion may put before its verb ("Clearly explains", "Never uses"). */
const LEAD_ADVERBS: ReadonlySet<string> = wordSet(`
  also always mostly never often only sometimes still usually
`);

/**
 * A lead adverb or any word in "-ly" ("Clearly", "Probably"): every rule that allows a lead
 * adverb allows any "-ly" word too (round-4 check R3-RL-1).
 */
function isAdverb(word: string | undefined): boolean {
  return word !== undefined && (LEAD_ADVERBS.has(word) || /^\p{L}{3,}ly$/u.test(word));
}

/**
 * Words that may stand before an opener or an instruction as well ("Even though", "Maybe when",
 * "Not because", "Just write").
 */
const LEAD_WORDS: ReadonlySet<string> = wordSet('all even ever just maybe not perhaps right');

function isLeadWord(word: string | undefined): boolean {
  return isAdverb(word) || (word !== undefined && LEAD_WORDS.has(word));
}

/** Instruction verbs: "Write ...", "Add ..." is a task for the child, not a criterion ("Use of" is). */
const INSTRUCTION_VERBS: ReadonlySet<string> = wordSet(`
  add ask avoid be begin change check choose copy describe do don't draw explain fill find finish
  fix get give go include keep let look make pick please put read remember replace rewrite say see
  show spell start take tell think try underline use write
`);

/**
 * Finite verbs and contractions that make a clause ("is", "was", "has", "can", "don't", ...), and
 * irregular simple past forms that are rarely anything else in a criterion ("ran", "went").
 */
const FINITE_VERBS: ReadonlySet<string> = wordSet(`
  am are is was were has have had do does did will would can could shall should may might must
  cannot ain't isn't aren't wasn't weren't hasn't haven't hadn't don't doesn't didn't won't
  wouldn't can't couldn't shouldn't mustn't it's he's she's that's there's here's what's who's
  let's you're they're you've they've he'd she'd they'd you'd it'd you'll he'll she'll they'll
  it'll
  arose ate awoke became began bit blew bought broke brought came caught chose clung crept drank
  drew drove dug fed fell fled flew flung forbade forgave forgot fought froze gave got grew heard
  held hid knelt knew leapt led made meant met paid ran rang rode said sang sank sat saw shone shook
  shrank slept slid sought spent spoke sprang spun stole stood strode struck stung swam swept swore
  swung taught threw told took tore went wept woke won wore wrote
`);

/** Subject pronouns (first person is refused earlier): a clause, not a criterion. */
const SUBJECT_PRONOUNS: ReadonlySet<string> = wordSet(`
  he she they you someone somebody everyone everybody anyone anybody nobody
`);

/** Words that open an embedded question ("explains why the character is sad"). */
const EMBEDDING_WORDS: ReadonlySet<string> = wordSet(`
  how if what whatever when whenever where whether which who whom whose why
`);

/** Relative pronouns whose own verb may follow ("a verb that is in the past tense"). */
const RELATIVE_PRONOUNS: ReadonlySet<string> = wordSet('that which who');

/** Words that start a new clause, ending an embedded question ("... because it was scared"). */
const CLAUSE_JOINS: ReadonlySet<string> = wordSet(`
  although and because but or since so then though unless until whereas while
`);

/**
 * Words that open a clause or a completion, never a noun-phrase criterion ("When he was scared",
 * "Because of the loud thunder", "That was a scary storm", "Once upon a time there lived"; round-3
 * check R2-LJA-F1-subordinate-and-that-bypass).
 */
const CLAUSE_OPENERS: ReadonlySet<string> = new Set([
  ...EMBEDDING_WORDS,
  ...RELATIVE_PRONOUNS,
  ...CLAUSE_JOINS,
  ...wordSet(`
    after as before cause cuz here however lest like once such there till to whereas wherever
    whichever whilst whoever
  `),
]);

/**
 * Words that open a clause wherever they stand (round-4 check R3-RL-1): a label holding one is
 * dropped unless the word is named as a word or sits in a fixed criterion idiom (strayClauseWord).
 */
const CLAUSE_WORDS: ReadonlySet<string> = wordSet(`
  although because cuz how however if lest since so that though till unless until what whatever
  when whenever where whereas wherever whether which whichever while whilst who whoever whom whose
  why
`);

/**
 * Verbs a criterion uses to ask for an embedded question ("Explains why", "Tells who", "Checks
 * if", "Finds out what"), in the base and the third-person form. "Writes", "Says", "Ends with",
 * "Uses" and the like are not among them: what follows them is wording, not a question.
 */
const QUESTION_VERBS: ReadonlySet<string> = new Set(
  [
    ...wordSet(`
      ask check choose compare consider contrast count decide demonstrate describe determine
      discuss estimate evaluate explain explore figure find identify illustrate infer justify know
      measure notice predict recall recognise recognize record remember retell show state
      summarise summarize tell understand
    `),
  ].flatMap((verb) => [verb, thirdPerson(verb)]),
);

/** Words that open an embedded question after a question verb. */
const QUESTION_WORDS: ReadonlySet<string> = wordSet(
  'how if what when where whether which who whom whose why',
);

/** Present-tense verbs a relative clause in a criterion may start with ("a verb that is ..."). */
const PRESENT_FINITE: ReadonlySet<string> = wordSet(
  "are aren't do does doesn't don't has hasn't have haven't is isn't",
);

/** Words that end the fixed idioms "if needed", "when necessary", "where possible". */
const AS_NEEDED: ReadonlySet<string> = wordSet(
  'applicable appropriate asked necessary needed possible required',
);

/** Words in "-ing" that are nouns, not a gerund after "when" or "while" ("when spring came"). */
const ING_NOUNS: ReadonlySet<string> = wordSet(`
  anything ceiling during evening everything king morning nothing ring something spring string
  thing wing
`);

/**
 * Prepositions: a subordinator or clause word straight after one opens a completion, never a
 * criterion ("Ends with because of the thunder", "Writes about when the storm came").
 */
const PREPOSITIONS: ReadonlySet<string> = wordSet(`
  about above across against along among around at behind below beneath beside between beyond by
  down during for from in inside into near of off on onto outside over past through throughout to
  toward towards under underneath up upon with within without
`);

/** Nouns after which a word is named as a word ("the word because", "the conjunction so"). */
const NAMING_NOUNS: ReadonlySet<string> = wordSet('conjunction conjunctions term terms word words');

/** Nouns before which a clause word is named as a word ("a because clause", "why questions"). */
const NAMED_KINDS: ReadonlySet<string> = wordSet(`
  clause clauses question questions sentence sentences statement statements word words
`);

/**
 * Right after the lead verb these start an adverbial clause or phrase, a completion rather than a
 * criterion ("Writes because of the loud thunder"), unless a gerund follows ("Plans before
 * writing").
 */
const SUBORDINATORS: ReadonlySet<string> = wordSet(`
  after although because before cause cuz lest once since though till unless until whenever
  wherever whereas while
`);

/** Words that join words named as words ("he and she", "was or were"). */
const LIST_JOINS: ReadonlySet<string> = wordSet('and nor or');

/** Words after which a named word ends ("Uses can for ability", "Uses you to speak ..."). */
const NAMING_ENDS: ReadonlySet<string> = wordSet(`
  accurately appropriately as at consistently correctly for in instead properly to with
`);

/**
 * Prepositions whose object may be a word named as a word ("instead of said", "like was", "such as
 * because", "with because or so").
 */
const NAMING_PREPOSITIONS: ReadonlySet<string> = wordSet('as besides except like of than with');

/**
 * Words that start an object: after a past form in "-ed" they make it a verb ("scared the dog").
 * "this"/"these"/"those" are left out, since they also start a time ("words learned this week").
 */
const OBJECT_STARTS: ReadonlySet<string> = wordSet('a an her him his its the their them');

/**
 * Words a relative "that" cannot follow (it follows a noun: "a verb that is ..."): after them
 * "that" opens a clause of its own ("Explains clearly that was why ...").
 */
const NOT_BEFORE_RELATIVE: ReadonlySet<string> = new Set([
  ...CLAUSE_OPENERS,
  ...LEAD_ADVERBS,
  ...FINITE_VERBS,
  ...SUBJECT_PRONOUNS,
  ...wordSet(`
    a about an at by for from her his in into its not now of on over the their these this those
    through toward towards under upon with without
  `),
]);

/** Words before a capital letter that name the letter ("Uses a capital A at the start"). */
const LETTER_WORDS: ReadonlySet<string> = wordSet('big capital letter upper uppercase');

/**
 * Lead verbs that are also plural nouns a relative "that" may follow ("Transitions that connect").
 */
const PLURAL_NOUN_LEADS: ReadonlySet<string> = wordSet(`
  answers hooks labels links lists models quotes sounds transitions
`);

/**
 * Words after "that" that make it the start of a reported clause ("that the dog ...") or a singular
 * subject ("that was ..."), so not a relative pronoun after a plural noun; so does a word in "-s"
 * ("that plants need ...": a relative's verb after a plural takes no "-s").
 */
const NOT_AFTER_PLURAL_RELATIVE: ReadonlySet<string> = new Set([
  ...OBJECT_STARTS,
  ...SUBJECT_PRONOUNS,
  ...wordSet(`
    does doesn't has hasn't he's is isn't it it's she's that's there there's this these those
    was wasn't what's who's
  `),
]);

/** Words that open a sentence: capitalised after the first word they mark a sentence to copy. */
const SENTENCE_STARTS: ReadonlySet<string> = wordSet(`
  a after an because before he her his if it its my once one our she so some that the their then
  there these they this those we when you your
`);

/** Adverbs ending in "s" that do not make "it" a subject ("uses it sometimes"). */
const S_ADVERBS: ReadonlySet<string> = wordSet(`
  across afterwards always besides less perhaps plus sometimes thus towards unless
`);

const NOUN_PHRASE_MAX_WORDS = 6;

/** Determiners that start a noun phrase, or the subject of a sentence ("The dog jumped ..."). */
const DETERMINERS: ReadonlySet<string> = wordSet(`
  a an the this that these those his her their its
`);

/** Words that may stand before an adjective in "-ed" ("well organized", "clearly stated"). */
const DEGREE_WORDS: ReadonlySet<string> = wordSet(`
  least less more most not so too very well
`);

/**
 * A determiner-led phrase with a past form in "-ed" after its noun is a sentence ("The dog jumped
 * over the log"); right after the determiner, or after "well"/"-ly", it is an adjective ("The
 * finished story", "A clearly stated idea").
 */
function regularPastAfterNoun(list: readonly Word[]): boolean {
  if (!DETERMINERS.has(list[0]?.text ?? '')) return false;
  for (let i = 2; i < list.length; i++) {
    const before = list[i - 1]!.text;
    if (/^\p{L}{3,}ed$/u.test(list[i]!.text) && !DEGREE_WORDS.has(before) && !/ly$/u.test(before)) {
      return true;
    }
  }
  return false;
}

interface Word {
  readonly text: string; // lower case, accents removed, apostrophes as "'"
  readonly capitalised: boolean;
  readonly endsClause: boolean; // followed by a comma, a semicolon, a bracket, a dash or a full stop
}

/** The text without accents and other combining marks ("àre" reads as "are"). */
function withoutMarks(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Abbreviations whose full stop does not end a clause ("Dr. King", "St. Louis"). */
const ABBREVIATIONS: ReadonlySet<string> = wordSet('dr etc jr mr mrs ms mt mx prof sr st vs');

function words(label: string): Word[] {
  return (
    label
      // A bracket, a dash or an ellipsis ends a clause as a comma does ("Tells why (he was ...)",
      // "Tells why - the dog ...", "Tells why … he ..."; round-4 check R3-RL-1).
      .replace(/\s*(?:[()[\]{}—–…]|\.{2,})+\s*|\s+-+\s+/gu, ', ')
      // Words joined by a hyphen, an underscore or a dot are read one by one ("It-was-raining",
      // "That.was.scary"; round-4 check R3-RL-4).
      .replace(/(?<=\p{L})[-_‐‑.](?=\p{L})/gu, ' ')
      .split(' ')
      .map((raw) => {
        const core = raw.replace(/[’‘]/gu, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
        const text = withoutMarks(core).toLocaleLowerCase('en-US');
        const fullStop = /[.!?]$/u.test(raw) && !ABBREVIATIONS.has(text) && text.length > 1;
        return {
          text,
          capitalised: /^\p{Lu}/u.test(core),
          endsClause: fullStop || /[,;:]$/u.test(raw),
        };
      })
      .filter((w) => w.text.length > 0)
  );
}

/** A regular past form in "-ed" ("scared", "jumped"; not "need" or "speed"). */
function regularPast(word: string): boolean {
  return /^\p{L}{3,}ed$/u.test(word) && !/eed$/u.test(word);
}

/**
 * True when "that" at this index is a relative pronoun: it follows a noun ("a verb that is ...").
 * After a function word, an adverb, a comma or a criterion verb joined to the lead ("... and shows
 * that ..."), "that" opens a clause of its own (round-3 check
 * R2-LJA-F1-subordinate-and-that-bypass).
 */
function relativeThat(list: readonly Word[], i: number): boolean {
  const prev = list[i - 1];
  if (prev === undefined || prev.endsClause) return false;
  if (NOT_BEFORE_RELATIVE.has(prev.text) || /ly$/u.test(prev.text)) return false;
  const before = list[i - 2];
  const joinedVerb =
    THIRD_PERSON_VERBS.has(prev.text) &&
    before !== undefined &&
    (before.endsClause || LIST_JOINS.has(before.text) || before.text === 'then');
  return !joinedVerb;
}

/**
 * How many words at the start are named as words, not used ("he and she" in "Uses he and she
 * correctly", "their, there and they're"): single words joined by "and"/"or"/commas that end the
 * label or come before a word like "correctly", "for" or "to". 0 when the start is not such a list.
 */
function namedWords(list: readonly Word[]): number {
  let i = 0;
  while (i < list.length) {
    const next = list[i + 1];
    if (next === undefined) return i + 1;
    if (list[i]!.endsClause) {
      i += 1;
    } else if (LIST_JOINS.has(next.text)) {
      i += 2;
    } else {
      return NAMING_ENDS.has(next.text) ? i + 1 : 0;
    }
  }
  return 0;
}

/**
 * Which words are named as words, not used: a list (namedWords) after a naming lead verb ("Uses he
 * and she correctly"), after a naming preposition ("instead of said", "with because or so") or
 * after "word"/"conjunction" ("the word because"), and clause words before "clause", "question" or
 * "word" ("a because clause", "who, what and why questions").
 */
function namedMask(list: readonly Word[], lead: number | null): boolean[] {
  const named = list.map(() => false);
  const markList = (from: number) => {
    const count = namedWords(list.slice(from));
    for (let k = from; k < from + count; k++) named[k] = true;
  };
  if (lead !== null && NAMING_VERBS.has(list[lead - 1]!.text)) markList(lead);
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]!;
    if (!prev.endsClause && (NAMING_PREPOSITIONS.has(prev.text) || NAMING_NOUNS.has(prev.text))) {
      markList(i);
    }
    if (!NAMED_KINDS.has(list[i]!.text)) continue;
    let j = i - 1;
    while (
      j >= 0 &&
      CLAUSE_WORDS.has(list[j]!.text) &&
      (j === i - 1 || list[j]!.endsClause || LIST_JOINS.has(list[j + 1]!.text))
    ) {
      named[j] = true;
      j -= LIST_JOINS.has(list[j - 1]?.text ?? '') ? 2 : 1;
    }
  }
  return named;
}

/** True when "it" before this word is a subject ("it was", "it rained", "it feels"). */
function predicateFollows(next: string | undefined): boolean {
  if (next === undefined) return false;
  if (FINITE_VERBS.has(next)) return true;
  return /^\p{L}{3,}(?:ed|s)$/u.test(next) && !/(?:ss|us|is)$/u.test(next) && !S_ADVERBS.has(next);
}

/**
 * True when the words make a clause of their own: a finite verb, a past form in "-ed" with an
 * object ("scared the dog") or a subject, that is not inside an embedded question ("why the dog was
 * scared"; only when allowEmbedded), is not a relative clause's own verb ("a verb that is") and is
 * not a word named as a word ("instead of said").
 */
function makesClause(list: readonly Word[], allowEmbedded = true): boolean {
  const named = namedMask(list, null);
  let embedded = false;
  let relative = false;
  for (let i = 0; i < list.length; i++) {
    const w = list[i]!.text;
    // After a subordinator, a determiner-led phrase with a past in "-ed" after its noun is the
    // clause it opens ("... until the storm stopped"); inside an embedded question only a clause
    // join ends the question ("Explains what happened after the storm passed" is kept).
    const opensClause = SUBORDINATORS.has(w) && (!embedded || CLAUSE_JOINS.has(w));
    if (opensClause && regularPastAfterNoun(list.slice(i + 1))) return true;
    if (CLAUSE_JOINS.has(w)) {
      embedded = false;
      relative = false;
      continue;
    }
    if (EMBEDDING_WORDS.has(w) && allowEmbedded) embedded = true;
    if (RELATIVE_PRONOUNS.has(w)) {
      // "which" and "who" open an embedded question as well; "that" is relative only after a noun.
      relative = w !== 'that' || relativeThat(list, i);
    } else {
      if (!named[i]) {
        const subject =
          SUBJECT_PRONOUNS.has(w) || (w === 'it' && predicateFollows(list[i + 1]?.text));
        if (subject && !embedded) return true;
        const verb =
          FINITE_VERBS.has(w) || (regularPast(w) && OBJECT_STARTS.has(list[i + 1]?.text ?? ''));
        if (verb && !embedded && !relative) return true;
      }
      relative = false;
    }
    if (list[i]!.endsClause) embedded = false;
  }
  return false;
}

/**
 * True when the question word at this index opens an embedded question straight after a question
 * verb ("Explains why", "Clearly tells how", "Explains clearly why", "Finds out what"), alone or
 * in a list of question words ("Explains how and why", "Tells who, what and where"), or joined by
 * "and"/"or" to the object of a leading question verb ("Explains the problem and how it was
 * solved").
 */
function questionAfterVerb(list: readonly Word[], i: number, lead: number | null): boolean {
  let start = i;
  for (;;) {
    const before = list[start - 1];
    if (before === undefined) return false;
    if (LIST_JOINS.has(before.text) && QUESTION_WORDS.has(list[start - 2]?.text ?? '')) {
      start -= 2;
    } else if (before.endsClause && QUESTION_WORDS.has(before.text)) {
      start -= 1;
    } else {
      break;
    }
  }
  const verbAt = (at: number) => {
    const verb = list[at];
    return verb !== undefined && !verb.endsClause && QUESTION_VERBS.has(verb.text);
  };
  const before = list[start - 1]!;
  if (verbAt(start - 1)) return true;
  if (LIST_JOINS.has(before.text) && lead !== null && verbAt(lead - 1)) {
    const between = list.slice(lead, start - 1);
    return between.every((w) => !w.endsClause && !CLAUSE_WORDS.has(w.text));
  }
  return (
    !before.endsClause && (isAdverb(before.text) || before.text === 'out') && verbAt(start - 2)
  );
}

/**
 * True when the word at this index can begin a relative clause's verb in the present tense ("is",
 * "support", "states", "fits the story"). A past, a modal, a subject or a noun that a verb follows
 * ("was", "ran", "can", "he", "the dog", "plants need") is not one.
 */
function presentVerbAt(list: readonly Word[], k: number): boolean {
  const word = list[k]?.text;
  if (word === undefined) return false;
  if (PRESENT_FINITE.has(word) || THIRD_PERSON_VERBS.has(word)) return true;
  if (!/^\p{L}{2,}$/u.test(word) || /ing$/u.test(word) || isAdverb(word)) return false;
  if (FINITE_VERBS.has(word) || regularPast(word) || CLAUSE_WORDS.has(word)) return false;
  if (NOT_BEFORE_RELATIVE.has(word) || OBJECT_STARTS.has(word) || word === 'it') return false;
  if (!/[^su]s$/u.test(word)) return true;
  // A word in "-s" is a verb before an object, a preposition, an adverb or the end ("that fits the
  // story", "that grows in sand"), and a plural subject before its verb ("that plants need").
  const next = list[k + 1]?.text;
  return (
    next === undefined ||
    list[k]!.endsClause ||
    OBJECT_STARTS.has(next) ||
    DETERMINERS.has(next) ||
    PREPOSITIONS.has(next) ||
    isAdverb(next) ||
    /[^su]s$/u.test(next)
  );
}

/**
 * True when the clause word at this index sits in a fixed criterion idiom:
 * - an embedded question after a question verb (questionAfterVerb); "which" and "whose" there must
 *   come before a noun ("Tells which operation to use", not "Explains which was the best");
 * - a relative "that" or "who" after a noun, with a verb in the present tense next ("a verb that is
 *   in the past tense", "Details that support the main idea", "a character who changes"); a past or
 *   a modal is a story, not a criterion ("The dog that was scared", "The girl who ran home");
 * - "if needed", "when necessary", "where possible" (AS_NEEDED);
 * - "when" or "while" before a gerund ("Uses a comma when joining two sentences");
 * - "when" or "if" after "happen(s)" ("Predicts what will happen if ...").
 */
function clauseIdiom(list: readonly Word[], i: number, lead: number | null): boolean {
  const word = list[i]!.text;
  const next = list[i + 1]?.text;
  const prev = list[i - 1];
  if (prev === undefined) return false;
  if (QUESTION_WORDS.has(word) && questionAfterVerb(list, i, lead)) {
    const nounNext = next !== undefined && !FINITE_VERBS.has(next) && !regularPast(next);
    return (word !== 'which' && word !== 'whose') || nounNext;
  }
  if ((word === 'that' || word === 'who') && relativeThat(list, i)) {
    return presentVerbAt(list, isAdverb(next) ? i + 2 : i + 1);
  }
  if (prev.endsClause || next === undefined) return false;
  if (/^(?:if|when|whenever|where|wherever)$/u.test(word) && AS_NEEDED.has(next)) return true;
  if (/^(?:when|whenever|while)$/u.test(word) && /^\p{L}{2,}ing$/u.test(next)) {
    return !ING_NOUNS.has(next);
  }
  return (word === 'when' || word === 'if') && (prev.text === 'happen' || prev.text === 'happens');
}

/**
 * True when a clause word stands outside the fixed criterion idioms (round-4 check R3-RL-1): any
 * of CLAUSE_WORDS, at any position, drops the label unless it is named as a word (namedMask), is
 * the last word ("Explains what happened and why") or sits in an idiom (clauseIdiom). A
 * subordinator or clause word straight after a preposition always drops it ("Ends with because of
 * the thunder", "Ends with after the storm", "Writes about when it rained"; round-4 check R3-RL-2).
 */
function strayClauseWord(list: readonly Word[], lead: number | null): boolean {
  const named = namedMask(list, lead);
  for (let i = 0; i < list.length; i++) {
    if (named[i]) continue;
    const word = list[i]!.text;
    const prev = list[i - 1];
    const clauseWord = CLAUSE_WORDS.has(word);
    if (prev !== undefined && !prev.endsClause && PREPOSITIONS.has(prev.text)) {
      if (clauseWord || SUBORDINATORS.has(word)) return true;
    }
    if (clauseWord && !(i > 0 && i === list.length - 1) && !clauseIdiom(list, i, lead)) return true;
  }
  return false;
}

/**
 * True when the words after a leading criterion verb form a clause of their own. Words named as
 * words come first ("Uses he and she correctly"); then "that" straight after the verb opens the
 * clause it reports ("Explains that the dog was scared") and a subordinator opens an adverbial one
 * ("Writes because of the loud thunder"), unless a gerund follows ("Plans before writing").
 */
function clauseAfterLead(list: readonly Word[], lead: number): boolean {
  let rest = list.slice(lead);
  if (NAMING_VERBS.has(list[lead - 1]!.text)) rest = rest.slice(namedWords(rest));
  const first = rest[0]?.text;
  if (first === 'that') {
    // "Transitions that connect ideas" is a plural noun and its relative clause, read whole.
    const next = rest[1]?.text;
    const nounReading =
      lead === 1 &&
      PLURAL_NOUN_LEADS.has(list[0]!.text) &&
      next !== undefined &&
      !NOT_AFTER_PLURAL_RELATIVE.has(next) &&
      !/[^s]s$/u.test(next);
    return nounReading ? makesClause(list) : true;
  }
  if (
    first !== undefined &&
    SUBORDINATORS.has(first) &&
    !/\p{L}{2,}ing$/u.test(rest[1]?.text ?? '')
  ) {
    return true;
  }
  return makesClause(rest);
}

/** Index after a leading criterion verb ("Uses", "Clearly explains", "Doesn't repeat"), or null. */
function afterLeadingVerb(list: readonly Word[]): number | null {
  const first = list[0]?.text;
  if (first === undefined) return null;
  if (first === "doesn't" && list.length > 1) return 2;
  if (first === 'does' && list[1]?.text === 'not' && list.length > 2) return 3;
  const at = isAdverb(first) ? 1 : 0;
  return THIRD_PERSON_VERBS.has(list[at]?.text ?? '') ? at + 1 : null;
}

/**
 * Whether a plain label reads as a criterion rather than a sentence to copy (spec P6 "no ...
 * completed sentence"; round-2 check CHK-LJA-F1-residual, round-3 checks R2-LJA-F1-*, round-4
 * checks R3-RL-*). A criterion either starts with a verb in the third person ("Uses details",
 * "Explains why the character is sad") or is a short noun phrase ("Capital letters", "Use of
 * transition words"); in both, nothing after the lead may form a clause of its own ("Writes the
 * lamp is bright", "Says it was scared", "Explains that the dog was scared"). A clause is a finite
 * verb, a listed irregular past, a past in "-ed" with an object ("scared the dog") or a subject
 * pronoun. A clause word (CLAUSE_WORDS: a wh-word, "if", "that", "because", "so", ...) may stand
 * only in the fixed idioms of clauseIdiom (an embedded question straight after a question verb, a
 * present-tense relative "that"/"who" after a noun, "if needed", "when" + gerund, "what happens
 * when"), named as a word (namedMask: "Uses because to join two ideas", "a because clause") or as
 * the last word; anywhere else, and straight after any preposition, it drops the label. Not
 * criteria either: a label that opens with a clause word, "after", "as", "like", "once", "there",
 * "to", ... after up to two lead words ("Probably when ..."), a lead verb followed straight away by
 * "that" or a subordinator ("Writes because of ..."), an instruction ("Write a topic sentence",
 * "Neatly write ..."), a capitalised sentence start after the first word ("Write The lamp ..."),
 * and any letter that is not a Latin letter over a-z (homoglyphs such as a Cyrillic "а", or another
 * script), since the word lists are English. A full stop, bracket, dash or ellipsis ends a clause
 * as a comma does, and words joined by a hyphen, underscore or dot are read one by one. This fails
 * closed: a dropped label shows no row.
 *
 * Heuristic limits (round 4, measured with synthetic labels):
 * - Kept: the checker's 95 realistic K-8 criteria 92 (the 3 dropped are statements); a further
 *   132 criteria across the six subjects 128; the round-3 checker's 83 math, science, social
 *   studies and reading criteria 69 (79 in round 2, 73 in round 3); 124 criteria that use a
 *   clause word in an idiom, all 124.
 * - Dropped although legitimate (the fail-closed cost): statements ("Spelling is mostly correct");
 *   "that" straight after a lead verb ("Checks that the answer makes sense", "Shows that both
 *   sides are equal", "Explains that plants need sunlight"; 8 of the 83); a relative clause in the
 *   past, with a modal or without "that" ("Identifies the variable that changed", "Describes events
 *   that happened in order", "Uses details the reader can picture"; 4 of the 83); a clause word
 *   outside the idioms ("Gives reasons why the opinion is right", "Shows understanding of how
 *   fractions work", "Asks questions about what was read", "Explains why the character made that
 *   choice", "Uses details so the reader understands"); a finite verb after a verb that asks no
 *   question ("Makes sure the answer is labeled"); a label opening with "Like" ("Like terms
 *   combined"); a letter outside a-z ("Uses π to find the circumference", "Uses µ correctly"); and
 *   first person ("Uses a capital I for yourself").
 * - Still shown (the answer guard against the key and the protected example wording is then the
 *   only protection): of the round-3 checker's 125 completions and sentences 25, and of the
 *   round-2 checker's 33 completions 7. They are a sentence whose verb is a regular present, or a
 *   regular past with no object ("Thunder scares the dog", "The lamp glows at night", "Sam jumped",
 *   "Writes the lamp glows at night", "States the lamp glows"); an irregular past that is not
 *   listed ("The dog found a bone", "The girl felt happy", "Mom left early"); a noun, gerund or
 *   adjective completion with no clause word ("Due to the loud thunder", "Scared of the loud
 *   thunder", "Swimming at the lake with friends"); a clause inside an idiom ("Tells why it was
 *   scary", "Writes the lamp that is bright"); and a digit written for a letter ("Dogs 4re loyal").
 */
export function isCriterionShaped(label: string): boolean {
  // The word lists are English in Latin letters: a letter from another script or a Latin look-alike
  // with no a-z base ("а" Cyrillic, "ɑ", "ı") could spell a listed word the check would not see.
  if (/\p{L}/u.test(withoutMarks(label).replace(/[A-Za-z]/g, ''))) return false;
  const list = words(label);
  if (list.length === 0) return false;
  const rest = list.slice(1).filter((w) => /^\p{L}{4,}/u.test(w.text));
  const titleCase = rest.length > 0 && rest.every((w) => w.capitalised);
  const sentenceStart = list.some(
    (w, i) =>
      i > 0 &&
      w.capitalised &&
      SENTENCE_STARTS.has(w.text) &&
      // "Uses a capital A at the start" names the letter.
      !(w.text === 'a' && LETTER_WORDS.has(list[i - 1]!.text)),
  );
  if (!titleCase && sentenceStart) return false;
  // A wh-word, subordinator or "that" first, after up to two lead words ("Probably when ...",
  // "Only just when ..."), opens a clause or a completion, never a criterion.
  let first = 0;
  while (first < 2 && isLeadWord(list[first]?.text)) first += 1;
  const opener = list[first];
  if (opener !== undefined && CLAUSE_OPENERS.has(opener.text)) return false;
  const lead = afterLeadingVerb(list);
  if (strayClauseWord(list, lead)) return false;
  if (lead !== null) return !clauseAfterLead(list, lead);
  const head = isLeadWord(list[0]!.text) ? list[1] : list[0];
  if (head !== undefined && INSTRUCTION_VERBS.has(head.text)) {
    const next = list[list.indexOf(head) + 1]?.text;
    if (next !== 'of') return false;
  }
  // A noun phrase holds no embedded question of its own ("The day when she ran home").
  return (
    list.length <= NOUN_PHRASE_MAX_WORDS && !makesClause(list, false) && !regularPastAfterNoun(list)
  );
}

/**
 * A full stop that does not end the example: after a title or a common abbreviation ("Mr. Lee's
 * lamp", "at 9 p.m.") or inside a number ("3.5 cm").
 */
const EXAMPLE_ABBREVIATION = String.raw`(?<!\p{L})(?:Mr|Mrs|Ms|Mx|Dr|Prof|St|Mt|Jr|Sr|a\.m|p\.m|e\.g|i\.e|etc|vs)\.|(?<=\p{N})\.(?=\p{N})`;

/** The example after its cue: the rest of the sentence, after an optional line break. */
const EXAMPLE_TEXT = String.raw`[ \t]*\n?[ \t]*(?<text>(?:${EXAMPLE_ABBREVIATION}|[^\n.!?]){3,400})`;

/** A colon, a dash (a hyphen only with a space after it) or an arrow after a cue. */
const CUE_MARK = String.raw`[ \t]*(?:[:：]|[—–→]|-(?=[ \t]))`;

/** Up to two words, numbers ("1", "#1") or a bracketed note between a label word and its mark. */
const CUE_EXTRA = String.raw`(?<extra>(?:[ \t]+(?:[\p{L}'’]+|#?\p{N}{1,3}|\([^)\n]{1,40}\))){0,2}?)`;

/**
 * Words after a label word that make it a description of what to accept, not an example
 * ("Answers will vary - look for ...", "Response should include: ...").
 */
const NOT_EXAMPLE_EXTRA =
  /(?<!\p{L})(?:vary|varies|should|must|needs?|includes?|contains?)(?!\p{L})/iu;

/**
 * The start of a description of an answer rather than an example: "a sentence that uses glow",
 * "any complete sentence", "one that rhymes", or a criterion verb in lower case ("has a capital
 * letter", "uses glow as a verb").
 */
const DESCRIBED_ANSWER =
  /^(?:(?:a|an|any|one|some|each|every)[ \t]+(?:[\p{L}'’]+[ \t]+)?(?:sentences?|answers?|responses?|words?|phrases?|paragraphs?)|(?:one|something|anything)[ \t]+(?:that|which|with|about|using))(?!\p{L})/iu;

function describesAnswer(text: string): boolean {
  if (DESCRIBED_ANSWER.test(text)) return true;
  const first = /^\p{Ll}[\p{L}'’]*/u.exec(text)?.[0];
  return (
    first !== undefined &&
    (THIRD_PERSON_VERBS.has(first) || /^(?:is|are|should|must|needs)$/u.test(first))
  );
}

interface ExampleCue {
  readonly pattern: RegExp;
  /** Whether a match is example wording, given the source (round-4 check R3-RL-5). */
  readonly accept: (match: RegExpMatchArray, source: string) => boolean;
}

/**
 * Where unquoted example wording starts in a parent-only solution or note (round-3 check
 * R2-LJA-F1-example-span-gaps; round-4 check R3-RL-5):
 * - after a label word, up to two more words, numbers or a bracketed note and a colon, dash or
 *   arrow ("A good answer:", "Example 1:", "Sample answer #1:", "Model answer (for the parent):",
 *   "Example —", "Ideal response →", "Answer key:", "Sample response:" and a new line), but not
 *   "Answers will vary -" or "Response should include:";
 * - after "write" or "say" behind another word ("They could write:"; a note that starts
 *   "Writes: ..." describes the criterion);
 * - after a word of praise and "sentence" or "paragraph" ("A strong sentence -", "Possible
 *   sentence:"), not "Topic sentence:", "First sentence -" or "The sentence -";
 * - after "example is", "example would be" and the like ("A good example is ...", "An example
 *   would be ..."), when at least three words follow;
 * - after "for example" or "for instance"; after "e.g." or "i.e." as well, except straight after
 *   a word in "-s" (and a comma) with no colon or dash of their own, where they list kinds of
 *   things ("sentence parts, e.g. a subject and a verb");
 * - after "such as", "something like" or "like this" with a colon or dash.
 * Wording that describes an answer instead of giving one is not an example: "a sentence that uses
 * glow", "any complete sentence", "has a capital letter" (describesAnswer).
 * Not found (measured in round 4): an instruction or other opener before a colon ("Try: ...",
 * "Here is one: ..."), a label word alone on its line ("Answer" and a new line), and "could write"
 * or "might say" with no colon or dash. A label copying such an example is then dropped only by its
 * shape (isCriterionShaped) or by the answer guard against the key and any quoted wording.
 */
const EXAMPLE_CUES: readonly ExampleCue[] = [
  {
    pattern: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?:examples?|samples?|models?|exemplars?|answers?|responses?|possibilit(?:y|ies)|ex)` +
        CUE_EXTRA +
        CUE_MARK +
        EXAMPLE_TEXT,
      'giu',
    ),
    accept: (match) => !NOT_EXAMPLE_EXTRA.test(match.groups?.extra ?? ''),
  },
  {
    pattern: new RegExp(
      String.raw`(?<=\p{L}[ \t]+)(?:writes?|says?|wrote|said)${CUE_MARK}${EXAMPLE_TEXT}`,
      'giu',
    ),
    accept: () => true,
  },
  {
    pattern: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?:acceptable|best|better|correct|excellent|good|great|ideal|model|perfect|possible|sample|strong|suggested)(?:[ \t]+[\p{L}'’]+)?[ \t]+(?:sentences?|paragraphs?)(?:[ \t]+#?\p{N}{1,3})?` +
        CUE_MARK +
        EXAMPLE_TEXT,
      'giu',
    ),
    accept: () => true,
  },
  {
    pattern: new RegExp(
      String.raw`(?<![\p{L}\p{N}])examples?(?:[ \t]+(?:sentences?|answers?|responses?))?[ \t]+(?:(?:would|could|might|may|will|can)[ \t]+be|is|are|was|were)(?:[ \t]*[:：—–])?` +
        EXAMPLE_TEXT,
      'giu',
    ),
    accept: (match) => (match.groups?.text ?? '').trim().split(/\s+/u).length >= 3,
  },
  {
    pattern: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?:for example|for instance|(?<abbr>e\.g\.|e\.g|eg|i\.e\.|i\.e|ie))(?![\p{L}\p{N}])(?<mark>[ \t]*[,:：—–]?)` +
        EXAMPLE_TEXT,
      'giu',
    ),
    accept: (match, source) => {
      if (match.groups?.abbr === undefined || /[:：—–]/u.test(match.groups.mark ?? '')) return true;
      const index = match.index ?? 0;
      const before = source.slice(Math.max(0, index - 80), index).replace(/[ \t]+$/u, '');
      if (before === '' || /[\n.!?;:：([—–-]$/u.test(before)) return true;
      return !/\p{L}{2,}[^su\s]s,?$/iu.test(before);
    },
  },
  {
    pattern: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?:such as|something like|like this)[ \t]*[:：—–]${EXAMPLE_TEXT}`,
      'giu',
    ),
    accept: () => true,
  },
];

/**
 * Example wording without quotes in a parent-only solution or rubric note, up to the end of its
 * sentence, for the caller to protect so that no rubric row copies it (LJA-F1; round-3 check
 * R2-LJA-F1-example-span-gaps, round-4 check R3-RL-5; the cues are listed at EXAMPLE_CUES). What a
 * grown-up is told to look for ("Look for: a capital letter", "Answers will vary - look for ...")
 * and a plain list after "such as" ("words such as first, next and last") are not examples.
 */
export function exampleWordingSpans(source: string): string[] {
  const spans = new Set<string>();
  for (const cue of EXAMPLE_CUES) {
    for (const match of source.matchAll(cue.pattern)) {
      const span = (match.groups?.text ?? '').replace(/^[\s"“”„«»'‘’([]+|[\s"“”„«»'‘’)\]]+$/gu, '');
      if (span.length > 0 && cue.accept(match, source) && !describesAnswer(span)) spans.add(span);
    }
  }
  return [...spans];
}

/**
 * True when a child-facing row states none of the protected forms (the answer-leak guard, with
 * expressions read as their value). The guard takes at most MAX_PROTECTED_ANSWERS forms per call,
 * so a longer list is checked in batches; an empty list still runs the answer-independent checks.
 */
export function rowStatesNoAnswer(body: string, answers: readonly ProtectedAnswer[]): boolean {
  const batches: ProtectedAnswer[][] = [];
  for (let i = 0; i < answers.length; i += MAX_PROTECTED_ANSWERS) {
    batches.push(answers.slice(i, i + MAX_PROTECTED_ANSWERS));
  }
  if (batches.length === 0) batches.push([]);
  return batches.every(
    (batch) =>
      guardChildContent({
        packet: { steps: [body] },
        answers: batch,
        allowNoProtectedAnswers: batch.length === 0,
        options: { evaluateExpressions: true },
      }).decision === 'release',
  );
}

export interface RubricSafetyOptions {
  /** The writing prompt and subject the labels must stay grounded in. */
  readonly context?: ScreenContext;
  readonly ageBand?: SafetyAgeBand | null;
  /** Called with a payload-free code for every label the safety screen drops. */
  readonly onSafetyReject?: (code: string) => void;
  /**
   * Forms of the private key and example wording no row may state (LJA-F1). When given, every row
   * passes the answer-leak guard against them and a blocked row is dropped.
   */
  readonly protectedAnswers?: readonly ProtectedAnswer[];
  /** Called with a payload-free code for every row the answer guard drops. */
  readonly onLeak?: (code: string) => void;
}

/**
 * The rubric rows a child sees for one written answer: unmet criteria first (the next step matters
 * most), at most MAX_RUBRIC_FEEDBACK_ROWS, each label once. Invalid input yields no rows.
 */
export function childRubricFeedback(
  rubric: unknown,
  options: RubricSafetyOptions = {},
): RubricFeedbackRow[] {
  if (!Array.isArray(rubric)) return [];
  const next: RubricFeedbackRow[] = [];
  const praise: RubricFeedbackRow[] = [];
  const seen = new Set<string>();
  for (const item of rubric as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const { criterion, met } = item as { criterion?: unknown; met?: unknown };
    if (typeof met !== 'boolean') continue;
    const label = plainLabel(criterion);
    if (label === null) continue;
    // The safety screen sees every plain label before its shape is judged, so a severe label is
    // always reported, even one that would also be dropped as not a criterion.
    const screen = screenModelOutput([label], {
      ageBand: options.ageBand ?? null,
      context: options.context ?? {},
    });
    if (screen.level === 'severe') {
      options.onSafetyReject?.(`SAFETY_${screen.categories[0]!.toUpperCase()}`);
      continue;
    }
    if (!isCriterionShaped(label)) continue;
    const key = label.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    const row: RubricFeedbackRow = met
      ? { kind: 'encouragement', body: `You did this well: ${label}.` }
      : { kind: 'method_step', body: `Next time, work on: ${label}.` };
    if (
      options.protectedAnswers !== undefined &&
      !rowStatesNoAnswer(row.body, options.protectedAnswers)
    ) {
      options.onLeak?.('ANSWER_LEAK');
      continue;
    }
    seen.add(key);
    (met ? praise : next).push(row);
  }
  return [...next, ...praise].slice(0, MAX_RUBRIC_FEEDBACK_ROWS);
}
