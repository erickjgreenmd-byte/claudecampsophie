import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { childMeResponseSchema } from '@pencillift/contracts';
import { STORAGE_KEYS, unpairChildDevice, type SecureStorage } from '../lib/mode.ts';
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

/**
 * HUNT4-MOB-3. `once` used to decide whether to retry by "is a token cached right now", which is one
 * retry slot for the whole session rather than one per call. Two calls that both presented the same
 * stale token race: the first refusal to land drops the token and retries, the second finds nothing
 * cached and is told the device is not connected — while the refresh it needed was already in flight.
 * No explicit Promise.all is needed: the limits GET issued on the scan screen's mount, or a request
 * left running by a screen the child navigated away from, consumes the slot just as well.
 */
describe('the retry is per call, not one slot for the whole session (HUNT4-MOB-3)', () => {
  it('[repro] two calls refused at the same instant both recover, through a single refresh', async () => {
    const t = setup(0);
    await pair(t.session);
    t.advance(16); // the server-side token is dead
    t.setSkew(-30); // the device clock moved back, so the device still believes it live
    const results = await Promise.allSettled([
      t.childApi.get('/v1/child/me', childMeResponseSchema),
      t.childApi.get('/v1/child/assignments', childMeResponseSchema),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    // The single-flight refresher still collapses them: one rotation, not one per call.
    expect(t.server.refreshes).toBe(1);
    expect(await t.session.isPaired()).toBe(true);
  });

  it('three concurrent calls still make exactly one refresh', async () => {
    const t = setup(0);
    await pair(t.session);
    t.advance(16);
    t.setSkew(-30);
    const paths = ['/v1/child/me', '/v1/child/assignments', '/v1/child/rewards'];
    const results = await Promise.allSettled(
      paths.map((p) => t.childApi.get(p, childMeResponseSchema)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(t.server.refreshes).toBe(1);
  });

  it('a call made while the device is not paired at all is still refused, not retried', async () => {
    const t = setup(0);
    // Never paired: there is no refresh token, so nothing a retry could do.
    await expect(t.childApi.get('/v1/child/me', childMeResponseSchema)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(t.server.refreshes).toBe(0);
    const me = t.server.calls.filter((c) => c.path === '/v1/child/me');
    expect(me).toHaveLength(1);
  });
});

/**
 * HUNT4-MOB-2. withChildTokenRetry was applied to two of the four child clients. The child's rewards
 * screen and the child's help/report screen built `createMobileApi(tokenSource)` straight from the
 * registered source, so after a backwards device-clock jump they got 401 with nothing invalidating
 * the cached token: every tap presented the same dead token, and help.tsx turned the child's attempt
 * to report a problem into "not connected" copy while the homework screens recovered on their first
 * try. These screens import react-native, so this suite reads their source (as
 * src/homework/scan-screen.test.ts does for the scan screen).
 */
describe('every child surface gets the token retry, not only homework (HUNT4-MOB-2)', () => {
  const screen = (name: string) =>
    readFileSync(join(import.meta.dirname, '..', '..', 'app', '(child)', name), 'utf8');

  for (const name of ['help.tsx', 'rewards.tsx']) {
    it(`${name} builds its child client through withChildTokenRetry`, () => {
      const source = screen(name);
      expect(source).toMatch(
        /withChildTokenRetry\(\s*createMobileApi\(tokenSource\),\s*childSession/,
      );
      // And never the bare client, which would leave the dead token cached on every tap.
      expect(source).not.toMatch(/=>\s*\(tokenSource \? createMobileApi\(tokenSource\) : null\)/);
    });
  }
});

/**
 * HUNT5-G-3. `once` sampled the token generation BEFORE the call ran, and the bearer is resolved
 * inside the request (packages/contracts/src/client.ts). A call whose cached token had expired on
 * the device's own clock therefore refreshed for ITSELF, which bumped the generation, so its refusal
 * took the "another call already replaced the token I presented" branch: it retried with the same,
 * still-cached token and never reached `invalidateAccessToken()` — the whole point of MOB-R2-02.
 */
describe('a call that refreshed for itself still drops the token the server refused (HUNT5-G-3)', () => {
  it('[repro] the retry presents a fresh token, not the one the server just refused', async () => {
    const presented: (string | null)[] = [];
    let refreshes = 0;
    const session = createChildSession({
      storage: pairedStorage(),
      publicApi: {
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => {
          refreshes += 1;
          return Promise.resolve(freshTokens(`access-${refreshes}`, `rotated-${refreshes}`));
        },
      },
      authedApi: () => ({
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => Promise.reject(new Error('unexpected send')),
      }),
      now: () => new Date('2026-09-26T12:00:00.000Z'),
    });
    // A grown-up tapped "Disconnect this device" in the portal between the rotation and this call:
    // every access token is refused from here on, while /v1/child/refresh still answers.
    const refuse = async () => {
      presented.push(await session.accessToken());
      throw new ApiRequestError('UNAUTHENTICATED', 'Ask a grown-up to connect again', 401);
    };
    const childApi = withChildTokenRetry({ get: () => refuse(), send: () => refuse() }, session);

    await expect(childApi.get('/v1/child/me', childMeResponseSchema)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    // Two presentations, two different tokens: the refused token was dropped and the retry went
    // through the one single-flight refresher.
    expect(presented).toEqual(['access-1', 'access-2']);
    expect(refreshes).toBe(2);
  });
});

/** A storage that already holds a pairing, so refresh() has a token to present. */
function pairedStorage(): SecureStorage & { data: Map<string, string> } {
  const storage = memoryStorage();
  storage.data.set(STORAGE_KEYS.childRefreshToken, 'stored-refresh-token');
  return storage;
}

/** The shape POST /v1/child/refresh answers with, as childTokenResponseSchema parses it. */
function freshTokens(accessToken: string, refreshToken: string) {
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: '2026-09-26T12:15:00.000Z',
    accessTokenExpiresInSeconds: 900,
    child: { id: RILEY, nickname: 'Riley' },
  } as never;
}

/**
 * BUG-244 is an accepted, documented open defect again (HUNT6-A-1): the recovery that let the server
 * answer a second time for a rotation it had already committed is REMOVED, on this side as on the
 * server's. Nothing marked the row a recovery had served, so one captured request body was served
 * again and again for the whole window and EVERY serving handed back a full-lifetime rotating refresh
 * token — a self-renewing child session until the tablet's own next refresh. The window bounded when
 * a replay could START, not how long it lasted.
 *
 * These cases pin both halves: the rule (the device presents the token it holds and nothing else, and
 * any presentation of a spent token is theft) and the cost the product accepts for it (a lost answer
 * unpairs the tablet and a grown-up mints a new pairing code).
 */
describe('the child refresh presents the stored token and nothing else (HUNT6-A-1)', () => {
  /**
   * A server that rotates on every refresh and treats any presentation of a spent token as theft.
   * `loseAnswer` drops the answer AFTER the rotation is committed, which is BUG-244's whole shape.
   */
  function rotatingServer(loseAnswer: (attempt: number) => boolean) {
    const live = new Set<string>(['stored-refresh-token']);
    const bodies: unknown[] = [];
    let attempt = 0;
    const publicApi: ApiClient = {
      get: () => Promise.reject(new Error('unexpected GET')),
      send: (_method, _path, body) => {
        bodies.push(body);
        attempt += 1;
        const presented = (body as { refreshToken?: unknown }).refreshToken;
        if (typeof presented !== 'string' || !live.delete(presented)) {
          live.clear();
          return Promise.reject(
            new ApiRequestError(
              'UNAUTHENTICATED',
              'Ask a grown-up to connect this device again',
              401,
            ),
          );
        }
        live.add(`rotated-${attempt}`);
        if (loseAnswer(attempt)) {
          return Promise.reject(new ApiRequestError('NETWORK', 'offline', 0));
        }
        return Promise.resolve(freshTokens(`access-${attempt}`, `rotated-${attempt}`));
      },
    };
    return { publicApi, bodies };
  }

  function sessionOn(storage: SecureStorage, publicApi: ApiClient) {
    return createChildSession({
      storage,
      publicApi,
      authedApi: () => ({
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => Promise.reject(new Error('unexpected send')),
      }),
      now: () => new Date('2026-09-26T12:00:00.000Z'),
    });
  }

  it('sends the refresh token alone, and writes no request id to the keychain', async () => {
    const storage = pairedStorage();
    const server = rotatingServer(() => false);
    expect(await sessionOn(storage, server.publicApi).accessToken()).toBe('access-1');
    expect(server.bodies).toEqual([{ refreshToken: 'stored-refresh-token' }]);
    // The key the recovery needed is gone from the map every caller reads keys from, so no caller
    // can write one by name, and the keychain holds only the rotated token and the cached profile.
    expect(Object.keys(STORAGE_KEYS)).toEqual(['mode', 'childRefreshToken', 'childProfile']);
    expect([...storage.data.keys()].sort()).toEqual(
      [STORAGE_KEYS.childProfile, STORAGE_KEYS.childRefreshToken].sort(),
    );
  });

  it('[repro] a retry after a lost answer presents the spent token, and the tablet is unpaired', async () => {
    // The accepted cost of the reversal (BUG-244, open in docs/Bug_Ledger.md): the rotation is
    // committed before the answer that never arrived, so the token this device still holds is spent.
    // The retry is an ordinary refresh — no id, no recovery — so the server reads it as reuse and
    // revokes the session. This case exists so that cost stays visible and cannot be traded away
    // again for a mechanism that hands a captured request body a renewable child session.
    const storage = pairedStorage();
    const server = rotatingServer((attempt) => attempt === 1);
    const session = sessionOn(storage, server.publicApi);
    await expect(session.accessToken()).rejects.toMatchObject({ code: 'NETWORK' });
    // Still paired after the lost answer: the device keeps what it has and tries again.
    expect(await session.isPaired()).toBe(true);
    expect(await session.accessToken()).toBeNull();
    expect(server.bodies).toEqual([
      { refreshToken: 'stored-refresh-token' },
      { refreshToken: 'stored-refresh-token' },
    ]);
    expect(await session.isPaired()).toBe(false);
    expect(await storage.getItem(STORAGE_KEYS.mode)).toBe('signed_out');
  });

  it('unpairing leaves nothing of the child in the keychain', async () => {
    const storage = pairedStorage();
    storage.data.set(STORAGE_KEYS.childProfile, '{"id":"child","nickname":"Riley"}');
    await unpairChildDevice(storage);
    expect(storage.data.get(STORAGE_KEYS.childRefreshToken)).toBeUndefined();
    expect(storage.data.get(STORAGE_KEYS.childProfile)).toBeUndefined();
    expect(await storage.getItem(STORAGE_KEYS.mode)).toBe('signed_out');
  });

  it('the recovery machinery is gone from the modules, not merely unused', () => {
    // The fix IS the removal, so the check is that there is nothing left to switch back on: no mint,
    // no stored-record parser, no keychain mirror, no age bound. The cases above pin what the device
    // sends; this pins that it has nothing else it could send.
    const source = readFileSync(join(import.meta.dirname, 'child-session.ts'), 'utf8');
    expect(source).not.toMatch(
      /refreshRequestId|newRequestId|parseStoredRequest|REQUEST_ID_MAX_AGE|pendingRequest/,
    );
    const mode = readFileSync(join(import.meta.dirname, '..', 'lib', 'mode.ts'), 'utf8');
    expect(mode).not.toMatch(/childRefreshRequestId|refresh\.rid/);
  });
});
