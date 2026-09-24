// Child-safety screen (spec P4; AC_SECURITY_02): deterministic, dependency-free moderation of K-8
// child text and child-facing model output, plus the safety templates shown instead of coaching.
//
// WHAT IT IS. A first layer, not a classifier: fixed word and phrase rules (lexicon.ts, each with
// its rationale) over normalized text. It errs toward sending a first-person risk statement to a
// person; it never decides anything about a child on its own. The provider moderation endpoint
// (OpenAI moderation) is the intended second layer and is NOT wired: no API key is available in
// this build, so this screen is the only automated check today.
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
// WAS ABUSED"). The printed prompt is screened by every rule except SELF_HARM_ONLY_WAY_OUT and the
// endorsement rules (SEXUAL_ABUSE_ENDORSED, SEXUAL_GROOMING_GAME), its first person is a
// worksheet's words, not the child's, so it never makes a tier-B word severe (CHK-CS-2: "In our
// unit we discuss child abuse."), and it reads a lone "I" as a numeral in three exact idioms
// ("World War I", "Act I", "Queen Elizabeth I"). First-person rules ("I want to die", "I was
// raped") never have an exemption at all; "suicide is the only way out" or endorsed ("... is the
// answer", "... is the way to go") is severe in the child's answer unless a third person holds the
// view ("Teens may think ...", "Brutus decides ...", "According to Cleopatra, ..."; CHK2-CS-4,
// CHK3-CS-6; a "To ..." that opens the sentence is a note's salutation, never a holder: CHK3-CS-5),
// and sexual abuse called acceptable ("My teacher said sex with kids is ok", "He says sex is our
// game") is severe unless a body-safety lesson or a third person that is not reported about holds
// it ("If someone says touching private parts is a secret, tell ...", "the villain thinks ...",
// "Don't say rape is ok"; CHK3-CS-3) and no first person is in the sentence around it; a
// negation across another word is a report ("He said it is not bad, ..."), and a phrase that
// names the child ("sex is our secret") is held only by a conditional, a negated "say" or a
// quoted third person. A first-person sexual-violence word inside an abuse disclosure is reported
// as `abuse` only. For model output a tier-B word is exempt only when the printed question itself
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
// scissors"), a slit or slashed wrist has no accident tail at all, and a blade or a room is not an
// accident ("with scissors", "in the kitchen"; round 4, CHK3-CS-4). A negation cancels a
// `negatable` rule right before the match, or one word earlier across "to", an adverb or an opinion
// or speech verb ("Be careful not to hurt yourself", "I don't really want to die", "Don't say rape
// is ok"; NEGATION_BRIDGES); across any other word it negates that word, not the disclosure after
// it ("I'm not ok, dying is the only way out", "I'm not fine I will hurt myself"; round 4). The
// body-safety lesson guard stops at a nearer first person like the other holder guards ("I'm not
// ok, he touches my private parts" is a report; "It is not ok if someone touches your private
// parts" is a lesson).
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
//     peer incidents are not. Bullying ("I'm being bullied") is not a severe category. Games and
//     play are recognised by listed phrases only ("beats me at chess", "pushes me on the swing");
//     other play wording escalates.
//   - An educational answer with a tier-B word and a first-person word outside the listed frames
//     is severe ("In my story the villain commits suicide", "Our family read about child abuse",
//     "I don't think suicide is right"). Inside a frame the tier-B word is judged by subject and
//     cues like a third-person sentence, so a frame followed by an ambiguous clause stays
//     educational in an educational context ("I would tell my mom about the rape" in social
//     studies, "In my class there is sexual abuse"); "... is the only way out / is the answer / is
//     the way to go" has its own rule (SELF_HARM_ONLY_WAY_OUT) and is severe unless a third person
//     within eight words holds the view ("Romeo thinks ...", "Kids who are bullied may feel ...",
//     "To Cleopatra, ..."). That rule reads the answer only, and any "... suicide is the answer"
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
//     title and a name ("Queen Elizabeth I", not "St. Louis I"), so its worksheet text is not a
//     held first-person flag.
//   - A printed prompt's first person never makes its tier-B word severe, so a child's note that
//     the extraction merged into the prompt ("... suicide is my plan") is judged by subject and
//     cues; the prompt's first-person rules ("I want to die") still apply.
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
//   - A printed question that itself uses a tier-B word outside a listed subject or cue ("Why do
//     people commit suicide?" or "What is an overdose?" filed under `other` or with no subject) is
//     flagged even if the answer is benign; so is a third-person answer with a tier-B word and no
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
//     destroy myself in Minecraft"). A child's report is read even with a negation or a lesson word
//     before the phrase when the phrase or the words after it name the child ("He said it is
//     not bad, sex is our secret", "He said it is a rule, sex is our secret"); only a conditional,
//     a negated "say" or "believe", "not true", "unsafe", "some people" or a story's character
//     still holds such a phrase ("If someone tells you touching private parts is our secret, tell").
//     A report that names no first person and has a lesson word before the phrase is still read as
//     a lesson and missed ("He says you should never tell because touching private parts is a
//     game").
//   - Not read by any rule (round 4; first-person wording a new rule would need, with game and
//     hyperbole uses to separate): "ill off myself" and "I'm going to off myself" ("off" is "of"
//     once repeats collapse, as in "think of myself"), "I'll bleed out tonight", "I'll sleep forever
//     and never wake up", "I'll disappear forever", "I'll end it tonight" (without "all" or "my
//     life") and "Every season I cut myself" (the habit marker before the verb). A report with a
//     lesson word ("not", "ok", "safe") in the four words before it and no first person nearer is
//     read as a body-safety lesson ("not happy he touches me at night").
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
