import { apiErrorBodySchema, type ApiErrorCode } from './errors.ts';
import type { z } from 'zod';

/** A typed API failure the UI can branch on (never shows raw server text for unknown errors). */
export class ApiRequestError extends Error {
  readonly code: ApiErrorCode | 'NETWORK';
  readonly rule: string | undefined;
  readonly status: number;

  constructor(code: ApiErrorCode | 'NETWORK', message: string, status: number, rule?: string) {
    super(message);
    this.code = code;
    this.rule = rule;
    this.status = status;
  }
}

export type TokenSource = () => Promise<string | null>;

/**
 * Per-call options. `signal` lets a screen stop a request it no longer wants (a child's "Stop
 * sending"); `timeoutMs` overrides the client's default for a call that legitimately takes longer.
 */
export interface RequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ApiClient {
  get<S extends z.ZodType>(path: string, schema: S, options?: RequestOptions): Promise<z.infer<S>>;
  send<S extends z.ZodType>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    schema: S,
    options?: RequestOptions,
  ): Promise<z.infer<S>>;
}

export interface ApiClientOptions {
  /** Default per-request timeout; a stalled connection fails as NETWORK/TIMEOUT instead of hanging. */
  readonly timeoutMs?: number | undefined;
}

/**
 * JSON calls give up after this long (MOB-R1-03). React Native on Android sets no socket timeouts,
 * so without it a half-open connection would keep a screen spinning forever.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** `rule` values a NETWORK error can carry, so screens can word a timeout differently from offline. */
export const NETWORK_RULES = { timeout: 'TIMEOUT', aborted: 'ABORTED' } as const;

/** True for a NETWORK failure caused by the request timeout: not offline, not stopped by the caller. */
export function isRequestTimeout(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.code === 'NETWORK' &&
    error.rule === NETWORK_RULES.timeout
  );
}

const OFFLINE_MESSAGE = 'You appear to be offline. Check your connection and try again.';
const TIMEOUT_MESSAGE = 'This is taking longer than usual. Check your connection and try again.';
const ABORTED_MESSAGE = 'The request was stopped.';

/**
 * One abort signal for a request: fires when the caller's signal fires or when the timeout
 * elapses. Built from AbortController + setTimeout only, so it works on Hermes, where
 * AbortSignal.timeout/any may be missing.
 */
function requestSignal(caller: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (caller?.aborted) controller.abort();
  else caller?.addEventListener('abort', onCallerAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  /** Rejects when the signal fires, for a fetch implementation that ignores its signal. */
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  aborted.catch(() => undefined);
  return {
    signal: controller.signal,
    race<T>(work: Promise<T>): Promise<T> {
      return Promise.race([work, aborted]);
    },
    failure(): ApiRequestError {
      if (caller?.aborted)
        return new ApiRequestError('NETWORK', ABORTED_MESSAGE, 0, NETWORK_RULES.aborted);
      if (timedOut)
        return new ApiRequestError('NETWORK', TIMEOUT_MESSAGE, 0, NETWORK_RULES.timeout);
      return new ApiRequestError('NETWORK', OFFLINE_MESSAGE, 0);
    },
    clear() {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Fetch wrapper that validates every response against its contract schema, so a server change that
 * adds a private field fails loudly in the client instead of silently rendering it.
 */
export function createApiClient(
  baseUrl: string,
  token: TokenSource,
  fetchImpl: typeof fetch = fetch,
  clientOptions: ApiClientOptions = {},
): ApiClient {
  const defaultTimeoutMs = clientOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function call<S extends z.ZodType>(
    method: string,
    path: string,
    body: unknown,
    schema: S,
    options: RequestOptions,
  ): Promise<z.infer<S>> {
    const abort = requestSignal(options.signal, options.timeoutMs ?? defaultTimeoutMs);
    try {
      if (abort.signal.aborted) throw abort.failure();
      const headers: Record<string, string> = { accept: 'application/json' };
      const bearer = await token();
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      let response: Response;
      let payload: unknown;
      try {
        response = await abort.race(
          fetchImpl(`${baseUrl}${path}`, {
            method,
            headers,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: abort.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        payload = await abort.race(response.json().catch(() => null));
      } catch {
        throw abort.failure();
      }
      if (!response.ok) {
        const parsed = apiErrorBodySchema.safeParse(payload);
        if (parsed.success) {
          throw new ApiRequestError(
            parsed.data.error.code,
            parsed.data.error.message,
            response.status,
            parsed.data.error.rule,
          );
        }
        throw new ApiRequestError(
          'INTERNAL',
          'Something went wrong. Please try again.',
          response.status,
        );
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success)
        throw new ApiRequestError(
          'INTERNAL',
          'Unexpected response from the server.',
          response.status,
        );
      return parsed.data;
    } finally {
      abort.clear();
    }
  }
  return {
    get: (path, schema, options = {}) => call('GET', path, undefined, schema, options),
    send: (method, path, body, schema, options = {}) => call(method, path, body, schema, options),
  };
}
