/**
 * WHAT THIS FILE IS FOR. Zero data retention is a property of the OpenAI ORGANIZATION, granted by
 * OpenAI after review — not something code can turn on. `gate.ts` already refuses to send a child's
 * personal data without documented evidence of that grant. This file guards the other half, which
 * nothing was guarding: that the requests PencilLift makes stay inside the shape an approved ZDR
 * configuration actually covers.
 *
 * It exists because every one of those properties held by CONVENTION. Only ZDR-eligible endpoints
 * were called, no identifier was put in `metadata`, no second AI vendor was wired — all true, all
 * true by nobody having done otherwise yet, and none of it checkable. This repository has spent four
 * rounds learning that a rule kept by convention is a rule waiting to be broken (L-071), so each one
 * is now a value a test can read and a type a caller cannot escape.
 *
 * WHAT IT IS NOT. It is not evidence of anything. Nothing here makes ZDR active, and a green test
 * here says only that the request shape matches what an approved configuration would cover. Whether
 * the configuration IS approved is `ZdrEvidence` in gate.ts, and whether that evidence is true is the
 * owner's verification against the OpenAI dashboard (docs/Owner_Actions.md #6).
 *
 * SOURCES, read 2026-10-01. OpenAI's data-controls guide lists the endpoints eligible for zero data
 * retention and, importantly, the ones that are NOT; its under-18 guidance states that a developer
 * should not process personal data of children under 13 (or the local age of digital consent)
 * "without first implementing zero data retention in the API", which is the rule gate.ts enforces.
 * Both pages are quoted in docs/Threat_Model.md and docs/Owner_Actions.md #6 rather than paraphrased
 * here, because a paraphrase of a policy goes stale silently.
 */

/**
 * The endpoints OpenAI documents as eligible for zero data retention. Listed so that the two this
 * product calls can be ASSERTED to be on it, rather than assumed to be.
 *
 * This list is a record of what the guide said on the date above, not a promise about today. It is
 * deliberately not exhaustive of OpenAI's surface: an endpoint missing here is treated as ineligible,
 * which is the safe direction for a product whose payload is a child's homework.
 */
export const ZDR_ELIGIBLE_ENDPOINTS: readonly string[] = [
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/moderations',
  '/v1/embeddings',
  '/v1/completions',
];

/**
 * Endpoints and features this product must NOT reach while it carries a child's work, with the
 * reason attached to each. Written down because the dangerous ones are the convenient ones: every
 * entry here is something a developer would reasonably reach for.
 */
export const ZDR_INELIGIBLE: Readonly<Record<string, string>> = {
  '/v1/files':
    'NOT ZDR-eligible: 30-day abuse-monitoring retention AND application state kept until the ' +
    'file is explicitly deleted. Homework images must travel inline in the request body as data ' +
    'URLs, which is what dataUrlBytes/imagePart already do, and never be uploaded as files.',
  '/v1/uploads': 'The multipart counterpart of /v1/files and ineligible for the same reason.',
  '/v1/containers':
    'Hosted containers (Code Interpreter, Hosted Shell) write application state to a container ' +
    'filesystem that outlives the request. Nothing in this product needs a container.',
  '/v1/assistants':
    'Assistants keep threads and messages as application state by design, which is the opposite ' +
    'of what a ZDR configuration buys.',
  '/v1/vector_stores':
    'A vector store is persisted application state built from the content put into it.',
  '/v1/batches':
    'Batch inputs and outputs are held as files for retrieval, so the /v1/files reasoning applies.',
};

/**
 * Features that are not endpoints but change what is retained, with the position taken on each.
 * Reviewed before enabling, as the brief asked, rather than after something stores a child's work.
 */
export const ZDR_FEATURE_POSITIONS: Readonly<Record<string, string>> = {
  store:
    'ALWAYS false, sent explicitly on every request (client.ts). Under an approved ZDR ' +
    'organization OpenAI documents `store` as forced to false regardless of what a request asks ' +
    'for, so sending it is belt and braces: it is the only part of this that works BEFORE the ' +
    'grant exists, and it keeps a development or staging call from creating stored state.',
  prompt_caching:
    'ACCEPTED, and the reason is written down rather than assumed. OpenAI documents prompt caching ' +
    'as encrypted key/value tensors in GPU-local storage, expiring within 24 hours and not ' +
    'retained past expiry. It is not an application-state store and is not opt-out per request. ' +
    'Treated as part of request processing; named here so a reviewer meets a decision rather than ' +
    'a silence.',
  background_mode:
    'NOT USED. A background response is retrievable later, which means state exists between the ' +
    'request and the retrieval. Every call this product makes is synchronous.',
  file_search:
    'NOT USED. It requires a vector store, which is persisted state (see /v1/vector_stores).',
  code_interpreter: 'NOT USED. It requires a container (see /v1/containers).',
  web_search: 'NOT USED. No stage needs it, and it would send a child’s text to a third party.',
  image_generation:
    'NOT USED. This product reads images and never generates them. The generation endpoints carry ' +
    'their own 30-day abuse-monitoring window.',
};

/** Thrown rather than returned: reaching an ineligible endpoint is a programming error. */
export class ZdrEndpointError extends Error {
  constructor(
    readonly endpoint: string,
    reason: string,
  ) {
    super(`${endpoint} may not be called with child data: ${reason}`);
    this.name = 'ZdrEndpointError';
  }
}

/** The path of an absolute OpenAI URL, or the input unchanged when it is already a path. */
export function endpointPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Refuses any endpoint not on the eligible list. Called by every transport in this package, so a new
 * call site cannot reach an ineligible endpoint without deleting this line — which a test notices.
 */
export function assertZdrEligibleEndpoint(url: string): void {
  const path = endpointPath(url);
  const named = ZDR_INELIGIBLE[path];
  if (named !== undefined) throw new ZdrEndpointError(path, named);
  if (!ZDR_ELIGIBLE_ENDPOINTS.includes(path)) {
    throw new ZdrEndpointError(
      path,
      'it is not on the documented zero-data-retention eligible list. An endpoint nobody has ' +
        'checked is treated as ineligible; add it to ZDR_ELIGIBLE_ENDPOINTS only with the guide ' +
        'open and the date recorded.',
    );
  }
}

/**
 * THE ONLY KEYS THAT MAY TRAVEL IN `metadata`, which OpenAI stores alongside the request.
 *
 * `metadata` was typed `Record<string, string>`. Nothing in it carried an identifier, and nothing
 * stopped one: a caller adding `child_id` for debugging would have sent a child's identifier to the
 * provider with no test noticing, which is the data-minimisation failure that is easiest to commit
 * and hardest to see. A closed type makes it a compile error; the runtime check below makes it an
 * error for metadata assembled dynamically, because the compiler cannot see a spread.
 *
 * Both keys are about the SOFTWARE, never the person: which stage ran, and which prompt version.
 */
export interface ZdrSafeMetadata {
  /** Which pipeline stage made the call, e.g. 'grading' or 'moderation_answer'. */
  readonly stage: string;
  /** The prompt definition's version, added by run.ts. */
  readonly prompt_version?: string;
}

export const ZDR_SAFE_METADATA_KEYS: readonly string[] = ['stage', 'prompt_version'];

/**
 * Key shapes that are identifiers whatever they are called. The closed type above is the real
 * control; this catches the dynamic case and names WHY, so whoever trips it reads the reason rather
 * than deleting the check.
 */
const IDENTIFIER_LIKE =
  /(^|_)(id|ids|uuid|email|name|nickname|phone|address|user|child|family|parent|guardian|student|account|session|device|ip)($|_)/i;

export function assertZdrSafeMetadata(
  metadata: ZdrSafeMetadata | Readonly<Record<string, string>>,
): void {
  for (const key of Object.keys(metadata)) {
    if (!ZDR_SAFE_METADATA_KEYS.includes(key)) {
      throw new ZdrEndpointError(
        'metadata',
        `"${key}" is not one of ${ZDR_SAFE_METADATA_KEYS.join(', ')}. Request metadata is stored ` +
          'beside the request by the provider, so it carries only facts about the software.',
      );
    }
    if (IDENTIFIER_LIKE.test(key)) {
      throw new ZdrEndpointError('metadata', `"${key}" looks like an identifier`);
    }
  }
}

/**
 * The AI providers this product may call. A single-entry list is the point: the brief asks for no
 * automatic fallback to another provider without separately verified privacy controls, and the
 * honest way to hold that is a list a test can read, not the absence of a second one.
 *
 * Adding an entry means that provider needs its OWN documented retention position and its own
 * evidence in `ZdrEvidence` terms. A fallback that silently reroutes a child's homework to an
 * unreviewed vendor is the failure this prevents.
 */
export const APPROVED_AI_PROVIDER_HOSTS: readonly string[] = ['api.openai.com'];

export function assertApprovedProviderHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new ZdrEndpointError(url, 'is not an absolute URL, so its host cannot be checked');
  }
  if (!APPROVED_AI_PROVIDER_HOSTS.includes(host)) {
    throw new ZdrEndpointError(
      host,
      'is not an approved AI provider host. A second provider needs its own verified privacy ' +
        'controls and its own retention position before any child data reaches it; there is no ' +
        'automatic fallback.',
    );
  }
}
