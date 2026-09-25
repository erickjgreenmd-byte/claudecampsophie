import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiRequestError, DEFAULT_REQUEST_TIMEOUT_MS, createApiClient } from './client.ts';

const schema = z.strictObject({ ok: z.boolean() });

function fakeFetch(status: number, body: unknown) {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe('api client', () => {
  it('sends the bearer token and no cookies', async () => {
    const fetchImpl = fakeFetch(200, { ok: true });
    const client = createApiClient('https://api.test', () => Promise.resolve('tok'), fetchImpl);
    await client.get('/x', schema);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(init.credentials).toBe('omit');
  });

  it('rejects responses carrying unexpected fields (e.g. a leaked private field)', async () => {
    const client = createApiClient(
      'https://api.test',
      () => Promise.resolve(null),
      fakeFetch(200, { ok: true, answerKey: '3/4' }),
    );
    await expect(client.get('/x', schema)).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('maps structured errors to codes and rules', async () => {
    const client = createApiClient(
      'https://api.test',
      () => Promise.resolve(null),
      fakeFetch(422, {
        error: {
          code: 'BUSINESS_RULE',
          rule: 'FAMILY_ALREADY_REDEEMED_CAMPAIGN',
          message: 'Already used',
          requestId: 'r1',
        },
      }),
    );
    await expect(client.get('/x', schema)).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
      rule: 'FAMILY_ALREADY_REDEEMED_CAMPAIGN',
    });
  });

  it('reports offline as NETWORK', async () => {
    const client = createApiClient(
      'https://api.test',
      () => Promise.resolve(null),
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(client.get('/x', schema)).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('api client timeouts and cancellation (MOB-R1-03)', () => {
  const stalled = () => vi.fn(() => new Promise<Response>(() => undefined));

  it('gives up on a stalled request after the timeout and reports it as NETWORK/TIMEOUT', async () => {
    const fetchImpl = stalled();
    const client = createApiClient('https://api.test', () => Promise.resolve(null), fetchImpl, {
      timeoutMs: 20,
    });
    await expect(client.get('/x', schema)).rejects.toMatchObject({
      code: 'NETWORK',
      rule: 'TIMEOUT',
    });
    // The fetch was told to stop, so the socket does not linger behind the error.
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it('a caller’s AbortSignal stops the request at once and reports NETWORK/ABORTED', async () => {
    // A fetch that honours its signal the way the platform fetch does.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const controller = new AbortController();
    const client = createApiClient(
      'https://api.test',
      () => Promise.resolve(null),
      fetchImpl as unknown as typeof fetch,
      { timeoutMs: 60_000 },
    );
    const pending = client.send('POST', '/x', { a: 1 }, schema, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'NETWORK', rule: 'ABORTED' });
  });

  it('a request whose signal is already aborted never reaches the network', async () => {
    const fetchImpl = fakeFetch(200, { ok: true });
    const client = createApiClient('https://api.test', () => Promise.resolve(null), fetchImpl);
    const controller = new AbortController();
    controller.abort();
    await expect(client.get('/x', schema, { signal: controller.signal })).rejects.toMatchObject({
      code: 'NETWORK',
      rule: 'ABORTED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('applies a default timeout so no call can hang forever, and a per-call one can lengthen it', async () => {
    const fetchImpl = stalled();
    const client = createApiClient('https://api.test', () => Promise.resolve(null), fetchImpl, {
      timeoutMs: 20,
    });
    const started = Date.now();
    await expect(client.get('/x', schema, { timeoutMs: 80 })).rejects.toMatchObject({
      rule: 'TIMEOUT',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('a completed request clears its timer (no late abort after success)', async () => {
    const fetchImpl = fakeFetch(200, { ok: true });
    const client = createApiClient('https://api.test', () => Promise.resolve(null), fetchImpl, {
      timeoutMs: 10,
    });
    await expect(client.get('/x', schema)).resolves.toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 30));
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal?.aborted).toBe(false);
  });
});
