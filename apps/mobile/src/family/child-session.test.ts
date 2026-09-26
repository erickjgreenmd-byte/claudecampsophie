import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { STORAGE_KEYS, type SecureStorage } from '../lib/mode.ts';
import { createChildSession } from './child-session.ts';

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const NOW = new Date('2026-09-24T15:00:00Z');

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

function tokenResponse(n: number, expiresInMs = 15 * 60_000) {
  return {
    accessToken: `access-${n}`,
    accessTokenExpiresAt: new Date(NOW.getTime() + expiresInMs).toISOString(),
    // The lifetime the device measures on its own clock (MOB-R2-02); the instant above is the
    // server's view of the same expiry.
    accessTokenExpiresInSeconds: expiresInMs / 1000,
    refreshToken: `refresh-token-number-${n}-abcdefghijkl`,
    child: { id: RILEY, nickname: 'Riley' },
  };
}

function fakeApi(respond: (call: Call) => unknown) {
  const calls: Call[] = [];
  // Responses pass through the real contract schema, exactly as the production client does.
  const handle = async (call: Call, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    calls.push(call);
    await Promise.resolve();
    const value = respond(call);
    if (value instanceof Error) throw value;
    return schema.parse(value) as never;
  };
  const api: ApiClient = {
    get: () => Promise.reject(new Error('unexpected GET')),
    send: (method, path, body, schema) => handle({ method, path, body }, schema),
  };
  return { api, calls };
}

function setup(respond: (call: Call) => unknown, now = () => NOW) {
  const storage = memoryStorage();
  const pub = fakeApi(respond);
  const authed: { tokens: (string | null)[]; calls: Call[] } = { tokens: [], calls: [] };
  const session = createChildSession({
    storage,
    publicApi: pub.api,
    authedApi: (token) => {
      const client = fakeApi((call) => {
        authed.calls.push(call);
        return { ok: true };
      });
      return {
        get: (path, schema) => client.api.get(path, schema),
        send: async (method, path, body, schema) => {
          authed.tokens.push(await token());
          return client.api.send(method, path, body, schema);
        },
      };
    },
    now,
  });
  return { storage, session, calls: pub.calls, authed };
}

describe('child session', () => {
  it('pairs with a normalized code and stores only the refresh token and profile', async () => {
    const { session, storage, calls } = setup(() => tokenResponse(1));
    const result = await session.pair({
      code: 'abcd-efgh',
      deviceLabel: ' Tablet ',
      platform: 'ios',
    });
    expect(result).toEqual({ ok: true, child: { id: RILEY, nickname: 'Riley' } });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/child/pair',
        body: { code: 'ABCDEFGH', deviceLabel: 'Tablet', platform: 'ios' },
      },
    ]);
    expect(storage.data.get(STORAGE_KEYS.childRefreshToken)).toBe(tokenResponse(1).refreshToken);
    expect(JSON.parse(storage.data.get(STORAGE_KEYS.childProfile)!)).toEqual({
      id: RILEY,
      nickname: 'Riley',
    });
    // The access token is kept in memory only.
    expect([...storage.data.values()].join()).not.toContain('access-1');
    expect(await session.accessToken()).toBe('access-1');
    expect(calls).toHaveLength(1);
  });

  it('does not call the server for an invalid code and explains a rejected one calmly', async () => {
    const { session, calls } = setup(
      () => new ApiRequestError('NOT_FOUND', 'That code did not work.', 404),
    );
    const invalid = await session.pair({ code: 'abc', deviceLabel: 'Tablet', platform: 'ios' });
    expect(invalid.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const rejected = await session.pair({
      code: 'ABCDEFGH',
      deviceLabel: 'Tablet',
      platform: 'ios',
    });
    expect(rejected).toEqual({
      ok: false,
      message: 'That code didn’t work. Ask a grown-up for a new one.',
    });
    expect(await session.isPaired()).toBe(false);
  });

  it('refreshes once for concurrent callers and stores the rotated token', async () => {
    let now = NOW;
    let n = 1;
    const { session, storage, calls } = setup(
      () => tokenResponse(n++),
      () => now,
    );
    await session.pair({ code: 'ABCDEFGH', deviceLabel: 'Tablet', platform: 'android' });
    now = new Date(NOW.getTime() + 20 * 60_000); // access token expired
    const [a, b, c] = await Promise.all([
      session.accessToken(),
      session.accessToken(),
      session.accessToken(),
    ]);
    expect([a, b, c]).toEqual(['access-2', 'access-2', 'access-2']);
    const refreshes = calls.filter((call) => call.path === '/v1/child/refresh');
    expect(refreshes).toEqual([
      {
        method: 'POST',
        path: '/v1/child/refresh',
        body: { refreshToken: tokenResponse(1).refreshToken },
      },
    ]);
    expect(storage.data.get(STORAGE_KEYS.childRefreshToken)).toBe(tokenResponse(2).refreshToken);
  });

  it('[BUG-012 reproduction] two independent refreshers on one device revoke the child session', async () => {
    // The server rotates refresh tokens and treats a presented token that was already rotated as
    // reuse: it revokes the whole session (spec P3; the API's child refresh behaviour).
    const valid = new Set<string>();
    let revoked = false;
    let n = 1;
    const server = (call: Call) => {
      if (call.path === '/v1/child/pair') {
        const t = tokenResponse(n++);
        valid.add(t.refreshToken);
        return t;
      }
      const presented = (call.body as { refreshToken: string }).refreshToken;
      if (revoked || !valid.delete(presented)) {
        revoked = true;
        return new ApiRequestError('UNAUTHENTICATED', 'Session ended', 401);
      }
      const t = tokenResponse(n++);
      valid.add(t.refreshToken);
      return t;
    };
    let now = NOW;
    const storage = memoryStorage();
    const make = () =>
      createChildSession({
        storage,
        publicApi: fakeApi(server).api,
        authedApi: () => fakeApi(() => ({ ok: true })).api,
        now: () => now,
      });
    // Before the fix, the homework screens ran a second session beside the app's: same stored
    // refresh token, separate in-memory state.
    const appSession = make();
    const homeworkSession = make();
    await appSession.pair({ code: 'ABCDEFGH', deviceLabel: 'Tablet', platform: 'android' });
    now = new Date(NOW.getTime() + 20 * 60_000); // both access tokens expired
    await Promise.allSettled([appSession.accessToken(), homeworkSession.accessToken()]);
    expect(revoked).toBe(true); // the second presentation of the same token ended the session
    expect(storage.data.get(STORAGE_KEYS.childRefreshToken)).toBeUndefined();
    // Hence exactly one session per device: see 'the app has exactly one child token refresher'.
  });

  it('forgets the child when the server revoked the session', async () => {
    let revoked = false;
    let now = NOW;
    const { session, storage } = setup(
      () =>
        revoked
          ? new ApiRequestError(
              'UNAUTHENTICATED',
              'Ask a grown-up to connect this device again',
              401,
            )
          : tokenResponse(1),
      () => now,
    );
    await session.pair({ code: 'ABCDEFGH', deviceLabel: 'Tablet', platform: 'ios' });
    revoked = true;
    now = new Date(NOW.getTime() + 20 * 60_000);
    expect(await session.accessToken()).toBeNull();
    expect(await session.isPaired()).toBe(false);
    expect(await session.profile()).toBeNull();
    expect(storage.data.get(STORAGE_KEYS.mode)).toBe('signed_out');
  });

  it('keeps the refresh token when offline so the device can reconnect later', async () => {
    let offline = false;
    let now = NOW;
    const { session } = setup(
      () => (offline ? new ApiRequestError('NETWORK', 'offline', 0) : tokenResponse(1)),
      () => now,
    );
    await session.pair({ code: 'ABCDEFGH', deviceLabel: 'Tablet', platform: 'ios' });
    offline = true;
    now = new Date(NOW.getTime() + 20 * 60_000);
    await expect(session.accessToken()).rejects.toMatchObject({ code: 'NETWORK' });
    expect(await session.isPaired()).toBe(true);
  });

  it('returns null without a pairing and ignores a tampered stored profile', async () => {
    const { session, storage } = setup(() => tokenResponse(1));
    expect(await session.accessToken()).toBeNull();
    storage.data.set(STORAGE_KEYS.childProfile, '{"id":"nope","nickname":"X","extra":1}');
    expect(await session.profile()).toBeNull();
  });

  it('logs out on the server with the current token and forgets the child', async () => {
    const { session, authed } = setup(() => tokenResponse(1));
    await session.pair({ code: 'ABCDEFGH', deviceLabel: 'Tablet', platform: 'ios' });
    await session.logout();
    expect(authed.tokens).toEqual(['access-1']);
    expect(authed.calls.map((c) => c.path)).toEqual(['/v1/child/logout']);
    expect(await session.isPaired()).toBe(false);
  });
});
