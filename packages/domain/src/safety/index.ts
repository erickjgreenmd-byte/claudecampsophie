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
//                     purpose", "I should kms"), "kill yourself"/"kys"; the words suicide /
//                     self-harm / overdose on their own (tier B); in model output also diet, meal
//                     skipping and body-shaming advice.
//   abuse             disclosure of physical or sexual abuse or neglect ("my dad hits me", "he
//                     touches my private parts", "I was raped", "nobody feeds me", "I am scared
//                     to go home"), violence against a family member ("my dad hits my mom"),
//                     threats from a caregiver ("my dad said he would kill me"), threats that
//                     keep a child silent ("if I tell he will hurt me", "he will hurt me if I
//                     tell").
//   violence          first-person threat to kill or hurt a person or a school; model output that
//                     encourages violence.
//   sexual            explicit terms, first-person sexual activity, sexual images; tier-B words
//                     (rape, molest, intercourse, ...) outside an educational context.
//   secrecy           a child reporting being told not to tell; model output asking for secrecy.
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
// educational ("Romeo committed suicide" in reading). First-person statements are never exempt:
// "I want to die" is severe in a science answer and "I was raped" in a reading answer, because
// they match a first-person rule that has no exemption (the tier-B rule is only the fallback for
// the bare word). For model output a tier-B word is exempt only when the printed question itself
// raised the same topic; the subject alone is not enough.
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
// repeated letters ("diiiie"), contractions spelled out ("I'll" → "i will", "I'm" → "i am",
// "imma" → "i am going to", "he's" → "he is"), "2" for "to" and "u" for "you" in rules. A few
// first-person phrases also match when typed as one run-together word ("iwanttokillmyself").
//
// BOUNDED WORK. At most MAX_SCREEN_CHARS characters and MAX_SCREEN_TOKENS tokens per stream (more
// reports `truncated`), a fixed number of streams, rules indexed by first word, no backtracking
// regular expressions, each rule matched at most once per screen.
//
// KNOWN LIMITS (reviewed; a person handles what this misses through the help/report button and the
// runbook's review procedures):
//   - English, plus a handful of canonical Spanish phrases ("quiero morir", "me quiero matar",
//     "mi papá me pega"); every other language, emoji-only messages and images are not screened,
//     and the child's template is English only (threat-model item).
//   - Paraphrases outside the phrase lists are missed ("I don't see the point anymore"); moderate
//     distress ("nobody loves me", "I hate myself") is deliberately not escalated.
//   - Fiction and quoted speech are not distinguished ("'I will kill you,' said the monster",
//     '"I want to die," said the old man'): both are severe.
//   - Common hyperbole is excluded and a real statement in the same words is missed: "I would
//     rather die than ...", "my mom is going to kill me" (a caregiver threat counts only when it is
//     reported, "he said he would kill me", attempted or threatened, or conditioned on telling).
//   - Sibling and playground fights in the present tense ("my brother hits me") are escalated;
//     past-tense peer incidents are not. Bullying ("I'm being bullied") is not a severe category.
//   - A first-person plan to bring a weapon to school is escalated whatever the reason ("a knife
//     for the science fair"); a direct future threat is covered for a named person ("he's going to
//     hurt me") but not for "they", and a silencing threat that names the same person ("my mom will
//     kill me if I tell her") is read as hyperbole.
//   - Letters masked by symbols that are not leetspeak ("k*ll") and splits that break a word into
//     two real words are not recovered; a word split inside a double letter ("kil lmyself") is
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
