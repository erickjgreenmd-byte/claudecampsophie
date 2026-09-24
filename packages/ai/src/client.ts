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
          body: JSON.stringify(buildRequestBody(request)),
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
