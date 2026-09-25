import type { InputPart } from './prompts.ts';

/**
 * Server-only OpenAI Responses API transport (spec P12). Plain fetch keeps it Workers-compatible.
 * `store: false` is always sent; it does NOT by itself provide zero data retention (see gate.ts).
 * Not exercised against the live API from the build environment (egress blocked).
 */

export interface ResponsesRequest {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly InputPart[];
  readonly outputName: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Pseudonymous ids only (never names or homework). */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ResponsesUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export type ResponsesResult =
  | {
      readonly kind: 'ok';
      readonly text: string;
      readonly usage: ResponsesUsage;
      readonly modelId: string;
      readonly latencyMs: number;
    }
  | {
      readonly kind: 'incomplete';
      readonly usage: ResponsesUsage;
      readonly modelId: string;
      readonly latencyMs: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'error';
      readonly status: number | null;
      readonly retryable: boolean;
      readonly latencyMs: number;
      readonly timedOut: boolean;
    };

export interface ResponsesClient {
  readonly name: string;
  readonly isMock: boolean;
  create(request: ResponsesRequest): Promise<ResponsesResult>;
}

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

interface ApiResponse {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  usage?: ApiUsage;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
}

function usageOf(u: ApiUsage | undefined): ResponsesUsage {
  // input_tokens already includes image tokens; output_tokens already includes reasoning tokens.
  return {
    inputTokens: u?.input_tokens ?? 0,
    cachedInputTokens: u?.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
  };
}

export function buildRequestBody(request: ResponsesRequest): Record<string, unknown> {
  return {
    model: request.model,
    instructions: request.instructions,
    input: [{ role: 'user', content: request.input }],
    text: {
      format: {
        type: 'json_schema',
        name: request.outputName,
        schema: request.jsonSchema,
        strict: true,
      },
    },
    max_output_tokens: request.maxOutputTokens,
    store: false,
    metadata: request.metadata,
  };
}

const BASE64_ALPHABET = Uint8Array.from(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  (c) => c.charCodeAt(0),
);
const PAD = 0x3d; // '='

/**
 * The data URL of an image (`data:<type>;base64,...`) as ASCII bytes, encoded straight from the
 * image bytes (JOBS-R1-02): no whole-page binary string and no base64 pieces to join. With
 * `imagePartFromDataUrl` a caller can drop the image bytes before the URL string is made, so a
 * page is never held three times at once.
 */
export function dataUrlBytes(mimeType: 'image/jpeg' | 'image/png', bytes: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`data:${mimeType};base64,`);
  const out = new Uint8Array(prefix.length + 4 * Math.ceil(bytes.length / 3));
  out.set(prefix, 0);
  let o = prefix.length;
  const whole = bytes.length - (bytes.length % 3);
  for (let i = 0; i < whole; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o] = BASE64_ALPHABET[v >>> 18]!;
    out[o + 1] = BASE64_ALPHABET[(v >>> 12) & 63]!;
    out[o + 2] = BASE64_ALPHABET[(v >>> 6) & 63]!;
    out[o + 3] = BASE64_ALPHABET[v & 63]!;
    o += 4;
  }
  const rest = bytes.length - whole;
  if (rest > 0) {
    const v = (bytes[whole]! << 16) | (rest === 2 ? bytes[whole + 1]! << 8 : 0);
    out[o] = BASE64_ALPHABET[v >>> 18]!;
    out[o + 1] = BASE64_ALPHABET[(v >>> 12) & 63]!;
    out[o + 2] = rest === 2 ? BASE64_ALPHABET[(v >>> 6) & 63]! : PAD;
    out[o + 3] = PAD;
  }
  return out;
}

/** The image input part for a data URL made by `dataUrlBytes` (one flat ASCII string). */
export function imagePartFromDataUrl(
  url: Uint8Array,
  detail: 'low' | 'high' | 'auto' = 'high',
): InputPart {
  return { type: 'input_image', image_url: new TextDecoder().decode(url), detail };
}

/**
 * The same part as `imagePart(mimeType, base64(bytes), detail)`, built without intermediate
 * strings (JOBS-R1-02). Holds `bytes` while the URL string is made; a caller that can let go of
 * the bytes first uses `dataUrlBytes` + `imagePartFromDataUrl` instead.
 */
export function imagePartFromBytes(
  mimeType: 'image/jpeg' | 'image/png',
  bytes: Uint8Array,
  detail: 'low' | 'high' | 'auto' = 'high',
): InputPart {
  return imagePartFromDataUrl(dataUrlBytes(mimeType, bytes), detail);
}

/** Characters a data URL of base64 content consists of: all ASCII, none escaped by JSON. */
const DATA_URL_RE = /^data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/;

/**
 * The exact UTF-8 bytes of `JSON.stringify(buildRequestBody(request))`, built without that whole
 * string (JOBS-R1-02): the JSON around the images is small and the image data URLs (ASCII, never
 * escaped) are written straight into the result, so a multi-page request needs one copy of its
 * images instead of three (the part strings, the JSON string and its encoding for the wire).
 * Falls back to the plain encoding whenever the shortcut would not be byte-identical.
 */
export function encodeRequestBody(request: ResponsesRequest): Uint8Array {
  const encoder = new TextEncoder();
  const urls: string[] = [];
  const token = (i: number) => `__pencillift_image_${i}__`;
  const input = request.input.map((part) => {
    if (part.type !== 'input_image' || !DATA_URL_RE.test(part.image_url)) return part;
    urls.push(part.image_url);
    return { ...part, image_url: token(urls.length - 1) };
  });
  const plain = () => encoder.encode(JSON.stringify(buildRequestBody(request)));
  if (urls.length === 0) return plain();
  const skeleton = JSON.stringify(buildRequestBody({ ...request, input }));
  const segments = skeleton.split(/__pencillift_image_(\d+)__/u);
  // segments: text, index, text, index, ..., text. Every placeholder exactly once, in order;
  // otherwise (e.g. a text part that contains a placeholder) the plain encoding is used.
  if (segments.length !== 2 * urls.length + 1) return plain();
  const texts: Uint8Array[] = [];
  let total = 0;
  for (let k = 0; k < segments.length; k += 1) {
    if (k % 2 === 1) {
      if (segments[k] !== String((k - 1) / 2)) return plain();
      total += urls[(k - 1) / 2]!.length;
    } else {
      const bytes = encoder.encode(segments[k]);
      texts.push(bytes);
      total += bytes.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (let k = 0; k < segments.length; k += 1) {
    if (k % 2 === 1) {
      const url = urls[(k - 1) / 2]!;
      const { written } = encoder.encodeInto(url, out.subarray(offset, offset + url.length));
      if (written !== url.length) return plain();
      offset += url.length;
    } else {
      const bytes = texts[k / 2]!;
      out.set(bytes, offset);
      offset += bytes.length;
    }
  }
  return out;
}

export function createOpenAiResponsesClient(options: {
  apiKey: string;
  project?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}): ResponsesClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => Date.now());
  return {
    name: 'openai_responses',
    isMock: false,
    async create(request) {
      const started = clock();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            ...(options.project ? { 'openai-project': options.project } : {}),
          },
          // Always backed by a plain ArrayBuffer (TextEncoder output or `new Uint8Array(n)`); the cast
          // only narrows the type for runtimes whose DOM and Node typings disagree on BodyInit.
          body: encodeRequestBody(request) as Uint8Array<ArrayBuffer>,
          signal: controller.signal,
        });
        const latencyMs = clock() - started;
        if (!response.ok) {
          return {
            kind: 'error',
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
            latencyMs,
            timedOut: false,
          };
        }
        const body = (await response.json()) as ApiResponse;
        const usage = usageOf(body.usage);
        const modelId = body.model ?? request.model;
        if (body.status === 'incomplete') {
          return {
            kind: 'incomplete',
            usage,
            modelId,
            latencyMs,
            reason: body.incomplete_details?.reason ?? 'unknown',
          };
        }
        const text = (body.output ?? [])
          .filter((o) => o.type === 'message')
          .flatMap((o) => o.content ?? [])
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text ?? '')
          .join('');
        return { kind: 'ok', text, usage, modelId, latencyMs };
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'AbortError';
        return {
          kind: 'error',
          status: null,
          retryable: true,
          latencyMs: clock() - started,
          timedOut,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Labeled test/development double. Production readiness rejects it. */
export function createMockResponsesClient(
  handler: (request: ResponsesRequest) => ResponsesResult | Promise<ResponsesResult>,
): ResponsesClient & {
  readonly requests: ResponsesRequest[];
} {
  const requests: ResponsesRequest[] = [];
  return {
    name: 'mock_responses',
    isMock: true,
    requests,
    async create(request) {
      requests.push(request);
      return handler(request);
    },
  };
}
