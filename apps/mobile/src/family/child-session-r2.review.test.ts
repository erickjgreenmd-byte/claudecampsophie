import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { childMeResponseSchema } from '@pencillift/contracts';
import { STORAGE_KEYS, type SecureStorage } from '../lib/mode.ts';
import { createChildSession, withChildTokenRetry } from './child-session.ts';

/**
 * MOB-R2-02. The child access token's lifetime is measured on the device's own clock, and a data
 * call refused as UNAUTHENTICATED with a cached token refreshes once through the single-flight
 * refresher rather than telling the child the device is not connected.
 *
 * The clock is pinned (L-027): every timestamp below comes from SERVER_NOW. "Server time" is the
 * instant the fake API stamps its responses with; the device's own clock is a separate value, so a
 * skew is exactly the difference between the two.
 */

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SERVER_NOW = new Date('2026-09-24T15:00:00Z');
const LIFETIME_SECONDS = 15 * 60;
const MINUTE = 60_000;

function memoryStorage(): SecureStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => Promise.resolve(data.get(k) ?? null),
    setItem: (k, v) => {
      data.set(k, v);
      return Promise.resolve();
    },
    deleteItem: (k) => {
      data.delete(k);
      return Promise.resolve();
    },
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A labeled mock of the API: it stamps every token with the SERVER clock (as the real API does) and
 * rejects an access token whose server-side lifetime has elapsed, so a device presenting a dead
 * token gets the same UNAUTHENTICATED the real server answers.
 */
function mockServer(serverClock: () => Date) {
  const issued = new Map<string, number>();
  const validRefresh = new Set<string>();
  let n = 0;
  const calls: Call[] = [];
  let refreshes = 0;

  function issue() {
    n += 1;
    const now = serverClock().getTime();
    issued.set(`access-${n}`, now + LIFETIME_SECONDS * 1000);
    const refreshToken = `refresh-token-number-${n}-abcdefghijkl`;
    validRefresh.add(refreshToken);
    return {
      accessToken: `access-${n}`,
      accessTokenExpiresAt: new Date(now + LIFETIME_SECONDS * 1000).toISOString(),
      accessTokenExpiresInSeconds: LIFETIME_SECONDS,
      refreshToken,
      child: { id: RILEY, nickname: 'Riley' },
    };
  }

  const publicApi: ApiClient = {
    get: () => Promise.reject(new Error('unexpected GET')),
    async send(method, path, body, schema) {
      calls.push({ method, path, body });
      await Promise.resolve();
      if (path === '/v1/child/pair') return schema.parse(issue());
      if (path === '/v1/child/refresh') {
        refreshes += 1;
        const presented = (body as { refreshToken: string }).refreshToken;
        if (!validRefresh.delete(presented)) {
          throw new ApiRequestError('UNAUTHENTICATED', 'Ask a grown-up to connect again', 401);
        }
        return schema.parse(issue());
      }
      throw new Error(`unexpected ${path}`);
    },
  };

  /** A data client that refuses any token the server considers expired. */
  function dataApi(token: () => Promise<string | null>): ApiClient {
    const run = async (path: string, schema: { parse: (v: unknown) => unknown }) => {
      const presented = await token();
      calls.push({ method: 'GET', path, body: presented });
      const expiry = presented === null ? null : issued.get(presented);
      if (expiry === null || expiry === undefined || expiry <= serverClock().getTime()) {
        throw new ApiRequestError('UNAUTHENTICATED', 'Ask a grown-up to connect again', 401);
      }
      return schema.parse({ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10' });
    };
    return {
      get: (path, schema) => run(path, schema) as never,
      send: (_m, path, _b, schema) => run(path, schema) as never,
    };
  }

  return {
    publicApi,
    dataApi,
    calls,
    get refreshes() {
      return refreshes;
    },
  };
}

function setup(skewMinutes: number) {
  // Real elapsed time since pairing, shared by both clocks; the device's is offset by the skew.
  let elapsedMs = 0;
  let skew = skewMinutes;
  const serverClock = () => new Date(SERVER_NOW.getTime() + elapsedMs);
  const deviceClock = () => new Date(SERVER_NOW.getTime() + elapsedMs + skew * MINUTE);
  const server = mockServer(serverClock);
  const storage = memoryStorage();
  const session = createChildSession({
    storage,
    publicApi: server.publicApi,
    authedApi: (token) => server.dataApi(token),
    now: deviceClock,
  });
  return {
    server,
    storage,
    session,
    childApi: withChildTokenRetry(server.dataApi(session.accessToken), session),
    advance(minutes: number) {
      elapsedMs += minutes * MINUTE;
    },
    /** A child moving the tablet's clock while the app is running. */
    setSkew(minutes: number) {
      skew = minutes;
    },
  };
}

const pair = (session: {
  pair: (i: { code: string; deviceLabel: string; platform: 'ios' }) => unknown;
}) => session.pair({ code: 'ABCDEFGH', deviceLabel: 'Kitchen tablet', platform: 'ios' });

describe('the child token lifetime is measured on the device clock (MOB-R2-02)', () => {
  it('a correct clock refreshes once per lifetime', async () => {
    const t = setup(0);
    await pair(t.session);
    expect(await t.childApi.get('/v1/child/me', childMeResponseSchema)).toMatchObject({
      nickname: 'Riley',
    });
    t.advance(16);
    expect(await t.childApi.get('/v1/child/me', childMeResponseSchema)).toMatchObject({
      nickname: 'Riley',
    });
    expect(t.server.refreshes).toBe(1);
  });

  it('[repro] a clock 20 minutes slow no longer presents a token the server has already rejected', async () => {
    const t = setup(-20);
    await pair(t.session);
    // 16 real minutes later the server-side token is a minute dead, but the device's clock still
    // reads 15:00 - 4m, well inside the server instant 15:15 that the old code compared against.
    t.advance(16);
    const before = t.server.calls.length;
    const me = await t.childApi.get('/v1/child/me', childMeResponseSchema);
    expect(me).toMatchObject({ nickname: 'Riley' });
    // The pairing is untouched: the child is never told the device is not connected.
    expect(await t.session.isPaired()).toBe(true);
    expect(t.server.refreshes).toBe(1);
    // And the dead token is never presented: the device knew it had expired, so the call is made
    // once, not once refused and once retried.
    const paths = t.server.calls.slice(before).map((c) => c.path);
    expect(paths.filter((p) => p === '/v1/child/me')).toHaveLength(1);
  });

  it('[repro] a clock 20 minutes fast does not refresh on every call', async () => {
    const t = setup(20);
    await pair(t.session);
    for (let i = 0; i < 4; i += 1) {
      expect(await t.childApi.get('/v1/child/me', childMeResponseSchema)).toMatchObject({
        nickname: 'Riley',
      });
      t.advance(1);
    }
    // One lifetime, one token: a fast clock must not rotate the refresh token per call and burn
    // the server's 60-refreshes-an-hour budget.
    expect(t.server.refreshes).toBe(0);
  });
});

describe('a refused data call refreshes once through the single-flight refresher (MOB-R2-02)', () => {
  it('drops the cached token, refreshes and retries the call once', async () => {
    // The clock moves BACKWARDS after the token was received, so no lifetime arithmetic can know
    // the token is dead: the server's refusal is the only signal.
    const t = setup(0);
    await pair(t.session);
    t.advance(16);
    t.setSkew(-30);
    const paths = t.server.calls.length;
    await t.childApi.get('/v1/child/me', childMeResponseSchema);
    const after = t.server.calls.slice(paths).map((c) => c.path);
    // Nothing refreshes twice for one call, and the retry is the same call again.
    expect(after.filter((p) => p === '/v1/child/refresh')).toHaveLength(1);
    expect(after.filter((p) => p === '/v1/child/me')).toHaveLength(2);
  });

  it('a second refusal after a fresh token is surfaced, not retried forever', async () => {
    const t = setup(0);
    await pair(t.session);
    // The stored refresh token is gone: the refresh itself is refused, so the device forgets the
    // child exactly once and the call fails with the server's answer.
    await t.storage.deleteItem(STORAGE_KEYS.childRefreshToken);
    t.advance(16);
    await expect(t.childApi.get('/v1/child/me', childMeResponseSchema)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('only the refresh being refused forgets the pairing', async () => {
    const t = setup(0);
    await pair(t.session);
    t.advance(16);
    t.setSkew(-30);
    await t.childApi.get('/v1/child/me', childMeResponseSchema);
    expect(await t.session.isPaired()).toBe(true);
    expect(await t.session.profile()).toMatchObject({ nickname: 'Riley' });
  });
});
