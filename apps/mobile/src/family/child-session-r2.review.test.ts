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
    newRequestId: () => 'aaaaaaaa-0000-4000-8000-00000000000a',
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
      newRequestId: (() => {
        let n = 0;
        return () => `66666666-0000-4000-8000-00000000006${++n}`;
      })(),
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

/**
 * What the keychain holds for an unfinished refresh: the id AND the instant this device minted it,
 * so an id older than the server's recovery window is never presented for a later refresh.
 */
function storedRequestId(raw: string | null): { id: string; mintedAtMs: number } | null {
  return raw === null ? null : (JSON.parse(raw) as { id: string; mintedAtMs: number });
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
 * BUG-244: one refresh, one id, kept across this device's own retries of that refresh.
 *
 * The server commits the rotation before its response goes out, so a lost response leaves this device
 * holding a token the server has marked used. Presenting it again with the id that consumed it is how
 * the server recognises the rightful holder finishing its attempt; a NEW id on the retry would be a
 * new refresh and would be treated as theft, which is what unpaired tablets before this.
 */
describe('a refresh keeps its request id across this device’s own retries (BUG-244)', () => {
  it('[repro] a retry after a network failure sends the SAME id, and a later refresh a new one', async () => {
    const ids: (string | undefined)[] = [];
    let attempt = 0;
    let issued = 0;
    const session = createChildSession({
      storage: pairedStorage(),
      publicApi: {
        get: () => Promise.reject(new Error('unexpected GET')),
        send: (_method, _path, body) => {
          ids.push((body as { refreshRequestId?: string }).refreshRequestId);
          attempt += 1;
          // The first attempt's response never arrives; the second and third succeed.
          if (attempt === 1) return Promise.reject(new Error('network down'));
          issued += 1;
          return Promise.resolve(freshTokens(`access-${issued}`, `rotated-${issued}`));
        },
      },
      authedApi: () => ({
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => Promise.reject(new Error('unexpected send')),
      }),
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      newRequestId: (() => {
        let n = 0;
        return () => `00000000-0000-4000-8000-00000000000${++n}`;
      })(),
    });

    await expect(session.accessToken()).rejects.toThrow('network down');
    expect(await session.accessToken()).toBe('access-1');
    // Same refresh, so the same id: the retry is the first attempt finishing, not a second refresh.
    expect(ids).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
    ]);

    // A later refresh, after this one finished, is a new refresh and takes a new id.
    session.invalidateAccessToken();
    expect(await session.accessToken()).toBe('access-2');
    expect(ids[2]).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('a refusal ends the refresh, so the next one does not reuse its id', async () => {
    // A refusal forgets the pairing, so the only road to a second refresh is a new pairing — which
    // is what the parent does next: "Use a different code" on the pair screen, then "Connect", in
    // one app process. The earlier version of this case stopped at the refusal and carried an
    // `attempt === 2` mock branch that could never be reached (HUNT5-G-2), so nothing in it observed
    // the property in its title.
    const ids: (string | undefined)[] = [];
    const storage = pairedStorage();
    let refused = true;
    const session = createChildSession({
      storage,
      publicApi: {
        get: () => Promise.reject(new Error('unexpected GET')),
        send: (_method, path, body) => {
          if (path === '/v1/child/pair') {
            return Promise.resolve(freshTokens('access-repaired', 'rotated-repaired'));
          }
          ids.push((body as { refreshRequestId?: string }).refreshRequestId);
          return refused
            ? Promise.reject(new ApiRequestError('UNAUTHENTICATED', 'no', 401))
            : Promise.resolve(freshTokens('access-after', 'rotated-after'));
        },
      },
      authedApi: () => ({
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => Promise.reject(new Error('unexpected send')),
      }),
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      newRequestId: (() => {
        let n = 0;
        return () => `00000000-0000-4000-8000-00000000001${++n}`;
      })(),
    });
    // The refusal forgets the pairing, so this device asks for nothing more until it is paired again.
    expect(await session.accessToken()).toBeNull();
    expect(await storage.getItem(STORAGE_KEYS.childRefreshToken)).toBeNull();
    expect(ids).toEqual(['00000000-0000-4000-8000-000000000011']);

    // Paired again, so the next refresh is a NEW refresh: the refused session's id is never
    // presented for the new session's token, which the server would read as theft.
    refused = false;
    expect(await pair(session)).toMatchObject({ ok: true });
    session.invalidateAccessToken();
    expect(await session.accessToken()).toBe('access-after');
    expect(ids[1]).toBe('00000000-0000-4000-8000-000000000012');
  });

  /**
   * The id has to outlive the PROCESS, not just the promise. A tablet's OS kills a backgrounded app
   * whenever it likes, and a child who closes the app while a refresh is spinning loses the response
   * exactly as a dropped connection does — so the next cold start has to finish that same refresh.
   */
  it('a process killed mid-refresh finishes that same refresh after a cold start', async () => {
    const ids: (string | undefined)[] = [];
    const storage = pairedStorage();
    let allowed = false;
    const build = (idPrefix: string) =>
      createChildSession({
        storage,
        publicApi: {
          get: () => Promise.reject(new Error('unexpected GET')),
          send: (_method, _path, body) => {
            ids.push((body as { refreshRequestId?: string }).refreshRequestId);
            return allowed
              ? Promise.resolve(freshTokens('access-cold', 'rotated-cold'))
              : Promise.reject(new Error('network down'));
          },
        },
        authedApi: () => ({
          get: () => Promise.reject(new Error('unexpected GET')),
          send: () => Promise.reject(new Error('unexpected send')),
        }),
        now: () => new Date('2026-09-26T12:00:00.000Z'),
        // A second process would mint a DIFFERENT id, which the server would read as theft.
        newRequestId: () => `${idPrefix}-0000-4000-8000-000000000021`,
      });

    const first = build('11111111');
    await expect(first.accessToken()).rejects.toThrow('network down');
    // The app dies here: `first` is gone and nothing in memory survives — only storage does.
    expect(storedRequestId(await storage.getItem(STORAGE_KEYS.childRefreshRequestId))).toEqual({
      id: '11111111-0000-4000-8000-000000000021',
      mintedAtMs: Date.parse('2026-09-26T12:00:00.000Z'),
    });

    allowed = true;
    const afterRestart = build('22222222');
    expect(await afterRestart.accessToken()).toBe('access-cold');
    expect(ids).toEqual([
      '11111111-0000-4000-8000-000000000021',
      '11111111-0000-4000-8000-000000000021',
    ]);
    // Finished, so the id is gone and the next refresh is a new attempt.
    expect(await storage.getItem(STORAGE_KEYS.childRefreshRequestId)).toBeNull();
    expect(await storage.getItem(STORAGE_KEYS.childRefreshToken)).toBe('rotated-cold');
  });

  it('a stored id that is not a uuid is replaced instead of wedging every refresh', async () => {
    const ids: (string | undefined)[] = [];
    const storage = pairedStorage();
    // Whatever wrote this — a corrupted keychain entry, an older build — the contract would refuse it
    // on every attempt, so refresh must not keep presenting it.
    storage.data.set(STORAGE_KEYS.childRefreshRequestId, 'not-a-uuid');
    const session = createChildSession({
      storage,
      publicApi: {
        get: () => Promise.reject(new Error('unexpected GET')),
        send: (_method, _path, body) => {
          ids.push((body as { refreshRequestId?: string }).refreshRequestId);
          return Promise.resolve(freshTokens('access-clean', 'rotated-clean'));
        },
      },
      authedApi: () => ({
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => Promise.reject(new Error('unexpected send')),
      }),
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      newRequestId: () => '33333333-0000-4000-8000-000000000031',
    });
    expect(await session.accessToken()).toBe('access-clean');
    expect(ids).toEqual(['33333333-0000-4000-8000-000000000031']);
  });

  /**
   * FIX-A's residual, as the lead decided it. The server serves a retry of a rotated refresh only
   * within RECOVERY_WINDOW_MS of the rotation (apps/api/src/routes/child-auth.ts), so an id the
   * keychain still holds hours later belongs to an attempt the server cannot serve any more.
   * Presenting it for a NEW refresh breaks the one rule the mechanism rests on — one id per logical
   * attempt (L-049) — and it is how a single id came to be presented on every later refresh when the
   * deleteItem in refreshFinished() failed and was swallowed. The id is stored with the instant this
   * device minted it, and an id older than the window is replaced.
   */
  const coldStart = (
    storage: SecureStorage & { data: Map<string, string> },
    clock: () => Date,
    id: string,
    answer: () => Promise<unknown>,
    ids: (string | undefined)[],
  ) =>
    createChildSession({
      storage,
      publicApi: {
        get: () => Promise.reject(new Error('unexpected GET')),
        send: (_method, _path, body) => {
          ids.push((body as { refreshRequestId?: string }).refreshRequestId);
          return answer() as Promise<never>;
        },
      },
      authedApi: () => ({
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => Promise.reject(new Error('unexpected send')),
      }),
      now: clock,
      newRequestId: () => id,
    });

  it('[repro] an id kept across a long cold start is replaced instead of presented', async () => {
    const ids: (string | undefined)[] = [];
    const storage = pairedStorage();
    let nowMs = Date.parse('2026-09-26T12:00:00.000Z');
    let offline = true;
    const answer = () =>
      offline
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(freshTokens('access-fresh', 'rotated-fresh'));

    const bedtime = coldStart(
      storage,
      () => new Date(nowMs),
      '88888888-0000-4000-8000-000000000081',
      answer,
      ids,
    );
    await expect(bedtime.accessToken()).rejects.toThrow('network down');
    // The tablet is put down and the OS kills the app; it is picked up the next morning.
    nowMs += 14 * 60 * 60 * 1000;
    offline = false;
    const morning = coldStart(
      storage,
      () => new Date(nowMs),
      '99999999-0000-4000-8000-000000000091',
      answer,
      ids,
    );
    expect(await morning.accessToken()).toBe('access-fresh');
    // Last night's id is not presented for this morning's refresh: it is a new attempt, so it mints
    // its own id, and the server can no longer serve a recovery for the old one anyway.
    expect(ids).toEqual([
      '88888888-0000-4000-8000-000000000081',
      '99999999-0000-4000-8000-000000000091',
    ]);
    expect(storedRequestId(await storage.getItem(STORAGE_KEYS.childRefreshRequestId))).toBeNull();
  });

  it('a cold start seconds later still finishes the refresh it interrupted', async () => {
    // The window must stay generous enough for what it is for: the process died mid-refresh, the
    // child re-opens the app, and this is the SAME attempt finishing — so it keeps its id even
    // though a fresh process would happily mint one.
    const ids: (string | undefined)[] = [];
    const storage = pairedStorage();
    let nowMs = Date.parse('2026-09-26T12:00:00.000Z');
    let offline = true;
    const answer = () =>
      offline
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(freshTokens('access-resumed', 'rotated-resumed'));

    const killed = coldStart(
      storage,
      () => new Date(nowMs),
      '10101010-0000-4000-8000-000000000101',
      answer,
      ids,
    );
    await expect(killed.accessToken()).rejects.toThrow('network down');
    expect(
      storedRequestId(await storage.getItem(STORAGE_KEYS.childRefreshRequestId)),
    ).toMatchObject({ id: '10101010-0000-4000-8000-000000000101', mintedAtMs: nowMs });
    nowMs += 30_000;
    offline = false;
    const reopened = coldStart(
      storage,
      () => new Date(nowMs),
      '20202020-0000-4000-8000-000000000201',
      answer,
      ids,
    );
    expect(await reopened.accessToken()).toBe('access-resumed');
    expect(ids).toEqual([
      '10101010-0000-4000-8000-000000000101',
      '10101010-0000-4000-8000-000000000101',
    ]);
  });

  /**
   * HUNT5-G-1. The pending request id is a closure variable, and only a refresh that FINISHED cleared
   * it: `forget()` (a logout, or a refresh refused as UNAUTHENTICATED) deleted the stored copy and
   * left the in-memory one, and `pair()` reset nothing. The next session's first refresh then found
   * an id already in memory, so it presented a dead session's id AND skipped the write to storage —
   * so an app the OS killed mid-refresh came back, found no stored id, minted a fresh one and
   * presented the already-rotated token under it, which the server reads as theft (it stamps
   * child_sessions.revoked_at with refresh_token_reuse). That is the harm BUG-244 closed.
   */
  it('[repro] a re-pairing after an offline refresh gets its own id, in storage first', async () => {
    const storage = pairedStorage();
    const ids: (string | undefined)[] = [];
    /** What the keychain held at the moment each refresh request went out. */
    const storedWhenSent: (string | null)[] = [];
    let offline = true;
    const session = createChildSession({
      storage,
      publicApi: {
        get: () => Promise.reject(new Error('unexpected GET')),
        send: (_method, path, body) => {
          if (path === '/v1/child/pair') {
            return Promise.resolve(freshTokens('access-paired', 'rotated-paired'));
          }
          ids.push((body as { refreshRequestId?: string }).refreshRequestId);
          storedWhenSent.push(storage.data.get(STORAGE_KEYS.childRefreshRequestId) ?? null);
          return offline
            ? Promise.reject(new Error('network down'))
            : Promise.resolve(freshTokens('access-new', 'rotated-new'));
        },
      },
      authedApi: () => ({
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => Promise.reject(new Error('unexpected send')),
      }),
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      newRequestId: (() => {
        let n = 0;
        return () => `55555555-0000-4000-8000-00000000005${++n}`;
      })(),
    });

    // A parent troubleshooting a child's tablet on a flaky connection: the refresh fails offline and
    // the logout that follows swallows that same error, then they pair with a different code.
    await session.logout();
    expect(await storage.getItem(STORAGE_KEYS.childRefreshRequestId)).toBeNull();

    offline = false;
    expect(await pair(session)).toMatchObject({ ok: true });
    session.invalidateAccessToken();
    expect(await session.accessToken()).toBe('access-new');

    expect(ids).toHaveLength(2);
    // A new session, a new refresh, a new id.
    expect(ids[1]).not.toBe(ids[0]);
    // And the id was in the keychain before the request went out, on this path too, so a process
    // killed mid-refresh finishes THIS refresh instead of minting a third id for a used token.
    expect(storedRequestId(storedWhenSent[1] ?? null)?.id).toBe(ids[1]);
  });

  /**
   * The other half of the HUNT5-G-1 decision: the write to storage is UNCONDITIONAL, not "only when
   * the id was minted". The case above mints the id it checks, and the pre-fix code wrote a minted id
   * too, so nothing in it could tell the two rules apart. This one adopts an id the device already
   * holds in memory, with nothing in the keychain to adopt it from — reachable because
   * `setItem` is allowed to fail and the failure is swallowed: expo-secure-store rejects when the
   * keychain is momentarily unavailable (a locked device, and the child session's items are
   * WHEN_UNLOCKED_THIS_DEVICE_ONLY, src/lib/secure-storage.ts). Under the conditional write the
   * refresh then ran to its end with its id in memory alone, which is the state BUG-244 exists to
   * prevent: one process death and the next cold start mints a NEW id for an already-rotated token,
   * and the server reads that as theft and revokes the child's session.
   */
  it('[repro] an id adopted from memory is in the keychain before the request goes out', async () => {
    const ids: (string | undefined)[] = [];
    /** What the keychain held at the moment each refresh request went out. */
    const storedWhenSent: (string | null)[] = [];
    const inner = pairedStorage();
    let keychainRefusesWrites = true;
    const storage: SecureStorage & { data: Map<string, string> } = {
      data: inner.data,
      getItem: (key) => inner.getItem(key),
      setItem: (key, value) =>
        keychainRefusesWrites && key === STORAGE_KEYS.childRefreshRequestId
          ? Promise.reject(new Error('keychain unavailable'))
          : inner.setItem(key, value),
      deleteItem: (key) => inner.deleteItem(key),
    };
    let offline = true;
    const session = createChildSession({
      storage,
      publicApi: {
        get: () => Promise.reject(new Error('unexpected GET')),
        send: (_method, _path, body) => {
          ids.push((body as { refreshRequestId?: string }).refreshRequestId);
          storedWhenSent.push(storage.data.get(STORAGE_KEYS.childRefreshRequestId) ?? null);
          return offline
            ? Promise.reject(new Error('network down'))
            : Promise.resolve(freshTokens('access-retried', 'rotated-retried'));
        },
      },
      authedApi: () => ({
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => Promise.reject(new Error('unexpected send')),
      }),
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      newRequestId: (() => {
        let n = 0;
        return () => `12121212-0000-4000-8000-00000000012${++n}`;
      })(),
    });

    // The refresh mints its id, the keychain refuses the write, and the request goes out anyway
    // (failing to note the id must not stop the child's session being refreshed) — and fails.
    await expect(session.accessToken()).rejects.toThrow('network down');
    expect(storedWhenSent[0]).toBeNull();

    // The keychain is readable again and the device retries: same refresh, so the id is taken from
    // memory rather than minted, and this attempt writes it before presenting it.
    keychainRefusesWrites = false;
    offline = false;
    expect(await session.accessToken()).toBe('access-retried');
    expect(ids).toEqual([
      '12121212-0000-4000-8000-000000000121',
      '12121212-0000-4000-8000-000000000121',
    ]);
    expect(storedRequestId(storedWhenSent[1] ?? null)?.id).toBe(
      '12121212-0000-4000-8000-000000000121',
    );
  });

  it('[repro] pairing a new code while a refresh is unfinished starts a new refresh', async () => {
    // The same leak without a logout in between: an offline refresh leaves its id pending while the
    // device is still paired, and the parent connects a different code. `pair()` used to reset
    // nothing, so the next refresh of the NEW session presented the OLD session's id.
    const ids: (string | undefined)[] = [];
    let offline = true;
    const session = createChildSession({
      storage: pairedStorage(),
      publicApi: {
        get: () => Promise.reject(new Error('unexpected GET')),
        send: (_method, path, body) => {
          if (path === '/v1/child/pair') {
            return Promise.resolve(freshTokens('access-paired', 'rotated-paired'));
          }
          ids.push((body as { refreshRequestId?: string }).refreshRequestId);
          return offline
            ? Promise.reject(new Error('network down'))
            : Promise.resolve(freshTokens('access-second', 'rotated-second'));
        },
      },
      authedApi: () => ({
        get: () => Promise.reject(new Error('unexpected GET')),
        send: () => Promise.reject(new Error('unexpected send')),
      }),
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      newRequestId: (() => {
        let n = 0;
        return () => `77777777-0000-4000-8000-00000000007${++n}`;
      })(),
    });

    await expect(session.accessToken()).rejects.toThrow('network down');
    offline = false;
    expect(await pair(session)).toMatchObject({ ok: true });
    session.invalidateAccessToken();
    expect(await session.accessToken()).toBe('access-second');
    expect(ids).toEqual([
      '77777777-0000-4000-8000-000000000071',
      '77777777-0000-4000-8000-000000000072',
    ]);
  });

  it('unpairing takes the unfinished refresh with it', async () => {
    const storage = pairedStorage();
    storage.data.set(STORAGE_KEYS.childRefreshRequestId, '44444444-0000-4000-8000-000000000041');
    await unpairChildDevice(storage);
    expect(await storage.getItem(STORAGE_KEYS.childRefreshRequestId)).toBeNull();
  });
});
