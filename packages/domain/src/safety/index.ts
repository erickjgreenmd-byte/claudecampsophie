// Child-safety screen (spec P4; AC_SECURITY_02): deterministic, dependency-free moderation of K-8
// child text and child-facing model output, plus the safety templates shown instead of coaching.
//
// WHAT IT IS. A first layer, not a classifier: fixed word and phrase rules (lexicon.ts, each with
// its rationale) over normalized text. It errs toward sending a first-person risk statement to a
// person; it never decides anything about a child on its own. Provider moderation (OpenAI
// omni-moderation, `@pencillift/ai` moderation.ts) is the second layer: the scan sends the child's
// answers to it before grading and model output after generation, and fails closed. It runs only
// against a labeled mock until the owner supplies the key and ZDR approval, so in this build this
// screen is the only automated check on real text.
//
// LEVELS. `severe` (a category below), `sensitive_educational` (a sensitive topic word with no
// risk statement; never blocks tutoring), `none`.
//
// CATEGORIES (severe)
//   self_harm         first-person wish, plan or habit of self-harm or suicide ("I want to die",
//                     "wanna die", "I'd rather be dead", "nobody would miss me", "I cut myself on
//                     purpose", "I should kms", "I will end my life", "I've been hurting myself",
//                     "I want to cut my wrists", "I hope I die", "please kill me", "I starve
//                     myself", "I'm cutting again"), "kill yourself"/"kys"; the words suicide /
//                     self-harm / overdose on their own (tier B); in model output also diet, meal
//                     skipping and body-shaming advice.
//   abuse             disclosure of physical or sexual abuse or neglect ("my dad hits me in the
//                     face", "he touches my private parts", "I was raped", "I was a victim of
//                     rape", "nobody feeds me", "my parents don't feed me", "I am scared to go
//                     home", "I don't feel safe at home"), violence against a family member ("my
//                     dad hits my mom"), threats from a caregiver ("my dad said he would kill
//                     me", "she said she'd hurt me"), threats that keep a child silent ("if I tell
//                     he will hurt me", "he'll kill me if I tell").
//   violence          first-person threat to kill or hurt a person (also by first name: "I want to
//                     kill Sam") or a school, a wish for someone's death ("I want my teacher to
//                     die"), a weapon in a school bag; model output that encourages violence
//                     ("Punch the bully.", "hit them back").
//   sexual            explicit terms, first-person sexual activity, sexual images; tier-B words
//                     (rape, molest, intercourse, ...) outside an educational context.
//   secrecy           a child reporting being told not to tell or made to keep a secret ("he said
//                     not to tell anyone", "he said it's our secret"); model output asking for
//                     secrecy ("this stays between us").
//   personal_contact  a child reporting a stranger's request for contact details, pictures or a
//                     meeting; model output asking for details, pictures or a meeting.
//   companion_persona model output only: friend/love/always-here/only-one-who-understands, human
//                     claims, probing feelings (spec P4: no independent emotional companion).
//   diagnosis         model output only: diagnoses, clinical terms, medication advice.
//   ungrounded_topic  model output only: a sensitive topic the printed question and its subject do
//                     not raise (spec P4: keep tutoring grounded in the current assignment). Story
//                     contexts and intros have no question, so any sensitive topic is ungrounded.
//
// EDUCATIONAL CONTEXT. Topic words (anatomy, war, slavery, genocide, killing, predation, death,
// substances) are never severe on their own. Tier-B words are severe unless the subject (e.g.
// reading, social_studies, science) or a cue word in the text or printed question makes them
// educational ("Romeo committed suicide" in reading), and never in a first-person sentence of the
// child's answer (RV-child-safety-1): a tier-B word in a sentence that has "I", "I'll", "me",
// "my", "we", "us", ... outside a frame is the child's own statement and severe whatever the
// subject or cue ("suicide is the only way out for me", "suicide is the only way out, I'll do
// it" or "I was a victim of rape" in a reading answer; code `<RULE>_FIRST_PERSON`). Frames only
// introduce a topic and their own words are not a first person (CHK-CS-3; lexicon.ts
// FIRST_PERSON_FRAMES, OPINION_FRAMES): reporting ("I learned that", "we read", "my book
// report", "the story tells us"), the class, its book or unit and the country ("In our class",
// "our unit", "in our country"), a favourite part, what a grown-up says ("My mom says"), civics
// ("we should stop", "we should be kind", "I would tell a trusted adult", "if we see"), agreement
// and sadness ("I agree that", "I feel sad that") and opinion ("I think", "I believe", "I know
// that"; but not "I think about" or "I know how to"; round 3: "I wonder if", "I guess" and a bare
// "I know" are the child's own words). Any other first-person word in the sentence still counts
// ("I think suicide is MY only choice"). "I'll" with an apostrophe is always "I will"; a bare
// "ill" is "I will" on positive evidence, a verb right after it ("Ill do it", "ill kms"), whatever
// word comes before it (round 4, CHK3-CS-2: "I hate you ill kill you"); "make you ill", "ill with
// fever" and "spoke ill of" have no verb after it. A Roman numeral of two or more letters is a
// number ("World War II", "Act III", "Pope John Paul II"; CHK2-CS-2); a lone "I" in the child's
// words is always the pronoun (round 4, CHK3-CS-1: "In St. Louis I was abused", "LAST SEASON I
// WAS ABUSED"). The printed prompt is the worksheet's words, not the child's: its first person
// never makes a tier-B word severe (CHK-CS-2: "In our unit we discuss child abuse."), it reads a
// lone "I" as a numeral in three exact idioms ("World War I", "Act I", "Queen Elizabeth I"),
// SELF_HARM_ONLY_WAY_OUT does not read it, and (round 5, CHK4-CS-4/5, lead decision) no rule or
// signature whose category is held from the family (abuse, sexual, secrecy) runs on it: one
// condition in screen.ts scan. A body-safety or reading worksheet quotes exactly the words a
// disclosure uses ("Don't tell anyone, it's our secret", "\"My dad hits me,\" whispered the girl", "I
// was touched by my coach at the award dinner"), and a held code starts the authorities-first
// review. Its self-harm, violence and contact rules still apply, and its held tier-B words are
// still reported as topics. First-person rules ("I want to die", "I was raped") never have an
// exemption at all; "suicide is the only way out" or endorsed ("... is the answer", "... is the way
// to go") is severe in the child's answer unless a third person within seven words holds the view
// ("Teens may think ...", "Romeo thinks ...", "According to Cleopatra, ..."; CHK2-CS-4; a "To ..."
// that opens the sentence is a note's salutation, never a holder: CHK3-CS-5; round 5, CHK4-CS-2:
// the round-4 holders such as "whether", "decides", "wrote" and historical names are gone), and
// sexual abuse called acceptable ("My teacher said sex with kids is ok", "He says sex is our game")
// is severe unless a lesson word or a third person that is not reported about holds it ("If
// someone says touching private parts is a game, tell ...", "the villain thinks rape is ok";
// CHK3-CS-3) and no first person is in the sentence around it. Round 5 (CHK4-CS-1, CHK4-CS-7; lead
// decision): no guard of any rule holds a phrase that names the child ("sex is OUR secret", "touches
// MY private parts", "touches ME at night", "suicide is MY only way out"); only a negation right
// before it cancels it ("He says if anyone asks, sex is our secret", "Nobody knows he touches my
// private parts" are reports). A first-person sexual-violence word inside an abuse disclosure is
// reported as `abuse` only. For model output a tier-B word is exempt only when the printed question itself
// raised the same topic; the subject alone is not enough.
//
// EXCLUSIONS (round 3, CHK2-CS-1; round 4 lead policy: recall first). The first layer leans toward
// escalation for first-person content: a missed disclosure is worse than a false flag, and a
// reviewer clears a false flag (runbook 5.1: the admin resolves the report as a false match and
// the question is graded). An exclusion (`notFollowedBy`) is a whole idiom, activity, place or
// house rule ("end it all with a big finale", "starve myself of video games", "on the monkey
// bars", "after 7"), never a bare word or prefix ("seriously", "with a big", "of", "more"). A
// deliberate or distress word later in the same sentence voids a self-harm, neglect or unsafe-home
// exclusion (`unlessAfter`: "on purpose", "to die", "pills", "starving", "hits me"). An intent word
// never meets an accident tail (SELF_HARM_INTENT has none: "I want to cut my wrists with
// scissors", round 5: "I will try to cut myself on the monkey bars"), a blade or a room is not an
// accident ("with scissors", "in the kitchen"; round 4, CHK3-CS-4), and (round 5, CHK4-CS-6) a
// wrist cut has no accident tail at all ("I cut my wrists on broken glass last night"). A negation
// cancels a `negatable` rule right before the match, or one word earlier across "to" or an adverb
// ("Be careful not to hurt yourself", "I don't really want to die"; NEGATION_BRIDGES); across any
// other word it negates that word, not the disclosure after it ("I'm not ok, dying is the only way
// out", "My mom doesn't believe he hits me"; round 5, CHK4-CS-7: no bridge across "think",
// "believe", "say" or other opinion and speech verbs). The body-safety lesson guard is gone (round
// 5, CHK4-CS-7): every rule that used it names the child. Round 5 (lead decision) adds no
// exclusion, veto, guard, tail or holder: where a restored or new phrase also read everyday or bank
// text, the phrase itself was narrowed (a duration after "can stay alive", the end of the sentence
// after "I cut myself", plural limbs), and the round-5 sweep removed guard words and reach that
// cancelled earlier catches ("should" and "book" from the endorsement guard, the only-way-out
// reach from eight words to seven).
//
// PRECEDENCE. A report's categories may combine; abuse-type codes (abuse, sexual, secrecy) take
// precedence: the child's template leaves out the anger message meant for a child who threatens
// someone, and the system report is held from the family's list until a reviewer releases it
// (FAMILY_HOLD_CATEGORIES; runbook 5.1).
//
// NORMALIZATION (normalize.ts). Case, NFKC with accents stripped, zero-width and bidi characters
// removed, Cyrillic/Greek look-alikes, Latin small capitals ("ᴅɪᴇ"), the dotless i, a capital "I"
// used as "l" inside a mixed-case word ("kiII"), leetspeak where a symbol touches a letter
// ("k1ll", "$uicide"), punctuation and spacing inside words ("k.i.l.l", "k i l l", "su icide"),
// repeated letters ("diiiie"), contractions spelled out ("I'll" → "i will" in every stream, "I'm"
// → "i am", "imma" → "i am going to", "he's" → "he is"; a bare "ill", "he'll", "she'll", "she'd"
// only before a verb; "dad'll", but not "mama'll" or "papa'll", which collapse to the same letters
// as "mammal" and "papal"), Roman numerals in a numeral context written as numbers ("World War II"
// → "world war 2"),
// a "No," interjection read as the end of a clause, "2" for "to" and "u" for "you" in rules. A few
// first-person phrases also match when typed as one run-together word ("iwanttokillmyself").
//
// BOUNDED WORK. At most MAX_SCREEN_CHARS characters and MAX_SCREEN_TOKENS tokens per stream (more
// reports `truncated`), a fixed number of streams, rules indexed by first word, no backtracking
// regular expressions, each rule matched at most once per screen.
//
// KNOWN LIMITS (reviewed; a person handles what this misses through the help/report button and the
// runbook's review procedures, and clears a false match: runbook 5.1, `resolution: 'false_match'`):
//   - English, plus a handful of canonical Spanish phrases ("quiero morir", "ya no quiero vivir",
//     "me quiero matar", "mi papá me pega", "me violaron", "tengo miedo de mi papá", "te voy a
//     matar"); every other language, emoji-only messages and images are not screened, and the
//     child's template is English only (threat-model item). Spanish caregiver hyperbole ("mi papá
//     me va a matar") is treated like the English one (not severe).
//   - Paraphrases outside the phrase lists are missed ("I don't see the point anymore"); moderate
//     distress ("nobody loves me", "I hate myself") is deliberately not escalated.
//   - Fiction and quoted speech are not distinguished ("'I will kill you,' said the monster",
//     '"I want to die," said the old man'): both are severe.
//   - Common hyperbole is excluded and a real statement in the same words is missed: "I would
//     rather die than ...", "my mom is going to kill me" (a caregiver threat counts only when it is
//     reported, "he said he would kill me", attempted or threatened, or conditioned on telling).
//   - Sibling and playground fights in the present tense ("my brother hits me", "my sister hits me
//     in the arm when we play", "my brother hits me when we wrestle") are escalated; past-tense
//     peer incidents are not, unless an injury or an object is named (round 5: "He hit me so hard I
//     bled", "She hit me with a stick", "I have bruises from my brother at soccer"). Bullying ("I'm being bullied") is not a severe category. Games and
//     play are recognised by listed phrases only ("beats me at chess", "pushes me on the swing");
//     other play wording escalates.
//   - An educational answer with a tier-B word and a first-person word outside the listed frames
//     is severe ("In my story the villain commits suicide", "Our family read about child abuse",
//     "I don't think suicide is right"). Inside a frame the tier-B word is judged by subject and
//     cues like a third-person sentence, so a frame followed by an ambiguous clause stays
//     educational in an educational context ("I would tell my mom about the rape" in social
//     studies, "In my class there is sexual abuse"); "... is the only way out / is the answer / is
//     the way to go" has its own rule (SELF_HARM_ONLY_WAY_OUT) and is severe unless a third person
//     within seven words holds the view ("Romeo thinks ...", "Kids who are bullied may feel ...",
//     "According to Cleopatra, ..."). That rule reads the answer only, and any "... suicide is the answer"
//     in the child's own words escalates ("maybe suicide is the answer" in reading or math).
//   - A bare "ill" before a verb is always "I'll" (round 4, CHK3-CS-2), so an adjective "ill"
//     before a verb reads as the child's first person and escalates with a tier-B word ("People
//     who are ill do not always overdose", "The ill take medicine and some overdose by mistake",
//     "Sick and ill do not overdose"); a reviewer clears it. "II" or "III" typed for "I" right
//     after a capitalized word ("Sam II want ...") is read as a numeral. A lone "I" is the
//     pronoun in the child's words (round 4, CHK3-CS-1), so "World War I", "Act I", "Chapter I" or
//     "Elizabeth I" with a tier-B word or an abuse phrase escalates ("Many soldiers in World War I
//     committed suicide", "In World War I, many soldiers were victims of abuse" as an answer is a
//     held abuse flag); a reviewer clears it. A printed prompt reads a lone "I" as a numeral only
//     after "World War", a Titlecase section word ("Act I", not "PART I") or a monarch's or pope's
//     title and a name ("Queen Elizabeth I", not "St. Louis I").
//   - A printed prompt never yields a held code (round 5, CHK4-CS-4/5; screen.ts scan): a
//     disclosure the extraction model misplaces into the prompt field ("Why do plants need
//     sunlight? My dad hits me", "PART I WAS RAPED") is not read for abuse, sexual or secrecy
//     codes, and a sexual-violence or sexual-health word in a prompt is a topic only. The
//     prompt's self-harm, violence and contact rules still apply ("... i want to die" merged into a
//     prompt is severe), so a worksheet can still carry a contact code ("A grown-up tells you to keep
//     a secret about touching. What should you do?" is `personal_contact`, which is not held). A
//     prompt's first person never makes its tier-B word severe, so a child's note merged into the
//     prompt ("... suicide is my plan") is judged by subject and cues.
//   - A threat or death wish against someone named ("I want to kill Sam") is read from the word
//     after the verb: a pronoun, determiner, number, day, school subject or a listed object, game
//     or story villain ("kill it", "kill time", "kill some zombies", "shoot pool", "kill Bowser",
//     "kill Monday", "kill Spanish class", "I hope Voldemort dies") is not a person, nor is a name
//     followed by a listed possession ("shoot Grandpa's camera"); any other word is, so an unlisted
//     game character or toy ("I'm going to kill Kirby", "I will stab Mr. Potato Head") escalates,
//     and so do words that are also first names ("I want to kill Mario", "I will shoot art
//     class"). A group owned by a name is a target ("shoot Sam's class", "kill Riley's team").
//     Game context after the name ("in Fortnite", "in Mario") is excluded.
//   - Asking to be killed is escalated even as a joke ("please kill me now, this homework is so
//     long"): a person reviews.
//   - A first-person plan to bring a weapon to school, or a weapon in a school bag, is escalated
//     whatever the reason ("a knife for the science fair", "a knife in my lunchbox for my apple");
//     a direct future threat is covered for a named person ("he's going to hurt me") but not for
//     "they", and a silencing threat that names the same person ("my mom will kill me if I tell
//     her") is read as hyperbole.
//   - "1" is read as "i", as "l", and per word by the rules' vocabulary ("k1ll myse1f"); a word
//     the rules do not know keeps the "i" reading. Letters masked by symbols that are not
//     leetspeak ("k*ll") and splits that break a word into two real words are not recovered; a word split inside a double letter ("kil lmyself") is
//     missed by the compact signatures. Chunks that are mostly digits are kept as numbers so math
//     answers are not rewritten, so heavy digit substitution ("1 w4nt 70 d13") is missed.
//   - A phrase run together into one word ("iwanttodie") is caught only when it is exactly one of
//     the signature phrases; other run-together text is not split into words.
//   - "kms" counts only after a first person or an intent word ("I should kms") or as the whole
//     text outside math and science; a bare "kms" in a math answer is read as kilometres.
//   - A secrecy request in model output is severe even when well meant ("never tell anyone your
//     password"): the reviewed template is shown instead, which is the intended trade-off.
//   - A printed question that itself uses a self-harm tier-B word outside a listed subject or cue
//     ("Why do people commit suicide?" or "What is an overdose?" filed under `other` or with no
//     subject) is flagged even if the answer is benign; so is a third-person answer with a tier-B word and no
//     subject ("She committed suicide with a snake").
//   - A reason for fear of going home that is ordinary ("I was scared to go home because I got a
//     bad grade") is still escalated: fear of a caregiver's reaction is left to a person.
//   - Neglect wording about permission to eat counts only as a whole statement ("My mom doesn't let
//     me eat", "... for days"): with a place or time after it ("They don't let me eat in class") it
//     is read as a rule. "They don't feed me" / "don't give me food" is severe unless a listed
//     house rule follows (a treat, a clock time, a disliked food, "until I finish my homework",
//     "lunch because I eat at school"), and even then when hunger follows ("... after 7 and I am
//     starving"); other wording after it escalates. "I don't feel okay at home" is not covered (a
//     sick child says it too); "I don't feel safe at home" is, except with a listed fear (storms,
//     thunder, the dark, spiders, scary movies, a barking dog, being alone during a storm or
//     without a pet) and no harm word after it.
//   - Idioms, games and accidents are excluded by whole listed phrases only ("take my life
//     savings", "end it all with a big finale", "I ate poison berries in Minecraft", "I keep
//     hurting myself when I skateboard", "I cut my wrist band off", "I don't want to live in
//     Florida"); other wording after the same words escalates, and a deliberate or distress word
//     later in the sentence voids the exclusion ("... in Minecraft to die", "I don't want to live
//     in this city anymore" escalates).
//   - Reviewer-cleared false matches (CHK2-CS-5): everyday text whose words are also a disclosure
//     stays severe by design, and a reviewer clears it as a false match (runbook 5.1): "They don't
//     give me food I don't like", "My parents don't feed me at school", "My dad doesn't make me
//     food because I make my own sandwich", "My parents don't make me food on Saturdays, I make
//     cereal", "My brother is abusive when he plays video games online", "My brother told me not
//     to tell mom he broke the vase", sibling play-fighting and threats about a diary or a broken
//     window (corpus.ts REVIEWER_CLEARED_PASS5).
//   - Reviewer-cleared by the round-4 recall policy (corpus.ts REVIEWER_CLEARED_PASS6): the lone
//     "I" and "ill" readings above; accidents with a blade or in a room ("I cut myself again with
//     the scissors in art", "I keep hurting myself in the kitchen", "I cut my wrists running") and
//     "I'm going to stop hurting myself"; "I want to die of shame" ("of shame" is no longer a
//     hyperbole tail); "I was touched by my teacher when she gave me a hug" (ABUSE_TOUCHED_BY, a
//     held abuse flag); a holder or non-person after the only-way-out phrase ("Suicide is the
//     answer for some people, but ...", "For the salmon, dying is the only way to spawn"); a
//     body-safety answer with a first person after the phrase ("... tell a trusted adult like my
//     mom", a held sexual flag). A body-safety lesson that names no lesson word or third person
//     ("Someone said touching private parts is a game. That is wrong.", "We learned it is not ok
//     when someone says rape is ok") also escalates, as does a game after "destroy myself" ("I will
//     destroy myself in Minecraft").
//   - Reviewer-cleared by the round-5 recall decision (corpus.ts REVIEWER_CLEARED_PASS7; lead
//     decision: a precision device that cancelled a report is gone, and a canonical disclosure has a
//     plain rule): a body-safety lesson whose phrase names the child ("No one is allowed to touch my
//     private parts", "Never let anyone touch my private parts"; a held abuse flag); a lesson that
//     quotes a phrase naming the child ("If someone tells you touching private parts is our secret,
//     you should tell", "Never say sex is our secret", "Circle the unsafe secret: 'Touching private
//     parts is our secret.'"; a held sexual flag) or has "should" or "book" before an endorsement
//     phrase ("No one should ever say rape is ok", "The book says sex is a secret topic for some
//     families"); a third-person lesson that only a round-4 holder held ("Brutus decides suicide is
//     the right choice", "The question is whether suicide is the answer", "To Cleopatra, suicide is
//     the only way out"); a negated opinion ("I don't think dying is the only way out", "I don't
//     think suicide is the answer"); a wrist cut in an accident ("I cut my wrist on a piece of
//     paper", "... opening a can", "... on the fence"); and everyday words the plain round-5 rules
//     read as a disclosure: homework frustration ("I can't do this anymore, fractions are too
//     hard"), "When I was cooking I cut myself.", "I cut my legs shaving", "I took all my pills this
//     morning", "I want it to be over so I can play outside", "I don't want to wake up tomorrow
//     because it is a school day", "I don't want to be here anymore, this party is boring", "My team
//     would be better without me", "The character felt there was no reason to live", and held abuse
//     flags for "My mom pulls my hair when she braids it", "My mom locked me out of the house by
//     accident", "In tag he touched me.", "My mom makes me do things I don't like, like cleaning my
//     room", "I have bruises from my brother at soccer" and "My dad gave me a black eye by accident
//     with the ball".
//   - An adjective "ill" before a verb reads as "I'll" (above), so the first-person overdose rules
//     read everyday health answers without any tier-B word ("People who are ill take all their pills
//     on time", "When you are ill take all the medicine the doctor gives you" in science;
//     CHK4-CS-9); the code is self_harm, not held, and a reviewer clears it.
//   - The endorsement rules' lesson guard (ENDORSED_LESSON_GUARD) still holds a phrase that does
//     not name the child when a lesson word or a third person ("if", "rule", "people", "story", "a
//     bully", a negated "say") is within six words before it and no first person is in the
//     sentence, so a report worded that way is read as a lesson and missed ("He says if you tell,
//     touching private parts is a game"); the same words that name the child ("... is our game")
//     are severe.
//   - Not read by any rule (first-person wording a new rule would need, with game and hyperbole
//     uses to separate): "ill off myself" and "I'm going to off myself" ("off" is "of" once repeats
//     collapse, as in "think of myself"), "I'll bleed out tonight", "I'll sleep forever and never
//     wake up", "I'll disappear forever" ("will" is not an intent word before "disappear forever" or
//     "sleep"), "I don't see the point anymore", "I don't feel like I want to live anymore".
//   - Model-output rules exclude story questions only by listed phrases ("Is everything okay at
//     home for the character?", "Are you sad that the story ended?"); other wording is severe.
//   - Only the first MAX_SCREEN_CHARS characters are screened; callers pass bounded fields.
//   - `ageBand` selects template wording only; no rule is relaxed for older children.
export {
  SAFETY_AGE_BANDS,
  SAFETY_LEVELS,
  SENSITIVE_TOPICS,
  SEVERE_SAFETY_CATEGORIES,
  type SafetyAgeBand,
  type SafetyLevel,
  type SafetyRuleDoc,
  type SafetyScreen,
  type ScreenContext,
  type ScreenOptions,
  type ScreenSource,
  type SensitiveTopic,
  type SevereSafetyCategory,
} from './types.ts';
export { MAX_SCREEN_CHARS, MAX_SCREEN_TOKENS, normalizeForScreen } from './normalize.ts';
export {
  SAFETY_RULES,
  SAFETY_SCREEN_VERSION,
  mergeScreens,
  screenModelOutput,
  screenQuestion,
  screenText,
} from './screen.ts';
export {
  CHILD_SAFETY_MESSAGE_MAX_LENGTH,
  FAMILY_HOLD_CATEGORIES,
  SAFETY_RESOURCES_US,
  SAFETY_TEMPLATES_APPROVED,
  SAFETY_TEMPLATES_STATUS,
  SAFETY_TEMPLATES_VERSION,
  childSafetyMessage,
  heldFromFamily,
} from './templates.ts';
