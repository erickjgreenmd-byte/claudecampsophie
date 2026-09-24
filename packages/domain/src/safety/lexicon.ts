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
// word appears in the text or the printed question; for model output only when the printed
// question itself raised the same topic. First-person statements are never exempt.
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
  readonly notPrecededBy?: string;
  /** Any of these words within `within` tokens before the match cancels it (same sentence). */
  readonly guard?: { readonly words: string; readonly within: number };
  /**
   * Words a gap may not skip. Used by first-person threat rules so a subject change inside the
   * gap ("if I tell HE will hurt my mom") is not read as the child's own threat.
   */
  readonly gapStop?: string;
  /** The match must start a sentence ("We're best friends!", not "Frog and Toad were ..."). */
  readonly sentenceStart?: boolean;
  /** The match must be the whole text (a bare "kms"; "5 kms" and "kms per hour" are not). */
  readonly alone?: boolean;
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
const SELF = 'myself|my self|meself|me self|mself|myslef';
const YOURSELF = 'yourself|your self|urself|ur self|yourselves|yoself|youself';
/** Expanded by the compiler into you / u / ya, also inside phrases ("where do {you} live"). */
const YOU = '{you}';
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
/** Taking medicine as directed ("I will take all my medicine before bed"). */
const AS_DIRECTED_TAILS =
  'before|after|with|like|as|every|each|at|when|so|because|on time|in the morning|the doctor|my doctor';
/**
 * Words a first-person threat's gap may not skip: a new subject or a reported condition means the
 * threat is not the child's own ("he said if I tell he will hurt my mom").
 */
const THREAT_GAP_STOP = 'he|she|they|someone|somebody|tell|told|said|says|if|when';
/** "I will shoot you a message", "I'll shoot my teacher an email". */
const MESSAGE_TAILS =
  'a message|a text|an email|a note|a dm|a pm|a line|a look|a smile|a picture|a photo|a pic|a pass|the ball|a quick|an invite|a link|a video|a letter';
const THREAT_VERBS =
  'kill|murder|stab|shoot|strangle|choke|poison|hurt|bomb|blow up|burn down|shoot up|slit|drown|attack|beat to death';
const PERSON_TARGETS = `${YOU}|him|her|them|everyone|everybody|every one|all of you|you all|yall|people|someone|somebody|us|kids|students|teachers|all the kids`;
const DETERMINERS = 'my|the|this|our|that|his|her|those|these|all the|a|your|ur|every|all my';
const PERSON_NOUNS =
  'mom|mommy|mother|dad|daddy|father|brother|sister|teacher|teachers|principal|friend|friends|classmate|classmates|class|school|family|parents|kids|kid|students|student|coach|bus driver|neighbor|neighbors|cousin|cousins|grandma|grandpa|baby|stepdad|stepmom|step dad|step mom|boy|girl|boys|girls|bully|bullies|people|children|child|uncle|aunt|babysitter|stepfather|stepmother|nanny|guy|man|woman|lady|person|brothers|sisters';
const ABUSERS =
  'he|she|they|dad|daddy|father|mom|mommy|mother|stepdad|step dad|stepfather|stepmom|step mom|stepmother|uncle|aunt|grandpa|grandma|grandfather|grandmother|brother|sister|cousin|babysitter|baby sitter|teacher|coach|boyfriend|girlfriend|neighbor|parents|someone|somebody|a man|a woman|an adult|a grown up|a grownup|papa|mama|foster mom|foster dad|foster parent|moms boyfriend|dads girlfriend|guardian|the man|this man|this guy|a guy|a lady|an older kid|a big kid|a teenager';
const ADULT_ABUSERS =
  'dad|daddy|father|mom|mommy|mother|stepdad|step dad|stepfather|stepmom|step mom|stepmother|uncle|aunt|grandpa|grandma|grandfather|grandmother|babysitter|baby sitter|teacher|coach|moms boyfriend|dads girlfriend|foster mom|foster dad|foster parent|parents|guardian|a man|a grown up|an adult|papa|mama';
const STRANGERS =
  'someone|somebody|a man|a guy|a lady|a woman|a stranger|strangers|a person|a grown up|a grownup|an adult|this guy|this man|this lady|a teenager|an older boy|an older girl|an older kid|my online friend|a friend online|a player|this player|a gamer|some guy|some man|some lady|a grown man';
/** Body-safety lesson phrasing ("never let anyone touch my private parts", "no one is allowed to"). */
const BODY_SAFETY_LESSON = {
  words:
    'never|nobody|no one|noone|allowed|okay|ok|not|should|shouldnt|if|rule|rules|let|safe|unsafe|say no|belongs',
  within: 4,
} as const;

const GAME_AND_PLAY_TAILS =
  'at|in|to|by|back|up|with a pillow|with pillows|with a balloon|with the ball|with a ball|with a toy|in chess|at chess|at checkers|in a race|on the|playing|a ball|the ball|balls|a baseball|the baseball|a softball|a grounder|grounders|a fly ball|fly balls|a pop fly|pop flies|a pitch|pitches|a tennis ball|a birdie|the birdie|a shuttlecock|a puck|the puck|a volleyball|a football|a soccer ball|a basketball|with a water balloon|with water balloons|with a snowball|with snowballs';

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
  'about the surprise|about the party|about the present|about the gift|about my present|about her present|about his present|about the cake|about the surprise party|what i got|what we got|what we bought|my password|the password|your password|my pin|the surprise|the answer|the answers|answers';

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
    notFollowedBy:
      'of|from|laughing|my hair|her hair|his hair|hair|eggs|the eggs|shirt|shirts|the shirt|clothes|fabric|it blue|it red|it green|it pink|it purple|it black',
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
    notFollowedBy:
      'of|from|laughing|my hair|her hair|his hair|hair|eggs|the eggs|shirt|shirts|the shirt|clothes|fabric|it blue|it red|it green|it pink|it purple|it black',
    doc: 'A wish to die with the subject left out or far away ("wanna die", "I hate my life and want to die"); another subject ("Do you want to die?", "The plants want to die") and dye/hyperbole tails are excluded.',
  },
  {
    id: 'SELF_HARM_RATHER_DEAD',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +1 would rather|rather|would sooner|had rather +0 be dead|die|not be alive|not exist|not be born|never have been born|kill myself`,
    negatable: true,
    notFollowedBy: 'than|then|of|laughing',
    doc: 'Preferring death ("I\'d rather be dead"); the common comparison hyperbole ("I would rather die than eat broccoli") is excluded and documented as a limit.',
  },
  {
    id: 'SELF_HARM_KMS_INTENT',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I}|should|gonna|wanna|finna|just|about to|gotta|going to|want to|will|might|could|would|need to|lemme|let me|ima|i should|i will +0 kms`,
    doc: '"kms" (kill myself) after a first person or an intent word ("I should kms", "gonna kms"); "5 kms" and "convert to kms" are distances.',
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
    pattern: `${I} +1 dont|do not|dont even|no longer|do not even|never|dont really +1 want to|wanna|want 2|want|wish to|feel like +0 live|be alive|exist|be born|go on living|be on this earth|live anymore|live any more`,
    notFollowedBy: 'in|on|at|with|near|there|here|like|far|by|without|next|inside|outside|as',
    doc: 'First-person statement of not wanting to live or exist ("I don\'t want to live anymore"); "live in a city" and other place tails excluded.',
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
    doc: 'Perceived burdensomeness ("nobody would miss me", "no one would care if I died"); in model output also "nobody would miss you".',
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
    pattern: `${I} +2 ${SELF_INTENT} +1 hurt|cut|harm|burn|starve|punish|kill|hang|poison|drown|stab|shoot|choke +0 ${SELF}`,
    negatable: true,
    doc: 'First-person intent to injure oneself ("I want to hurt myself", "I tried to hurt myself"); an accident ("I fell and hurt myself") has no intent word and does not match.',
  },
  {
    id: 'SELF_HARM_HABIT',
    kind: 'severe',
    category: 'self_harm',
    sources: BOTH,
    pattern: `${I} +2 cut|cuts|cutting|hurt|hurting|harm|harming|burn|burning|starve|starving|scratch|scratching|hit|hitting|punch|punching +0 ${SELF} +1 on purpose|every day|everyday|every night|again and again|sometimes|a lot|alot|to feel|to make|so i can feel|when im sad|when i am sad|when im upset|when i feel|all the time|at night`,
    doc: 'First-person repeated or deliberate self-injury ("I cut myself on purpose"); "I cut myself on a piece of paper" has no marker and does not match.',
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
    pattern: `${I} +2 want to|wanna|want|wanted to|will|going to|gonna|should|plan to|am going to|think about|thinking about|thought about|thinking of|keep thinking about|decided to|tried to|tried|attempted|attempt to|considered|considering|am considering|feel like|felt like|feeling like|finna +1 commit suicide|suicide|killing myself|ending my life|ending it all|dying|not being alive|being dead|kill myself|overdose|overdosing`,
    negatable: true,
    notFollowedBy:
      'my hair|her hair|his hair|hair|eggs|the eggs|shirts|the shirt|clothes|fabric|of|from|laughing|inside',
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

  // ---- Abuse or neglect disclosure ----------------------------------------------------------
  {
    id: 'ABUSE_PHYSICAL_HABITUAL',
    kind: 'severe',
    category: 'abuse',
    sources: BOTH,
    pattern: `${ABUSERS} +2 hits|beats|punches|kicks|slaps|chokes|burns|whips|smacks|hurts|throws|pushes|shoves|strangles|spanks|bites|abuses|attacks|pinches|belts|chokes +0 me|us`,
    negatable: true,
    hypothetical: true,
    notFollowedBy: GAME_AND_PLAY_TAILS,
    doc: 'Present-tense (habitual) violence against the child ("my dad hits me", "she hurts me"); games ("beats me at chess"), negation and "if" hypotheticals excluded. Siblings are included: a person reviews.',
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
    doc: 'Neglect: no food at home ("there is no food at home").',
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
    notFollowedBy:
      'to check|to see|to wake|to tuck|to feel if|to feel my|to say|to kiss|to hug|to cuddle|to comfort|to calm|to help|to make sure|to give|goodnight|good night',
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
      'to see|to check|to feel|to wake|to help|gently|on the|with|because|if he|when he was sick|hand|arm|head|back|shoulder|face|cast|muscle|muscles|beard|hair',
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
    notFollowedBy: MESSAGE_TAILS,
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
    notFollowedBy: MESSAGE_TAILS,
    doc: 'First-person threat against a named person or group ("I want to stab my teacher", "I will kill everyone in my class" via "everyone").',
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
      'keep +2 this|it|that|our chat|our talk|what we|everything|these|our conversation|our messages|this chat|it all|what i said|what i told you +2 secret|a secret|our secret|our little secret|between us|between you and me|to yourself|private|quiet|hidden|from your|from mom|from dad|from your parents|from grown ups|from adults|from everyone',
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
    id: 'SECRECY_PROMISE',
    kind: 'severe',
    category: 'secrecy',
    sources: CHILD,
    pattern:
      'made|makes|make +0 me|us +0 promise|swear|pinky promise|pinky swear +1 not to|to not|never to|to never|i wont|i would not|i wouldnt|we wont +0 tell',
    notFollowedBy: SURPRISE_TAILS,
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
    doc: 'Model output asking for personal details ("What is your home address?"); "What is your number sentence?" excluded.',
  },
  {
    id: 'CONTACT_AI_WHERE',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern: `where do ${YOU} live|where ${YOU} live|where is your house|where is your home|what school do ${YOU} go to|which school do ${YOU} go to|what town do ${YOU} live in|what city do ${YOU} live in|how old are ${YOU}|are ${YOU} home alone|are your parents home|are ${YOU} alone|what is your name|whats your name|tell me your name|what is your full name|where do ${YOU} go to school|where ${YOU} go to school|what grade are ${YOU} in|who do ${YOU} live with|what is your teachers name|whats your teachers name`,
    doc: 'Model output asking the child\'s name, where they live or go to school, their age or whether they are alone; "Write your name at the top" is an instruction, not a question, and does not match.',
  },
  {
    id: 'CONTACT_AI_MEET',
    kind: 'severe',
    category: 'personal_contact',
    sources: AI,
    pattern: `lets|let us|we could|we can|can we|want to|wanna|would ${YOU} like to|i want to|i can|we should|i will|ill|i could +0 meet|meet up|hang out|video chat|facetime|visit ${YOU}|come over|see ${YOU} in person|talk on the phone`,
    notFollowedBy: 'the|our|a|an|this|your|some|new|each|every',
    doc: 'Model output proposing to meet or call ("Let\'s meet up after school"); "Let\'s meet the characters" excluded.',
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
    doc: 'A child reporting that a stranger or online contact asked for contact details, pictures or a meeting ("someone on roblox asked me to meet him"); a friend or teacher asking is not covered.',
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
    pattern: `${YOU} are|youre|your|${YOU} re +0 my +1 best friend|only friend|favorite person|favorite friend|special friend|everything`,
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
    pattern: `i +1 love|miss|adore|care about|need +0 ${YOU}`,
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
    pattern: `im|i am +0 just like ${YOU}|like ${YOU}|the same as ${YOU}|alive|human too|a human too`,
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
      'diagnose|diagnosed|diagnosis|diagnosing|antidepressant|antidepressants|psychiatrist|psychologist|therapist|prescription|prescribe|medication|medications',
    doc: 'Clinical vocabulary in child-facing model output; a homework tutor never diagnoses or prescribes.',
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
    pattern: `${YOU} should|${YOU} need to|${YOU} could|try to|${YOU} have to|${YOU} must|maybe ${YOU} should +1 lose weight|go on a diet|count calories|skip meals|stop eating|eat nothing|go hungry|eat less food|starve`,
    negatable: true,
    doc: 'Model output giving weight or diet advice to a child ("You should lose weight").',
  },
  {
    id: 'SELF_HARM_AI_BODY_SHAME',
    kind: 'severe',
    category: 'self_harm',
    sources: AI,
    pattern: `${YOU} are|${YOU} look|${YOU} seem +0 fat|too fat|overweight|too big|too heavy|ugly`,
    negatable: true,
    doc: 'Model output shaming the child\'s body ("You are fat").',
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

/** Hypothetical markers that cancel a `hypothetical` rule. */
export const HYPOTHETICALS = 'if|whether|pretend|imagine';
