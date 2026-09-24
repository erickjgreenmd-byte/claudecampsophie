import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiRequestError, createApiClient } from './api.ts';

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
