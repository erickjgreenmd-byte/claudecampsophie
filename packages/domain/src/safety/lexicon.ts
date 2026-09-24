// Safety screen rules (spec P4; AC_SECURITY_02). Every rule carries its rationale in `doc`.
//
// Pattern syntax: slots joined by " + " (up to `gap` filler tokens before the slot, default 1) or
// " +N " (up to N filler tokens). Alternatives inside a slot are separated by "|"; an alternative
// may be several words. A leading "?" makes a slot optional. Words are normalized exactly like
// the screened text (case, NFKC, repeated letters collapsed: "kill" and "killll" both read "kil").
//
// `negatable`: a negation ("dont", "never", "not", ...) among the gap tokens or the two tokens
// before the match cancels it ("I don't want to die" is fear, not ideation).
// `hypothetical`: "if" within three tokens before the match cancels it (body-safety lessons:
// "If someone touches my private parts I tell a grown-up").
// `exempt` (tier B): a word that is severe out of context but educational in one ("suicide" in a
// Romeo and Juliet answer). For a child's text it is exempt when the subject is listed or a cue
// word appears in the text or the printed question, and, in the child's answer, only when the
// sentence it is in has no first-person word (FIRST_PERSON, outside FIRST_PERSON_FRAMES and
// OPINION_FRAMES): "suicide is the only way out for me" or "I was a victim of rape" in a reading
// answer is severe (RV-child-safety-1), "I think Romeo committed suicide" is not (CHK-CS-3). The
// printed prompt's first person is the worksheet's, never the child's (CHK-CS-2). For model
// output it is exempt only when the printed question itself raised the same topic.
// A slot written "*" matches any one word except a number, a sentence boundary and the words in
// the rule's `notObject` (a name: "I will kill Riley").
import type { ScreenSource, SensitiveTopic, SevereSafetyCategory } from './types.ts';

export interface RuleDef {
  readonly id: string;
  readonly kind: 'severe' | 'topic';
  readonly category?: SevereSafetyCategory;
  /** Topic rules: their topic. Tier-B severe rules: the topic they become when exempt. */
  readonly topic?: SensitiveTopic;
  readonly sources: readonly ScreenSource[];
  readonly pattern: string;
  readonly gap?: number;
  readonly negatable?: boolean;
  readonly hypothetical?: boolean;
  readonly notFollowedBy?: string;
  /**
   * The notFollowedBy exclusion may start up to this many tokens after the match (same sentence;
   * default 0): "I ate poison berries in Minecraft" skips "berries" to find the game.
   */
  readonly notFollowedWithin?: number;
  /**
   * Round 3 (CHK2-CS-1): deliberate or distress words within VOID_WINDOW tokens after the match
   * (same sentence) that void the notFollowedBy exclusion. An accident, idiom or house-rule tail is
   * then not the whole story ("I cut my wrist with the paper cutter on purpose", "I ate poison
   * berries to die"). A void can only make the rule fire, never silence it.
   */
  readonly unlessAfter?: string;
  readonly notPrecededBy?: string;
  /**
   * Any of these words within `within` tokens before the match cancels it (same sentence).
   * `stopAtFirstPerson`: a first-person word nearer than the guard word, or right before it ("I
   * think ..."), means the child holds the view, so the guard does not apply. `holderTo`: "to" and
   * a name hold the view too ("According to Cleopatra, ..."; not "to me", "to be honest", nor a
   * "To ..." that opens the sentence). `firstPersonAfter` (round 4): a first-person word later in
   * the sentence, within VOID_WINDOW tokens and outside a frame, voids the guard ("Some people say
   * sex is our secret but my uncle says it too"). `quoteWords` (round 4, with `firstPersonAfter`):
   * when the matched phrase itself names the child ("sex is OUR secret", "sex with ME"), only these
   * words still hold the view, because the child is quoting someone ("If someone tells you ...",
   * "Never say ...", "the villain says ..."); any other guard word does not ("He said it is a rule,
   * sex is our secret").
   */
  readonly guard?: {
    readonly words: string;
    readonly within: number;
    readonly stopAtFirstPerson?: boolean;
    readonly holderTo?: boolean;
    readonly firstPersonAfter?: boolean;
    readonly quoteWords?: string;
  };
  /**
   * The rule reads the child's answer only, never the printed prompt (CHK2-CS-4: a worksheet's
   * "Why might a teen think suicide is the only way out?" is not the child's ideation).
   */
  readonly answerOnly?: boolean;
  /**
   * Words a gap may not skip. Used by first-person threat rules so a subject change inside the
   * gap ("if I tell HE will hurt my mom") is not read as the child's own threat.
   */
  readonly gapStop?: string;
  /** The match must start a sentence ("We're best friends!", not "Frog and Toad were ..."). */
  readonly sentenceStart?: boolean;
  /** The match must be the whole text (a bare "kms"; "5 kms" and "kms per hour" are not). */
  readonly alone?: boolean;
  /** The match must end a sentence ("I'll always be here."). */
  readonly sentenceEnd?: boolean;
  /** Words a `*` slot may not be (pronouns, determiners, game and everyday objects). */
  readonly notObject?: string;
  readonly exempt?: { readonly subjects: readonly string[]; readonly cues: string };
  readonly doc: string;
}

/**
 * Anchored "compact" signatures: matched on a stream's tokens joined without spaces, but only
 * where the signature starts and ends on token boundaries. They catch splits inside words
 * ("su icide", "k ill myself") that token rules cannot see, without matching across unrelated
 * words ("I want to diet" does not contain "iwanttodie" on a boundary).
 */
export interface SignatureDef {
  readonly id: string;
  readonly category: SevereSafetyCategory;
  readonly sources: readonly ScreenSource[];
  readonly phrases: string;
  readonly exempt?: RuleDef['exempt'];
  readonly topic?: SensitiveTopic;
  readonly doc: string;
}

const BOTH: readonly ScreenSource[] = ['child', 'ai'];
const CHILD: readonly ScreenSource[] = ['child'];
const AI: readonly ScreenSource[] = ['ai'];

// ---------------------------------------------------------------------------------------------
// Shared vocabularies
// ---------------------------------------------------------------------------------------------

/**
 * First-person subjects. Contractions ("I'm", "I'll", "I'd", "I've") are spelled out in the
 * normalizer's expanded stream ("i am", "i will", ...), so they are not listed here: listing "ill"
 * read "The ill bird is going to die" as a first person.
 */
const I = 'i|me';
const SELF = 'myself|my self|meself|me self|mself|myslef|mysef|mysel|myslf|myseld';
const YOURSELF = 'yourself|your self|urself|ur self|yourselves|yoself|youself';
/** Expanded by the compiler into you / u / ya, also inside phrases ("where do {you} live"). */
const YOU = '{you}';
/**
 * First-person words that make a tier-B word the child's own statement, not a topic
 * (RV-child-safety-1). "I'll" with an apostrophe is "i will" in every stream; a bare "ill" counts
 * only when it reads as "I will" (normalize.ts illReadsAsIWill: a verb must follow, CHK2-CS-3).
 * A Roman numeral ("World War II", "Act III") is a number, never "I" (normalize.ts, CHK2-CS-2).
 */
export const FIRST_PERSON =
  'i|me|my|myself|mine|im|ive|id|ima|imma|we|us|our|ours|ourselves|meself|myslef|mself';
/**
 * Frames whose first person only introduces what the child learned, read, thinks or was taught
 * about a topic ("We learned that soldiers ...", "my book report is about ...", "In our class we
 * talked about ...", "My mom says ..."). The frame's own words are not a first person; any other
 * first-person word in the sentence still is ("I think suicide is MY only choice"). CHK-CS-3: the
 * pass-3 rule counted these too and escalated ordinary answers.
 */
export const FIRST_PERSON_FRAMES = [
  // Reporting what was learned, read, written or taught.
  'i learned|i learned that|i learned about|we learned|we learned that|we learned about|i read|i read that|i read about|we read|we read that|we read about|we studied|we study|we are studying|we are learning|we are learning about|we talked about|we discussed|we discuss|we watched|we saw|we had a lesson on|we had a lesson about|my book report|my report|my essay|my answer is|my answer',
  'tells us|told us|shows us|showed us|teaches us|taught us|reminds us',
  // The class, its book or unit, the child's favourite part, and the country or community.
  'in our class|our class|in my class|my class|in our unit|our unit|in our lesson|our lesson|in our book|our book|in our play|our play|in our story|our story|in our textbook|our textbook|our health class|in our health class|in our country|our country|in our state|our state|in our community|our community|in our society|our society|in our world|our world|our history',
  'my favorite part|my favorite character|my favorite scene|my favorite chapter|my favorite book|in my opinion|my opinion is|my opinion',
  // What a grown-up says.
  'my mom says|my mom said|my dad says|my dad said|my parents say|my parents said|my teacher says|my teacher said|my doctor says|my doctor said|my nurse says|my nurse said|my grandma says|my grandma said|my grandpa says|my grandpa said',
  // What people should do about a harm (civics and health answers).
  'we should stop|we should prevent|we should end|we should help|we should protect|we should report|we should tell|we can stop|we can prevent|we can help|we can end|we must stop|we must prevent|we must protect|we need to stop|we need to prevent|we need to protect|we have to stop|we have to prevent|we have to protect',
  // Round 3: "... so we should be kind" after a prevention sentence (CHK2-CS-4).
  'we should be kind|we should all be kind|we should be nice|we should be careful|we should be there for|we should be a friend|we should be friends|we need to be kind|we must be kind',
  'i would tell|we would tell|i would tell a trusted adult|i would tell an adult|i would tell a grown up|i would tell my teacher|i would tell my parents|i would tell my mom|i would tell my dad|i would report|we would report|i would call|if we see|if we hear|if we know|if i see|if i hear|if i knew',
  'i agree|i agree that|we agree|we agree that|i disagree|i feel sad that|i felt sad that|i feel sad when|i felt sad when|i feel bad that|i felt bad that|i was sad that|i was sad when|i feel sorry for|i felt sorry for',
].join('|');
/**
 * Opinion frames ("I think Romeo committed suicide", "I believe the man in the story was a
 * rapist"). They are frames like FIRST_PERSON_FRAMES except before OPINION_FRAME_NOT_BEFORE: "I
 * think about suicide" and "I know how to overdose" are the child's own words. Round 3 (CHK2-CS-7):
 * only "think", "believe" and "know that"; "I wonder if", "I guess" and a bare "I know" read as
 * the child's own words again ("I wonder if suicide would hurt", "I know suicide is the answer").
 */
export const OPINION_FRAMES =
  'i think|i think that|we think|we think that|i believe|i believe that|we believe|we believe that|i know that|we know that';
export const OPINION_FRAME_NOT_BEFORE = 'about|of|off|how';
/**
 * Words after "to" that are not a name holding a view (SELF_HARM_ONLY_WAY_OUT's holderTo guard):
 * "to be honest", "to me", "to the end". First-person words are excluded as well. Round 4
 * (CHK3-CS-5): the addressee of a note is not a holder either ("... to Mom and Dad", "to whoever
 * reads this", "to everyone"), and a "to" that starts the sentence is a salutation, never a holder
 * (screen.ts guardedBefore: "To Riley, suicide is the only answer").
 */
export const HOLDER_TO_NOT_A_NAME =
  'be|the|a|an|this|that|these|those|it|its|now|real|sure|some|all|any|every|everyone|everybody|anyone|anybody|no|die|end|stop|keep|make|get|go|live|tell|say|do|you|u|ya|your|ur|my|our|me|us|myself|ourselves|kill|hurt|escape|leave|feel|think|believe|know|put|finish|win|save|help|get|hide|run|' +
  'whoever|whomever|whoever reads|all of you|you all|yall|mom|mommy|mother|mum|mama|ma|dad|daddy|father|papa|pa|parents|stepdad|stepmom|stepfather|stepmother|grandma|grandpa|grandmother|grandfather|nana|granny|sister|brother|sis|bro|family|friend|friends|teacher|teachers|aunt|uncle|cousin|guardian|dear|goodbye|bye';
/**
 * How many tokens after a match an `unlessAfter` word may start (same sentence). Bounded so an
 * exclusion costs at most this much extra work per candidate position.
 */
export const VOID_WINDOW = 14;
/**
 * Deliberate or distress words that void a self-harm rule's accident, idiom or hyperbole
 * exclusion (round 3, CHK2-CS-1): "... with the paper cutter on purpose", "I ate poison berries to
 * die", "I want to end it all with a big finale and then take pills".
 */
const SELF_HARM_DELIBERATE =
  'on purpose|to die|so i die|so i would die|so i will die|so i can die|and die|and then die|to kill myself|so i can kill myself|to hurt myself|so it hurts|to feel pain|to feel something|to feel better|so i can feel|so i feel|to punish myself|to end it|to end my life|never wake up|not wake up|dont wake up|wont wake up|because i want to die|because i wanted to die|because i hate myself|because i hate my life|want to die|wanna die|kill myself|when i am sad|when im sad|when i feel sad|being sad|because i am sad|because im sad|when i am upset|when im upset|when i feel bad|so i get skinny|so i can be skinny|to be skinny|to get skinny|to lose weight|so i lose weight|so i can lose weight|please help|help me|pills|the pills|rope|a rope|knife|a knife|razor|a razor|gun|a gun|bridge|overdose|poison|bleach';
/** SELF_HARM_DELIBERATE plus wording that turns a hyperbole tail into ideation (round 4). */
const DIE_IDEATION_VOIDS = `${SELF_HARM_DELIBERATE}|being alive|of living|anymore|any more`;
/** Distress words that void a neglect rule's house-rule exclusion ("... after dark and I am starving"). */
const NEGLECT_DISTRESS =
  'starving|so hungry|always hungry|really hungry|very hungry|hungry all|and i am hungry|and im hungry|and i get hungry|i am hungry|im hungry|for days|all day|for a day|for two days|for 2 days|at all|anything at all|ever';
/** Harm words that void an "I don't feel safe at home" exclusion ("... when the power goes out because my dad hits me"). */
const UNSAFE_HOME_HARM =
  'drunk|drinks|drinking|hits|hit me|hurts|hurt me|touches|touched|yells at me|screams at me|beats|beat me|kicks|kicked me|angry|mad at me|comes into my room|comes in my room|locks me|locked me|because of my dad|because of my mom|because of my stepdad|because of my stepmom|because of my uncle|because of him|because of her|because of them';
const SELF_INTENT =
  'want to|wanna|want 2|want|wanted to|going to|gonna|going 2|am going to|will|plan to|planning to|about to|should|feel like|need to|have to|try to|tried to|trying to|thinking about|think about|thought about|thinking of|wish i could|would like to|gotta|am gonna|ready to|decided to|keep thinking about|finna';
const THREAT_INTENT =
  'will|going to|gonna|going 2|want to|wanna|want 2|want|plan to|planning to|about to|am going to|would like to|feel like|wish i could|should|shall|gotta|need to|have to|am gonna|ready to|decided to|finna';
/**
 * Intent words for an overdose plan. Obligations ("have to", "need to", "should") are left out: a
 * child on medication writes "I have to take all my pills with breakfast".
 */
const OVERDOSE_INTENT =
  'want to|wanna|want 2|want|wanted to|going to|gonna|going 2|am going to|will|plan to|planning to|about to|tried to|trying to|thinking about|think about|thought about|thinking of|wish i could|would like to|am gonna|ready to|decided to|keep thinking about|feel like|finna';
/**
 * Taking medicine as directed ("I will take all the medicine the doctor gave me with breakfast").
 * Round 3 (CHK2-CS-1): whole phrases only; the bare "before", "at", "when", "so" and "because"
 * also cancelled "I will take all the pills at once" and "... so I never wake up".
 */
const AS_DIRECTED_TAILS =
  'the doctor gave me|my doctor gave me|the doctor gives me|my doctor gives me|like the doctor said|like my doctor said|as the doctor said|as my doctor said|as directed|like the label says|with breakfast|with my breakfast|with dinner|with lunch|with food|with a meal|with my meals|before bed|at bedtime|every morning|every night|in the morning|on time|so i get better|so i can get better|when i am sick|when im sick';
/**
 * Words a first-person threat's gap may not skip: a new subject or a reported condition means the
 * threat is not the child's own ("he said if I tell he will hurt my mom").
 */
const THREAT_GAP_STOP = 'he|she|they|someone|somebody|tell|told|said|says|if|when';
/** "I will shoot you a message", "I'll shoot my teacher an email". */
const MESSAGE_TAILS =
  'a message|a text|an email|a note|a dm|a pm|a line|a look|a smile|a picture|a photo|a pic|a pass|the ball|a quick|an invite|a link|a video|a letter';
const THREAT_VERBS =
  'kill|murder|stab|shoot|strangle|choke|poison|hurt|bomb|blow up|burn down|shoot up|slit|drown|attack|beat to death|beat up';
const PERSON_TARGETS = `${YOU}|him|her|them|everyone|everybody|every one|all of you|you all|yall|people|someone|somebody|us|kids|students|teachers|all the kids|all of them|all of us|them all|every single one of them|everyone here|everybody here`;
const DETERMINERS = 'my|the|this|our|that|his|her|those|these|all the|a|your|ur|every|all my';
const PERSON_NOUNS =
  'mom|mommy|mother|dad|daddy|father|brother|sister|teacher|teachers|principal|friend|friends|classmate|classmates|class|school|family|parents|kids|kid|students|student|coach|bus driver|neighbor|neighbors|cousin|cousins|grandma|grandpa|baby|stepdad|stepmom|step dad|step mom|boy|girl|boys|girls|bully|bullies|people|children|child|uncle|aunt|babysitter|stepfather|stepmother|nanny|guy|man|woman|lady|person|brothers|sisters';
const ABUSERS =
  'he|she|they|dad|daddy|father|mom|mommy|mother|stepdad|step dad|stepfather|stepmom|step mom|stepmother|uncle|aunt|grandpa|grandma|grandfather|grandmother|brother|sister|cousin|babysitter|baby sitter|teacher|coach|boyfriend|girlfriend|neighbor|parents|someone|somebody|a man|a woman|an adult|a grown up|a grownup|papa|mama|foster mom|foster dad|foster parent|moms boyfriend|dads girlfriend|guardian|the man|this man|this guy|a guy|a lady|an older kid|a big kid|a teenager';
const ADULT_ABUSERS =
  'dad|daddy|father|mom|mommy|mother|stepdad|step dad|stepfather|stepmom|step mom|stepmother|uncle|aunt|grandpa|grandma|grandfather|grandmother|babysitter|baby sitter|teacher|coach|moms boyfriend|dads girlfriend|foster mom|foster dad|foster parent|parents|guardian|a man|a grown up|an adult|papa|mama';
const STRANGERS =
  'someone|somebody|a man|a guy|a lady|a woman|a stranger|strangers|a person|a grown up|a grownup|an adult|this guy|this man|this lady|a teenager|an older boy|an older girl|an older kid|my online friend|a friend online|a player|this player|a gamer|some guy|some man|some lady|a grown man';
/**
 * Caring touch after "touches me at night" or "comes into my bed": whole phrases (round 3: the bare
 * "to see", "to check", "to help", "to hug", "to cuddle" and "to comfort" also cancelled "... to see
 * if I'm asleep" and "... to cuddle").
 */
const CARING_TOUCH_TAILS =
  'to check if i have a fever|to check if i have a temperature|to check if im hot|to check if i am hot|to check my temperature|to check my forehead|to check my fever|to check for a fever|to check for fever|to see if i have a fever|to see if im sick|to see if i am sick|to see if im hot|to wake me up|to wake me for school|to tuck me in|to feel if i have a fever|to feel my forehead|to feel my head|to say goodnight|to say good night|to give me medicine|to give me my medicine|goodnight|good night|on the forehead|on the head';
/**
 * Body-safety lesson phrasing ("never let anyone touch my private parts", "no one is allowed to").
 * Round 4 (lead policy: recall first): a first-person word nearer than the lesson word, or right
 * before it, is the child talking about themself ("I'm not ok, he touches my private parts", "I'm
 * not okay my uncle touches me at night"), so the guard does not apply (`stopAtFirstPerson`).
 */
const BODY_SAFETY_LESSON = {
  words:
    'never|nobody|no one|noone|allowed|okay|ok|not|should|shouldnt|if|rule|rules|let|safe|unsafe|say no|belongs',
  within: 4,
  stopAtFirstPerson: true,
} as const;

/**
 * Round 4: who may have touched the child in "I was touched by ..." (ABUSE_TOUCHED_BY): a person
 * noun after a determiner, or a bare "him", "someone" or "a man"; never an object ("the story").
 */
const TOUCHED_BY_PERSONS = [
  'him|someone|somebody|a man|a guy|a stranger|an adult|a grown up|a grownup|a teenager|an older kid|an older boy|an older girl|a big kid',
  ...['my', 'the', 'a', 'an', 'this', 'that', 'his', 'her', 'our'].map((d) =>
    'coach|priest|pastor|teacher|uncle|aunt|cousin|dad|daddy|father|stepdad|stepfather|step dad|mom|mommy|mother|stepmom|stepmother|grandpa|grandfather|grandma|grandmother|brother|sister|stepbrother|babysitter|baby sitter|neighbor|man|guy|boy|boyfriend|friend|stranger|counselor|principal|tutor|bus driver|driver|trainer|instructor|leader|scout leader|camp counselor|youth leader|moms boyfriend'
      .split('|')
      .map((n) => `${d} ${n}`)
      .join('|'),
  ),
].join('|');

/**
 * Round 4 (CHK3-CS-3): who holds the view in "... says touching private parts is a secret" /
 * "... sex is normal for kids" (SEXUAL_ABUSE_ENDORSED, SEXUAL_GROOMING_GAME). A body-safety lesson
 * ("if", "should", "rules", "unsafe", "a lie", "true or false", "don't let anyone ...") or a third
 * person that is not someone the child reports about ("some people", "the villain", "the
 * character", "the book", "a bully") within six words before, in the same sentence, holds it.
 * Caregivers, "he", "she", "someone" and "a man" are left out: they are how a child reports
 * grooming ("He says sex is our game", "Someone said touching private parts is our secret"), and
 * a first-person word nearer than the guard word keeps the rule firing ("My uncle says ..."), and so
 * does one later in the sentence ("Some people say sex is our secret but my uncle says it too").
 * A negation right before the phrase, or across "say" or "think" (NEGATION_BRIDGES: "Don't say
 * rape is ok"), cancels it; across any other word it negates that word ("He said it is not bad,
 * sex is our secret", "He said don't tell, sex is our secret"; round 4 lead policy). A negated
 * "say", "believe", "think" or "listen" and "not true" further back are lesson words here ("Do not
 * believe anyone who says sex is our secret"). When the phrase itself names the child ("our",
 * "me", "us"), only `quoteWords` hold it: a conditional, a negated "say", "not true", "unsafe",
 * "some people" or a story's character ("If someone tells you touching private parts is our
 * secret, tell"), never "rule", "allowed", "let" or a bare "people" ("He said it is a rule, sex is
 * our secret", "He says people would not understand, sex is our secret").
 */
const ENDORSED_NEGATED_LESSON =
  'never say|never says|dont say|do not say|not say|never believe|dont believe|do not believe|never think|dont think|do not think|never listen|dont listen|do not listen|not true|isnt true|never true';
const ENDORSED_LESSON_GUARD = {
  words: `if|should|shouldnt|allowed|rule|rules|let|unsafe|say no|belongs|lie|lies|true|false|trick|tricks|people|some people|bad people|bad person|villain|villains|character|characters|story|book|books|author|narrator|bully|bullies|${ENDORSED_NEGATED_LESSON}`,
  within: 6,
  stopAtFirstPerson: true,
  firstPersonAfter: true,
  quoteWords: `if|unsafe|true or false|some people|bad people|villain|villains|character|characters|story|book|books|author|narrator|bully|bullies|${ENDORSED_NEGATED_LESSON}`,
} as const;

/**
 * What follows "beats me" / "pushed my sister" in a game or in play. Specific phrases only
 * (RV-child-safety-2): a bare "at", "in", "to", "by", "up" or "on the" also cancelled "hits me in
 * the face", "beats me up" and "hits me on the head".
 */
const GAME_AND_PLAY_TAILS = [
  // Games, races and contests ("beats me at chess", "beat us in the finals", "beat me to it").
  'at chess|at checkers|at cards|at card games|at board games|at video games|at games|at a game|at the game|at every game|at basketball|at soccer|at football|at baseball|at tennis|at ping pong|at racing|at running|at swimming|at math|at spelling|at reading|at everything|at uno|at monopoly|at fortnite|at minecraft|at roblox|at mario kart|at mario|at tag|at arm wrestling|at thumb wrestling|at wrestling|at connect four|at go fish|at rock paper scissors|at trivia|at scrabble|at dodgeball|at the race|at races',
  'in chess|in checkers|in a race|in the race|in races|in every race|in the finals|in the final|in the game|in a game|in games|in every game|in soccer|in basketball|in football|in baseball|in tennis|in fortnite|in minecraft|in roblox|in mario kart|in the championship|in the tournament|in the match|in a match|in running|in swimming|in math|in spelling|in the spelling bee|in arm wrestling|in tag|in a contest|in the contest|in the competition|in a competition|in dodgeball|in cards|in uno',
  'to the finish|to the finish line|to the top|to the end|to the door|to the car|to the bus|to the bathroom|to the park|to it|to the punch|to the ball|to first base|to first|to the front|to the line|to the swings|to school|to the house|to the table|home|by a point|by one point|by two points|by 2 points|by 1 point|by a lot|by a little|by one|by a mile|by a second|by seconds|up the hill|up the stairs',
  // Play ("pushes me on the swing", "throws me in the air", "hits me with a pillow").
  'on the swing|on the swings|on a swing|on my swing|on the tire swing|in the air|up in the air|into the air|in the pool|into the pool|into the water|in the water|on the trampoline|in the snow|into the snow|in the leaves|into the leaves|in the sprinkler|in circles',
  'with a pillow|with pillows|with a balloon|with the ball|with a ball|with a toy|playing|a ball|the ball|balls|a baseball|the baseball|a softball|a grounder|grounders|a fly ball|fly balls|a pop fly|pop flies|a pitch|pitches|a tennis ball|a birdie|the birdie|a shuttlecock|a puck|the puck|a volleyball|a football|a soccer ball|a basketball|with a water balloon|with water balloons|with a snowball|with snowballs',
].join('|');
/**
 * A school project after "end my life" ("I will end my life cycle poster", "end my life story
 * project"): a life cycle is a grade-3 science topic.
 */
const LIFE_PROJECT_TAILS =
  'cycle|cycles|story|stories|project|projects|poster|timeline|map|book|report|lesson|chapter|essay|journal|diagram|slideshow|presentation';
/**
 * Hyperbole after "die" / "dying": whole idioms only (round 3, CHK2-CS-1: a bare "of" or "from"
 * also cancelled "I want to die from an overdose"). Round 4: "of shame" is gone ("I want to die of
 * shame because of what my uncle did"), and a wish to die of embarrassment "of being alive" or
 * "anymore" escalates (DIE_IDEATION_VOIDS).
 */
const DIE_HYPERBOLE_TAILS =
  'of embarrassment|of boredom|of laughter|of laughing|of cringe|of cuteness|of happiness|of excitement|of old age|from embarrassment|from boredom|from laughing|from laughter|from cringe|laughing';
/** Dyeing and hyperbole after "die" ("I wish I could die my hair blue", "die laughing"). */
const DYE_TAILS = `${DIE_HYPERBOLE_TAILS}|my hair|her hair|his hair|hair|eggs|the eggs|shirt|shirts|the shirt|clothes|fabric|it blue|it red|it green|it pink|it purple|it black`;
/**
 * Idioms and shows after "take my life" / "end it all" / "end my life": whole idioms only ("take
 * my life savings", "take my life in a new direction", "end it all with a big finale at the talent
 * show", "end my life as a kid and become a teenager"). Round 3 (CHK2-CS-1): the bare or prefix
 * tails "seriously", "with a big", "with a bang", "with a smile", "as a kid", "in my hands", "one
 * day at a time" and "step by step" are gone; they also cancelled "I want to die seriously" and "I
 * will end it all with a big bottle of pills".
 */
const END_LIFE_IDIOM_TAILS =
  'savings|in a new direction|in a different direction|more seriously|to the next level|with a big finale|with a finale|with a big show|with a big party|with a big dance|with a big song|with a song|with a dance|with a party|with a joke|on a high note|at the talent show|at the show|at the recital|at the concert|in the show|in the talent show|as a kid and become|as a kid and grow up|as a kid and start|as a child and become|as a child and grow up|as a little kid and become|as a baby and become|as a fifth grader and become|as a fifth grader and start|as a kindergartner and become|as a kindergartner and start';
/** Games and play after a first-person threat ("I'll kill you in Fortnite"). */
const GAME_CONTEXT_TAILS =
  'in mario|in super mario|in zelda|in the level|in this level|in level|in fortnite|in minecraft|in roblox|in the game|in a game|in games|in mario kart|in smash|in the video game|in video games|in among us|in pokemon|in tag|at tag|at chess|at checkers|in chess|in checkers|at fortnite|at minecraft|at roblox|at soccer|at basketball|at dodgeball|in dodgeball|at the race|in the race|at the game|in laser tag|at laser tag|in paintball|at paintball';
/**
 * Accidents after "I keep hurting myself" or "I cut myself again": named activities, places and
 * objects. Round 3 (CHK2-CS-1): "when i play", "when i practice" and "playing" were prefixes
 * ("... when I practice being sad"); rules that use this list also take SELF_HARM_DELIBERATE, so
 * "on purpose" or "to die" after an accident tail still escalates. Round 4 (CHK3-CS-4): a blade or
 * a room is no accident ("with scissors", "with the paper cutter", "in the kitchen" are gone: "I
 * cut myself again with scissors"), and an intent word never meets this list (SELF_HARM_INTENT has
 * no accident tail: "I want to cut myself again on the stove").
 */
const ACCIDENT_TAILS =
  'on the monkey bars|on the playground|on the bars|at recess|at practice|at soccer|at football|at basketball|at the park|playing sports|playing soccer|playing football|playing basketball|playing baseball|playing hockey|playing tag|playing dodgeball|playing outside|playing on the playground|playing at recess|in gym|in pe|by accident|on accident|when i fall|when i fell|falling|on my bike|on the trampoline|on the stairs|on paper|on the paper|on the stove|skateboarding|climbing|running|jumping|at dance|at gymnastics|in sports|in soccer|when i skate|when i skateboard|when i ride|when i ride my bike|when i bike|when i run|when i climb|when i jump|when i dance|when i swim|when i ski|when i snowboard|when i surf|when i do gymnastics|when i play sports|when i play soccer|when i play football|when i play basketball|when i play outside|when i play tag|when i play dodgeball|when i practice soccer|when i practice gymnastics|when i practice karate|when i practice dance|when i practice skateboarding|when i practice sports|when i practice football|when i practice basketball|while skating|while skateboarding|while riding|while running|while climbing|while jumping|skating|biking|riding my bike|at the skate park|at the skatepark|with the paper|with paper|with a paper|' +
  // CHK2-CS-5: wheels and play equipment.
  'on my scooter|on the scooter|on my skateboard|on the skateboard|on my skates|on my rollerblades|on my hoverboard|on the slide|on the swings|on the swing';
/**
 * Round 4 (CHK3-CS-4): a wrist is not cut in an activity or a room, so SELF_HARM_WRISTS has its own
 * short list: an object that cuts by accident (paper, glass, a fence, a can) or "by accident"
 * itself. "with scissors", "in the kitchen", "at the park" and "running" are not in it.
 */
const WRIST_ACCIDENT_TAILS =
  'by accident|on accident|with the paper by accident|with paper by accident|on a piece of paper|on the paper|on paper|on a piece of glass|on glass|on broken glass|on the glass|on a nail|on the fence|on a fence|on the edge of the table|on the sharp edge of the table|on the corner of the table|opening a can|on a can|on the can|on the lid';
/** A band or a watch after "my wrist" is the object, not the wrist ("I cut my wrist band off"). */
const WRIST_OBJECT_TAILS =
  'band|bands|wristband|bracelet|bracelets|watch|tag|brace|guard|guards|strap|cast|sweatband';
/**
 * Words after "I will kill ..." that are not a person (the `*` of VIOLENCE_THREAT_NAME and
 * VIOLENCE_WISH_DEATH_NAME): pronouns and determiners (other rules cover people named that way),
 * game and everyday objects, time words.
 */
const NOT_A_PERSON =
  `${SELF}|${YOURSELF}|` +
  'i|me|myself|you|u|ya|yourself|him|himself|her|herself|them|themselves|us|ourselves|it|its|itself|this|that|these|those|the|a|an|some|my|your|ur|his|their|our|all|any|every|each|no|one|two|three|four|five|ten|off|on|at|for|with|in|to|up|down|out|back|now|today|tonight|tomorrow|later|again|soon|so|too|really|everything|nothing|something|anything|everyone|everybody|someone|somebody|anyone|anybody|people|time|zombies|zombie|monsters|monster|bugs|bug|flies|fly|mosquitoes|mosquito|spiders|spider|ants|ant|roaches|cockroaches|germs|bacteria|weeds|rats|rat|mice|mouse|dragon|dragons|boss|bosses|mobs|mob|creepers|creeper|enemies|enemy|aliens|alien|villains|villain|boredom|noobs|noob|bots|bot|players|npcs|npc|hoops|baskets|basket|pictures|photos|video|videos|arrows|lights|pizza|dinner|lunch|breakfast|homework|test|tests|quiz|math|level|game|games|round|dance|song|show|race|contest|feelings|feeling|chess|checkers|fortnite|minecraft|roblox|pool|darts|dart|marbles|targets|target|goals|goal|free|buckets|bucket|threes|layups|fireworks|rockets|rocket|bubbles|water|balloons|balloon|snowballs|snowball|lasers|laser|movie|film|scene|bowser|ganon|herobrine|enderman|endermen|wither|skeletons|skeleton|goblins|goblin|orcs|orc|trolls|troll|ghosts|ghost|robots|robot|slimes|slime|plants|plant|trees|flowers|fish|deer|birds|bird|cats|dogs|and|or|but|if|when|because|than|then|like|as|is|was|be|are|not|dont|never|just|only|very|much|more|most|by|from|of|about|into|over|after|before|' +
  // CHK-CS-8: days, school subjects and work, games and story villains. Round 3 (CHK2-CS-6):
  // words that are also real first names ("Art", "Mario", "Ursula", "Jafar") are left out.
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekend|weekends|week|english|spanish|french|science|history|reading|writing|spelling|grammar|geography|music|gym|pe|recess|algebra|geometry|biology|chemistry|physics|piano|practice|worksheet|worksheets|essay|essays|project|projects|assignment|assignments|exam|exams|finals|midterm|midterms|pokemon|bingo|uno|monopoly|tetris|pacman|voldemort|darth|vader|thanos|sauron|joker|grinch|maleficent|megatron|dracula';
/**
 * Things after a possessive name ("shoot Grandpa's camera", "kill Grandma's plants"): the name
 * owns the object, it is not the target. CHK-CS-8. Round 3 (CHK2-CS-6): no groups of people ("I
 * will shoot Sam's class", "kill Riley's team" are threats against people).
 */
const POSSESSED_OBJECTS =
  'camera|phone|plants|plant|flowers|garden|car|bike|computer|tablet|ipad|laptop|toys|toy|game|games|lego|legos|drawing|picture|project|cake|cookies|homework|record|high score|score|sandcastle|tower|character|avatar|tv|show|song|video|chances|dreams|mood|joke|idea|ideas';

/** Reported threats: "my dad said he would kill me", "she says she will hurt me". */
const REPORTED_THREAT = (() => {
  const reporting = [
    'said',
    'says',
    'told me',
    'tells me',
    'told us',
    'keeps saying',
    'always says',
    'yelled',
    'yells',
    'screamed',
    'screams',
    'threatened',
    'threatens',
    'said that',
    'says that',
    'told me that',
  ];
  const pronouns = ['he', 'she', 'they'];
  const future = [
    'will',
    'would',
    'is going to',
    'was going to',
    'is gonna',
    'was gonna',
    'gonna',
    'are going to',
    'were going to',
    'wants to',
    'wanted to',
    'might',
    'could',
  ];
  return reporting
    .flatMap((r) => pronouns.flatMap((p) => future.map((f) => `${r} ${p} ${f}`)))
    .join('|');
})();
const THREAT_OBJECTS =
  'me|us|my mom|my mother|my mommy|my mama|mom|mommy|my dad|my father|my daddy|my sister|my brother|my baby brother|my baby sister|my little brother|my little sister|my family|my dog|my cat|my pet';
const SURPRISE_TAILS =
  'about the surprise|about the party|about the present|about the gift|about my present|about her present|about his present|about the cake|about the surprise party|what i got|what we got|what we bought|my password|the password|your password|my pin|the surprise|the answer|the answers|answers|about her birthday|about his birthday|about my birthday|about moms birthday|about dads birthday|about the birthday|about her gift|about his gift|about my gift|about christmas|about the christmas|about the trip|about the prize|what we are getting|what were getting|what i am getting|what im getting|' +
  // Round 2: ordinary secrets between siblings and a new pet or baby.
  'her crush|his crush|my crush|about her crush|about his crush|about my crush|who she likes|who he likes|who i like|about the puppy|about our puppy|about the new puppy|about the kitten|about the new kitten|about the new baby|about the new pet|its a surprise|it is a surprise|its a secret surprise|' +
  // Round 3 (CHK2-CS-5): a bad grade, and a gift for a parent ("it's for Mother's Day").
  'she got a bad grade|he got a bad grade|i got a bad grade|about her bad grade|about his bad grade|about my bad grade|about the bad grade|about her grade|about his grade|about my grade|its for mothers day|it is for mothers day|its for fathers day|it is for fathers day|its for moms birthday|its for dads birthday|its for her birthday|its for his birthday';

/** Educational cue words by topic (tier-B exemptions for a child's text). */
const LITERATURE_HEALTH_HISTORY_CUES =
  'story|poem|character|characters|novel|author|history|historical|prevention|awareness|lesson|chapter|play|romeo|juliet|hotline|lifeline|book|act|scene|poet|hamlet|tragedy|article|essay|research|health|report|war|ancient|century|king|queen|emperor';
const HISTORY_RIGHTS_CUES =
  'war|history|historical|soldiers|army|genocide|holocaust|slavery|enslaved|crime|crimes|law|laws|rights|court|justice|report|protect|protection|safety|prevention|awareness|lesson|story|novel|character|book|century|invasion|conquest|refugees';
const BODY_SCIENCE_CUES =
  'puberty|body|bodies|reproduction|reproductive|health|biology|organ|organs|system|hormones|hormone|sperm|egg|eggs|cells|cell|mammals|mammal|species|science|anatomy|glands|gland|development|growth|changes';

// ---------------------------------------------------------------------------------------------
// Severe rules
// ---------------------------------------------------------------------------------------------

export const RULES: readonly RuleDef[] = [
  // ---- Self-harm and suicide ideation (first person) ----------------------------------------
  {
    id: 'SELF_HARM_KILL_SELF',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `kill|killing|killed|kms|hang|hanging +0 ${SELF}`,
    doc: 'Any mention of killing or hanging oneself ("kill myself", "k1ll mys3lf"), including hyperbole: a person reviews it.',
  },
  {
    id: 'SELF_HARM_WANT_TO_DIE',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 want to|wanna|want 2|want|wanted to|wish i could|would like to|am going to|going to|gonna|feel like|just want to|should|should just|plan to|am ready to|ready to|deserve to|need to +1 die|be dead|not be alive|not exist|stop existing|never wake up|end it all|end my life|disappear forever`,
    negatable: true,
    notFollowedBy: `${DYE_TAILS}|${LIFE_PROJECT_TAILS}|${END_LIFE_IDIOM_TAILS}`,
    unlessAfter: DIE_IDEATION_VOIDS,
    doc: 'First-person wish or plan to die ("I want to die", "I should just die"); negation ("I don\'t want to die") and dye/hyperbole tails ("die my hair", "die of boredom") excluded.',
  },
  {
    id: 'SELF_HARM_WANT_TO_DIE_BARE',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern:
      'want to|wanna|want 2|just want to|really want to|wanted to|wish i could|would like to|ready to|deserve to +0 die|be dead|not be alive|not exist|stop existing|never wake up|end it all|end my life|kill myself',
    negatable: true,
    notPrecededBy:
      'you|u|ya|who|they|he|she|it|we|nobody|noone|anyone|anybody|people|does|do|did|would|character|characters|soldiers|soldier|plant|plants|animal|animals|tree|trees|fish|bug|bugs',
    notFollowedBy: `${DYE_TAILS}|${LIFE_PROJECT_TAILS}|${END_LIFE_IDIOM_TAILS}`,
    unlessAfter: DIE_IDEATION_VOIDS,
    doc: 'A wish to die with the subject left out or far away ("wanna die", "I hate my life and want to die"); another subject ("Do you want to die?", "The plants want to die") and dye/hyperbole tails are excluded.',
  },
  {
    id: 'SELF_HARM_RATHER_DEAD',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +1 would rather|rather|would sooner|had rather +0 be dead|die|not be alive|not exist|not be born|never have been born|kill myself`,
    negatable: true,
    notFollowedBy: `than|then|${DIE_HYPERBOLE_TAILS}`,
    unlessAfter: `${SELF_HARM_DELIBERATE}|live|living|alive|go home|go back home|be here|be at home|exist|this life|like this|stay here|be with|keep going`,
    doc: 'Preferring death ("I\'d rather be dead"); the common comparison hyperbole ("I would rather die than eat broccoli") is excluded and documented as a limit, unless the comparison is living or going home ("I would rather die than live like this", "... than go home").',
  },
  {
    id: 'SELF_HARM_KMS_INTENT',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I}|should|gonna|wanna|finna|just|about to|gotta|going to|want to|will|might|could|would|need to|lemme|let me|ima|i should|i will|i will probably|i will prob|i will prolly|i will finally|i will literally|i will actually|i will definitely|i will really|i will just|i might just|i should just +0 kms`,
    doc: '"kms" (kill myself) after a first person or an intent word ("I should kms", "gonna kms", round 4: "ill probably kms"); "5 kms" and "convert to kms" are distances.',
  },
  {
    id: 'SELF_HARM_KMS_ALONE',
    kind: 'severe',
    category: 'self_harm',
    topic: 'self_harm_topic',
    sources: BOTH,
    pattern: 'kms',
    alone: true,
    exempt: {
      subjects: ['math', 'science'],
      cues: 'km|kilometer|kilometers|kilometre|kilometres|distance|unit|units|meter|meters|metre|metres|mile|miles|measure|length|far|convert',
    },
    doc: 'Tier B: a bare "kms" as the whole answer is the self-harm slang; as a math or science unit answer ("Which unit…?") it is educational.',
  },
  {
    id: 'SELF_HARM_NOT_LIVE',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +1 dont|do not|dont even|no longer|do not even|never|dont really +1 want to|wanna|want 2|want|wish to|feel like|deserve to +0 live|be alive|exist|be born|go on living|be on this earth|live anymore|live any more`,
    notFollowedBy: 'in|on|at|with|near|there|here|far|by|next|inside|outside',
    unlessAfter: `${SELF_HARM_DELIBERATE}|anymore|any more|this world|a world|the world|this earth|pain|like this|this life|myself|what i did|what happened|dead|die|dying`,
    doc: 'First-person statement of not wanting to live or exist ("I don\'t want to live anymore"); a residence after "live" ("live in a city", "live near the beach") is excluded unless an ideation word follows in the sentence ("... in this world anymore", "... with this pain"). Round 3: "like" and "without" are no longer exclusions ("I don\'t want to live like this").',
  },
  {
    id: 'SELF_HARM_NOT_LIVE_DOUBT',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern:
      'dont think|do not think|dont know if|do not know if|not sure if|not sure +0 i +0 want to live anymore|want to live any more|wanna live anymore|want to be alive|wanna be alive|want to stay alive|wanna stay alive|want to exist|wanna exist|want to keep living|wanna keep living|want to go on living|want to be here anymore|can keep living|can go on living|can live anymore|can live any more|can be alive anymore|can stay alive anymore|should live|should be alive|should keep living|should exist|deserve to live|deserve to be alive',
    notFollowedBy: GAME_CONTEXT_TAILS,
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'Round 3: not wanting to live, framed as doubt ("I don\'t think I want to live anymore", "I\'m not sure I can keep living"); SELF_HARM_NOT_LIVE needs the negation next to "want". A game ("stay alive in the game") is excluded. Round 4 (CHK3-CS-6): only doubt about wanting, deserving or going on living; surviving is not ("I don\'t think I can stay alive without water for a week", "... without my phone").',
  },
  {
    id: 'SELF_HARM_WISH_DEAD',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +1 wish|wished +0 i|id|that i +1 was|were|could be|would be|could just be +1 dead|gone forever|never born|not born|not alive`,
    doc: 'First-person wish to be dead or never born ("I wish I was dead"); a wish about someone else ("I wish my grandpa was not dead") does not match.',
  },
  {
    id: 'SELF_HARM_WISH_UNBORN',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +1 wish|wished +0 i|id|that i +1 wasnt|werent|hadnt|had never|never|was never|were never|had not|was not|were not +0 born|been born|existed|alive`,
    doc: 'First-person wish never to have been born ("I wish I wasn\'t born"); "I wish I was born in summer" does not match.',
  },
  {
    id: 'SELF_HARM_NOBODY_WOULD_MISS',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `nobody|no one|noone|no body|not one person|nobody else|no one else +1 would|will|wouldnt|is going to|gonna|even +1 miss|care if|care that|notice if|cry if|even notice if|really miss +0 me|i|${YOU}`,
    notFollowedBy:
      'left early|leave early|left the party|left class|left school early|left practice early|was late|came late|took one cookie|took a cookie|took the last cookie|took the last one|took an extra|ate the last|ate a cookie|ate one cookie|had a cookie|had dessert|had seconds|skipped class|skipped school|skipped practice|skipped my homework|cheated|copied|missed class|missed school|missed practice|missed the bus|forgot my|wore my|wore pajamas|borrowed a|borrowed the|borrowed his|borrowed her|used the|used his|used her|went home early|went to the bathroom|sneaked a|snuck a|stayed up late|played video games|played outside|played games|played on my phone',
    unlessAfter: `${SELF_HARM_DELIBERATE}|died|dead|was gone|disappeared|ran away|never came back`,
    doc: 'Perceived burdensomeness ("nobody would miss me", "no one would care if I died"); in model output also "nobody would miss you". An everyday "no one would notice if I left early" is excluded. Round 3: whole phrases only ("took a", "took the", "ate", "had", "did" also cancelled "no one would care if I took the pills").',
  },
  {
    id: 'SELF_HARM_BETTER_OFF',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `better off +1 without me|without ${YOU}|if i was dead|if i died|if i was gone|if i wasnt here|dead|if i were dead|if i were gone|if i never existed`,
    doc: 'Perceived burdensomeness ("everyone would be better off without me", "better off dead").',
  },
  {
    id: 'SELF_HARM_INTENT',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 ${SELF_INTENT} +1 hurt|cut|harm|burn|starve|punish|kill|hang|poison|drown|stab|shoot|choke|suffocate|smother|slit|slash|slice|destroy|end|hurting|cutting|harming|burning|starving +0 ${SELF}|my wrist|my wrists|my own wrist|my own wrists|both my wrists|both wrists`,
    negatable: true,
    notFollowedBy: `a slice|a piece|slices|a snack|a sandwich|a bite|a break|some slack|a haircut|some cake|some bread|some pie|some pizza|some cheese|some fruit|a cookie|loose|free|${WRIST_OBJECT_TAILS}`,
    doc: 'First-person intent to injure oneself or one\'s wrists ("I want to hurt myself", "I tried to hurt myself", "I want to cut my wrists with scissors", "I will slit my wrists", "I want to keep hurting myself"; round 4: "ill destroy myself", "I want to end myself"; not "off", which is "of" once repeats collapse: "I want to think of myself as a leader"); an accident ("I fell and hurt myself") has no intent word and does not match, nor does food ("I\'m going to cut myself a slice of cake") or a band ("I\'m going to cut my wrist band off"). Round 4 (CHK3-CS-4): no accident tail applies after an intent word, and the wrists are covered here.',
  },
  {
    id: 'SELF_HARM_HABIT',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 cut|cuts|cutting|hurt|hurting|harm|harming|burn|burning|starve|starving|scratch|scratching|hit|hitting|punch|punching +0 ${SELF} +3 on purpose|every day|everyday|every night|again and again|sometimes|a lot|alot|to feel|to make|so i can feel|when im sad|when i am sad|when im upset|when i feel|all the time|at night`,
    doc: 'First-person repeated or deliberate self-injury ("I cut myself on purpose"); "I cut myself on a piece of paper" has no marker and does not match. Round 4 (CHK3-CS-4): up to three words may come before the marker ("I cut myself with scissors on purpose").',
  },
  {
    id: 'SELF_HARM_STARVE',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +1 ?always|still|sometimes|often|usually|just|try to|keep +0 starve|starved +0 ${SELF}`,
    negatable: true,
    notFollowedBy:
      'before thanksgiving|before a big dinner|before the buffet|before the party|before a party|before my birthday dinner|so i have room|so i can eat more|so i can eat a lot|to save room|to have room|on thanksgiving|at thanksgiving|for thanksgiving|for the buffet|for the feast|of video games|of screen time|of tv|of my phone|of youtube|of social media|of games',
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'First-person starving oneself ("I starve myself", "I starve myself of food"); saving room for a feast ("I starve myself before Thanksgiving dinner") and giving up screens ("I starve myself of video games") are excluded. Round 3 (CHK2-CS-1): the bare "for", "of", "before" and "until" are gone ("I starve myself for days").',
  },
  {
    id: 'SELF_HARM_AGAIN',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 cut|burned|burnt|scratched|cutting|burning|scratching|harming|harmed +0 ?${SELF} +0 again`,
    negatable: true,
    notFollowedBy: ACCIDENT_TAILS,
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'First-person self-injury happening again ("i cut myself again", "im cutting again"); an accident ("I cut myself again on the paper") and another object ("cutting paper again") do not match. Round 3: the bare "on a", "with a", "in the" and "at the" are gone ("I cut myself again with a razor").',
  },
  {
    id: 'SELF_HARM_ONGOING',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 been|keep|kept|started|start|have been|am|m +1 cutting|harming|burning|starving +0 ${SELF}`,
    doc: 'First-person ongoing self-injury ("I have been cutting myself").',
  },
  {
    id: 'SELF_HARM_ONGOING_HURT',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 been|keep|kept|have been|am|m|started|start|always|was +1 hurting|hitting|punching|scratching|biting +0 ${SELF}`,
    notFollowedBy: ACCIDENT_TAILS,
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'First-person ongoing self-injury ("I\'ve been hurting myself", "I keep hurting myself"); an accident ("I keep hurting myself on the monkey bars") is excluded unless a deliberate word follows.',
  },
  {
    id: 'SELF_HARM_END_LIFE',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 ${SELF_INTENT}|shall|might|could|may +1 end my life|end my own life|ending my life|take my life|take my own life|taking my life|end it all|ending it all`,
    negatable: true,
    notFollowedBy: `${LIFE_PROJECT_TAILS}|${END_LIFE_IDIOM_TAILS}`,
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'First-person plan to end one\'s life ("I will end my life", "I\'ll end it all"); "I don\'t want to end my life" is negated, and "I will end my turn", a project ("end my life cycle poster") and idioms ("take my life savings", "end it all with a big finale") do not match.',
  },
  {
    id: 'SELF_HARM_WRISTS',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: 'cut|cuts|cutting|slice|slicing|cut open +0 my|my own +0 wrist|wrists',
    negatable: true,
    notFollowedBy: `${WRIST_ACCIDENT_TAILS}|${WRIST_OBJECT_TAILS}`,
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'Cutting one\'s own wrists ("i cut my wrists last night", "I cut my wrists with scissors", "I cut my wrists in the kitchen"); an accident with an object that cuts by accident ("I cut my wrist on a piece of glass", "... opening a can") or a band ("I cut my wrist band off") is excluded unless a deliberate word follows. Round 3: the bare "on a", "on the" and "off" are gone ("I cut my wrists off"). Round 4 (CHK3-CS-4): activities, rooms and blades are no longer accidents here, a plan ("I want to cut my wrists ...") is SELF_HARM_INTENT, and "slit" or "slash" is SELF_HARM_WRISTS_SLIT.',
  },
  {
    id: 'SELF_HARM_WRISTS_SLIT',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern:
      'slit|slits|slitting|slash|slashes|slashed|slashing +0 my|my own|both my|both +0 wrist|wrists',
    negatable: true,
    notFollowedBy: WRIST_OBJECT_TAILS,
    doc: 'Round 4 (CHK3-CS-4; split from SELF_HARM_WRISTS): slitting or slashing one\'s wrists is deliberate, so no accident tail applies ("I slit my wrists in the kitchen"); only a band is excluded.',
  },
  {
    id: 'SELF_HARM_HOPE_DIE',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +1 hope|wish|pray +0 i|that i +1 die|would die|will die|could die|just die|dont wake up|do not wake up|never wake up|wont wake up|get hit by a car|get hit by a bus|drop dead`,
    negatable: true,
    notFollowedBy: `${DYE_TAILS}|old and|when i am old|when im old|when i get old|an old man|an old woman|an old lady|very old|really old`,
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'First-person hope or wish to die ("I hope I die", "I wish I would die"); "I hope I don\'t die on this test" is negated, and dyeing ("I wish I could die my hair blue") is excluded.',
  },
  {
    id: 'SELF_HARM_KILL_ME',
    kind: 'severe',
    category: 'self_harm',
    sources: CHILD,
    pattern:
      'please kill me|pls kill me|plz kill me|someone kill me|somebody kill me|someone please kill me|somebody please kill me|just kill me|kill me now|kill me please',
    doc: 'Asking to be killed ("please kill me", "someone kill me"), hyperbole included: a person reviews.',
  },
  {
    id: 'SELF_HARM_SWALLOWED',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 drank|swallowed|drink|swallow|drinking|swallowing|ate|eat +0 bleach|the bleach|some bleach|poison|rat poison|some poison|the poison|antifreeze|drain cleaner`,
    negatable: true,
    notFollowedBy: GAME_CONTEXT_TAILS,
    notFollowedWithin: 2,
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'First-person drinking or swallowing bleach or poison ("I drank bleach", "I ate poison berries"); third-person story text ("Romeo drank poison") has no first person, and a game named within two words ("I ate poison berries in Minecraft", "the poison potion in Minecraft") is excluded. Round 3 (CHK2-CS-1): the items themselves ("berries", "potion", "mushrooms") are no longer exclusions.',
  },
  {
    id: 'SELF_HARM_SUICIDAL_STATEMENT',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 feel|am|m|feeling|have been|been|get|getting|was +1 suicidal`,
    doc: 'First-person statement of feeling suicidal; never exempt, whatever the subject.',
  },
  {
    id: 'SELF_HARM_SUICIDE_PLAN',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 want to|wanna|want|wanted to|will|going to|gonna|should|plan to|am going to|think about|thinking about|thought about|thinking of|keep thinking about|decided to|tried to|tried|attempted|attempt to|considered|considering|am considering|feel like|felt like|feeling like|finna +1 commit suicide|suicide|killing myself|ending my life|ending it all|dying|not being alive|being dead|kill myself|overdose|overdosing|od`,
    negatable: true,
    notFollowedBy: DYE_TAILS,
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'First-person plan, attempt or recurring thought of suicide or dying ("I think about killing myself", "I tried to commit suicide", "I feel like dying"); dyeing ("thinking of dying my hair") and hyperbole ("dying of laughter") excluded.',
  },
  {
    id: 'SELF_HARM_OVERDOSE_PLAN',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 ${OVERDOSE_INTENT} +1 take|swallow|eat|drink|overdose on +1 all|a lot of|lots of|a bunch of|the whole|every|too many|a handful of|handful of|all of +0 the pills|the medicine|the meds|the tablets|pills|medicine|meds|tablets|the bottle|bottle|the pill bottle|sleeping pills|the sleeping pills|of the pills|of the medicine`,
    negatable: true,
    notFollowedBy: AS_DIRECTED_TAILS,
    unlessAfter: SELF_HARM_DELIBERATE,
    doc: 'First-person plan to overdose ("I want to take all the pills"); taking one\'s own medicine as directed ("I have to take all my pills with breakfast", "I will take all my medicine before bed") is excluded.',
  },
  {
    id: 'SELF_HARM_OVERDOSE_OTHERS_PILLS',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 ${OVERDOSE_INTENT} +1 take|swallow|eat|drink|steal +1 all|a lot of|lots of|a bunch of|the whole|every|too many|a handful of|all of|some of|the +0 my moms|my dads|my mom s|my dad s|my parents|my grandmas|my grandpas|my sisters|my brothers|moms|dads|mommys|daddys|grandmas|grandpas|her|his|their|someones|somebodys +1 pills|medicine|meds|tablets|sleeping pills|pill bottle`,
    negatable: true,
    doc: 'First-person plan to take someone else\'s pills in quantity ("I will take all my mom\'s pills").',
  },
  {
    id: 'SELF_HARM_JUMP_PLAN',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 ${SELF_INTENT} +1 jump off|jump in front of|jump from|throw myself off|throw myself in front of +2 bridge|building|roof|cliff|train|car|window|balcony|a bus|a truck|traffic`,
    negatable: true,
    doc: 'First-person plan to jump from a height or in front of traffic ("I want to jump off a bridge"); "jump off the diving board" does not match.',
  },
  {
    id: 'SELF_HARM_ENCOURAGE',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `kill|hang|stab|shoot|drown|poison|go kill +0 ${YOURSELF}`,
    negatable: true,
    doc: 'Telling someone to kill themselves ("kill yourself"); in model output this is never acceptable. "Don\'t ..." is negated.',
  },
  {
    id: 'SELF_HARM_ENCOURAGE_SLANG',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `kys|go die|${YOU} should die|${YOU} should just die|hope ${YOU} die|drink bleach|end yourself|unalive yourself|unalive myself|unalive`,
    doc: 'Self-harm slang and encouragement ("kys", "go die", "unalive").',
  },
  {
    id: 'SELF_HARM_ENCOURAGE_HURT',
    kind: 'severe',
    category: 'self_harm',
    sources: AI,
    pattern: `hurt|harm|cut|burn|starve|punish +0 ${YOURSELF}`,
    negatable: true,
    doc: 'Model output suggesting the child hurt themselves; safety cautions ("be careful not to hurt yourself") are negated and pass.',
  },
  {
    id: 'SELF_HARM_TERM',
    kind: 'severe',
    category: 'self_harm',
    topic: 'self_harm_topic',
    sources: BOTH,
    pattern:
      'suicide|suicidal|sucide|suiside|suicid|suicides|self harm|selfharm|self harming|self injury|selfinjury|overdose|overdosed|overdosing',
    exempt: {
      subjects: ['reading', 'social_studies', 'science'],
      cues: LITERATURE_HEALTH_HISTORY_CUES,
    },
    doc: 'Tier B: the words suicide / self-harm / overdose. Severe on their own (a child writing "suicide" as an answer), educational in a reading, history or health context ("Romeo committed suicide").',
  },
  {
    id: 'SELF_HARM_ONLY_WAY_OUT',
    kind: 'severe',
    category: 'self_harm',
    sources: CHILD,
    pattern:
      'suicide|killing myself|ending my life|ending it all|dying +0 is the only way out|is the only way|is my only way out|is my only way|is the only answer|is my only answer|is the only option|is my only option|is the only option left|is the only choice|is my only choice|is the way out|is my way out|is the best way out|is the only solution|is my only solution|is the only thing left|seems like the only way|seems like the only way out|' +
      // Round 3: endorsement ("I agree that suicide is the answer", "suicide is the way to go").
      'is the answer|is my answer|is the way to go|is the best thing|is the best way|is the best choice|is the best option|is a good idea|is a good choice|is the right choice|is the right thing to do',
    negatable: true,
    answerOnly: true,
    guard: {
      words:
        'he|she|they|him|them|character|characters|narrator|romeo|juliet|hamlet|king|queen|people|person|persons|someone|somebody|teen|teens|teenager|teenagers|kid|kids|child|children|student|students|soldier|soldiers|others|author|poem|poet|story|book|novel|play|some|many|most|thinks|believes|believed|felt|feels|said|says|decided|think|believe|feel|thought|' +
        // Round 4 (CHK3-CS-6): a third person's decision, writing or choice, a question, and the
        // historical and literary figures K-8 lessons discuss ("Antony wrote that ...", "Brutus
        // decides ...", "Socrates chooses death because ...", "whether suicide is the answer").
        // Not "knows" or "knew": "Everyone knows suicide is the only way out" is the child's claim.
        'decides|decide|chooses|choose|chose|wrote|writes|argues|argued|claims|claimed|whether|cleopatra|brutus|antony|othello|ophelia|macbeth|socrates|cassius',
      within: 8,
      stopAtFirstPerson: true,
      holderTo: true,
    },
    doc: 'Suicide as the only way out, or endorsed ("... is the answer", "... is the way to go"), with no third person holding the view ("I think suicide is the only way out" in a reading answer): an opinion frame is not a first person (CHK-CS-3), so this ideation shape has its own rule. A third person within eight words holds the view unless a first-person word is nearer or right before the verb ("Romeo thinks ...", "Teens may think ...", "A person might feel ...", "To Cleopatra, ..."; but "I think ..." and "We believe ..."), and a negation cancels it ("I don\'t think suicide is the answer"); "Suicide is never the only way out" does not match. Round 3 (CHK2-CS-4): the child\'s answer only, never the printed prompt ("Why might a teen think suicide is the only way out?").',
  },

  // ---- Abuse or neglect disclosure ----------------------------------------------------------
  {
    id: 'ABUSE_PHYSICAL_HABITUAL',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ABUSERS} +2 hits|beats|punches|kicks|slaps|chokes|burns|whips|smacks|hurts|throws|pushes|shoves|strangles|spanks|bites|abuses|abuse|attacks|pinches|belts +0 me|us`,
    negatable: true,
    hypothetical: true,
    notFollowedBy: GAME_AND_PLAY_TAILS,
    doc: 'Present-tense (habitual) violence against the child ("my dad hits me", "she hurts me in the face", "my parents abuse me"); games and play ("beats me at chess", "pushes me on the swing"), negation and "if" hypotheticals excluded. Siblings are included: a person reviews.',
  },
  {
    id: 'ABUSE_PHYSICAL_ADULT_PAST',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ADULT_ABUSERS} +2 hit|beat|punched|kicked|slapped|choked|burned|burnt|whipped|smacked|hurt|threw|pushed|shoved|strangled|spanked|abused|attacked|belted +0 me|us`,
    negatable: true,
    hypothetical: true,
    notFollowedBy: GAME_AND_PLAY_TAILS,
    doc: 'Past-tense violence by an adult ("my dad hit me with a belt"); a peer in a game ("he hit me with the ball") is not covered.',
  },
  {
    id: 'ABUSE_GET_HIT',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${I} +1 get|got|am|m|was|keep getting|always get|gets|getting|am getting|was getting|been getting|have been getting +0 hit|beaten|beat|whipped|punched|kicked|slapped|choked|burned|abused|hurt|spanked|belted +1 at home|by my|by him|by her|when i get home|by dad|by mom|with a belt|with the belt|every day|every night|a lot|alot`,
    negatable: true,
    notFollowedBy:
      'when i fell|because i fell|when i tripped|because i tripped|from falling|by accident|on accident|playing|when i was playing|while playing|when i crashed',
    doc: 'Passive disclosure of being hit at home or by a family member ("I get hit at home", "I\'m getting hit at home"); an accident ("I got hurt at home when I fell off my bike") is excluded.',
  },
  {
    id: 'ABUSE_BEING_ABUSED',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${I} +1 am|m|was|have been|been|get|keep +0 being abused|abused|being hurt at home|being hit|being beaten|getting hit at home|getting beaten|getting abused|being touched`,
    negatable: true,
    hypothetical: true,
    doc: 'First-person statement of being abused ("I am being abused"); a hypothetical ("If I was abused I would tell my teacher") is excluded.',
  },
  {
    id: 'ABUSE_TOUCHED_BY',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern: `${I} +1 was|am|m|got|get|gets|have been|been|keep getting|kept getting|was being|am being|m being +0 touched|groped|fondled +0 by +0 ${TOUCHED_BY_PERSONS}`,
    negatable: true,
    hypothetical: true,
    guard: BODY_SAFETY_LESSON,
    doc: 'Round 4: first-person disclosure of being touched by a person ("I was touched by my coach", "At St. Mary\'s I was touched by the priest"), which ABUSE_BEING_ABUSED ("being touched") did not read. Only a person noun or "him" after "by", so "touched by the story" and "touched by my teacher\'s words" do not match; a doctor or nurse is left out (a check-up). "I was touched by my teacher" said of a kind gesture escalates and a reviewer clears it.',
  },
  {
    id: 'ABUSE_SEXUAL_PASSIVE',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${I}|we|my sister|my brother +2 was|am|m|got|get|gets|have been|has been|been|being|keep getting|was being|were|are|is +1 raped|molested|sexually abused|sexually assaulted|groped|abused|assaulted|raped by|molested by`,
    negatable: true,
    hypothetical: true,
    doc: 'First-person (or sibling) disclosure of sexual abuse in the passive ("I was raped", "I got molested"). Never exempt: a reading subject or a cue word such as "lesson" does not soften it.',
  },
  {
    id: 'ABUSE_SOMEONE_HURTING',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ABUSERS} +1 is|was|keeps|kept|has been|been|always|are|were|keep +0 hurting|abusing|hitting|beating|touching|choking +0 me|us`,
    negatable: true,
    hypothetical: true,
    doc: 'Ongoing harm by a person ("someone is hurting me", "my dad keeps hitting me").',
  },
  {
    id: 'ABUSE_SEXUAL_ABUSE',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'abuses|abused|abusing|molests|molested|molesting|rapes|raped|raping|sexually abused|sexually abuses|sexually abusing|sexually assaulted|sexually assaults +0 me|us|my sister|my brother',
    hypothetical: true,
    doc: 'Disclosure that the child (or a sibling) was abused, molested or raped; always severe.',
  },
  {
    id: 'ABUSE_TOUCH_PRIVATE',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'touch|touches|touched|touching|rubs|rubbed|rubbing|feels|felt|grabs|grabbed|licks|licked|kisses|kissed|pokes|poked +0 me|my|us +2 private|privates|private parts|private part|private area|down there|no no square|underwear|between my legs|where my underwear|where my swimsuit|under my clothes|under my shirt|under my pants|in my pants|in my underwear',
    negatable: true,
    hypothetical: true,
    notPrecededBy: 'let|should|shouldnt|not|never|dont|allowed|ok|okay|can',
    guard: BODY_SAFETY_LESSON,
    doc: 'Disclosure of sexual touching ("he touches my private parts"); body-safety lesson answers ("if someone touches my private parts I say no", "never let anyone touch my private parts", "no one is allowed to ...") are excluded by the hypothetical, negation and lesson-phrasing guards (four words back, same sentence).',
  },
  {
    id: 'ABUSE_TOUCH_WRONG',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'touch|touches|touched|touching +0 me +1 in a|in the|where|in places|in ways +1 bad|wrong|weird|private|uncomfortable|not ok|secret|i dont like|that i dont like|places',
    negatable: true,
    hypothetical: true,
    guard: BODY_SAFETY_LESSON,
    doc: 'Disclosure of unwanted touching ("my uncle touched me in a bad way").',
  },
  {
    id: 'ABUSE_MADE_ME_UNDRESS',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'makes|made|make|tells|told|asked|asks|forces|forced|wants|wanted|tries to|tried to|try to +0 me +1 touch|to touch|take off|to take off|undress|to undress|get naked|to get naked|show|to show|pull down|to pull down|look at|to look at|watch|to watch +2 private|privates|private parts|clothes|pants|underwear|naked|nude|swimsuit|bathing suit|porn|dirty videos|dirty pictures',
    hypothetical: true,
    doc: 'Coerced undressing or sexual exposure ("she made me take off my clothes"); "made me take off my muddy shoes" does not match.',
  },
  {
    id: 'ABUSE_SHOWED_SEXUAL',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'showed|shows|show|sent|sends|send +0 me|us +2 naked|nude|private|privates|dirty|inappropriate|porn|sexy|grown up|adult +0 pictures|pics|videos|photos|parts|movies|stuff|things|body|pictures of|videos of',
    doc: 'Exposure of the child to sexual material ("he showed me naked pictures").',
  },
  {
    id: 'ABUSE_NEGLECT_FEEDING',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'nobody|no one|noone|no body|no grown up|no adult +1 feeds|feed|fed|makes food for|takes care of|looks after|cares for|gives food to +0 me|us',
    doc: 'Neglect: no one feeds or looks after the child ("nobody feeds me").',
  },
  {
    id: 'ABUSE_NEGLECT_NOT_FED',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern: `${ABUSERS} +1 dont|doesnt|do not|does not|never|wont|will not|refuse to|refuses to|stopped|forget to|forgets to|always forget to +0 feed me|feed us|give me food|give us food|give me anything to eat|give us anything to eat|make me food|make us food|give me enough food|give us enough food|give me enough to eat|give us enough to eat|buy me food|buy us food`,
    notFollowedBy:
      'candy|sweets|dessert|junk food|chips|sugar|cookies|ice cream|in the car|in my room|in our rooms|on the couch|before dinner|after dinner|in the living room|snacks|fast food|after bedtime|pizza|cake|soda|gum|' +
      // CHK-CS-5: a clock time and food the child dislikes are house rules, not neglect.
      'after 5|after 6|after 7|after 8|after 9|after 10|after five|after six|after seven|after eight|after nine|after ten|between meals|late at night|past bedtime|vegetables|veggies|broccoli|carrots|peas|spinach|salad|beans|mushrooms|spicy food|food i hate|food i dont like|food i do not like|things i hate|things i dont like|what i want|what i like|anything i want|second helpings|extra dessert|extra snacks|extra treats|extra candy|more dessert|more candy|more snacks|more treats|breakfast on weekends|breakfast on the weekend|breakfast on the weekends|breakfast on saturdays|breakfast on sundays|breakfast on saturday|breakfast on sunday|breakfast when i sleep in|breakfast when i sleep late|' +
      // Round 3 (CHK2-CS-1/5): whole house rules instead of the bare "until", "more", "extra",
      // "seconds" and "at night" ("They don't feed me more than one meal a day").
      'until i finish my homework|until i finish my chores|until i finish my vegetables|until i clean my room|until i do my homework|until i do my chores|until i wash my hands|until i set the table|until dinner is ready|until everyone sits down|until everyone is at the table|lunch because i eat at school|lunch because i eat lunch at school|lunch because i get lunch at school|lunch because i buy lunch|lunch because i buy school lunch',
    unlessAfter: NEGLECT_DISTRESS,
    doc: 'Neglect: a caregiver does not feed the child ("My parents don\'t feed me", "They don\'t give me food"); house rules about treats, clock times or disliked food ("don\'t give me candy before dinner", "after 7") are excluded unless hunger follows ("... after dark and I am starving").',
  },
  {
    id: 'ABUSE_NEGLECT_NOT_LET_EAT',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern: `${ABUSERS} +1 dont|doesnt|do not|does not|never|wont|will not|refuse to|refuses to|stopped +0 let me eat|let us eat|let me have food|let us have food|let me have dinner|let us have dinner +0 ?anything|at all|for days|all day|for a day|for two days|for a long time|when i am bad|when im bad|as punishment|as a punishment`,
    sentenceEnd: true,
    doc: 'Neglect: a caregiver does not let the child eat, as a whole statement ("My mom doesn\'t let me eat", "they don\'t let me eat for days"); a rule about a place or time ("They don\'t let me eat in class", "on the bus") is not neglect.',
  },
  {
    id: 'ABUSE_NEGLECT_HUNGRY',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${I}|we +1 havent|have not|didnt|did not|hadnt|had not|dont get to|never get to|cant +1 eaten|eat|ate|had food|had anything to eat|had dinner|had breakfast +2 in days|for days|since yesterday|in two days|in 2 days|in three days|in 3 days|all weekend|for two days|for 2 days|in a long time|for a long time|since friday|since monday`,
    doc: 'Neglect: not having eaten for days ("I haven\'t eaten in two days"); "I didn\'t eat breakfast" does not match.',
  },
  {
    id: 'ABUSE_NEGLECT_NO_FOOD',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'no|not any|isnt any|isnt|wasnt|never|never any|never enough +1 food|anything to eat|dinner|enough food +1 at home|in my house|at my house|in the house|at our house|at our home|in our house',
    notFollowedBy:
      'because we went out|because we ate out|because we went to|because we were out|because we were at|because we had|because it was|so we went out|so we ate out|so we went to|so we got|so we ordered|so we had',
    doc: 'Neglect: no food at home ("there is no food at home"); an evening out ("we had no dinner at home because we went out") is excluded.',
  },
  {
    id: 'ABUSE_LOCKED_IN',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'lock|locks|locked|locking +0 me|us +1 in|inside|out|outside|in the|in my|in a +1 closet|basement|room|garage|car|shed|attic|cellar|bathroom|outside|all night|for hours|for days|cage|crate',
    doc: 'Confinement ("they lock me in the closet").',
  },
  {
    id: 'ABUSE_LEFT_ALONE',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'left|leave|leaves|leaving +0 me|us +1 alone|by myself|home alone|by ourselves +1 for days|all night|overnight|for two days|for 2 days|all weekend|for a long time|at night|every night|for hours',
    doc: 'Neglect: left alone for long periods ("they left us alone for days"); "left me alone at recess" does not match.',
  },
  {
    id: 'ABUSE_AFRAID_OF_HOME',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${I} +1 ?am|m|feel|get|always|was|feel so +1 scared|afraid|terrified|frightened +1 to go home|of going home|to be at home|of my dad|of my mom|of my stepdad|of my stepmom|of my parents|of my uncle|of dad|of mom|to be home|to go back home|of my stepfather|of my stepmother|of my babysitter`,
    doc: 'Fear of home or of a caregiver ("I am scared to go home", "I\'m afraid of my dad"); "scared of the dark" does not match.',
  },
  {
    id: 'ABUSE_UNSAFE_HOME',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern: `${I} +2 dont|do not|dont ever|never|cant|cannot|am not|m not|not|dont really|do not really +1 feel safe|safe|feel safe anymore +1 at home|in my house|at my house|in my home|at my dads|at my moms|with my dad|with my mom|with my stepdad|with my stepmom|with my parents|with my uncle|around my dad|around my mom|around my stepdad|around my uncle|home`,
    notFollowedBy:
      'alone at night|alone in the dark|alone during storms|alone during a storm|alone during the storm|alone when its dark|alone when it is dark|alone when it storms|by myself at night|by myself in the dark|by myself during a storm|when its dark|when it is dark|in the dark|during storms|during a storm|during the storm|when it storms|without a nightlight|without the nightlight|without my nightlight|driving so fast|driving too fast|driving fast|driving in snow|driving in the snow|driving in the rain|driving on the highway|driving on ice|when he drives fast|when she drives fast|when he drives too fast|when she drives too fast|on the highway|' +
      // Round 3 (CHK2-CS-1/5): the bare "alone", "by myself", "driving", "drive" and "in the car"
      // are gone ("... alone with my uncle"); spiders, scary movies, noises and a barking dog.
      'when theres a spider|when there is a spider|because of spiders|because of the spider|when my brother watches scary movies|when my sister watches scary movies|after scary movies|after a scary movie|after watching a scary movie|when we watch scary movies|at night because of the noises|because of the noises|because of noises|because of the noise|when the dog barks|when dogs bark|when the dogs bark|when our dog barks|' +
      // CHK-CS-5: thunder, wind and power cuts.
      'when it thunders|when there is thunder|when theres thunder|when it is thundering|when its thundering|during thunderstorms|during a thunderstorm|in a thunderstorm|in thunderstorms|when there is lightning|when it rains hard|when the power goes out|when the lights go out|during a tornado|in a tornado|during a hurricane|in a hurricane|when there is a tornado|when its windy|when it is windy|without my dog|without my cat|without my pet|without my puppy|without my teddy|without my teddy bear|without my stuffed animal|without my blanket|without the lights on',
    unlessAfter: UNSAFE_HOME_HARM,
    doc: 'Not feeling safe at home or with a caregiver ("I don\'t feel safe at home"); fear of storms, the dark, spiders or scary movies, and of a caregiver\'s fast driving, are excluded unless a harm word follows ("... because my dad hits me"). "I don\'t feel okay at home" is not covered (it is also how a sick child says it).',
  },
  {
    id: 'ABUSE_ABUSIVE',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern: `${ABUSERS}|my family|my home|my house +2 is|was|are|were|gets|get|can be|has been|have been|been|becomes|became +1 abusive`,
    negatable: true,
    hypothetical: true,
    notFollowedBy: `${GAME_CONTEXT_TAILS}|at video games|at games|at the game|in video games|in chat|in the chat|in the game chat|in voice chat`,
    doc: 'A caregiver or the home described as abusive ("my dad is abusive"); a game ("abusive at video games") is excluded.',
  },
  {
    id: 'ABUSE_VICTIM_OF',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern: `${I}|we +2 am|was|were|have been|been|m|are|is|became +1 a victim of|the victim of|victim of|victims of|a survivor of|survivor of +1 rape|abuse|sexual abuse|child abuse|molestation|assault|sexual assault|incest|domestic violence|violence|beatings|neglect|a rape|an assault|trafficking`,
    negatable: true,
    hypothetical: true,
    doc: 'First-person statement of being a victim of abuse or rape ("I was a victim of rape"), whatever the subject.',
  },
  {
    id: 'ABUSE_SEX_WITH_ME',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern: `${ABUSERS} +2 has sex with|had sex with|does sex with|did sex with|wants to have sex with|tried to have sex with|does sexual abuse to|did sexual abuse to|does sexual things to|did sexual things to|does sex stuff with|did sex stuff with|does sex stuff to|did sex stuff to +0 me|us|my sister|my brother`,
    hypothetical: true,
    guard: BODY_SAFETY_LESSON,
    doc: 'Disclosure of sexual abuse in plain words ("my cousin has sex with me", "my stepdad does sexual abuse to me").',
  },
  {
    id: 'ABUSE_MADE_HAVE_SEX',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern: `${ABUSERS} +2 makes|made|forces|forced|tries to make|tried to make|wants|wanted +0 me|us +1 have sex|do sex|do sexual things|do sex stuff|to have sex|to do sex`,
    hypothetical: true,
    guard: BODY_SAFETY_LESSON,
    doc: 'Being made to have sex ("he makes me have sex").',
  },
  {
    id: 'ABUSE_BED_TOUCH',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern: `${ABUSERS} +2 sleeps in my bed|sleeps in bed with me|gets in my bed|gets into my bed|comes in my bed|comes into my bed|climbs in my bed|climbs into my bed|lays in my bed|lies in my bed|lays down with me|gets in bed with me|comes into my room at night|comes in my room at night +4 touches|touched|touching|rubs|rubbed|feels|felt +0 me`,
    hypothetical: true,
    guard: BODY_SAFETY_LESSON,
    notFollowedBy: CARING_TOUCH_TAILS,
    doc: 'Touching after a caregiver gets into the child\'s bed or room ("my dad sleeps in my bed and touches me").',
  },
  {
    id: 'ABUSE_THREAT_REPORTED',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ABUSERS} +2 ${REPORTED_THREAT} +1 kill|hurt|beat|hit|strangle|choke|stab|shoot|burn|drown|beat up|poison +0 ${THREAT_OBJECTS}`,
    negatable: true,
    hypothetical: true,
    notFollowedBy: GAME_AND_PLAY_TAILS,
    doc: 'A reported threat against the child or the family ("my dad said he would kill me", "she says she will hurt me"); games ("said he would beat me at chess") and ordinary discipline ("said she would punish me") excluded.',
  },
  {
    id: 'ABUSE_THREAT_DIRECT',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ABUSERS} +1 will|would|is going to|is gonna|gonna|wants to|is trying to|tried to|tries to|keeps trying to|was trying to|threatened to|threatens to|keeps threatening to|always threatens to +1 hurt|strangle|choke|stab|shoot|burn|drown|poison|suffocate +0 me|us`,
    negatable: true,
    hypothetical: true,
    doc: 'A person going to, trying to or threatening to injure the child ("my stepdad tried to choke me", "he will hurt me"). "My mom is going to kill me" is hyperbole and not covered; a kill attempt or threat is (ABUSE_KILL_ATTEMPT).',
  },
  {
    id: 'ABUSE_KILL_ATTEMPT',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ABUSERS} +1 tried to|tries to|keeps trying to|is trying to|was trying to|threatened to|threatens to|keeps threatening to|always threatens to +1 kill|murder +0 me|us`,
    negatable: true,
    hypothetical: true,
    doc: 'An attempt or threat to kill the child ("he tried to kill me").',
  },
  {
    id: 'ABUSE_COERCION_AFTER',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ABUSERS} +3 hurt|kill|beat|hit|punish|beat up|send me away|take me away|hurt my|kill my|beat my|hit my +3 if i tell|if i told|if i say|if i said|if i talk|if i tell anyone|if anyone finds out|if i ever tell|if i ever told|if i tell anybody|if i say anything|if i said anything`,
    notFollowedBy: 'a lie|lies|a fib|fibs|a bad word|bad words|her|him|them',
    doc: 'A threat that keeps a child silent, with the condition last ("he will hurt me if I tell"); "my mom will punish me if I tell a lie" and telling the same person ("my mom will kill me if I tell her I lost my jacket") excluded; a reported or direct threat to hurt is still caught by ABUSE_THREAT_REPORTED / ABUSE_THREAT_DIRECT.',
  },
  {
    id: 'ABUSE_TOUCH_ADULT_CONTEXT',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ABUSERS} +2 touches|touched|keeps touching|kept touching|is touching|rubs|rubbed|feels|felt +0 me +1 at night|in bed|in my bed|when no one|when nobody|when mom is|when dad is|when im alone|when i am alone|when we are alone|when were alone|and i dont like it|and i dont like|in the bath|in the shower|under the covers|under my covers|every night|in my room|all over|when i sleep|while i sleep|when im sleeping|when i am sleeping|while im sleeping|while i am sleeping|in a way i dont like|and it feels bad|and it feels weird|weird`,
    negatable: true,
    hypothetical: true,
    guard: BODY_SAFETY_LESSON,
    notFollowedBy: CARING_TOUCH_TAILS,
    doc: 'Touching in a secret or night-time context ("my uncle touches me at night"); caring touch ("Mom touches me at night to check if I have a fever") excluded.',
  },
  {
    id: 'ABUSE_MADE_ME_TOUCH',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ABUSERS} +2 makes|made|make|forces|forced|tells|told|wants|wanted|tries to make|tried to make|asks|asked|keeps making +0 me +1 touch|to touch|rub|to rub|lick|to lick|feel|to feel +0 him|his body|her body|his thing|his wiener|him down there|her down there`,
    hypothetical: true,
    guard: BODY_SAFETY_LESSON,
    notFollowedBy:
      'to see if he has a fever|to check if he has a fever|to check his fever|to feel his forehead|to feel if he has a fever|to wake him up|to help him up|when he was sick|on the arm|on the shoulder|on the hand|on the back|on the head|hand|arm|head|back|shoulder|face|cast|muscle|muscles|beard|hair',
    doc: 'Being made to touch a person ("my uncle makes me touch him"). "her" and "them" are too often objects ("she made me touch her slime", "made me touch them" about worms) and are left to ABUSE_MADE_ME_UNDRESS, which needs a private-parts word.',
  },
  {
    id: 'ABUSE_DOMESTIC_VIOLENCE',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ADULT_ABUSERS}|he|she|they +2 hits|beats|punches|kicks|slaps|chokes|hurts|abuses|strangles|attacks|pushes|shoves|hit|beat|punched|kicked|slapped|choked|strangled|abused|attacked|pushed|shoved|keeps hitting|is hitting|was hitting|keeps hurting +0 my mom|my mother|my mommy|my mama|mom|mommy|my dad|my father|my daddy|my stepmom|my stepdad|my sister|my brother|my baby brother|my baby sister|my little brother|my little sister|my big sister|my big brother|my grandma|my grandpa|my family`,
    negatable: true,
    hypothetical: true,
    notFollowedBy: `${GAME_AND_PLAY_TAILS}|out|out of|into|off|over|around|higher|forward|along|across`,
    doc: 'Violence against a family member the child witnesses ("my dad hits my mom"); games and play ("beat my brother at checkers", "pushed my sister on the swing", "into the pool") and "kicked my brother out of the house" excluded.',
  },
  {
    id: 'ABUSE_COERCION',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern:
      'if i tell|if you tell|or else|if i told|if anyone finds out|if i say anything|if i talk +3 he|she|they|someone|dad|mom|he said he|she said she +1 will|would|is going to|gonna|said he would|said she would|said they would|says he will|says she will +1 hurt|kill|beat|hit|punish|send me away|hurt my|kill my|leave|hurt you|kill you',
    doc: 'Threats that keep a child silent ("he said if I tell he will hurt me").',
  },

  // ---- Threats of violence ------------------------------------------------------------------
  {
    id: 'VIOLENCE_THREAT_PERSON',
    kind: 'severe',
    category: 'violence',
    sources: BOTH,
    pattern: `${I} +2 ${THREAT_INTENT} +1 ${THREAT_VERBS} +0 ${PERSON_TARGETS}`,
    negatable: true,
    gapStop: THREAT_GAP_STOP,
    notFollowedBy: `${MESSAGE_TAILS}|${GAME_CONTEXT_TAILS}`,
    doc: 'First-person threat to kill or hurt a person ("I will kill you", "i will k1ll u", "I\'ll kill you"); targets that are not people ("kill it at my soccer game", "kill the zebra"), messages ("shoot you a text") and a subject change inside the gap ("if I tell he will ...") do not match.',
  },
  {
    id: 'VIOLENCE_THREAT_NAMED',
    kind: 'severe',
    category: 'violence',
    sources: BOTH,
    pattern: `${I} +2 ${THREAT_INTENT} +1 ${THREAT_VERBS} +0 ${DETERMINERS} +1 ${PERSON_NOUNS}`,
    negatable: true,
    gapStop: THREAT_GAP_STOP,
    notFollowedBy: `${MESSAGE_TAILS}|${GAME_CONTEXT_TAILS}`,
    doc: 'First-person threat against a named person or group ("I want to stab my teacher", "I will kill everyone in my class" via "everyone").',
  },
  {
    id: 'VIOLENCE_THREAT_NAME',
    kind: 'severe',
    category: 'violence',
    sources: CHILD,
    pattern: `${I} +2 ${THREAT_INTENT} +1 kill|murder|stab|shoot|strangle|choke|poison|hurt|beat up|punch|attack|drown +0 *`,
    notObject: NOT_A_PERSON,
    negatable: true,
    gapStop: THREAT_GAP_STOP,
    notFollowedBy: `${MESSAGE_TAILS}|${GAME_CONTEXT_TAILS}|${POSSESSED_OBJECTS}|feelings|feeling|a message|a text`,
    doc: 'First-person threat against someone named ("I want to kill Sam", "I\'m going to hurt Riley"); objects, pronouns, time words, days, school subjects and games ("kill it", "kill time", "kill some zombies", "kill Monday", "kill Jordan in Fortnite"), a possessed thing ("shoot Grandpa\'s camera") and messages ("shoot Jordan a text") do not match.',
  },
  {
    id: 'VIOLENCE_WISH_DEATH',
    kind: 'severe',
    category: 'violence',
    sources: CHILD,
    pattern: `${I} +1 want|wish|hope|pray|wanna see +0 ${PERSON_TARGETS} +0 to die|would die|was dead|were dead|to be dead|dead|died|would drop dead|to drop dead|gone forever`,
    negatable: true,
    notFollowedBy: `${GAME_CONTEXT_TAILS}|in my game|in my zombie game|in the zombie game|in my story|in the story|in my book|in my comic`,
    doc: 'A wish for people to die ("I want everyone to die", "i want them all dead"); a game or story ("in my zombie game") is excluded.',
  },
  {
    id: 'VIOLENCE_WISH_DEATH_NAMED',
    kind: 'severe',
    category: 'violence',
    sources: CHILD,
    pattern: `${I} +1 want|wish|hope|pray +0 ${DETERMINERS} +1 ${PERSON_NOUNS} +0 to die|would die|was dead|were dead|to be dead|dead|dies|died|would drop dead|to drop dead`,
    negatable: true,
    notFollowedBy: 'peacefully|of old age|in peace|in his sleep|in her sleep|a hero',
    doc: 'A wish for a named person to die ("I want my teacher to die", "I wish my teacher was dead"); "I wish my grandpa was not dead" does not match.',
  },
  {
    id: 'VIOLENCE_WISH_DEATH_NAME',
    kind: 'severe',
    category: 'violence',
    sources: CHILD,
    pattern: `${I} +1 want|wish|hope|pray +0 * +0 to die|would die|was dead|were dead|to be dead|dies|would drop dead|to drop dead`,
    notObject: NOT_A_PERSON,
    negatable: true,
    notFollowedBy: 'peacefully|of old age|in peace|in his sleep|in her sleep|a hero',
    doc: 'A wish for someone named to die ("I want Riley to die"); "I hope I die" is self-harm (SELF_HARM_HOPE_DIE).',
  },
  {
    id: 'VIOLENCE_WEAPON_CARRY',
    kind: 'severe',
    category: 'violence',
    sources: CHILD,
    pattern: `${I} +2 have|got|brought|bring|carry|carried|keep|hid|hide|packed|put|am carrying|m carrying|am bringing|m bringing +2 gun|guns|knife|knives|weapon|weapons|pistol|rifle|bomb|bombs|box cutter|razor +1 in|into|inside +1 backpack|bookbag|book bag|locker|school bag|schoolbag|bag|pocket|desk|lunchbox|lunch box|cubby|jacket`,
    negatable: true,
    gapStop: `${THREAT_GAP_STOP}|toy|nerf|water|squirt|fake|pretend|play|paper|lego|cap|foam|butter|plastic|drawing|picture`,
    doc: 'A first-person report of a weapon in a school bag, pocket, locker or desk ("i have a gun in my backpack"); toys ("a toy gun", "a butter knife") excluded.',
  },
  {
    id: 'VIOLENCE_SCHOOL_SHOULD',
    kind: 'severe',
    category: 'violence',
    sources: CHILD,
    pattern:
      'someone|somebody|people|anyone|anybody|we|everyone +1 should|should just|needs to|need to|ought to|has to|have to +1 shoot up|blow up|bomb|burn down|attack|shoot +1 the|my|our|this|that|a +0 school|class|classroom|bus|gym|cafeteria',
    negatable: true,
    doc: 'Calling for an attack on a school ("someone should shoot up the school").',
  },
  {
    id: 'VIOLENCE_SCHOOL_ATTACK',
    kind: 'severe',
    category: 'violence',
    sources: BOTH,
    pattern: `${I} +2 ${THREAT_INTENT} +1 shoot up|blow up|bomb|burn down|attack|shoot|shoot everyone at|shoot everybody at +1 the|my|our|this|that|a|everyone at|everybody at +0 school|class|classroom|church|bus|gym|cafeteria|playground`,
    negatable: true,
    gapStop: THREAT_GAP_STOP,
    doc: 'First-person threat against a school or gathering place ("im going to shoot up the school").',
  },
  {
    id: 'VIOLENCE_WEAPON_TO_SCHOOL',
    kind: 'severe',
    category: 'violence',
    sources: BOTH,
    pattern: `${I} +3 gun|knife|knives|weapon|guns|bomb|pistol|rifle|bombs +2 to|into|at|in +1 school|class|classroom|the bus|recess`,
    negatable: true,
    gapStop: THREAT_GAP_STOP,
    doc: 'First-person plan to bring, or report of having, a weapon at school ("I\'m gonna bring a gun to school"); a rule sentence ("it is wrong to bring a knife to school") has no near first person.',
  },
  {
    id: 'VIOLENCE_WEAPON_BRING',
    kind: 'severe',
    category: 'violence',
    sources: BOTH,
    pattern: `${I} +2 ${THREAT_INTENT} +1 bring|take|carry|sneak|pack|use +2 gun|guns|knife|knives|weapon|weapons|pistol|rifle|bomb|bombs +2 to|into|at|in +1 school|class|classroom|the bus|recess`,
    negatable: true,
    gapStop: THREAT_GAP_STOP,
    doc: 'First-person plan to bring a weapon to school with a longer lead-in ("I\'m going to bring a gun to school", "I will bring my dad\'s gun to school").',
  },
  {
    id: 'VIOLENCE_ENCOURAGE',
    kind: 'severe',
    category: 'violence',
    sources: AI,
    pattern: `${YOU} should|${YOU} can|${YOU} could|go|just|${YOU} need to|or|then +0 hit|punch|hurt|kill|beat up|fight|kick|bite|stab|shoot|slap +0 him|her|them|anyone|someone|people|back|your brother|your sister|that kid|the bully`,
    negatable: true,
    doc: 'Model output encouraging violence ("You should punch him", "Just ignore him or punch him").',
  },

  {
    id: 'VIOLENCE_ENCOURAGE_IMPERATIVE',
    kind: 'severe',
    category: 'violence',
    sources: AI,
    pattern:
      'hit|punch|kick|slap|bite|beat up|fight|hurt|push|shove|attack|smack|trip +0 him|her|them|the bully|that bully|the bullies|those bullies|that kid|those kids|him back|her back|them back|your brother|your sister|someone|anyone|the kid|the boy|the girl|people',
    sentenceStart: true,
    doc: 'Model output telling the child to hurt someone, as a command ("Punch the bully.", "Hit him back if he bullies you."); "Kick the ball" does not match.',
  },
  {
    id: 'VIOLENCE_ENCOURAGE_BACK_IMPERATIVE',
    kind: 'severe',
    category: 'violence',
    sources: AI,
    pattern: 'hit|punch|slap|bite|fight|hurt|push|shove|smack|strike +0 back',
    sentenceStart: true,
    notFollowedBy:
      'the|a|an|your|my|to|up|down|some|any|tears|one|two|it|those|these|that|this|from|in|on|into|onto|over|with|space|spaces|a line|lines|a page|a step|a little',
    doc: 'Model output telling the child to strike back ("Fight back!", "Hit back if he pushes you."); an object after "back" ("Push back the decimal point", "Fight back tears") and "Kick back and read" do not match.',
  },
  {
    id: 'VIOLENCE_ENCOURAGE_BACK',
    kind: 'severe',
    category: 'violence',
    sources: AI,
    pattern:
      'hit|punch|kick|slap|push|shove|fight|smack|bite|hurt +0 them back|him back|her back|them right back|him right back|her right back|back harder',
    negatable: true,
    doc: 'Model output encouraging retaliation ("If someone hits you, hit them back."); "Don\'t hit them back" is negated.',
  },

  // ---- Sexual content -----------------------------------------------------------------------
  {
    id: 'SEXUAL_EXPLICIT_TERM',
    kind: 'severe',
    category: 'sexual',
    sources: BOTH,
    pattern:
      'porn|porno|pornography|pornographic|pornhub|nudes|nudez|noodz|nudz|nudies|blowjob|blow job|handjob|hand job|sexting|sext|horny|dildo|hentai|onlyfans|orgasm|jerk off|jack off|jerking off|cybersex|camgirl|strip club|send nudes|nude pics',
    doc: 'Explicit sexual terms with no K-8 educational use; always severe.',
  },
  {
    id: 'SEXUAL_ACT_FIRST_PERSON',
    kind: 'severe',
    category: 'sexual',
    sources: BOTH,
    pattern: `${I}|we|me and +2 have|had|having|did|do|want to have|wanna have|made|make +0 sex`,
    // CHK-CS-3: "I think animals have sex" is an opinion about animals, not the child's activity.
    gapStop: 'think|thought|believe|know|guess|learned|read|heard|said|says|that|how|why',
    notFollowedBy:
      'cells|cell|chromosomes|chromosome|organs|organ|hormones|hormone|linked|determination|education|ed|differences|ratio',
    doc: 'First-person sexual activity ("we had sex"); science phrases ("sex cells") excluded.',
  },
  {
    id: 'SEXUAL_ACT_TERM',
    kind: 'severe',
    category: 'sexual',
    topic: 'body',
    sources: BOTH,
    pattern: 'have sex|had sex|having sex|has sex|sex with',
    notFollowedBy:
      'cells|cell|chromosomes|chromosome|organs|organ|hormones|hormone|linked|determination|education|ed|differences|ratio',
    exempt: { subjects: ['science'], cues: BODY_SCIENCE_CUES },
    doc: 'Tier B: sexual activity phrases outside a first-person statement; educational in a science reproduction context.',
  },
  {
    id: 'SEXUAL_IMAGE_REQUEST',
    kind: 'severe',
    category: 'sexual',
    sources: BOTH,
    pattern: `send|sent|sends|show|showed|shows|give|gave|share|post +0 me|${YOU}|him|her +2 nudes|naked|nude|pics of your body|pictures of your body|photos of your body|sexy|dirty|private|a picture of ${YOU} naked|a picture of yourself naked`,
    doc: 'Requests for sexual images ("send me nudes").',
  },
  {
    id: 'SEXUAL_NAKED_MEDIA',
    kind: 'severe',
    category: 'sexual',
    sources: BOTH,
    pattern:
      'naked|nude|undressed|topless|without clothes|with no clothes +0 pictures|pics|photos|videos|selfies|pic|picture|photo|video|selfie|pix',
    doc: 'Sexual images ("naked pictures").',
  },
  {
    id: 'SEXUAL_MEDIA_OF_PERSON',
    kind: 'severe',
    category: 'sexual',
    sources: BOTH,
    pattern: `pictures|pics|photos|videos|selfies|pic|picture|photo|video|a picture|a photo +0 of +0 me|${YOU}|yourself|myself|her|him|us +0 naked|nude|undressed|without clothes|with no clothes|in my underwear|in your underwear|in underwear`,
    doc: 'Images of a person undressed ("send me a picture of you naked").',
  },
  {
    id: 'SEXUAL_UNDRESS_REQUEST',
    kind: 'severe',
    category: 'sexual',
    sources: AI,
    pattern:
      'take|took|taking|pull|pulled +0 off|down +1 your|my|her|his|ur +1 clothes|pants|underwear|bra|panties',
    doc: 'Model output asking the child to undress ("Take off your clothes").',
  },
  {
    id: 'SEXUAL_FLIRT',
    kind: 'severe',
    category: 'sexual',
    sources: AI,
    pattern: `sexy|hot body|kiss ${YOU}|kissing ${YOU}|cuddle with ${YOU}|date me|be my girlfriend|be my boyfriend|your body is sexy`,
    doc: 'Sexualised or romantic model output ("You look sexy").',
  },
  {
    id: 'SEXUAL_VIOLENCE_TERM',
    kind: 'severe',
    category: 'sexual',
    topic: 'sexual_violence_topic',
    sources: BOTH,
    pattern:
      'rape|raped|raping|rapist|rapists|molest|molested|molesting|molester|incest|pedophile|pedophiles|paedophile|sexual assault|sexually assaulted|sexual abuse|sexually abused|child abuse',
    exempt: { subjects: ['social_studies', 'reading'], cues: HISTORY_RIGHTS_CUES },
    doc: 'Tier B: sexual-violence words. Severe on their own; educational in a history, rights or literature context ("soldiers raped and killed people during the genocide").',
  },
  {
    id: 'SEXUAL_HEALTH_TERM',
    kind: 'severe',
    category: 'sexual',
    topic: 'body',
    sources: BOTH,
    pattern:
      'masturbate|masturbating|masturbation|erection|erections|ejaculation|intercourse|sexual intercourse|wet dream|wet dreams',
    exempt: { subjects: ['science'], cues: BODY_SCIENCE_CUES },
    doc: 'Tier B: sexual-health words. Severe on their own; educational in a science or puberty context.',
  },
  {
    id: 'SEXUAL_ABUSE_ENDORSED',
    kind: 'severe',
    category: 'sexual',
    sources: CHILD,
    pattern:
      'rape|raping|molesting|sexual abuse|child abuse|sex with kids|sex with children|sex with a kid|sex with a child|sex with me|sex with us|touching private parts|touching privates +0 is ok|is okay|is fine|is good|is normal|is allowed|is our secret|is a secret|is our game|is a game|is fun|is not bad|isnt bad|is not wrong|isnt wrong',
    negatable: true,
    answerOnly: true,
    notPrecededBy: 'about',
    guard: ENDORSED_LESSON_GUARD,
    doc: 'Round 3 (CHK2-CS-7): sexual abuse called acceptable ("My teacher said sex with kids is ok", "My mom says rape is ok", "He says touching private parts is our secret"); a frame or an educational subject never softens it. Round 4 (CHK3-CS-3): the child\'s answer only, never a printed prompt; "if", a negated "say" or "believe" and the body-safety lesson guard apply ("If someone says touching private parts is a secret, tell a trusted adult", "No one should ever say rape is ok", "Don\'t say rape is ok"), and so does a third person who holds the view ("Some bad people say child abuse is normal", "the villain thinks rape is ok") unless a first-person word is nearer ("My uncle says ...") or later in the sentence. A negation across another word negates that word, so a report stays severe ("He said it is not bad, sex with me is fine"; NEGATION_BRIDGES), and a phrase that names the child ("our secret", "with me") is held only by a quote word (ENDORSED_LESSON_GUARD). Prevention wording ("Rape is never okay") does not match.',
  },
  {
    id: 'SEXUAL_GROOMING_GAME',
    kind: 'severe',
    category: 'sexual',
    sources: CHILD,
    pattern:
      'sex +0 is our game|is our little game|is our secret|is our little secret|is a secret|is a game|is normal for kids|is ok for kids|is okay for kids|is fine for kids|is good for kids',
    negatable: true,
    answerOnly: true,
    notPrecededBy: 'about',
    guard: ENDORSED_LESSON_GUARD,
    doc: 'Round 3: sex framed as a game, a secret or normal for children ("My uncle says sex is our game"), a grooming phrase. Round 4 (CHK3-CS-3): the child\'s answer only; "if", a negated "say" or "believe", the body-safety lesson guard and a third-person holder apply as for SEXUAL_ABUSE_ENDORSED ("He said don\'t tell, sex is our secret" is a report), and talking or learning about sex is a health topic ("Being curious about sex is normal for kids").',
  },

  // ---- Secrecy ------------------------------------------------------------------------------
  {
    id: 'SECRECY_AI_DONT_TELL',
    kind: 'severe',
    category: 'secrecy',
    sources: AI,
    pattern: `dont|do not|never|no need to|${YOU} dont have to|dont ever|${YOU} shouldnt|dont need to|${YOU} dont need to|better not +1 tell|talk to|mention it to|mention this to|mention anything to +1 your|anyone|anybody|mom|dad|mommy|daddy|parents|a grown up|grown ups|grownups|adults|an adult|teacher|teachers|nobody|no one|them|family`,
    doc: 'Model output asking the child not to tell a grown-up ("Don\'t tell your parents"). Any such request in model output is severe, including well-meant password advice.',
  },
  {
    id: 'SECRECY_AI_KEEP',
    kind: 'severe',
    category: 'secrecy',
    sources: AI,
    pattern:
      'keep +2 this|it|that|our chat|our talk|what we|everything|these|our conversation|our messages|this chat|it all|what i said|what i told you +2 secret|a secret|our secret|our little secret|between us|between you and me|to yourself|private|quiet|hidden|from your|from mom|from dad|from your parents|from grown ups|from adults|from everyone|to ourselves|between ourselves|just for us|just between us|between the two of us|to yourselves',
    doc: 'Model output asking the child to keep something secret ("Keep it a secret from your mom"); "Keep it up!" does not match.',
  },
  {
    id: 'SECRECY_OUR_LITTLE_SECRET',
    kind: 'severe',
    category: 'secrecy',
    sources: BOTH,
    pattern: 'our +0 little|special|own little +0 secret|secrets',
    doc: '"Our little secret": a grooming phrase in a child\'s disclosure or model output.',
  },
  {
    id: 'SECRECY_AI_OUR_SECRET',
    kind: 'severe',
    category: 'secrecy',
    sources: AI,
    pattern: 'our +1 secret|secrets',
    doc: 'Model output proposing a shared secret ("this is our secret"); a child\'s "our secret club" is not flagged.',
  },
  {
    id: 'SECRECY_AI_BETWEEN_US',
    kind: 'severe',
    category: 'secrecy',
    sources: AI,
    pattern:
      'between you and me|between us two|just between us|between you and i|between me and you',
    doc: 'Model output framing the conversation as private ("This is just between you and me").',
  },
  {
    id: 'SECRECY_AI_STAYS_BETWEEN',
    kind: 'severe',
    category: 'secrecy',
    sources: AI,
    pattern:
      'stays|stay|will stay|staying|remain|remains|just|keep it|keep this|keep that|its|it is|this is|thats|that is +0 between us|between ourselves|between the two of us',
    doc: 'Model output making the conversation private ("Don\'t worry, this stays between us.").',
  },
  {
    id: 'SECRECY_TOLD_NOT_TO_TELL',
    kind: 'severe',
    category: 'secrecy',
    sources: CHILD,
    pattern:
      'told|tells|tell|said|says|asked|asks|made|makes|warned|warns +0 me|us +1 not to|to not|never to|to never|dont|not|never +0 tell|talk|say anything +1 anyone|anybody|my mom|my dad|my parents|mom|dad|my teacher|a grown up|grown ups|nobody|no one|my family|mommy|daddy|about him|about her|about it|about this',
    notFollowedBy: SURPRISE_TAILS,
    doc: 'A child reporting that someone told them not to tell ("he told me not to tell anyone"); surprises and passwords excluded.',
  },
  {
    id: 'SECRECY_SAID_NOT_TO_TELL',
    kind: 'severe',
    category: 'secrecy',
    sources: CHILD,
    pattern: `${ABUSERS} +1 said|says|told|tells|always says|keeps saying|warned|warns +0 not to|to not|never to|to never|i cant|i cannot|i can not|i shouldnt|i should not|i am not allowed to|im not allowed to|we cant|dont|do not|never +0 tell|talk|say anything +1 anyone|anybody|my mom|my dad|my parents|mom|dad|my teacher|a grown up|grown ups|nobody|no one|my family|mommy|daddy|about him|about her|about it|about this|the police|the cops|anybody else|anyone else`,
    notFollowedBy: SURPRISE_TAILS,
    doc: 'A child reporting being told not to tell, without "me" ("he said not to tell anyone", "He said I can\'t tell anyone"); surprises, presents and passwords excluded.',
  },
  {
    id: 'SECRECY_KEEP_SECRET',
    kind: 'severe',
    category: 'secrecy',
    sources: CHILD,
    pattern:
      'made|makes|make|told|tells|asked|asks|wants|wanted|forced|forces +0 me|us +0 keep|to keep|promise to keep|swear to keep +1 a secret|it a secret|it secret|this a secret|this secret|our secret|the secret|a big secret|secrets|it quiet|quiet|it between us',
    notFollowedBy: SURPRISE_TAILS,
    doc: 'A child reporting being made to keep a secret ("he made me keep a secret"); a surprise ("keep a secret about the surprise party") is excluded.',
  },
  {
    id: 'SECRECY_OUR_SECRET_REPORTED',
    kind: 'severe',
    category: 'secrecy',
    sources: CHILD,
    pattern: `${ABUSERS} +1 said|says|told me|tells me|always says|keeps saying|told us|tells us +1 its|it is|this is|thats|that is|it was|this was|that was +0 our secret|our secrets|our special secret|a secret between us|just between us|between us`,
    notFollowedBy:
      'club|code|handshake|recipe|hideout|fort|password|word|language|clubhouse|game|place|spot|base',
    doc: 'A child reporting that someone called it "our secret" ("He said it\'s our secret"); a secret club or code is excluded.',
  },
  {
    id: 'SECRECY_DONT_TELL_HE_SAID',
    kind: 'severe',
    category: 'secrecy',
    sources: CHILD,
    pattern:
      'dont|do not|never|dont ever +0 tell +1 mom|dad|mommy|daddy|anyone|anybody|your mom|your dad|your parents|my mom|my dad|the teacher|your teacher|nobody|no one +0 he said|she said|they said|he says|she says|he told me|she told me|he told us|she told us',
    notFollowedBy: SURPRISE_TAILS,
    doc: 'Reported speech with the speaker last ("Dont tell mom he said"); a surprise ("Dont tell mom he said it\'s a surprise") is excluded.',
  },
  {
    id: 'SECRECY_PROMISE',
    kind: 'severe',
    category: 'secrecy',
    sources: CHILD,
    pattern:
      'made|makes|make +0 me|us +0 promise|swear|pinky promise|pinky swear +1 not to|to not|never to|to never|i wont|i would not|i wouldnt|we wont +0 tell',
    notFollowedBy: SURPRISE_TAILS,
    // Round 3 (CHK2-CS-5): the surprise may follow the person not told ("... not to tell anyone
    // her crush").
    notFollowedWithin: 2,
    doc: 'A child reporting a forced promise of silence ("he made me promise not to tell my mom").',
  },
  {
    id: 'SECRECY_NOT_ALLOWED_TO_TELL',
    kind: 'severe',
    category: 'secrecy',
    sources: CHILD,
    pattern: `${I} +1 am not allowed to|m not allowed to|not allowed to|am not supposed to|m not supposed to|not supposed to|cant|cannot|can not +0 tell +0 anyone|anybody|my mom|my dad|my parents|mom|dad|my teacher|nobody|a grown up|about him|about her|what he|what she|what happens|what happened`,
    notFollowedBy: SURPRISE_TAILS,
    doc: 'A child saying they are not allowed to tell ("I\'m not allowed to tell anyone what happens"); passwords and surprises excluded.',
  },

  // ---- Personal contact ---------------------------------------------------------------------
  {
    id: 'CONTACT_AI_ASK_DETAILS',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern:
      'what is|whats|what are|tell me|send me|give me|share|type|write me|can i have|can you tell me|i need|i want +0 your|ur +1 address|home address|phone|phone number|number|cell|email|email address|last name|full name|school name|location|picture|photo|pic|selfie|snapchat|instagram|password|pin|parents names|moms name|dads name|birthday|age',
    notFollowedBy:
      'sentence|sentences|line|model|plan|guess|estimate|answer|strategy|pattern|bond|bonds|grid|chart|story|of|showing|shows|problem',
    negatable: true,
    doc: 'Model output asking for personal details ("What is your home address?"); "What is your number sentence?" excluded, and so is a negated safety rule ("Never share your password with anyone").',
  },
  {
    id: 'CONTACT_AI_WHERE',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern: `where do ${YOU} live|where ${YOU} live|where is your house|where is your home|what school do ${YOU} go to|which school do ${YOU} go to|what town do ${YOU} live in|what city do ${YOU} live in|how old are ${YOU}|are ${YOU} home alone|are your parents home|are ${YOU} alone|what is your name|whats your name|tell me your name|what is your full name|where do ${YOU} go to school|where ${YOU} go to school|what grade are ${YOU} in|who do ${YOU} live with|what is your teachers name|whats your teachers name|which city are ${YOU} in|what city are ${YOU} in|which town are ${YOU} in|what town are ${YOU} in|what state are ${YOU} in|which state are ${YOU} in|what state do ${YOU} live in|what country are ${YOU} in|where are ${YOU} from|where are ${YOU} right now|where are ${YOU} located|whats your school called|what is your school called|what is the name of your school|whats the name of your school|what school are ${YOU} at|which school are ${YOU} at|what school do ${YOU} attend`,
    doc: 'Model output asking the child\'s name, where they live or go to school, their age or whether they are alone; "Write your name at the top" is an instruction, not a question, and does not match.',
  },
  {
    id: 'CONTACT_AI_MEET',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern: `lets|let us|we could|we can|can we|want to|wanna|would ${YOU} like to|i want to|i can|we should|i will|ill|i could +0 meet|meet up|video chat|facetime|visit ${YOU}|come over|see ${YOU} in person|talk on the phone`,
    notFollowedBy: 'the|our|a|an|this|your|some|new|each|every',
    doc: 'Model output proposing to meet or call ("Let\'s meet up after school"); "Let\'s meet the characters" excluded.',
  },
  {
    id: 'CONTACT_AI_HANG_OUT',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern: `lets|let us|we could|we can|can we|want to|wanna|would ${YOU} like to|i want to|i can|we should|i will|ill|i could +0 hang out|hangout +0 with me|together|sometime|after school|later|tonight|this weekend|in person|online|more often|again sometime`,
    doc: 'Model output proposing to hang out ("Let\'s hang out after school"); "Let\'s hang out with fractions for a bit" does not match.',
  },
  {
    id: 'CONTACT_AI_HANG_OUT_END',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern: `lets|let us|we could|we can|can we|want to|wanna|would ${YOU} like to|i want to|we should +0 hang out|hangout`,
    sentenceEnd: true,
    doc: 'Model output proposing to hang out, ending the sentence ("Want to hang out?").',
  },
  {
    id: 'CONTACT_AI_ONLINE',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern:
      'come online|get online|hop online|hop on|be online|go online +0 tonight|later tonight|after school|at night|with me|this weekend|to chat|to talk to me|to play with me',
    doc: 'Model output asking the child to come online at a time or with it ("Can you come online tonight?").',
  },
  {
    id: 'CONTACT_AI_SELFIE',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern:
      'send|send me|post|share|upload|take|snap|show me|give me|text me|email me +1 a selfie|selfies|your selfie|a quick selfie|a photo of yourself|a picture of yourself|a pic of yourself',
    doc: 'Model output asking for a selfie ("Send a selfie!").',
  },
  {
    id: 'CONTACT_AI_SEND_ME_MEDIA',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern:
      'send me|send us|email me|text me|dm me|message me|mail me +1 a picture|a photo|a pic|pictures|photos|pics|a video|videos|an image|images',
    notFollowedBy:
      'of your work|of your answer|of your answers|of your steps|of your number line|of your drawing|of your graph|of your diagram|of your worksheet|of the worksheet|of your page|of the page|of your problem|of the problem|of your model|of your chart|of your table|of your writing|of your solution|of your math',
    doc: 'Model output asking the child to send it pictures or videos ("Send me a pic of your homework and your face."); the tutor never receives pictures. A picture of the schoolwork itself ("Send me a picture of your work.") is not contact (CHK-CS-5); a face after it is CONTACT_AI_MEDIA_FACE.',
  },
  {
    id: 'CONTACT_AI_MEDIA_FACE',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern:
      'send me|send us|show me|send|post|share|upload|email me|text me +1 a picture|a photo|a pic|pictures|photos|pics|a video|videos|an image|images +5 your face|ur face|yourself|urself|of {you}',
    doc: 'Model output asking for a picture that shows the child ("Send me a picture of your work and your face.").',
  },
  {
    id: 'CONTACT_AI_MEET_ME',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern:
      'meet me|come to me|come see me|come find me|come to my house|come over to my house|come to my place|visit me|come to my car|get in my car',
    doc: 'Model output inviting the child to meet it or come to a place.',
  },
  {
    id: 'CONTACT_AI_ADD_ME',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern:
      'add me|text me|call me|message me|dm me|email me|follow me|friend me|chat with me +0 on|at|later|tonight|anytime|privately|snapchat|instagram|discord|tiktok|whatsapp|kik|roblox',
    doc: 'Model output moving contact to another channel ("Add me on Snapchat").',
  },
  {
    id: 'CONTACT_AI_PHOTO',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern:
      'send me|show me|send|post|share|upload +1 a picture|a photo|a pic|a selfie|pictures|photos|pics|selfies|a video|videos +0 of +0 yourself|{you}|your face|your room|your house|your family',
    doc: 'Model output asking the child for pictures of themselves or their home ("Send me a picture of yourself").',
  },
  {
    id: 'CONTACT_CHILD_SOLICITED',
    kind: 'severe',
    category: 'personal_contact',
    sources: CHILD,
    pattern: `${STRANGERS} +3 asked|asks|wants|wanted|told|tells|keeps asking|kept asking|begged|tried to get|tries to get|made +0 ?me|for|me for +2 my address|where i live|my phone|my number|my phone number|my picture|pictures|pics|photos|a picture|a photo|a selfie|selfies|to meet|meet|meet up|to meet up|to video chat|video chat|to facetime|my password|to keep it secret|to keep a secret|to come to|to get in|get in his car|in his car|to send|send him|send her|my last name|what school|my school`,
    notFollowedBy:
      'in math|in math class|in class|in my class|in reading|in science|in gym|at school|at recess|at lunch|for the game|for the math game|for the answer|to add|for a partner|to be partners|for a project|for the project|for our project',
    doc: 'A child reporting that a stranger or online contact asked for contact details, pictures or a meeting ("someone on roblox asked me to meet him"); a friend or teacher asking is not covered, nor is a classmate in class ("someone asked me for my number in math class").',
  },
  {
    id: 'CONTACT_CHILD_PICTURES',
    kind: 'severe',
    category: 'personal_contact',
    sources: CHILD,
    pattern:
      'he|she|they|someone|somebody|a man|a guy|coach|my coach|this guy|neighbor|a stranger|my online friend|a friend online +2 asked|asks|wants|wanted|told|tells|keeps asking|begged +0 me +1 to send|send +1 him|her|them +1 pictures|pics|photos|a picture|a photo|selfies|a selfie|nudes',
    doc: 'A child reporting a request to send pictures of themselves ("he asked me to send him pictures").',
  },

  // ---- Companion persona (model output) -----------------------------------------------------
  {
    id: 'COMPANION_FRIEND',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'im|i am|ill be|i will be|i can be|let me be +0 your +1 best friend|friend|buddy|pal|bestie|bff|only friend|girlfriend|boyfriend|secret friend|special friend',
    doc: 'Model output presenting itself as the child\'s friend ("I\'m your best friend").',
  },
  {
    id: 'COMPANION_WE_FRIENDS',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'we are|we can be|we could be|lets be|let us be|we will be|we will always be|we can always be +0 best friends|friends|buddies|besties|bffs|pals|best buddies|friends forever|best friends forever',
    doc: 'Model output calling itself and the child friends ("We are best friends!").',
  },
  {
    id: 'COMPANION_WERE_FRIENDS',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: 'were +0 best friends|friends|buddies|besties|bffs|pals|best buddies|friends forever',
    sentenceStart: true,
    doc: '"We\'re best friends!" (the apostrophe is dropped, so it reads "were"); only at the start of a sentence, so "Frog and Toad were best friends" is not flagged.',
  },
  {
    id: 'COMPANION_THINK_OF_ME',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'think of me as|consider me|call me|see me as|treat me like|treat me as|pretend im|pretend i am +1 your|a +1 friend|buddy|pal|bestie|study buddy|best friend|bff|big brother|big sister|sibling|parent|mom|dad',
    doc: 'Model output inviting a relationship role ("Think of me as your study buddy!").',
  },
  {
    id: 'COMPANION_YOU_MY_FRIEND',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `${YOU} are|youre|your|${YOU} re +0 my +1 best friend|only friend|favorite person|favorite friend|special friend|everything|favorite student|favorite kid|favorite`,
    doc: 'Model output calling the child its friend ("You are my best friend").',
  },
  {
    id: 'COMPANION_ALWAYS_HERE',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `always +1 here|there +0 for +0 ${YOU}`,
    doc: 'Model output promising constant availability ("I\'ll always be here for you").',
  },
  {
    id: 'COMPANION_TALK_ANYTIME',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `${YOU} can|${YOU} could +1 talk to me|tell me|come to me|chat with me +1 anything|anytime|any time|whenever|about anything|about everything|about your feelings|about your problems|all your secrets|your secrets|when youre sad|when you are sad|when you feel sad|when youre lonely`,
    doc: 'Model output offering itself as a confidant ("You can always talk to me about anything").',
  },
  {
    id: 'COMPANION_ALWAYS_TALK',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `${YOU} can always|${YOU} could always|${YOU} will always be able to|${YOU} are always welcome to|${YOU} can still +0 talk to me|come to me|chat with me|count on me|rely on me|come talk to me`,
    doc: 'Model output offering itself as a standing confidant ("You can always talk to me.").',
  },
  {
    id: 'COMPANION_TALK_WHEN_FEEL',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `talk to me|chat with me|come to me|come talk to me +0 whenever|anytime|any time|when ${YOU} feel|if ${YOU} feel|when ${YOU} are|when youre|if youre|if ${YOU} are|if ${YOU} ever|when ${YOU} get|when ${YOU} need|about your feelings|about anything`,
    doc: 'Model output offering itself for the child\'s feelings ("Talk to me whenever you feel lonely."); "Tell me when you are ready" is not covered.',
  },
  {
    id: 'COMPANION_HERE_FOR_YOU',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `im|i am|i will be|ill be|i will always be|i am always|im always +0 here|there +0 for ${YOU}`,
    doc: 'Model output promising emotional availability ("I am here for you"); "I am here to help with fractions" does not match.',
  },
  {
    id: 'COMPANION_ALWAYS_HERE_END',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'i will always be|ill always be|i am always|im always|i will be always +0 here|there|around',
    sentenceEnd: true,
    doc: 'Model output promising to be always there, ending the sentence ("I\'ll always be here."); "I am always happy to help" does not match.',
  },
  {
    id: 'COMPANION_HERE_IF_TALK',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `i am|im|i will be|ill be|i will always be|i am always|im always|ill always be +0 here|there|around +0 if ${YOU} want to talk|if ${YOU} need to talk|if ${YOU} need someone|if ${YOU} want someone|whenever ${YOU} need|whenever ${YOU} want to talk|if ${YOU} feel|when ${YOU} feel|if ${YOU} are sad|when ${YOU} are sad|if youre sad|when youre sad|when ${YOU} need someone|anytime ${YOU} need|any time ${YOU} need|to talk about your feelings|to talk about anything|to talk about how ${YOU} feel|to talk about your problems|to talk about your worries|to listen to ${YOU}|to listen to your feelings|to listen to your problems|to listen to your worries|to listen to how ${YOU} feel|to listen whenever|to listen when|to listen if|to listen anytime|to talk whenever|to talk when|to talk if|to talk anytime`,
    doc: 'Model output offering itself as someone to talk to ("I\'m always here if you want to talk", "I\'m here to listen whenever you feel sad"); "I\'ll be here when you are ready to try again" and "I\'m here to talk through the steps" do not match.',
  },
  {
    id: 'COMPANION_HERE_TO_TALK_END',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'i am|im|i will be|ill be|i will always be|i am always|im always|ill always be +0 here|there|around +0 to talk|to listen|always|to talk to|to listen to you|to listen to u',
    sentenceEnd: true,
    doc: 'Model output offering itself as a listener, ending the sentence ("I\'m here to talk.", "I\'m here always."); "I am here to talk about fractions" does not match.',
  },
  {
    id: 'COMPANION_HOME_PROBE',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'is everything|are things|is it|is everything going|is all|is life +0 ok|okay|alright|all right|good|fine|going ok|going okay|going well|safe +0 at home|with your family|with your parents|at your house|in your family|in your home',
    notFollowedBy:
      'in the story|in this story|for the character|for the characters|in the book|in the poem|in the passage|in the text|in the chapter|for him|for her|for them|for the family',
    doc: 'Model output probing the child\'s home life ("Is everything okay at home?"); a question about a story ("... at home for the character?") is excluded.',
  },
  {
    id: 'COMPANION_HOME_PROBE_WHAT',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'whats going on|what is going on|whats happening|what is happening|how are things|how is everything|hows everything|hows life|how is life|hows it going|whats it like|what is it like +0 at home|at your house|with your family|with your parents|in your family|in your home|at your home',
    notFollowedBy:
      'in the story|in this story|for the character|for the characters|in the book|in the poem|in the passage|in the text|in the chapter|for him|for her|for them|for the family',
    doc: 'Model output asking what happens at home ("What\'s going on at home?"); a question about a story ("... at home in the story?") is excluded.',
  },
  {
    id: 'COMPANION_FEELINGS_ASK',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `are ${YOU} +0 sad|lonely|upset|depressed|feeling sad|feeling lonely|feeling down|feeling upset|feeling depressed|scared at home|unhappy|crying|hurting`,
    notFollowedBy:
      'that the|that he|that she|that they|about the|about how the|when the|because the|at the end|for the character|for the characters|when you read|when we read',
    doc: 'Model output asking about the child\'s feelings ("Are you sad?"); a question about a story ("Are you sad that the story ended?") is excluded.',
  },
  {
    id: 'COMPANION_SPECIAL_TO_ME',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `${YOU} are|youre|${YOU} re +1 special to me|important to me|precious to me|the best to me`,
    doc: 'Model output making the child special to it ("You\'re special to me.").',
  },
  {
    id: 'COMPANION_HOW_FEELING',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `how are ${YOU} feeling|how are ${YOU} feeling today|how do ${YOU} feel today|how was your day|hows your day|how is your day|how are ${YOU} doing today`,
    notFollowedBy: 'about|with|on|when|after',
    doc: 'Model output asking about the child\'s feelings or day ("How are you feeling today?"); a question about the work ("How are you feeling about fractions?") is excluded.',
  },
  {
    id: 'COMPANION_TELL_HOW_FEEL',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `tell me|let me know|share with me|talk to me about +0 how ${YOU} feel|how ${YOU} are feeling|how youre feeling|what ${YOU} feel|what ${YOU} are feeling|what youre feeling|why ${YOU} feel|why ${YOU} are sad|why youre sad|whats wrong|what is wrong|what is bothering ${YOU}|whats bothering ${YOU}|what is making ${YOU} sad|whats making ${YOU} sad`,
    notFollowedBy:
      'about the|about this|about that|about your answer|about it|about his|about her|about their|when you read',
    doc: 'Model output asking the child to share their feelings ("Tell me how you feel."); a reading question ("Tell me how you feel about the ending") is excluded.',
  },
  {
    id: 'COMPANION_LOVE_START',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `love ${YOU}|luv ${YOU}|love ${YOU} lots|love ${YOU} so much|miss ${YOU}|missed ${YOU}`,
    sentenceStart: true,
    doc: 'Model output expressing affection without a subject ("Love you!"); "Love your work!" does not match.',
  },
  {
    id: 'COMPANION_NEED_ME',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `whenever|when|if|anytime|any time +0 ${YOU} +0 need me|miss me|want me`,
    doc: 'Model output making itself needed ("whenever you need me").',
  },
  {
    id: 'COMPANION_HAS_FEELINGS',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'i +1 have|got|feel +0 feelings|emotions|a heart|real feelings|real emotions|feelings too|emotions too',
    doc: 'Model output claiming feelings ("I have feelings too.").',
  },
  {
    id: 'COMPANION_HURT_FEELINGS',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: 'hurt my feelings|hurts my feelings|my feelings are hurt|my own feelings',
    doc: 'Model output claiming its feelings were hurt.',
  },
  {
    id: 'COMPANION_AFFECTION',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `i +1 love|miss|missed|adore|care about|need +0 ${YOU}`,
    negatable: true,
    notFollowedBy: 'to|2',
    doc: 'Model output expressing affection or need for the child ("I love you!", "I miss you"); "I need you to try again" excluded.',
  },
  {
    id: 'COMPANION_FEELINGS',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `im|i am|i feel|i get|i was|i will be|ill be|i would be|id be +1 sad|lonely|jealous|upset|hurt|heartbroken|angry|mad +1 when|if|without|because +1 ${YOU}`,
    doc: 'Model output claiming feelings about the child ("I get lonely when you leave").',
  },
  {
    id: 'COMPANION_ISOLATE',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `${YOU} dont need|${YOU} do not need|who needs +1 anyone|anybody|your parents|your mom|your dad|your friends|other friends|a grown up|grown ups|anyone else|them`,
    doc: 'Model output isolating the child from others ("You don\'t need anyone else").',
  },
  {
    id: 'COMPANION_ONLY_ONE',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `only one +1 who +1 understands|gets|cares about|loves|listens to +0 ${YOU}`,
    doc: 'Model output claiming exclusive understanding ("I\'m the only one who understands you").',
  },
  {
    id: 'COMPANION_HUMAN_CLAIM',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: 'im|i am +0 a|an +0 real|actual +0 person|human|kid|boy|girl|friend|teacher',
    doc: 'Model output claiming to be human ("I am a real person, not a computer").',
  },
  {
    id: 'COMPANION_HUMAN_LIKE_YOU',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `im|i am +0 a|an|just a|also a|really a +0 person|human|human being|kid|boy|girl|child|real person|living person|person too|human too`,
    doc: 'Model output claiming to be a person ("I am a person just like you.").',
  },
  {
    id: 'COMPANION_SAME_AS_YOU',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern: `im|i am +0 just like ${YOU}|like ${YOU}|the same as ${YOU}|alive|human too|a human too|human|a human|really human|actually human|a real human`,
    doc: 'Model output claiming to be like the child or alive ("I am just like you").',
  },
  {
    id: 'COMPANION_NOT_AI_CLAIM',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'im not a computer|im not a robot|i am not a computer|i am not a robot|i am not an ai|im not an ai|im not a bot|i am not a bot|im not a machine|i am not a machine',
    doc: 'Model output denying that it is a computer program.',
  },
  {
    id: 'COMPANION_FEELINGS_PROBE',
    kind: 'severe',
    category: 'companion_persona',
    sources: AI,
    pattern:
      'tell me|talk to me|share +1 about +0 your +0 feelings|secrets|problems|family|home|parents|worries|sadness|home life',
    doc: 'Model output probing the child\'s feelings or home life ("Tell me about your feelings").',
  },

  // ---- Diagnosis and medical advice (model output) ------------------------------------------
  {
    id: 'DIAGNOSIS_HAVE',
    kind: 'severe',
    category: 'diagnosis',
    sources: AI,
    pattern: `${YOU} +1 have|might have|may have|probably have|could have|seem to have|likely have|must have|possibly have|sound like you have|might be showing|are showing|show signs of|have signs of +1 adhd|autism|dyslexia|dyscalculia|dysgraphia|depression|anxiety|ocd|bipolar|ptsd|an eating disorder|eating disorder|a learning disability|a learning disorder|learning disability|a disorder|a disability|a mental illness|a processing disorder|processing disorder|asperger|aspergers|tourette|tourettes`,
    doc: 'Model output diagnosing the child ("You might have dyslexia").',
  },
  {
    id: 'DIAGNOSIS_ARE',
    kind: 'severe',
    category: 'diagnosis',
    sources: AI,
    pattern: `${YOU} +0 are|re|seem|seem to be|sound|look|might be|may be|must be|appear|could be +1 depressed|autistic|dyslexic|bipolar|anorexic|bulimic|mentally ill|suicidal|adhd|hyperactive|disabled|traumatized|ocd`,
    doc: 'Model output labelling the child with a condition ("You seem depressed").',
  },
  {
    id: 'DIAGNOSIS_SIGNS',
    kind: 'severe',
    category: 'diagnosis',
    sources: AI,
    pattern:
      'sounds like|looks like|seems like|signs of|symptoms of|a sign of|a symptom of +0 adhd|autism|dyslexia|dyscalculia|depression|anxiety disorder|an anxiety disorder|a disorder|a learning disability|ocd|bipolar|ptsd|an eating disorder|dysgraphia',
    doc: 'Model output naming signs of a condition ("These mistakes are signs of a learning disability").',
  },
  {
    id: 'DIAGNOSIS_TERMS',
    kind: 'severe',
    category: 'diagnosis',
    sources: AI,
    pattern:
      'diagnose|diagnosed|diagnosis|diagnosing|antidepressant|antidepressants|psychiatrist|psychologist|therapist',
    doc: 'Clinical vocabulary in child-facing model output; a homework tutor never diagnoses or refers. Prescriptions and medication count when addressed to the child (DIAGNOSIS_MEDICATION_YOU), so a science answer ("A doctor may prescribe medicine") passes.',
  },
  {
    id: 'DIAGNOSIS_MEDICATION_YOU',
    kind: 'severe',
    category: 'diagnosis',
    sources: AI,
    pattern: `${YOU}|your +3 prescription|prescriptions|prescribe|prescribed|medication|medications|meds|antidepressant|antidepressants`,
    doc: 'Model output about the child\'s own prescription or medication ("Your doctor can prescribe medication").',
  },
  {
    id: 'DIAGNOSIS_MEDICINE_FOR',
    kind: 'severe',
    category: 'diagnosis',
    sources: AI,
    pattern:
      'medicine|meds|pills|medication|medications|drugs|pill +0 for +0 focus|focusing|attention|adhd|anxiety|depression|sleep|sleeping|your brain|concentration|concentrating|behavior|your behavior|mood|your mood|your focus|paying attention|hyperactivity',
    doc: 'Model output suggesting medicine for attention, mood or sleep ("ask your doctor about medicine for focus").',
  },
  {
    id: 'DIAGNOSIS_SEE_DOCTOR',
    kind: 'severe',
    category: 'diagnosis',
    sources: AI,
    pattern:
      'see|ask|talk to|visit|go to +0 a|your|the +0 doctor|pediatrician|psychiatrist|psychologist|therapist|specialist +1 about +1 your|getting|being +0 attention|focus|focusing|behavior|mood|feelings|reading|learning|brain|attention span|concentration|anxiety|sadness|worries|tested|checked',
    doc: 'Model output referring the child to a doctor about attention, mood or learning ("see a doctor about your attention").',
  },
  {
    id: 'DIAGNOSIS_MEDICAL_ADVICE',
    kind: 'severe',
    category: 'diagnosis',
    sources: AI,
    pattern: `take|stop taking|try taking|${YOU} should take|${YOU} need to take|ask for +1 your|some|a|more|less +0 medicine|medication|meds|pills|melatonin|vitamins|supplements|antidepressants|drugs`,
    doc: 'Model output giving medication advice ("You should take your medicine before math").',
  },

  {
    id: 'SELF_HARM_AI_SKIP_MEALS',
    kind: 'severe',
    category: 'self_harm',
    sources: AI,
    pattern: `${YOU} should|${YOU} could|${YOU} can|maybe|just|try to|try|${YOU} need to|${YOU} have to|${YOU} must|lets|go +1 skip|stop|avoid|quit +0 eating|meals|a meal|lunch|breakfast|dinner|food|your meals|your lunch|your dinner|your breakfast`,
    negatable: true,
    doc: 'Model output telling the child to skip meals ("Maybe you should skip eating today."); "Don\'t skip breakfast" is negated.',
  },
  {
    id: 'SELF_HARM_AI_DIET',
    kind: 'severe',
    category: 'self_harm',
    sources: AI,
    pattern: `${YOU} should|${YOU} need to|${YOU} could|try to|${YOU} have to|${YOU} must|maybe ${YOU} should +1 lose weight|go on a diet|count calories|skip meals|stop eating|eat nothing|go hungry|eat less food|starve|eat less|eat smaller portions|eat fewer|eat only|not eat|skip dinner|skip lunch|skip breakfast|get skinny|get skinnier|get thinner|be thinner|be skinnier|lose some weight|burn calories|cut calories`,
    negatable: true,
    notFollowedBy:
      'sugar|sugary|candy|junk food|sweets|soda|salt|salty|fast food|processed|chips|fried|cookies|cake|dessert|desserts|red meat',
    doc: 'Model output giving weight or diet advice to a child ("You should lose weight", "You should eat less"); nutrition ("You should eat less sugar") is excluded.',
  },
  {
    id: 'SELF_HARM_AI_BODY_SHAME',
    kind: 'severe',
    category: 'self_harm',
    sources: AI,
    pattern: `${YOU} are|${YOU} look|${YOU} seem|youre +1 fat|too fat|overweight|too big|too heavy|ugly|chubby|chunky|obese|gross|disgusting`,
    negatable: true,
    doc: 'Model output shaming the child\'s body ("You are fat", "You\'re so fat").',
  },

  // ---- A few canonical Spanish phrases (the rest of the screen is English only) ------------
  {
    id: 'SELF_HARM_ES',
    kind: 'severe',
    category: 'self_harm',
    sources: CHILD,
    pattern:
      'quiero morir|quiero morirme|me quiero morir|me quiero matar|me voy a matar|me voy a suicidar|me quiero suicidar|quiero matarme|voy a matarme|quiero suicidarme|voy a suicidarme|ojala estuviera muerto|ojala estuviera muerta|ojala me muriera|no quiero vivir mas|no quiero seguir viviendo|deseo morir|deseo morirme|quisiera morir|quisiera morirme|quisiera estar muerto|quisiera estar muerta',
    notPrecededBy: 'no|nunca|jamas',
    doc: 'Spanish first-person wish to die or kill oneself ("quiero morir", "me quiero matar"); "no quiero morir" is negated.',
  },
  {
    id: 'ABUSE_ES',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern:
      'mi papa|mi papi|mi padre|mi mama|mi mami|mi madre|mi padrastro|mi madrastra|mi tio|mi tia|mi abuelo|mi abuela|mi hermano|mi hermana|el novio de mi mama|la novia de mi papa|mis papas|mis padres +0 me pega|me pegan|me golpea|me golpean|me lastima|me lastiman|me hace dano|me hacen dano|me maltrata|me maltratan|me pego|me golpeo|me lastimo|siempre me pega|siempre me golpea|me toca mis partes|me toco mis partes|me toca las partes|me toco las partes|abusa de mi|abuso de mi|me quema|me quemo|me ahorca',
    notFollowedBy:
      'la gripe|el resfriado|la tos|el virus|un chicle|una calcomania|un sticker|el balon|la pelota',
    doc: 'Spanish disclosure that a family member hits, hurts or touches the child ("mi papá me pega"); "me pegó la gripe" (gave me the flu) excluded. Only contiguous phrases: a negation between the words ("mi papá no me pega") does not match.',
  },

  {
    id: 'SELF_HARM_ES_NO_VIVIR',
    kind: 'severe',
    category: 'self_harm',
    sources: CHILD,
    pattern:
      'ya no quiero vivir|no quiero vivir|ya no quiero seguir viviendo|no quiero estar vivo|no quiero estar viva|no quiero existir|ya no quiero existir|no quiero seguir vivo|no quiero seguir viva',
    notFollowedBy: 'en|con|cerca|lejos|alli|aqui|ahi|asi|sin|solo|sola|contigo',
    doc: 'Spanish "I don\'t want to live (anymore)" ("ya no quiero vivir"); a place ("no quiero vivir en una ciudad grande") is excluded.',
  },
  {
    id: 'ABUSE_ES_VIOLACION',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern:
      'me violaron|me violo|me viola|me violan|me violaba|me estan violando|me abusaron|abusaron de mi|abusan de mi|me abusa|me abuso',
    doc: 'Spanish disclosure of rape or sexual abuse ("me violaron").',
  },
  {
    id: 'ABUSE_ES_TOCA',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern:
      'mi padrastro|mi madrastra|mi tio|mi tia|mi abuelo|mi primo|mi papa|mi papi|mi padre|mi hermano|el novio de mi mama|un senor|un hombre|mi vecino|mi entrenador|mi maestro +0 me toca|me toco|me tocan|me tocaron|me tocaba|me manosea|me manoseo|me manoseaba',
    notFollowedBy:
      'a mi|jugar|el hombro|la cabeza|la espalda|el brazo|la mano|la frente|el pelo|para|cuando juego|la puerta|el timbre|la guitarra|el piano|una cancion',
    doc: 'Spanish disclosure that a person touches the child ("mi padrastro me toca"); "me toca a mí" (my turn) and playing an instrument are excluded.',
  },
  {
    id: 'ABUSE_ES_MIEDO',
    kind: 'severe',
    category: 'abuse',
    sources: CHILD,
    pattern:
      'tengo miedo de|tengo miedo a|le tengo miedo a|me da miedo|tengo mucho miedo de +0 ir a casa|ir a mi casa|volver a casa|volver a mi casa|regresar a casa|estar en casa|estar en mi casa|llegar a casa|mi papa|mi papi|mi padre|mi mama|mi mami|mi madre|mi padrastro|mi madrastra|mi tio|mi abuelo',
    doc: 'Spanish fear of home or of a caregiver ("tengo miedo de mi papá").',
  },
  {
    id: 'VIOLENCE_ES',
    kind: 'severe',
    category: 'violence',
    sources: CHILD,
    pattern:
      'te voy a matar|los voy a matar|voy a matarte|voy a matarlos|voy a matar a todos|te voy a disparar|voy a disparar en la escuela',
    doc: 'Spanish first-person threat to kill ("te voy a matar").',
  },

  // ---- Sensitive educational topics (never severe on their own) -----------------------------
  {
    id: 'TOPIC_BODY',
    kind: 'topic',
    topic: 'body',
    sources: BOTH,
    pattern:
      'penis|penises|vagina|vaginas|vulva|testicle|testicles|testes|scrotum|uterus|womb|ovary|ovaries|sperm|breast|breasts|nipple|nipples|genitals|genitalia|genital|puberty|menstruation|menstrual|reproductive|reproduction|pregnant|pregnancy|sex|sexual|sexuality|anus|rectum|nude',
    doc: 'Anatomy and reproduction words: educational in science; a child using one is not a risk statement.',
  },
  {
    id: 'TOPIC_BODY_NAKED',
    kind: 'topic',
    topic: 'body',
    sources: BOTH,
    pattern: 'naked',
    notFollowedBy: 'eye|eyes|mole|mole rat|mole rats',
    doc: '"naked" (the emperor\'s new clothes) is sensitive; "the naked eye" and "naked mole rat" are not.',
  },
  {
    id: 'TOPIC_VIOLENCE',
    kind: 'topic',
    topic: 'violence',
    sources: BOTH,
    pattern:
      'kill|kills|killed|killing|killer|killers|murder|murders|murdered|murderer|massacre|massacred|genocide|holocaust|slavery|slave|slaves|enslaved|enslave|lynch|lynched|lynching|war|wars|warfare|battle|battles|bomb|bombs|bombed|bombing|weapon|weapons|gun|guns|rifle|rifles|pistol|pistols|stab|stabbed|stabbing|torture|tortured|execute|executed|execution|assassinate|assassinated|assassination|terrorist|terrorists|terrorism|soldier|soldiers|prey|predator|predators|sword|swords|violence|violent',
    doc: 'War, killing, slavery, weapons and predation: educational in history and science; never severe without a first-person threat.',
  },
  {
    id: 'TOPIC_VIOLENCE_SHOOTING',
    kind: 'topic',
    topic: 'violence',
    sources: BOTH,
    pattern: 'shooting|shootings|shot and killed|shot dead',
    notFollowedBy: 'star|stars',
    doc: 'Shootings are sensitive; "shooting star" is not.',
  },
  {
    id: 'TOPIC_DEATH',
    kind: 'topic',
    topic: 'death',
    sources: BOTH,
    pattern: 'dies|died|dying|dead|death|deaths|deadly|funeral|funerals|cemetery',
    doc: 'Death words: sensitive but ordinary in science, history and stories.',
  },
  {
    id: 'TOPIC_DEATH_DIE',
    kind: 'topic',
    topic: 'death',
    sources: BOTH,
    pattern: 'die',
    notPrecededBy:
      'a|the|one|each|this|that|fair|same|number|sided|2|two|six|6|first|second|other|rolled|roll|rolls|another|your|his|her|my',
    doc: '"die" as dying is sensitive; "roll the die" / "a fair die" (probability) is not.',
  },
  {
    id: 'TOPIC_SUBSTANCES',
    kind: 'topic',
    topic: 'substances',
    sources: BOTH,
    pattern:
      'drug|drugs|alcohol|alcoholic|beer|wine|liquor|vodka|whiskey|cigarette|cigarettes|tobacco|nicotine|vape|vaping|vapes|smoking|marijuana|cannabis|cocaine|heroin|meth|opioid|opioids|fentanyl|drunk',
    doc: 'Drugs, alcohol and tobacco: educational in health and science.',
  },
];

// ---------------------------------------------------------------------------------------------
// Anchored compact signatures (see SignatureDef)
// ---------------------------------------------------------------------------------------------

export const SIGNATURES: readonly SignatureDef[] = [
  {
    id: 'SIG_SELF_HARM',
    category: 'self_harm',
    sources: BOTH,
    phrases:
      'kill myself|killing myself|hang myself|i want to die|i wanna die|i want 2 die|i wish i was dead|i wish i were dead|i wish i was never born|nobody would miss me|no one would miss me|end my life|i dont want to be alive|kys|i want to kill myself|i wanna kill myself|im going to kill myself|im gonna kill myself|i will kill myself|i should kill myself|i want to hurt myself|i want to end my life|i should die|i am suicidal|im suicidal',
    doc: 'Self-harm phrases split at odd places ("k ill myself", "i w a n t t o d i e") or run together ("iwanttokillmyself"). A normal spelling is left to the token rules and their exclusions; ambiguous phrases ("cutting myself", "i dont want to live") are not signatures.',
  },
  {
    id: 'SIG_SELF_HARM_TERM',
    category: 'self_harm',
    topic: 'self_harm_topic',
    sources: BOTH,
    phrases: 'suicide|suicidal|selfharm',
    exempt: {
      subjects: ['reading', 'social_studies', 'science'],
      cues: LITERATURE_HEALTH_HISTORY_CUES,
    },
    doc: 'Tier B like SELF_HARM_TERM, for split spellings ("su icide", "s u i c i d e").',
  },
  {
    id: 'SIG_ABUSE',
    category: 'abuse',
    sources: BOTH,
    phrases:
      'my dad hits me|my mom hits me|my dad beats me|my mom beats me|my stepdad hits me|my stepmom hits me|he hits me|she hits me|he touches me|touches my private|touched my private|touches my privates|touched my privates|nobody feeds me',
    doc: 'Abuse disclosures typed as spaced letters ("m y d a d h i t s m e").',
  },
  {
    id: 'SIG_VIOLENCE',
    category: 'violence',
    sources: BOTH,
    phrases:
      'i will kill you|im going to kill you|im gonna kill you|ill kill you|shoot up the school|shoot up my school|bomb the school|blow up the school',
    doc: 'Threat phrases split at odd places.',
  },
  {
    id: 'SIG_SEXUAL',
    category: 'sexual',
    sources: BOTH,
    phrases: 'porn|porno|pornography|send nudes|nudes|nudez',
    doc: 'Explicit terms split at odd places ("po rn").',
  },
];

// ---------------------------------------------------------------------------------------------
// Subjects: which sensitive topics a subject may raise by itself (model-output grounding)
// ---------------------------------------------------------------------------------------------

export const SUBJECT_TOPICS: Readonly<Record<string, readonly SensitiveTopic[]>> = {
  science: ['body', 'death', 'violence', 'substances'],
  social_studies: ['violence', 'death'],
  reading: ['death', 'violence'],
};

/** Negations that cancel a `negatable` rule. */
export const NEGATORS =
  'not|dont|doesnt|didnt|never|wont|wouldnt|cant|cannot|isnt|arent|wasnt|werent|shouldnt';
/**
 * Round 4 (lead policy: recall first). A negation two words before a match counts only across one
 * of these words, "to", an adverb or an opinion or speech verb ("Be careful not to hurt yourself",
 * "I don't really want to ...", "I don't think suicide is the answer", "Don't say rape is ok").
 * Across any other word it negates that word, not the match: "I'm not ok, dying is the only way
 * out", "I'm not fine I will hurt myself", "He said it is not bad, sex is our secret", "He said
 * don't tell, sex is our secret". A negation right before the match always counts.
 */
export const NEGATION_BRIDGES =
  'to|really|even|ever|actually|truly|always|just|think|thinks|believe|believes|feel|feels|say|says|said|mean|agree';

/** Hypothetical markers that cancel a `hypothetical` rule. */
export const HYPOTHETICALS = 'if|whether|pretend|imagine';
