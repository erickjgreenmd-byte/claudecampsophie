import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedFamily } from '@pencillift/db/testing/fixtures';
import { runIdentityHousekeeping } from '../src/auth/housekeeping.ts';
import { createParentVerifier, withLiveSessionCheck } from '../src/auth/parent.ts';
import { loadConfig } from '../src/config.ts';
import { ApiError, isTransientDbError, knownConstraintError } from '../src/errors.ts';
import {
  createTestApi,
  json,
  parentToken,
  TEST_ENV,
  TEST_ISSUER,
  type TestApi,
} from './helpers.ts';

/**
 * Parent session validity beyond the JWT signature (spec P3 "logout must invalidate access";
 * review note a on RV-lead-identity-access) and key-service failure handling
 * (RV-lead-identity-access-11). Real local Postgres; the Supabase auth.sessions table comes from
 * the labeled test shim; synthetic adults only.
 */

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

async function signedInSession(userId: string, sessionId: string, notAfter: Date | null = null) {
  await api.db.sql`
    insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
    values (${sessionId}, ${userId}, now(), now(), 'aal1', ${notAfter})`;
}

const family = (token: string) => api.request('/v1/family', { token });

describe('signing out ends API access at once (spec P3 logout)', () => {
  it('a signed-out session is refused although its access token has not expired', async () => {
    const fam = await seedFamily(api.db);
    const SESSION = '5e551011-0000-4000-8000-000000000001';
    await signedInSession(fam.ownerId, SESSION);
    const token = await parentToken(fam.ownerId, { sessionId: SESSION });
    expect((await family(token)).status).toBe(200);

    // Supabase Auth deletes the session row on sign-out.
    await api.db.sql`delete from auth.sessions where id = ${SESSION}`;
    const res = await family(token);
    expect(res.status).toBe(401);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('UNAUTHENTICATED');
  });

  it('the step-up of a signed-out session is revoked, so it cannot be reused elsewhere', async () => {
    const fam = await seedFamily(api.db);
    const SESSION = '5e551011-0000-4000-8000-000000000002';
    await signedInSession(fam.ownerId, SESSION);
    await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
    await api.db.sql`delete from auth.sessions where id = ${SESSION}`;
    const [row] = await api.db.sql<{ live: number }[]>`
      select count(*)::int as live from private.adult_unlocks
       where auth_session_id = ${SESSION} and revoked_at is null`;
    expect(row!.live).toBe(0);
  });

  it('"sign out other devices" ends the other sessions and keeps this one', async () => {
    const fam = await seedFamily(api.db);
    const KEPT = '5e551011-0000-4000-8000-000000000003';
    const OTHER = '5e551011-0000-4000-8000-000000000004';
    await signedInSession(fam.ownerId, KEPT);
    await signedInSession(fam.ownerId, OTHER);
    const kept = await parentToken(fam.ownerId, { sessionId: KEPT });
    const other = await parentToken(fam.ownerId, { sessionId: OTHER });
    expect((await family(other)).status).toBe(200);
    await api.db.sql`delete from auth.sessions where user_id = ${fam.ownerId} and id <> ${KEPT}`;
    expect((await family(other)).status).toBe(401);
    expect((await family(kept)).status).toBe(200);
  });

  it('a session past its time-box (not_after) is refused', async () => {
    const fam = await seedFamily(api.db);
    const SESSION = '5e551011-0000-4000-8000-000000000005';
    await signedInSession(fam.ownerId, SESSION, new Date(Date.now() - 60_000));
    expect((await family(await parentToken(fam.ownerId, { sessionId: SESSION }))).status).toBe(401);
  });

  it('another adult’s session id cannot be borrowed', async () => {
    const fam = await seedFamily(api.db);
    const stranger = await seedFamily(api.db);
    const SESSION = '5e551011-0000-4000-8000-000000000006';
    await signedInSession(stranger.ownerId, SESSION);
    expect((await family(await parentToken(fam.ownerId, { sessionId: SESSION }))).status).toBe(401);
  });

  it('a signed-out session cannot use the homework capture routes either (they verify tokens themselves)', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const SESSION = '5e551011-0000-4000-8000-000000000007';
    await signedInSession(fam.ownerId, SESSION);
    await api.db.sql`
      insert into public.consent_records
        (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'development_mock', 'development_mock', 'child_data_processing',
              'v1', 'verified', true, now())`;
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')
      on conflict (family_id) do update set paid_slots = excluded.paid_slots`;
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id)
      values (${fam.familyId}, ${fam.children[0]!.id})`;
    const token = await parentToken(fam.ownerId, { sessionId: SESSION });
    const create = (idempotencyKey: string) =>
      api.request('/v1/assignments', {
        method: 'POST',
        token,
        body: { childId: fam.children[0]!.id, pageCount: 1, idempotencyKey },
      });
    expect((await api.request('/v1/assignments/limits', { token })).status).toBe(200);
    expect((await create('signed-in-capture-0001')).status).toBe(201);

    await api.db.sql`delete from auth.sessions where id = ${SESSION}`;
    const limits = await api.request('/v1/assignments/limits', { token });
    expect(limits.status).toBe(401);
    expect((await json<{ error: { code: string } }>(limits)).error.code).toBe('UNAUTHENTICATED');
    expect((await create('signed-out-capture-0001')).status).toBe(401);
    const [made] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.assignments where family_id = ${fam.familyId}`;
    expect(made!.n).toBe(1);
  });

  it('the raw token verifier alone would accept a signed-out token; the installed check wraps any verifier once', async () => {
    const fam = await seedFamily(api.db);
    const SESSION = '5e551011-0000-4000-8000-000000000008';
    await signedInSession(fam.ownerId, SESSION);
    const token = await parentToken(fam.ownerId, { sessionId: SESSION });
    await api.db.sql`delete from auth.sessions where id = ${SESSION}`;
    const raw = createParentVerifier(api.config);
    expect((await raw(token)).userId).toBe(fam.ownerId); // signature and claims are still valid
    const checked = withLiveSessionCheck(raw, api.apiDb);
    expect(withLiveSessionCheck(checked, api.apiDb)).toBe(checked);
    await expect(checked(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('a session id that is not a Supabase session UUID is refused', async () => {
    const fam = await seedFamily(api.db);
    expect((await family(await parentToken(fam.ownerId, { sessionId: 'not-a-uuid' }))).status).toBe(
      401,
    );
  });
});

describe('parent JWKS: cached keys, outages are retryable, bad tokens stay 401 (RV-lead-identity-access-11)', () => {
  async function keyService() {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const state = { failing: false, hits: 0 };
    const server = createServer((_req, res) => {
      state.hits += 1;
      if (state.failing) {
        res.writeHead(500).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const sign = (sub: string, kid = 'k1', key = privateKey) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        role: 'authenticated',
        session_id: '5e551011-0000-4000-8000-0000000000aa',
        aal: 'aal1',
      })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(TEST_ISSUER)
        .setAudience('authenticated')
        .setSubject(sub)
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(key);
    };
    return {
      url: `http://127.0.0.1:${port}/auth/v1/.well-known/jwks.json`,
      state,
      sign,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function verifierFor(url: string) {
    const env: Record<string, string> = { ...TEST_ENV, SUPABASE_JWKS_URL: url };
    delete env.SUPABASE_JWT_SECRET;
    const loaded = loadConfig(env);
    if (!loaded.ok) throw new Error('config should load');
    return createParentVerifier(loaded.config);
  }

  const USER = '0a0a0a0a-0000-4000-8000-000000000001';

  async function failure(p: Promise<unknown>): Promise<ApiError> {
    try {
      await p;
    } catch (error) {
      if (error instanceof ApiError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  it('verifiers built per request share one key fetch; tokens with a wrong signature or key id stay 401', async () => {
    const keys = await keyService();
    try {
      for (let i = 0; i < 3; i += 1) {
        const principal = await verifierFor(keys.url)(await keys.sign(USER));
        expect(principal.userId).toBe(USER);
      }
      expect(keys.state.hits).toBe(1);

      const { privateKey: attackerKey } = await generateKeyPair('RS256');
      const forged = await failure(verifierFor(keys.url)(await keys.sign(USER, 'k1', attackerKey)));
      expect(forged.code).toBe('UNAUTHENTICATED');
      const unknownKid = await failure(verifierFor(keys.url)(await keys.sign(USER, 'nope')));
      expect(unknownKid.code).toBe('UNAUTHENTICATED');
      const garbage = await failure(verifierFor(keys.url)('not.a.jwt'));
      expect(garbage.code).toBe('UNAUTHENTICATED');
    } finally {
      await keys.close();
    }
  });

  it('a key service that errors or cannot be reached is a retryable 503, not "sign in again"', async () => {
    const keys = await keyService();
    keys.state.failing = true;
    try {
      const down = await failure(verifierFor(keys.url)(await keys.sign(USER)));
      expect(down.code).toBe('PROVIDER_UNAVAILABLE');
      expect(down.status).toBe(503);
      expect(down.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      await keys.close();
    }
    // Connection refused (nothing listening any more).
    const unreachable = await failure(verifierFor(keys.url)(await keys.sign(USER)));
    expect(unreachable.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('identity housekeeping for the scheduled tick', () => {
  it('purges ended rate-limit windows and sign-out records past the token lifetime only', async () => {
    const now = new Date('2026-09-24T15:00:00Z');
    await api.db.sql`
      insert into private.rate_limit_buckets (bucket_key, window_start, hits, updated_at, expires_at)
      values ('hk:old', ${new Date('2026-09-24T13:00:00Z')}, 3, ${now}, ${new Date('2026-09-24T13:15:00Z')}),
             ('hk:live', ${new Date('2026-09-24T14:45:00Z')}, 3, ${now}, ${new Date('2026-09-24T15:15:00Z')})`;
    // Sign-out records are written with the database clock, so they are aged by it too.
    await api.db.sql`
      insert into private.ended_auth_sessions (session_id, user_id, ended_at)
      values ('5e551011-0000-4000-8000-0000000000b1', gen_random_uuid(), now() - interval '9 days'),
             ('5e551011-0000-4000-8000-0000000000b2', gen_random_uuid(), now() - interval '7 days')`;
    const result = await runIdentityHousekeeping(api.apiDb, now);
    expect(result.rateLimitBuckets).toBeGreaterThanOrEqual(1);
    expect(result.endedAuthSessions).toBeGreaterThanOrEqual(1);
    const buckets = await api.db.sql<{ bucket_key: string }[]>`
      select bucket_key from private.rate_limit_buckets where bucket_key like 'hk:%'`;
    expect(buckets.map((b) => b.bucket_key)).toEqual(['hk:live']);
    const ended = await api.db.sql<{ session_id: string }[]>`
      select session_id::text from private.ended_auth_sessions where session_id::text like '5e551011-%-0000000000b%'`;
    expect(ended.map((e) => e.session_id)).toEqual(['5e551011-0000-4000-8000-0000000000b2']);
  });

  it('prunes child sessions that ended over 30 days ago with their tokens, never a live one (DB-R1-07)', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const childId = fam.children[0]!.id;
    const deviceId = fam.children[0]!.deviceId;
    const session = async (endedDaysAgo: number | null): Promise<string> => {
      const [row] = await api.db.sql<{ id: string }[]>`
        insert into public.child_sessions (family_id, child_id, device_id, expires_at, revoked_at, revoke_reason)
        values (${fam.familyId}, ${childId}, ${deviceId},
                now() + interval '30 days',
                ${endedDaysAgo === null ? null : api.db.sql`now() - make_interval(days => ${endedDaysAgo})`},
                ${endedDaysAgo === null ? null : 'test'})
        returning id`;
      return row!.id;
    };
    const live = await session(null);
    const recent = await session(5);
    const old = await session(45);
    const result = await runIdentityHousekeeping(api.apiDb, new Date('2027-06-01T00:00:00Z'));
    expect(result.endedSessionRows).toBeGreaterThanOrEqual(1);
    const left = await api.db.sql<{ id: string }[]>`
      select id from public.child_sessions where id = any(${[live, recent, old]}::uuid[])`;
    // The tick clock (far ahead) does not matter: rows are aged by the database clock.
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([live, recent]));
  });

  it('a tick clock far ahead of the database never purges a fresh sign-out record', async () => {
    const fam = await seedFamily(api.db);
    const KEPT = '5e551011-0000-4000-8000-0000000000c1';
    const ENDED = '5e551011-0000-4000-8000-0000000000c2';
    await signedInSession(fam.ownerId, KEPT);
    await signedInSession(fam.ownerId, ENDED);
    const ended = await parentToken(fam.ownerId, { sessionId: ENDED });
    await api.db.sql`delete from auth.sessions where user_id = ${fam.ownerId}`; // sign out everywhere
    expect((await family(ended)).status).toBe(401);
    await runIdentityHousekeeping(api.apiDb, new Date('2027-06-01T00:00:00Z'));
    const [row] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from private.ended_auth_sessions where session_id = ${ENDED}`;
    expect(row!.n).toBe(1);
    expect((await family(ended)).status).toBe(401);
  });
});

describe('central database error mapping', () => {
  it('maps known schema invariants by constraint name and nothing else', () => {
    const oneFamily = knownConstraintError({
      code: '23505',
      constraint_name: 'family_memberships_one_active_family_per_user',
    });
    expect(oneFamily).toMatchObject({ code: 'CONFLICT', message: 'You already have a family' });
    expect(
      knownConstraintError({ code: '23514', constraint_name: 'families_timezone_iana' }),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      knownConstraintError({ code: '23514', constraint_name: 'child_pairing_codes_child_active' }),
    ).toMatchObject({ code: 'BUSINESS_RULE', rule: 'CHILD_NOT_ACTIVE' });
    expect(knownConstraintError({ code: '23505', constraint_name: 'some_other_index' })).toBe(
      undefined,
    );
    expect(
      knownConstraintError({
        code: '42501',
        constraint_name: 'family_memberships_one_active_family_per_user',
      }),
    ).toBe(undefined);
  });

  it('deadlocks, serialization failures and lock timeouts are retryable', () => {
    for (const code of ['40P01', '40001', '55P03']) expect(isTransientDbError({ code })).toBe(true);
    expect(isTransientDbError({ code: '23505' })).toBe(false);
  });

  it('two overlapping "create family" requests by one adult: one family, the other gets 409', async () => {
    const adult = await api.db.createUser();
    const token = await parentToken(adult);
    const create = (displayName: string) =>
      api.request('/v1/families', {
        method: 'POST',
        token,
        body: { displayName, timezone: 'America/Chicago' },
      });
    const results = await Promise.all([create('Riley family'), create('Riley family (again)')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(await json<{ error: { code: string; message: string } }>(conflict)).toMatchObject({
      error: { code: 'CONFLICT', message: 'You already have a family' },
    });
    const [row] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.family_memberships where user_id = ${adult} and status = 'active'`;
    expect(row!.n).toBe(1);
  });
});
