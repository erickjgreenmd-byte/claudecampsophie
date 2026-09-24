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

export interface ApiClient {
  get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>>;
  send<S extends z.ZodType>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.infer<S>>;
}

/**
 * Fetch wrapper that validates every response against its contract schema, so a server change that
 * adds a private field fails loudly in the client instead of silently rendering it.
 */
export function createApiClient(
  baseUrl: string,
  token: TokenSource,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  async function call<S extends z.ZodType>(
    method: string,
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const bearer = await token();
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiRequestError(
        'NETWORK',
        'You appear to be offline. Check your connection and try again.',
        0,
      );
    }
    const payload: unknown = await response.json().catch(() => null);
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
  }
  return {
    get: (path, schema) => call('GET', path, undefined, schema),
    send: (method, path, body, schema) => call(method, path, body, schema),
  };
}
