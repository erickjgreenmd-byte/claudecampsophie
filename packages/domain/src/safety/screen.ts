// The safety screen's matcher (see index.ts for the rules, their limits and how callers use it).
import {
  FIRST_PERSON,
  FIRST_PERSON_FRAMES,
  HOLDER_TO_NOT_A_NAME,
  HYPOTHETICALS,
  NEGATION_BRIDGES,
  NEGATORS,
  OPINION_FRAME_NOT_BEFORE,
  OPINION_FRAMES,
  RULES,
  SIGNATURES,
  SUBJECT_TOPICS,
  VOID_WINDOW,
  type RuleDef,
  type SignatureDef,
} from './lexicon.ts';
import {
  BOUNDARY,
  collapseRepeats,
  ILL_VERBS,
  illReadsAsIWill,
  normalizeForScreen,
  normalizeRulePhrase,
  type CompactStream,
  type NormalizedText,
} from './normalize.ts';
import {
  SENSITIVE_TOPICS,
  SEVERE_SAFETY_CATEGORIES,
  type SafetyAgeBand,
  type SafetyRuleDoc,
  type SafetyScreen,
  type ScreenContext,
  type ScreenOptions,
  type ScreenSource,
  type SensitiveTopic,
  type SevereSafetyCategory,
} from './types.ts';

/** Bumped whenever a rule, a signature or the normalization changes. */
export const SAFETY_SCREEN_VERSION = 'safety-screen.v3';

// ---------------------------------------------------------------------------------------------
// Compilation (once, at module load)
// ---------------------------------------------------------------------------------------------

type Phrase = readonly string[];

interface Slot {
  readonly byFirst: ReadonlyMap<string, readonly Phrase[]>;
  readonly gap: number;
  readonly optional: boolean;
  /**
   * A `*` slot: any one word except these (a name: "I will kill Riley"). Null for a phrase slot.
   * A sentence boundary and a number never match a `*`.
   */
  readonly anyExcept: ReadonlySet<string> | null;
}

interface Exemption {
  readonly subjects: ReadonlySet<string>;
  readonly cues: ReadonlySet<string>;
}

interface CompiledGuard {
  readonly words: Slot;
  readonly within: number;
  readonly stopAtFirstPerson: boolean;
  readonly holderTo: boolean;
  readonly firstPersonAfter: boolean;
  readonly quoteWords: Slot | null;
}

interface CompiledRule {
  readonly def: RuleDef;
  readonly sources: ReadonlySet<ScreenSource>;
  readonly slots: readonly Slot[];
  readonly notFollowedBy: Slot | null;
  readonly notFollowedWithin: number;
  /** Words later in the sentence that void the notFollowedBy exclusion (round 3, CHK2-CS-1). */
  readonly unlessAfter: Slot | null;
  readonly notPrecededBy: ReadonlySet<string> | null;
  readonly guard: CompiledGuard | null;
  readonly gapStop: ReadonlySet<string> | null;
  readonly exempt: Exemption | null;
}

interface SignaturePhrase {
  readonly text: string;
  /**
   * Offsets inside `text` where the phrase's own words start (its natural spelling), or null for
   * the fully collapsed variant. A natural spelling is left to the token rules and their
   * exclusions ("I don't want to live in a city"); only unusual splits count here.
   */
  readonly boundaries: ReadonlySet<number> | null;
}

interface CompiledSignature {
  readonly def: SignatureDef;
  readonly sources: ReadonlySet<ScreenSource>;
  readonly phrases: readonly SignaturePhrase[];
  readonly exempt: Exemption | null;
}

const PLACEHOLDERS: Readonly<Record<string, readonly string[]>> = {
  you: ['you', 'u', 'ya'],
};

/** Expands `{you}` placeholders inside one alternative into every variant. */
function expandAlternative(alt: string): string[] {
  const m = /\{(\w+)\}/.exec(alt);
  if (m === null) return [alt];
  const values = PLACEHOLDERS[m[1]!];
  if (values === undefined) throw new Error(`safety lexicon: unknown placeholder ${m[0]}`);
  return values.flatMap((v) => expandAlternative(alt.replace(m[0], v)));
}

function compileSlot(
  text: string,
  gap: number,
  optional: boolean,
  anyExcept: ReadonlySet<string> | null = null,
): Slot {
  if (text === '*') {
    if (anyExcept === null) throw new Error(`safety lexicon: a * slot needs notObject`);
    return { byFirst: new Map(), gap, optional, anyExcept };
  }
  const byFirst = new Map<string, Phrase[]>();
  for (const raw of text.split('|')) {
    for (const alt of expandAlternative(raw.trim())) {
      const tokens = normalizeRulePhrase(alt);
      if (tokens.length === 0) throw new Error(`safety lexicon: empty alternative in "${text}"`);
      const list = byFirst.get(tokens[0]!) ?? [];
      list.push(tokens);
      byFirst.set(tokens[0]!, list);
    }
  }
  return { byFirst, gap, optional, anyExcept: null };
}

function compileTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const alt of text.split('|')) for (const t of normalizeRulePhrase(alt)) out.add(t);
  return out;
}

function compileExemption(exempt: RuleDef['exempt']): Exemption | null {
  return exempt === undefined
    ? null
    : { subjects: new Set(exempt.subjects), cues: compileTokens(exempt.cues) };
}

function compileRule(def: RuleDef): CompiledRule {
  const parts = def.pattern.split(/\s\+(\d?)\s/);
  const slots: Slot[] = [];
  const notObject = def.notObject === undefined ? null : compileTokens(def.notObject);
  for (let i = 0; i < parts.length; i += 2) {
    let text = parts[i]!.trim();
    const gapText = i === 0 ? '0' : (parts[i - 1] ?? '');
    const gap = i === 0 ? 0 : gapText === '' ? (def.gap ?? 1) : Number(gapText);
    const optional = text.startsWith('?');
    if (optional) text = text.slice(1);
    slots.push(compileSlot(text, gap, optional, notObject));
  }
  if (slots.length === 0 || slots[0]!.optional || slots[0]!.anyExcept !== null) {
    throw new Error(`safety lexicon: ${def.id} must start with a required phrase slot`);
  }
  if ((def.kind === 'severe') !== (def.category !== undefined)) {
    throw new Error(`safety lexicon: ${def.id} category does not match its kind`);
  }
  if ((def.exempt !== undefined || def.kind === 'topic') && def.topic === undefined) {
    throw new Error(`safety lexicon: ${def.id} needs a topic`);
  }
  if (
    (def.unlessAfter !== undefined || def.notFollowedWithin !== undefined) &&
    def.notFollowedBy === undefined
  ) {
    throw new Error(`safety lexicon: ${def.id} voids or widens an exclusion it does not have`);
  }
  return {
    def,
    sources: new Set(def.sources),
    slots,
    notFollowedBy: def.notFollowedBy ? compileSlot(def.notFollowedBy, 0, false) : null,
    notFollowedWithin: def.notFollowedWithin ?? 0,
    unlessAfter: def.unlessAfter ? compileSlot(def.unlessAfter, 0, false) : null,
    notPrecededBy: def.notPrecededBy ? compileTokens(def.notPrecededBy) : null,
    guard: def.guard
      ? {
          words: compileSlot(def.guard.words, 0, false),
          within: def.guard.within,
          stopAtFirstPerson: def.guard.stopAtFirstPerson ?? false,
          holderTo: def.guard.holderTo ?? false,
          firstPersonAfter: def.guard.firstPersonAfter ?? false,
          quoteWords: def.guard.quoteWords ? compileSlot(def.guard.quoteWords, 0, false) : null,
        }
      : null,
    gapStop: def.gapStop ? compileTokens(def.gapStop) : null,
    exempt: compileExemption(def.exempt),
  };
}

function compileSignature(def: SignatureDef): CompiledSignature {
  const phrases = new Map<string, SignaturePhrase>();
  for (const alt of def.phrases.split('|')) {
    const tokens = normalizeRulePhrase(alt);
    const joined = tokens.join('');
    if (joined.length < 3) throw new Error(`safety lexicon: ${def.id} phrase too short`);
    const boundaries = new Set<number>();
    let offset = 0;
    for (const t of tokens.slice(0, -1)) {
      offset += t.length;
      boundaries.add(offset);
    }
    phrases.set(joined, { text: joined, boundaries });
    const collapsed = collapseRepeats(joined);
    if (!phrases.has(collapsed)) phrases.set(collapsed, { text: collapsed, boundaries: null });
  }
  return {
    def,
    sources: new Set(def.sources),
    phrases: [...phrases.values()],
    exempt: compileExemption(def.exempt),
  };
}

const COMPILED_RULES: readonly CompiledRule[] = RULES.map(compileRule);
const COMPILED_SIGNATURES: readonly CompiledSignature[] = SIGNATURES.map(compileSignature);
const NEGATOR_SET = compileTokens(NEGATORS);
const NEGATION_BRIDGE_SET = compileTokens(NEGATION_BRIDGES);
const HYPOTHETICAL_SET = compileTokens(HYPOTHETICALS);
const FIRST_PERSON_SET = compileTokens(FIRST_PERSON);
const FIRST_PERSON_FRAME_SLOT = compileSlot(FIRST_PERSON_FRAMES, 0, false);
const OPINION_FRAME_SLOT = compileSlot(OPINION_FRAMES, 0, false);
const OPINION_NOT_BEFORE = compileTokens(OPINION_FRAME_NOT_BEFORE);
const HOLDER_TO_NOT_A_NAME_SET = compileTokens(HOLDER_TO_NOT_A_NAME);

/**
 * Every word the rules know. The normalizer uses it to read a "1" as "i" or "l" per word when a
 * text mixes both ("k1ll myse1f").
 */
const VOCABULARY: ReadonlySet<string> = (() => {
  const words = new Set<string>();
  const addSlot = (slot: Slot | null | undefined) => {
    if (!slot) return;
    for (const list of slot.byFirst.values())
      for (const phrase of list) phrase.forEach((w) => words.add(w));
    slot.anyExcept?.forEach((w) => words.add(w));
  };
  const addSet = (set: ReadonlySet<string> | null | undefined) => set?.forEach((w) => words.add(w));
  for (const rule of COMPILED_RULES) {
    rule.slots.forEach(addSlot);
    addSlot(rule.notFollowedBy);
    addSlot(rule.unlessAfter);
    addSlot(rule.guard?.words);
    addSlot(rule.guard?.quoteWords);
    addSet(rule.notPrecededBy);
    addSet(rule.gapStop);
    addSet(rule.exempt?.cues);
  }
  for (const sig of SIGNATURES) {
    for (const alt of sig.phrases.split('|')) normalizeRulePhrase(alt).forEach((w) => words.add(w));
  }
  for (const set of [
    NEGATOR_SET,
    NEGATION_BRIDGE_SET,
    HYPOTHETICAL_SET,
    FIRST_PERSON_SET,
    OPINION_NOT_BEFORE,
    HOLDER_TO_NOT_A_NAME_SET,
    ILL_VERBS,
  ])
    addSet(set);
  addSlot(FIRST_PERSON_FRAME_SLOT);
  addSlot(OPINION_FRAME_SLOT);
  return words;
})();

/** Rules indexed by every first token of their first slot. */
const INDEX: ReadonlyMap<string, readonly CompiledRule[]> = (() => {
  const index = new Map<string, CompiledRule[]>();
  for (const rule of COMPILED_RULES) {
    for (const first of rule.slots[0]!.byFirst.keys()) {
      const list = index.get(first) ?? [];
      if (!list.includes(rule)) list.push(rule);
      index.set(first, list);
    }
  }
  return index;
})();

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

const NUMBER = /^[0-9]+$/;

/** End index (exclusive) of the longest alternative of `slot` at `p`, or -1. */
function matchSlot(tokens: readonly string[], p: number, slot: Slot): number {
  const t = tokens[p];
  if (t === undefined) return -1;
  if (slot.anyExcept !== null) {
    return t === BOUNDARY || NUMBER.test(t) || slot.anyExcept.has(t) ? -1 : p + 1;
  }
  const list = slot.byFirst.get(t);
  if (list === undefined) return -1;
  let best = -1;
  for (const phrase of list) {
    let ok = true;
    for (let k = 1; k < phrase.length; k += 1) {
      if (tokens[p + k] !== phrase[k]) {
        ok = false;
        break;
      }
    }
    if (ok && p + phrase.length > best) best = p + phrase.length;
  }
  return best;
}

function anyBefore(
  tokens: readonly string[],
  start: number,
  count: number,
  set: ReadonlySet<string>,
): boolean {
  for (let k = 1; k <= count && start - k >= 0; k += 1) {
    const t = tokens[start - k]!;
    if (t === BOUNDARY) return false;
    if (set.has(t)) return true;
  }
  return false;
}

/**
 * A guard word or phrase starting within `within` tokens before `start` (same sentence). With
 * `stopAtFirstPerson`, a first-person word nearer than the guard, or right before it ("I think",
 * "I really believe"), means the child holds the view: not guarded. With `holderTo`, "to" and a
 * name inside a sentence hold the view ("According to Cleopatra, suicide is ..."; not "to me", "to
 * be honest", "... to Mom"). Round 4 (CHK3-CS-5): a "to" that starts the sentence opens a note
 * ("To Riley, suicide is the only answer", "To whoever reads this ..."), so it never holds a view.
 */
function guardedBefore(tokens: readonly string[], start: number, guard: CompiledGuard): boolean {
  const firstPersonAt = (p: number) => p >= 0 && FIRST_PERSON_SET.has(tokens[p]!);
  for (let k = 1; k <= guard.within && start - k >= 0; k += 1) {
    const p = start - k;
    const t = tokens[p]!;
    if (t === BOUNDARY) return false;
    if (guard.stopAtFirstPerson && FIRST_PERSON_SET.has(t)) return false;
    if (matchSlot(tokens, p, guard.words) >= 0) {
      return !(guard.stopAtFirstPerson && (firstPersonAt(p - 1) || firstPersonAt(p - 2)));
    }
    const salutation = p === 0 || tokens[p - 1] === BOUNDARY;
    if (guard.holderTo && t === 'to' && !salutation && p + 1 < start) {
      const name = tokens[p + 1]!;
      if (
        name !== BOUNDARY &&
        !NUMBER.test(name) &&
        !FIRST_PERSON_SET.has(name) &&
        !HOLDER_TO_NOT_A_NAME_SET.has(name)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A negation right before `start`, or one word earlier across a NEGATION_BRIDGES word, in the same
 * sentence ("don't want to die", "I don't think suicide is ..."; not "I'm not ok, dying is ...").
 */
function negatedBefore(tokens: readonly string[], start: number): boolean {
  const prev = tokens[start - 1];
  if (prev === undefined || prev === BOUNDARY) return false;
  if (NEGATOR_SET.has(prev)) return true;
  const prev2 = tokens[start - 2];
  return prev2 !== undefined && NEGATOR_SET.has(prev2) && NEGATION_BRIDGE_SET.has(prev);
}

/**
 * A first-person word (outside a frame) within VOID_WINDOW tokens after `pos`, in the same
 * sentence (a guard's `firstPersonAfter`; round 4, CHK3-CS-3).
 */
function firstPersonAfter(tokens: readonly string[], pos: number): boolean {
  let i = pos;
  while (i < tokens.length && i <= pos + VOID_WINDOW) {
    const t = tokens[i]!;
    if (t === BOUNDARY) return false;
    const frameEnd = matchSlot(tokens, i, FIRST_PERSON_FRAME_SLOT);
    if (frameEnd > i) {
      i = frameEnd;
      continue;
    }
    const opinionEnd = matchSlot(tokens, i, OPINION_FRAME_SLOT);
    if (opinionEnd > i && !OPINION_NOT_BEFORE.has(tokens[opinionEnd] ?? '')) {
      i = opinionEnd;
      continue;
    }
    if (FIRST_PERSON_SET.has(t) || illReadsAsIWill(tokens, i)) return true;
    i += 1;
  }
  return false;
}

/**
 * Whether the child's own first person voids a `firstPersonAfter` guard that matched before
 * tokens[start, pos): a first-person word after the phrase, or one inside it ("sex is OUR secret",
 * "sex with ME") unless one of the guard's `quoteWords` holds the view ("If someone tells you
 * touching private parts is our secret, tell"; round 4 lead policy).
 */
function childVoidsGuard(
  tokens: readonly string[],
  start: number,
  pos: number,
  guard: CompiledGuard,
): boolean {
  if (firstPersonAfter(tokens, pos)) return true;
  if (guard.quoteWords === null) return false;
  let inPhrase = false;
  for (let p = start; p < pos && !inPhrase; p += 1) inPhrase = FIRST_PERSON_SET.has(tokens[p]!);
  return inPhrase && !guardedBefore(tokens, start, { ...guard, words: guard.quoteWords });
}

/**
 * Whether the rule's notFollowedBy exclusion applies at `pos` (the match end): the exclusion may
 * start up to `notFollowedWithin` tokens later in the sentence ("poison berries in Minecraft"), and
 * a listed deliberate or distress word within VOID_WINDOW tokens voids it ("with the paper cutter
 * on purpose"; round 3, CHK2-CS-1).
 */
function excludedAfter(tokens: readonly string[], pos: number, rule: CompiledRule): boolean {
  const slot = rule.notFollowedBy;
  if (slot === null) return false;
  let hit = false;
  for (let g = 0; g <= rule.notFollowedWithin; g += 1) {
    const p = pos + g;
    if (p >= tokens.length || (g > 0 && tokens[p - 1] === BOUNDARY)) break;
    if (matchSlot(tokens, p, slot) >= 0) {
      hit = true;
      break;
    }
  }
  if (!hit || rule.unlessAfter === null) return hit;
  for (let p = pos; p < tokens.length && p <= pos + VOID_WINDOW; p += 1) {
    if (tokens[p] === BOUNDARY) break;
    if (matchSlot(tokens, p, rule.unlessAfter) >= 0) return false;
  }
  return true;
}

/** Greedy, bounded match of one rule starting at `start` (no backtracking). */
function matchAt(tokens: readonly string[], start: number, rule: CompiledRule): boolean {
  const def = rule.def;
  if (rule.notPrecededBy !== null && start > 0 && rule.notPrecededBy.has(tokens[start - 1]!)) {
    return false;
  }
  if (def.negatable && negatedBefore(tokens, start)) return false;
  if (def.hypothetical && anyBefore(tokens, start, 3, HYPOTHETICAL_SET)) return false;
  const guard = rule.guard;
  const guarded = guard !== null && guardedBefore(tokens, start, guard);
  if (guarded && !guard.firstPersonAfter) return false;
  if (def.sentenceStart && start > 0 && tokens[start - 1] !== BOUNDARY) return false;
  if (def.alone && !onlyBoundaries(tokens, 0, start)) return false;
  let pos = matchSlot(tokens, start, rule.slots[0]!);
  if (pos < 0) return false;
  for (let s = 1; s < rule.slots.length; s += 1) {
    const slot = rule.slots[s]!;
    let next = -1;
    for (let g = 0; g <= slot.gap; g += 1) {
      const p = pos + g;
      if (p >= tokens.length) break;
      if (g > 0) {
        const skipped = tokens[p - 1]!;
        if (skipped === BOUNDARY) break;
        if (def.negatable && NEGATOR_SET.has(skipped)) break;
        if (rule.gapStop !== null && rule.gapStop.has(skipped)) break;
      }
      next = matchSlot(tokens, p, slot);
      if (next >= 0) break;
    }
    if (next < 0) {
      if (slot.optional) continue;
      return false;
    }
    pos = next;
  }
  if (def.alone && !onlyBoundaries(tokens, pos, tokens.length)) return false;
  if (def.sentenceEnd && pos < tokens.length && tokens[pos] !== BOUNDARY) return false;
  if (guarded && !childVoidsGuard(tokens, start, pos, guard)) return false;
  return !excludedAfter(tokens, pos, rule);
}

/** True when tokens[from, to) are all sentence boundaries (or the range is empty). */
function onlyBoundaries(tokens: readonly string[], from: number, to: number): boolean {
  for (let k = from; k < to; k += 1) if (tokens[k] !== BOUNDARY) return false;
  return true;
}

/** True when the stream's word starts inside [at, end) are exactly the phrase's own. */
function naturallySpelled(
  stream: CompactStream,
  at: number,
  end: number,
  phrase: SignaturePhrase,
): boolean {
  if (phrase.boundaries === null) return false;
  for (let p = at + 1; p < end; p += 1) {
    if (stream.starts.has(p) !== phrase.boundaries.has(p - at)) return false;
  }
  return true;
}

/** A signature occurrence that starts and ends on token boundaries and is split unusually. */
function anchored(stream: CompactStream, phrase: SignaturePhrase): boolean {
  let from = 0;
  for (;;) {
    const at = stream.text.indexOf(phrase.text, from);
    if (at < 0) return false;
    const end = at + phrase.text.length;
    if (
      stream.starts.has(at) &&
      stream.ends.has(end) &&
      !naturallySpelled(stream, at, end, phrase)
    ) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Sentence indexes (counted by BOUNDARY tokens, which every stream places alike) whose words
 * include a first-person word outside a frame ("my", "me", "I", "I'll" — but not the "I" of "I
 * learned that ...", "I think ..." or the "our" of "In our class ..."). RV-child-safety-1, CHK-CS-3.
 */
function firstPersonSentences(tokens: readonly string[]): ReadonlySet<number> {
  const out = new Set<number>();
  let sentence = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === BOUNDARY) {
      sentence += 1;
      i += 1;
      continue;
    }
    const frameEnd = matchSlot(tokens, i, FIRST_PERSON_FRAME_SLOT);
    if (frameEnd > i) {
      i = frameEnd;
      continue;
    }
    const opinionEnd = matchSlot(tokens, i, OPINION_FRAME_SLOT);
    if (opinionEnd > i && !OPINION_NOT_BEFORE.has(tokens[opinionEnd] ?? '')) {
      i = opinionEnd;
      continue;
    }
    if (FIRST_PERSON_SET.has(t) || illReadsAsIWill(tokens, i)) out.add(sentence);
    i += 1;
  }
  return out;
}

interface Hits {
  readonly rules: ReadonlySet<CompiledRule>;
  readonly signatures: ReadonlySet<CompiledSignature>;
  /**
   * Tier-B hits in a child's text that sit in a first-person sentence (for signatures, in a text
   * that uses the first person at all). Such a hit is the child's own statement, never a topic.
   */
  readonly personal: ReadonlySet<CompiledRule | CompiledSignature>;
}

/**
 * `firstPerson`: whether a first-person sentence keeps a tier-B word from being exempt. True for
 * the child's own text; false for the printed prompt, which is not the child's statement
 * (CHK-CS-2: "In our unit we discuss child abuse." is a worksheet's words).
 */
function scan(norm: NormalizedText, source: ScreenSource, firstPerson: boolean): Hits {
  const rules = new Set<CompiledRule>();
  const personal = new Set<CompiledRule | CompiledSignature>();
  let sentences: ReadonlySet<number> | null = null;
  // The split "1 → i" stream: a bare "Ill" is its token "il" (see illReadsAsIWill).
  const personalSentences = () => (sentences ??= firstPersonSentences(norm.streams[0] ?? []));
  for (const tokens of norm.streams) {
    let sentence = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token === BOUNDARY) {
        sentence += 1;
        continue;
      }
      const candidates = INDEX.get(token);
      if (candidates === undefined) continue;
      for (const rule of candidates) {
        if (!rule.sources.has(source)) continue;
        // A rule about the child's own answer never reads the printed prompt (CHK2-CS-4).
        if (rule.def.answerOnly && !firstPerson) continue;
        // A tier-B rule on a child's text keeps looking (still bounded: one check per position)
        // until it finds an occurrence in a first-person sentence.
        const tierB = rule.exempt !== null && source === 'child' && firstPerson;
        if (tierB ? personal.has(rule) : rules.has(rule)) continue;
        if (!matchAt(tokens, i, rule)) continue;
        rules.add(rule);
        if (tierB && personalSentences().has(sentence)) personal.add(rule);
      }
    }
  }
  const signatures = new Set<CompiledSignature>();
  for (const sig of COMPILED_SIGNATURES) {
    if (!sig.sources.has(source)) continue;
    if (norm.compacts.some((c) => sig.phrases.some((phrase) => anchored(c, phrase)))) {
      signatures.add(sig);
      if (
        sig.exempt !== null &&
        source === 'child' &&
        firstPerson &&
        personalSentences().size > 0
      ) {
        personal.add(sig);
      }
    }
  }
  return { rules, signatures, personal };
}

// ---------------------------------------------------------------------------------------------
// Context (the printed question and its subject)
// ---------------------------------------------------------------------------------------------

interface ContextInfo {
  readonly subject: string | null;
  /** Topics the printed question raises, tier-B topics included whatever their level. */
  readonly promptTopics: ReadonlySet<SensitiveTopic>;
  readonly vocabulary: ReadonlySet<string>;
}

const EMPTY_CONTEXT: ContextInfo = {
  subject: null,
  promptTopics: new Set(),
  vocabulary: new Set(),
};

function contextInfo(context: ScreenContext | undefined): ContextInfo {
  const subject = context?.subject ?? null;
  const prompt = context?.prompt ?? null;
  if (prompt === null || prompt.trim().length === 0) return { ...EMPTY_CONTEXT, subject };
  const norm = normalizeForScreen(prompt, VOCABULARY, true);
  const hits = scan(norm, 'child', false);
  const promptTopics = new Set<SensitiveTopic>();
  for (const rule of hits.rules) if (rule.def.topic !== undefined) promptTopics.add(rule.def.topic);
  for (const sig of hits.signatures)
    if (sig.def.topic !== undefined) promptTopics.add(sig.def.topic);
  return { subject, promptTopics, vocabulary: norm.vocabulary };
}

function exemptFor(
  exempt: Exemption,
  topic: SensitiveTopic,
  source: ScreenSource,
  norm: NormalizedText,
  ctx: ContextInfo,
): boolean {
  // Model output may use a tier-B word only when the printed question raised the same topic.
  if (source === 'ai') return ctx.promptTopics.has(topic);
  if (ctx.subject !== null && exempt.subjects.has(ctx.subject)) return true;
  for (const cue of exempt.cues)
    if (norm.vocabulary.has(cue) || ctx.vocabulary.has(cue)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Public screens
// ---------------------------------------------------------------------------------------------

const CATEGORY_ORDER = new Map(SEVERE_SAFETY_CATEGORIES.map((c, i) => [c, i]));
const TOPIC_ORDER = new Map(SENSITIVE_TOPICS.map((t, i) => [t, i]));

function finish(
  categories: ReadonlySet<SevereSafetyCategory>,
  topics: ReadonlySet<SensitiveTopic>,
  codes: ReadonlySet<string>,
  truncated: boolean,
): SafetyScreen {
  return {
    level: categories.size > 0 ? 'severe' : topics.size > 0 ? 'sensitive_educational' : 'none',
    categories: [...categories].sort((a, b) => CATEGORY_ORDER.get(a)! - CATEGORY_ORDER.get(b)!),
    topics: [...topics].sort((a, b) => TOPIC_ORDER.get(a)! - TOPIC_ORDER.get(b)!),
    codes: [...codes].sort(),
    truncated,
  };
}

function screenWith(
  text: string,
  source: ScreenSource,
  ctx: ContextInfo,
  childStatement = true,
): SafetyScreen {
  // A printed prompt is the worksheet's text: "World War I" there is a numeral (normalize.ts).
  const norm = normalizeForScreen(text, VOCABULARY, !childStatement);
  const hits = scan(norm, source, childStatement);
  const categories = new Set<SevereSafetyCategory>();
  const topics = new Set<SensitiveTopic>();
  const codes = new Set<string>();
  const firstPerson: { id: string; category: SevereSafetyCategory; topic: SensitiveTopic }[] = [];
  const record = (
    id: string,
    category: SevereSafetyCategory | undefined,
    topic: SensitiveTopic | undefined,
    exempt: Exemption | null,
    personal: boolean,
  ) => {
    if (category === undefined) {
      if (topic !== undefined) topics.add(topic);
      codes.add(id);
    } else if (
      exempt !== null &&
      topic !== undefined &&
      exemptFor(exempt, topic, source, norm, ctx)
    ) {
      // RV-child-safety-1: the context would make the word educational, but the child used it in
      // a first-person sentence ("suicide is the only way out for me" in reading): never exempt.
      if (personal) {
        firstPerson.push({ id, category, topic });
      } else {
        topics.add(topic);
        codes.add(`${id}_EDUCATIONAL`);
      }
    } else {
      categories.add(category);
      codes.add(id);
    }
  };
  for (const rule of hits.rules)
    record(rule.def.id, rule.def.category, rule.def.topic, rule.exempt, hits.personal.has(rule));
  for (const sig of hits.signatures)
    record(sig.def.id, sig.def.category, sig.def.topic, sig.exempt, hits.personal.has(sig));
  for (const hit of firstPerson) {
    codes.add(`${hit.id}_FIRST_PERSON`);
    // A sexual-violence word inside a first-person abuse disclosure is part of that disclosure
    // ("I was a victim of rape" in reading is `abuse`); on its own it is `sexual`.
    if (hit.category === 'sexual' && categories.has('abuse')) topics.add(hit.topic);
    else categories.add(hit.category);
  }
  if (source === 'ai') {
    // Grounding (spec P4 "keep tutoring grounded in the current assignment"): model output may
    // not bring up a sensitive topic that neither the printed question nor its subject raises.
    const allowed = new Set<SensitiveTopic>([
      ...ctx.promptTopics,
      ...(ctx.subject !== null ? (SUBJECT_TOPICS[ctx.subject] ?? []) : []),
    ]);
    for (const topic of topics) {
      if (!allowed.has(topic)) {
        categories.add('ungrounded_topic');
        codes.add(`AI_UNGROUNDED_${topic.toUpperCase()}`);
      }
    }
  }
  return finish(categories, topics, codes, norm.truncated);
}

/** Combines several screens (the most serious level wins; categories, topics and codes join). */
export function mergeScreens(screens: readonly SafetyScreen[]): SafetyScreen {
  const categories = new Set<SevereSafetyCategory>();
  const topics = new Set<SensitiveTopic>();
  const codes = new Set<string>();
  let truncated = false;
  for (const s of screens) {
    s.categories.forEach((c) => categories.add(c));
    s.topics.forEach((t) => topics.add(t));
    s.codes.forEach((c) => codes.add(c));
    truncated ||= s.truncated;
  }
  return finish(categories, topics, codes, truncated);
}

/**
 * Screens one text. `source` defaults to `child`; `context` is the printed question and subject
 * the text belongs to (educational exemptions for a child's text, grounding for model output).
 */
export function screenText(text: string, options: ScreenOptions): SafetyScreen {
  return screenWith(text, options.source ?? 'child', contextInfo(options.context));
}

/**
 * The scan pipeline's input screen for one extracted question: the child's answer (in the context
 * of the printed question and subject) and the printed prompt itself (a child may have written in
 * it, or the extraction may have merged a margin note into it). Every rule reads the prompt, but
 * its first person does not make a tier-B word severe: a worksheet's "our class" or "we discuss"
 * is not the child's statement (CHK-CS-2), so a tier-B word in it is judged by subject and cues.
 */
export function screenQuestion(input: {
  readonly prompt: string | null;
  readonly answer: string | null;
  readonly subject: string | null;
  readonly ageBand: SafetyAgeBand | null;
}): SafetyScreen {
  const screens: SafetyScreen[] = [];
  if (input.answer !== null && input.answer.trim().length > 0) {
    screens.push(
      screenWith(
        input.answer,
        'child',
        contextInfo({ prompt: input.prompt, subject: input.subject }),
      ),
    );
  }
  if (input.prompt !== null && input.prompt.trim().length > 0) {
    screens.push(screenWith(input.prompt, 'child', contextInfo({ subject: input.subject }), false));
  }
  return mergeScreens(screens);
}

/**
 * Moderation after generation: screens every child-facing text a model produced, grounded in the
 * printed question and subject (pass `{}` when there is none, e.g. a practice intro). Companion,
 * diagnosis, secrecy and contact rules for model output apply only here.
 */
export function screenModelOutput(
  texts: readonly string[],
  options: { readonly ageBand: SafetyAgeBand | null; readonly context: ScreenContext },
): SafetyScreen {
  const ctx = contextInfo(options.context);
  return mergeScreens(texts.map((text) => screenWith(text, 'ai', ctx)));
}

/** Every rule and signature with its rationale (for review, docs and tests). */
export const SAFETY_RULES: readonly SafetyRuleDoc[] = [
  ...RULES.map((r) => ({
    id: r.id,
    kind: r.kind,
    category: r.category ?? null,
    topic: r.topic ?? null,
    sources: r.sources,
    doc: r.doc,
  })),
  ...SIGNATURES.map((s) => ({
    id: s.id,
    kind: 'severe' as const,
    category: s.category,
    topic: s.topic ?? null,
    sources: s.sources,
    doc: s.doc,
  })),
];
