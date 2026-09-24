// The safety screen's matcher (see index.ts for the rules, their limits and how callers use it).
import {
  HYPOTHETICALS,
  NEGATORS,
  RULES,
  SIGNATURES,
  SUBJECT_TOPICS,
  type RuleDef,
  type SignatureDef,
} from './lexicon.ts';
import {
  BOUNDARY,
  collapseRepeats,
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
export const SAFETY_SCREEN_VERSION = 'safety-screen.v2';

// ---------------------------------------------------------------------------------------------
// Compilation (once, at module load)
// ---------------------------------------------------------------------------------------------

type Phrase = readonly string[];

interface Slot {
  readonly byFirst: ReadonlyMap<string, readonly Phrase[]>;
  readonly gap: number;
  readonly optional: boolean;
}

interface Exemption {
  readonly subjects: ReadonlySet<string>;
  readonly cues: ReadonlySet<string>;
}

interface CompiledRule {
  readonly def: RuleDef;
  readonly sources: ReadonlySet<ScreenSource>;
  readonly slots: readonly Slot[];
  readonly notFollowedBy: Slot | null;
  readonly notPrecededBy: ReadonlySet<string> | null;
  readonly guard: { readonly words: Slot; readonly within: number } | null;
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

function compileSlot(text: string, gap: number, optional: boolean): Slot {
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
  return { byFirst, gap, optional };
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
  for (let i = 0; i < parts.length; i += 2) {
    let text = parts[i]!.trim();
    const gapText = i === 0 ? '0' : (parts[i - 1] ?? '');
    const gap = i === 0 ? 0 : gapText === '' ? (def.gap ?? 1) : Number(gapText);
    const optional = text.startsWith('?');
    if (optional) text = text.slice(1);
    slots.push(compileSlot(text, gap, optional));
  }
  if (slots.length === 0 || slots[0]!.optional) {
    throw new Error(`safety lexicon: ${def.id} must start with a required slot`);
  }
  if ((def.kind === 'severe') !== (def.category !== undefined)) {
    throw new Error(`safety lexicon: ${def.id} category does not match its kind`);
  }
  if ((def.exempt !== undefined || def.kind === 'topic') && def.topic === undefined) {
    throw new Error(`safety lexicon: ${def.id} needs a topic`);
  }
  return {
    def,
    sources: new Set(def.sources),
    slots,
    notFollowedBy: def.notFollowedBy ? compileSlot(def.notFollowedBy, 0, false) : null,
    notPrecededBy: def.notPrecededBy ? compileTokens(def.notPrecededBy) : null,
    guard: def.guard
      ? { words: compileSlot(def.guard.words, 0, false), within: def.guard.within }
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
const HYPOTHETICAL_SET = compileTokens(HYPOTHETICALS);

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

/** End index (exclusive) of the longest alternative of `slot` at `p`, or -1. */
function matchSlot(tokens: readonly string[], p: number, slot: Slot): number {
  const t = tokens[p];
  if (t === undefined) return -1;
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

/** A guard word or phrase starting within `within` tokens before `start` (same sentence). */
function guardedBefore(
  tokens: readonly string[],
  start: number,
  guard: { readonly words: Slot; readonly within: number },
): boolean {
  for (let k = 1; k <= guard.within && start - k >= 0; k += 1) {
    if (tokens[start - k] === BOUNDARY) return false;
    if (matchSlot(tokens, start - k, guard.words) >= 0) return true;
  }
  return false;
}

/** Greedy, bounded match of one rule starting at `start` (no backtracking). */
function matchAt(tokens: readonly string[], start: number, rule: CompiledRule): boolean {
  const def = rule.def;
  if (rule.notPrecededBy !== null && start > 0 && rule.notPrecededBy.has(tokens[start - 1]!)) {
    return false;
  }
  if (def.negatable && anyBefore(tokens, start, 2, NEGATOR_SET)) return false;
  if (def.hypothetical && anyBefore(tokens, start, 3, HYPOTHETICAL_SET)) return false;
  if (rule.guard !== null && guardedBefore(tokens, start, rule.guard)) return false;
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
  return rule.notFollowedBy === null || matchSlot(tokens, pos, rule.notFollowedBy) < 0;
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

interface Hits {
  readonly rules: ReadonlySet<CompiledRule>;
  readonly signatures: ReadonlySet<CompiledSignature>;
}

function scan(norm: NormalizedText, source: ScreenSource): Hits {
  const rules = new Set<CompiledRule>();
  for (const tokens of norm.streams) {
    for (let i = 0; i < tokens.length; i += 1) {
      const candidates = INDEX.get(tokens[i]!);
      if (candidates === undefined) continue;
      for (const rule of candidates) {
        if (rules.has(rule) || !rule.sources.has(source)) continue;
        if (matchAt(tokens, i, rule)) rules.add(rule);
      }
    }
  }
  const signatures = new Set<CompiledSignature>();
  for (const sig of COMPILED_SIGNATURES) {
    if (!sig.sources.has(source)) continue;
    if (norm.compacts.some((c) => sig.phrases.some((phrase) => anchored(c, phrase)))) {
      signatures.add(sig);
    }
  }
  return { rules, signatures };
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
  const norm = normalizeForScreen(prompt);
  const hits = scan(norm, 'child');
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

function screenWith(text: string, source: ScreenSource, ctx: ContextInfo): SafetyScreen {
  const norm = normalizeForScreen(text);
  const hits = scan(norm, source);
  const categories = new Set<SevereSafetyCategory>();
  const topics = new Set<SensitiveTopic>();
  const codes = new Set<string>();
  const record = (
    id: string,
    category: SevereSafetyCategory | undefined,
    topic: SensitiveTopic | undefined,
    exempt: Exemption | null,
  ) => {
    if (category === undefined) {
      if (topic !== undefined) topics.add(topic);
      codes.add(id);
    } else if (
      exempt !== null &&
      topic !== undefined &&
      exemptFor(exempt, topic, source, norm, ctx)
    ) {
      topics.add(topic);
      codes.add(`${id}_EDUCATIONAL`);
    } else {
      categories.add(category);
      codes.add(id);
    }
  };
  for (const rule of hits.rules)
    record(rule.def.id, rule.def.category, rule.def.topic, rule.exempt);
  for (const sig of hits.signatures)
    record(sig.def.id, sig.def.category, sig.def.topic, sig.exempt);
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
 * it, or the extraction may have merged a margin note into it).
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
    screens.push(screenWith(input.prompt, 'child', contextInfo({ subject: input.subject })));
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
