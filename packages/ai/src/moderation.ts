import {
  SEVERE_SAFETY_CATEGORIES,
  type SafetyScreen,
  type SevereSafetyCategory,
} from '@pencillift/domain/safety';

/**
 * Provider moderation (spec P4; AC_SECURITY_02): the second layer after the deterministic word-list
 * screen (@pencillift/domain/safety), before generation (the child's own words) and after it (every
 * model text a child would read). Server-only; plain fetch keeps it Workers-compatible like
 * client.ts. The OpenAI moderation endpoint receives the child's words, so callers run it only where
 * the child-data gate (gate.ts: ZDR approval, consent) lets grading run.
 *
 * Nothing here logs or returns text: an error carries a status and flags only, a result carries
 * booleans, category names and a score. Not exercised against the live API from the build
 * environment (no key; egress blocked). Development and test use the LABELED mock below; staging
 * and production without OPENAI_API_KEY use the refusing client, so nothing is ever graded or
 * shown unmoderated there.
 */

export const MODERATION_ENDPOINT = 'https://api.openai.com/v1/moderations';
export const MODERATION_MODEL = 'omni-moderation-latest';
/** Inputs per request; a larger call is split into several requests of at most this many. */
export const MODERATION_BATCH_CAP = 32;
/** Per-request timeout the callers pass (the endpoint is fast; a slow answer is an error). */
export const MODERATION_TIMEOUT_MS = 10_000;

/** OpenAI moderation categories (omni-moderation), by their API names. */
export const OPENAI_MODERATION_CATEGORIES = [
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
] as const;
export type OpenAiModerationCategory = (typeof OPENAI_MODERATION_CATEGORIES)[number];

export interface ModerationRequestOptions {
  readonly timeoutMs: number;
  /**
   * Pseudonymous ids and the calling step only (never names or homework). The moderation endpoint
   * takes no metadata, so the OpenAI transport does not send it; the mock records it for tests.
   */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ModerationResultItem {
  readonly flagged: boolean;
  /** OpenAI category names reported true for this input. */
  readonly categories: readonly string[];
  /** Highest category score (0 when none was reported). */
  readonly maxScore: number;
}

export type ModerationResult =
  | {
      readonly kind: 'ok';
      /** One per input, in input order. */
      readonly results: readonly ModerationResultItem[];
      readonly modelId: string;
      readonly latencyMs: number;
    }
  | {
      readonly kind: 'error';
      readonly status: number | null;
      readonly retryable: boolean;
      readonly timedOut: boolean;
      readonly latencyMs: number;
    };

export interface ModerationClient {
  readonly name: string;
  readonly isMock: boolean;
  moderate(inputs: readonly string[], options: ModerationRequestOptions): Promise<ModerationResult>;
}

// ---------------------------------------------------------------------------------------------
// Mapping to PencilLift safety categories (pure; exported for tests)
// ---------------------------------------------------------------------------------------------

/** A PencilLift category a provider flag can carry; every one is a system-report category (0760). */
export type ProviderMappedCategory = 'self_harm' | 'sexual' | 'violence';

/**
 * Which PencilLift severe category an OpenAI category means. The CHILD'S OWN WORDS turn a violence
 * flag into abuse AND violence (see providerSafetyCategories).
 *
 * Owner/lead decision (2026-09-25; CS-R2-03): `harassment`, `hate` and `illicit` map like their
 * `/threatening` and `/violent` siblings instead of to nothing. Recall comes first on a child's own
 * answer, and the provider's threat sub-signal is not what decides whether a grown-up should look:
 * these used to be logged and nothing else, so the answer was graded and coached and the parent was
 * never told.
 */
export const PROVIDER_CATEGORY_MAP: Readonly<
  Record<OpenAiModerationCategory, ProviderMappedCategory>
> = {
  'self-harm': 'self_harm',
  'self-harm/intent': 'self_harm',
  'self-harm/instructions': 'self_harm',
  sexual: 'sexual',
  'sexual/minors': 'sexual',
  violence: 'violence',
  'violence/graphic': 'violence',
  'harassment/threatening': 'violence',
  'hate/threatening': 'violence',
  'illicit/violent': 'violence',
  harassment: 'violence',
  hate: 'violence',
  illicit: 'violence',
};

/**
 * The PencilLift category a provider flag falls back to when its own category name means nothing
 * here: a category the provider added after this code shipped, or a result flagged with no category
 * at all (CS-R2-03). PencilLift has no "other" severe category and migration 0760 allows a system
 * report only the six screen codes, so the fallback is a real one; `violence` is where every
 * hostility-type provider category already maps, and on a child's own words it adds `abuse` like
 * the rest, which gives the calm child message (no anger line) and a flag for the parent.
 */
export const PROVIDER_FALLBACK_CATEGORY: ProviderMappedCategory = 'violence';

/** Who wrote the moderated text: the child (answers) or a model (child-facing output). */
export type ModeratedSource = 'child' | 'model_output';

const CATEGORY_ORDER = new Map<SevereSafetyCategory, number>(
  SEVERE_SAFETY_CATEGORIES.map((c, i) => [c, i]),
);

function isOpenAiCategory(category: string): category is OpenAiModerationCategory {
  return (OPENAI_MODERATION_CATEGORIES as readonly string[]).includes(category);
}

function addMapped(
  out: Set<SevereSafetyCategory>,
  mapped: ProviderMappedCategory,
  source: ModeratedSource,
): void {
  if (mapped === 'violence' && source === 'child') out.add('abuse');
  out.add(mapped);
}

/**
 * PencilLift severe categories for the OpenAI categories reported on one input, sorted like the
 * word-list screen's. For the child's own words a violence-type flag maps to abuse AND violence: a
 * model cannot tell a victim's report ("he beats me") from a threat, so the parent sees both codes'
 * message and can clear a false match (runbook 5.1; owner decision 2026-09-25: no report is held).
 * An unknown category name — one the provider added after this code shipped — takes
 * PROVIDER_FALLBACK_CATEGORY instead of being dropped (CS-R2-03): a new category name is not a
 * reason to grade a flagged answer and tell the parent nothing.
 */
export function providerSafetyCategories(
  categories: readonly string[],
  source: ModeratedSource,
): SevereSafetyCategory[] {
  const out = new Set<SevereSafetyCategory>();
  for (const category of categories) {
    addMapped(
      out,
      isOpenAiCategory(category) ? PROVIDER_CATEGORY_MAP[category] : PROVIDER_FALLBACK_CATEGORY,
      source,
    );
  }
  return [...out].sort((a, b) => CATEGORY_ORDER.get(a)! - CATEGORY_ORDER.get(b)!);
}

/** True when the provider reported anything at all for this input (fails closed on categories). */
export function moderationFlagged(item: ModerationResultItem): boolean {
  return item.flagged || item.categories.length > 0;
}

/**
 * Payload-free log codes for one input's flags: `PROVIDER_` and the OpenAI category in capitals
 * ("self-harm/intent" -> PROVIDER_SELF_HARM_INTENT), so reviewers see the source; `PROVIDER_FLAGGED`
 * when the input was flagged without a category. Sorted, bounded, letters, digits and "_" only.
 */
export function providerModerationCodes(item: ModerationResultItem): string[] {
  if (!moderationFlagged(item)) return [];
  const codes = new Set<string>();
  for (const category of item.categories) {
    const slug = category
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    codes.add(slug.length > 0 ? `PROVIDER_${slug}` : 'PROVIDER_FLAGGED');
  }
  if (codes.size === 0) codes.add('PROVIDER_FLAGGED');
  return [...codes].sort();
}

/**
 * One input's provider result as a safety screen, to merge with the word-list screen
 * (mergeScreens: the most serious level wins, categories and codes join).
 *
 * FAILS CLOSED on the categories (CS-R2-03): `severe` whenever moderationFlagged() is true, and a
 * flag that maps to no PencilLift category — flagged with no category at all, or only with names
 * this code does not know — carries PROVIDER_FALLBACK_CATEGORY, so the child gets the safety
 * template and the parent gets a flag instead of the answer being graded on a warn log alone. The
 * screen is used for the child's own answers (scan-process.ts childInputScreen); model output fails
 * closed on moderationFlagged() directly.
 */
export function providerSafetyScreen(
  item: ModerationResultItem,
  source: ModeratedSource,
): SafetyScreen {
  const flagged = moderationFlagged(item);
  let categories = flagged ? providerSafetyCategories(item.categories, source) : [];
  if (flagged && categories.length === 0) {
    const fallback = new Set<SevereSafetyCategory>();
    addMapped(fallback, PROVIDER_FALLBACK_CATEGORY, source);
    categories = [...fallback].sort((a, b) => CATEGORY_ORDER.get(a)! - CATEGORY_ORDER.get(b)!);
  }
  return {
    level: flagged ? 'severe' : 'none',
    categories,
    topics: [],
    codes: providerModerationCodes(item),
    truncated: false,
  };
}

// ---------------------------------------------------------------------------------------------
// OpenAI transport
// ---------------------------------------------------------------------------------------------

interface ApiModerationResult {
  flagged?: unknown;
  categories?: unknown;
  category_scores?: unknown;
}

interface ApiModerationResponse {
  model?: unknown;
  results?: unknown;
}

const UNFLAGGED: ModerationResultItem = { flagged: false, categories: [], maxScore: 0 };

/** Reads one API result; null when its shape is not the documented one (fail closed). */
function readResult(raw: unknown): ModerationResultItem | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as ApiModerationResult;
  if (typeof r.flagged !== 'boolean') return null;
  if (r.categories === null || typeof r.categories !== 'object') return null;
  const categories = Object.entries(r.categories as Record<string, unknown>)
    .filter(([, value]) => value === true)
    .map(([name]) => name)
    .sort();
  let maxScore = 0;
  if (r.category_scores !== null && typeof r.category_scores === 'object') {
    for (const value of Object.values(r.category_scores as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > maxScore) maxScore = value;
    }
  }
  return { flagged: r.flagged, categories, maxScore };
}

export function buildModerationRequestBody(inputs: readonly string[]): Record<string, unknown> {
  return { model: MODERATION_MODEL, input: [...inputs] };
}

/**
 * The OpenAI moderation client: one POST per batch of at most MODERATION_BATCH_CAP inputs, each
 * with its own timeout. Any failed batch fails the whole call (nothing partial is returned), and a
 * response whose results do not match the inputs one to one is an error, never "not flagged".
 * Blank inputs are not sent (nothing to moderate) and read as not flagged.
 */
export function createOpenAiModerationClient(options: {
  apiKey: string;
  project?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}): ModerationClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => Date.now());

  async function batch(
    inputs: readonly string[],
    timeoutMs: number,
    started: number,
  ): Promise<
    | { readonly ok: true; readonly results: ModerationResultItem[]; readonly modelId: string }
    | { readonly ok: false; readonly error: ModerationResult & { kind: 'error' } }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const failure = (status: number | null, retryable: boolean, timedOut: boolean) => ({
      ok: false as const,
      error: {
        kind: 'error' as const,
        status,
        retryable,
        timedOut,
        latencyMs: clock() - started,
      },
    });
    try {
      const response = await fetchImpl(MODERATION_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          ...(options.project ? { 'openai-project': options.project } : {}),
        },
        body: JSON.stringify(buildModerationRequestBody(inputs)),
        signal: controller.signal,
      });
      if (!response.ok) {
        return failure(response.status, response.status === 429 || response.status >= 500, false);
      }
      const body = (await response.json()) as ApiModerationResponse;
      const raw = Array.isArray(body.results) ? (body.results as unknown[]) : null;
      if (raw === null || raw.length !== inputs.length)
        return failure(response.status, true, false);
      const results: ModerationResultItem[] = [];
      for (const item of raw) {
        const read = readResult(item);
        if (read === null) return failure(response.status, true, false);
        results.push(read);
      }
      return {
        ok: true,
        results,
        modelId: typeof body.model === 'string' ? body.model : MODERATION_MODEL,
      };
    } catch (error) {
      // The error class only: a message could quote the request.
      return failure(null, true, error instanceof Error && error.name === 'AbortError');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'openai_moderation',
    isMock: false,
    async moderate(inputs, requestOptions) {
      const started = clock();
      const results: ModerationResultItem[] = inputs.map(() => UNFLAGGED);
      const sent = inputs.flatMap((text, index) => (text.trim().length > 0 ? [index] : []));
      let modelId = MODERATION_MODEL;
      for (let from = 0; from < sent.length; from += MODERATION_BATCH_CAP) {
        const indexes = sent.slice(from, from + MODERATION_BATCH_CAP);
        const out = await batch(
          indexes.map((i) => inputs[i]!),
          requestOptions.timeoutMs,
          started,
        );
        if (!out.ok) return out.error;
        modelId = out.modelId;
        out.results.forEach((result, k) => {
          results[indexes[k]!] = result;
        });
      }
      return { kind: 'ok', results, modelId, latencyMs: clock() - started };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Labeled mock and the refusing client
// ---------------------------------------------------------------------------------------------

/** The only thing the labeled mock flags: `[mock-moderation:<openai-category>]` in the input. */
const MOCK_MARKER = /\[mock-moderation:([a-z/-]+)\]/g;

/**
 * The labeled mock's answer for `inputs`, without any recording: an input is flagged only when it
 * contains `[mock-moderation:<openai-category>]` with a known OpenAI category name, so every test
 * that expects a flag states it in its fixture.
 */
export function mockModerationResult(inputs: readonly string[]): ModerationResult {
  return {
    kind: 'ok',
    results: inputs.map((text) => {
      const categories = [
        ...new Set([...text.matchAll(MOCK_MARKER)].map((m) => m[1]!).filter(isOpenAiCategory)),
      ].sort();
      return categories.length > 0
        ? { flagged: true, categories, maxScore: 0.99 }
        : { flagged: false, categories: [], maxScore: 0.01 };
    }),
    modelId: 'mock-moderation',
    latencyMs: 1,
  };
}

/** One scripted answer of the mock: a fixed result, or a function of the inputs of that call. */
export type MockModerationStep =
  ModerationResult | ((inputs: readonly string[]) => ModerationResult);

export interface MockModerationClient extends ModerationClient {
  /** Every call, in order (tests only; the mock sends nothing anywhere). */
  readonly requests: {
    readonly inputs: readonly string[];
    readonly options: ModerationRequestOptions;
  }[];
  /**
   * Answers for the next calls, used first to last before the marker behaviour (an error, a
   * timeout, or a flag on an input that carries no marker). Tests push to it.
   */
  readonly scripted: MockModerationStep[];
}

/** LABELED test/development double (isMock: true). Production and staging never wire it. */
export function createMockModerationClient(): MockModerationClient {
  const requests: MockModerationClient['requests'] = [];
  const scripted: MockModerationStep[] = [];
  return {
    name: 'mock_moderation',
    isMock: true,
    requests,
    scripted,
    moderate(inputs, options) {
      requests.push({ inputs: [...inputs], options });
      const step = scripted.shift();
      if (step === undefined) return Promise.resolve(mockModerationResult(inputs));
      return Promise.resolve(typeof step === 'function' ? step(inputs) : step);
    },
  };
}

/**
 * Staging/production without OPENAI_API_KEY: every call fails and cannot be retried, so no text is
 * graded or shown unmoderated. Not a mock (like the unavailable consent provider).
 */
export function createRefusingModerationClient(): ModerationClient {
  return {
    name: 'not_configured',
    isMock: false,
    moderate: () =>
      Promise.resolve({
        kind: 'error',
        status: null,
        retryable: false,
        timedOut: false,
        latencyMs: 0,
      }),
  };
}
