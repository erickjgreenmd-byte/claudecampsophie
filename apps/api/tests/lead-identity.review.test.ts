import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { loadConfig, productionReadiness } from '../src/config.ts';
import { createTestApi, json, parentToken, TEST_ENV, type TestApi } from './helpers.ts';

/**
 * Lead adversarial review of the identity / access slice (spec P3, P4 exports, E4; AC_ACCESS_*,
 * AC_SECURITY_*). Every "RV-lead-identity-access-N" test encodes the behaviour the spec requires and
 * fails against the reviewed code for the reason stated in its comment. Real local Postgres 16;
 * synthetic adults and children only; the storage/consent providers are the labelled test mocks.
 */

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

const FIXED_NOW = new Date('2026-09-24T15:00:00Z');
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

async function parentWithPin(sessionId: string, pin = '739164'): Promise<SeededFamily> {
  const fam = await seedFamily(api.db, { childCount: 1 });
  const token = await parentToken(fam.ownerId, { sessionId });
  const set = await api.request('/v1/adult/pin', { method: 'PUT', token, body: { pin } });
  expect(set.status).toBe(200);
  return fam;
}

const unlock = (token: string, pin: string) =>
  api.request('/v1/adult/unlock', { method: 'POST', token, body: { method: 'pin', pin } });

describe('RV-lead-identity-access-1: PIN lockout survives concurrent guesses (spec P3 brute-force lockout)', () => {
  /**
   * /v1/adult/unlock reads failed_attempts, runs PBKDF2 (tens of ms), then writes
   * `failed_attempts = <value read> + 1` and `locked_until = <lock or NULL>`. Concurrent wrong
   * guesses all read the same count, so the counter only moves by one per batch, and a slower
   * request that read a lower count overwrites a lock another request just set (locked_until NULL).
   * The per-session rate limit (10 / 15 min) is then the only bound: an attacker holding the
   * parent's signed-in device gets 9 wrong guesses and still has the right PIN accepted.
   */
  it('nine wrong PINs sent at once lock the adult out; the right PIN is then refused', async () => {
    const SESSION = 'a1111111-1111-4111-8111-111111111111';
    const fam = await parentWithPin(SESSION, '739164');
    const token = await parentToken(fam.ownerId, { sessionId: SESSION });
    const wrong = [
      '000001',
      '000002',
      '000003',
      '000004',
      '000005',
      '000006',
      '000007',
      '000008',
      '000009',
    ];
    const statuses = (await Promise.all(wrong.map((pin) => unlock(token, pin)))).map(
      (r) => r.status,
    );
    // Nothing was accepted (all wrong) — sanity check of the setup.
    expect(statuses.every((s) => s === 403 || s === 423)).toBe(true);

    const [row] = await api.db.sql<{ failed_attempts: number; locked_until: Date | null }[]>`
      select failed_attempts, locked_until from private.parent_pins where user_id = ${fam.ownerId}`;
    const right = await unlock(token, '739164');
    // Nine wrong PINs are at least five failures: the account must be locked, so the right PIN
    // (the attacker's 10th guess, still inside the per-session rate limit) is refused.
    expect({
      failedAttemptsRecorded: row!.failed_attempts,
      locked: row!.locked_until !== null,
      rightPinStatus: right.status,
    }).toEqual({ failedAttemptsRecorded: 0, locked: true, rightPinStatus: 423 });
  });
});

describe('RV-lead-identity-access-2: PIN recovery cannot be exhausted by requests that never reset (spec P3 recovery)', () => {
  /**
   * POST /v1/adult/pin/reset counts against the 5-per-day budget BEFORE it checks re-authentication
   * or the PIN. Anyone holding the parent's ordinary (not re-authenticated) session — e.g. a child
   * on the family tablet — can spend the budget with 5 refused calls, and a parent who types weak
   * PINs spends it too. The real parent, freshly re-authenticated, is then refused for 24 hours
   * while locked out of the adult area.
   */
  it('five refused calls from a stale session do not block a freshly re-authenticated reset', async () => {
    const SESSION = 'a2222222-2222-4222-8222-222222222222';
    const fam = await parentWithPin(SESSION);
    const stale = await parentToken(fam.ownerId, { sessionId: SESSION });
    for (let i = 0; i < 5; i += 1) {
      const r = await api.request('/v1/adult/pin/reset', {
        method: 'POST',
        token: stale,
        body: { pin: '731846' },
      });
      expect(r.status).toBe(422); // REAUTHENTICATION_REQUIRED — nothing was reset
    }
    const fresh = await parentToken(fam.ownerId, {
      sessionId: 'a2222222-2222-4222-8222-2222222222ff',
      amr: [{ method: 'password', timestamp: seconds(api.now.value) - 30 }],
    });
    const reset = await api.request('/v1/adult/pin/reset', {
      method: 'POST',
      token: fresh,
      body: { pin: '731846' },
    });
    expect(reset.status).toBe(200);
  });

  it('weak-PIN rejections do not use up the daily reset budget', async () => {
    const fam = await parentWithPin('a2333333-3333-4333-8333-333333333333');
    const fresh = await parentToken(fam.ownerId, {
      sessionId: 'a2333333-3333-4333-8333-3333333333ff',
      amr: [{ method: 'password', timestamp: seconds(api.now.value) - 30 }],
    });
    for (const weak of ['123456', '111111', '654321', '121212', '000000']) {
      const r = await api.request('/v1/adult/pin/reset', {
        method: 'POST',
        token: fresh,
        body: { pin: weak },
      });
      expect(r.status).toBe(400);
    }
    const good = await api.request('/v1/adult/pin/reset', {
      method: 'POST',
      token: fresh,
      body: { pin: '731846' },
    });
    expect(good.status).toBe(200);
  });
});

describe('RV-lead-identity-access-3: the whole-family data export needs a recent adult step-up to download (spec P3 "exports")', () => {
  /**
   * Spec P3: "enforce recent reauthentication server-side for answers, exports, …". Creating an
   * export requires the step-up (public.request_export: "Every export contains private family
   * data"), but GET /v1/exports/:id/download checks it only for the answer key. The family_data
   * file (every child's practice prompts, attempts, study-material text, test dates, points) is
   * handed out to any holder of the parent's session — including a child on a shared device where
   * the adult area is locked — until the export expires.
   */
  it('a locked (not recently unlocked) parent session cannot fetch the family_data file', async () => {
    const SESSION = 'a3333333-3333-4333-8333-333333333333';
    const fam = await seedFamily(api.db, { childCount: 2 });
    const [row] = await api.db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, status, storage_path)
      values (${fam.familyId}, ${fam.ownerId}, 'family_data', 'ready', ${`exports/${fam.familyId}/family.json`})
      returning id`;
    const locked = await parentToken(fam.ownerId, { sessionId: SESSION });
    const res = await api.request(`/v1/exports/${row!.id}/download`, { token: locked });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('STEP_UP_REQUIRED');

    await grantAdultUnlock(api.db, fam.ownerId, SESSION, 300);
    expect((await api.request(`/v1/exports/${row!.id}/download`, { token: locked })).status).toBe(
      200,
    );
  });
});

describe('RV-lead-identity-access-4: readiness does not report ZDR evidence the child-data gate rejects (AC_DEPLOY_07)', () => {
  /**
   * productionReadiness() marks zdr_evidence "ready" whenever both env values are non-empty, but
   * the enforcing gate (packages/ai checkChildDataGate, BUG-007) refuses a switch-like reference
   * or an unparseable/future verification date. The owner-admin readiness page therefore says
   * "ready" while every child-data AI request is refused in production.
   */
  it('a placeholder reference or a future/unparseable date is reported as blocked', () => {
    for (const [reference, verifiedAt] of [
      ['true', '2026-09-01'],
      ['approved', '2026-09-01'],
      ['ZDR-TICKET-4471', 'soon'],
      ['ZDR-TICKET-4471', '2099-01-01'],
    ] as const) {
      const loaded = loadConfig({
        ...TEST_ENV,
        ZDR_APPROVAL_EVIDENCE_REFERENCE: reference,
        ZDR_APPROVAL_VERIFIED_AT: verifiedAt,
      });
      if (!loaded.ok) throw new Error('config should load');
      const zdr = productionReadiness(loaded.config).find((c) => c.check === 'zdr_evidence')!;
      expect({ reference, verifiedAt, status: zdr.status }).toEqual({
        reference,
        verifiedAt,
        status: 'blocked',
      });
    }
  });
});

describe('RV-lead-identity-access-5: the 64 KiB JSON limit holds without a Content-Length header (availability)', () => {
  /**
   * app.ts enforces MAX_JSON_BYTES only from the Content-Length header. A chunked/streamed request
   * has none, so readJson() buffers and parses an arbitrarily large body on every route, including
   * unauthenticated ones (/v1/child/pair, /v1/child/refresh), inside a 128 MB Worker isolate.
   */
  it('a streamed 1 MiB body to an unauthenticated route is refused as too large', async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ code: 'x'.repeat(1024 * 1024), deviceLabel: 'Tablet', platform: 'ios' }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < payload.length; i += 16 * 1024)
          controller.enqueue(payload.slice(i, i + 16 * 1024));
        controller.close();
      },
    });
    const res = await api.app.request('/v1/child/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.55' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
  });
});

describe('RV-lead-identity-access-6: pairing-code guessing is limited per network, not per address (spec P3 rate limits)', () => {
  /**
   * The only brute-force control on POST /v1/child/pair is `pair:<cf-connecting-ip>` (20 / 15 min).
   * One IPv6 subscriber controls a whole /64 (2^64 addresses), so rotating the source address gives
   * unlimited guesses at every family's live 40-bit codes; child_pairing_codes.failed_attempts is
   * never used and there is no global or per-prefix limit.
   */
  it('guesses from many addresses of one IPv6 /64 are rate limited together', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 25; i += 1) {
      const res = await api.request('/v1/child/pair', {
        method: 'POST',
        headers: { 'cf-connecting-ip': `2001:db8:77:1::${i.toString(16)}` },
        body: { code: 'ZZZZ-ZZZZ', deviceLabel: 'Guessing phone', platform: 'android' },
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});

describe('RV-lead-identity-access-7: archiving a child ends its unredeemed pairing codes (AC_ACCESS_08)', () => {
  /**
   * Archive revokes the child's sessions and devices but leaves unconsumed pairing codes live.
   * /v1/child/pair only checks that the child is active at redemption time, so if the child is
   * re-activated while a pre-archive code is unexpired, that old code (e.g. one the parent archived
   * the child to cut off) still pairs a new device.
   */
  it('a code issued before archive does not pair after the child is re-activated', async () => {
    const SESSION = 'a7777777-7777-4777-8777-777777777777';
    const fam = await seedFamily(api.db, { childCount: 1 });
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')`;
    await api.db.sql`
      insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
    const childId = fam.children[0]!.id;
    await api.db
      .sql`insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${childId})`;
    await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
    const token = await parentToken(fam.ownerId, { sessionId: SESSION });

    const created = await api.request(`/v1/children/${childId}/pairing-code`, {
      method: 'POST',
      token,
    });
    expect(created.status).toBe(201);
    const { code } = await json<{ code: string }>(created);

    expect(
      (await api.request(`/v1/children/${childId}/archive`, { method: 'POST', token })).status,
    ).toBe(200);
    expect(
      (await api.request(`/v1/children/${childId}/activate`, { method: 'POST', token })).status,
    ).toBe(200);

    const paired = await api.request('/v1/child/pair', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.77' },
      body: { code, deviceLabel: 'Old code phone', platform: 'android' },
    });
    expect(paired.status).toBe(404);
  });
});

describe('RV-lead-identity-access-8: step-up and child-session expiry use one clock (CI time bomb, CLAUDE.md "domain code takes now")', () => {
  /**
   * /v1/adult/unlock writes created_at/expires_at from the injected clock, but
   * app.has_recent_adult_unlock() compares expires_at with the database's now(). Likewise /pair
   * writes child_sessions.expires_at from the injected clock while app.current_child_id() uses
   * now(). The API suites pin the clock to 2026-09-24T15:00Z, so every test that unlocks through
   * the API starts failing once the wall clock passes 2026-09-24T15:05Z (and every paired-child
   * test after 2026-10-24T15:00Z). Shown here with the injected clock one hour behind the database.
   */
  it('an unlock the API just granted is honoured by the step-up check whatever the injected clock', async () => {
    const SESSION = 'a8888888-8888-4888-8888-888888888888';
    const fam = await parentWithPin(SESSION, '739164');
    const token = await parentToken(fam.ownerId, { sessionId: SESSION });
    const [db] = await api.db.sql<{ now: Date }[]>`select now() as now`;
    api.now.value = new Date(db!.now.getTime() - 3600 * 1000);
    try {
      expect((await unlock(token, '739164')).status).toBe(200);
      const add = await api.request('/v1/children', {
        method: 'POST',
        token,
        body: { nickname: 'Avery', gradeLevel: 2, ageBand: '5-7' },
      });
      expect(add.status).toBe(201);
    } finally {
      api.now.value = FIXED_NOW;
    }
  });
});

describe('RV-lead-identity-access-11: parent key discovery is cached and a key-service outage is not "sign in again" (availability)', () => {
  /**
   * The Worker entry (src/index.ts) builds deps per request, so createParentVerifier() — and with it
   * jose's createRemoteJWKSet cache — is recreated for every HTTP request: each parent call makes an
   * extra fetch of Supabase's JWKS before any work. When that fetch fails or times out, the verifier
   * maps the error to UNAUTHENTICATED ("Sign in again to continue", 401), so a Supabase Auth blip
   * tells every signed-in parent their session is invalid instead of returning a retryable error.
   */
  async function jwksServer(mode: { failing: boolean }) {
    const { createServer } = await import('node:http');
    const { exportJWK, generateKeyPair } = await import('jose');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'rv11', alg: 'RS256', use: 'sig' };
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      if (mode.failing) {
        res.writeHead(503).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/auth/v1/.well-known/jwks.json`,
      hits: () => hits,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      token: async (sub: string) => {
        const { SignJWT } = await import('jose');
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({
          role: 'authenticated',
          session_id: 'ab111111-1111-4111-8111-111111111111',
          aal: 'aal1',
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'rv11' })
          .setIssuer(TEST_ENV.SUPABASE_JWT_ISSUER!)
          .setAudience('authenticated')
          .setSubject(sub)
          .setIssuedAt(now)
          .setExpirationTime(now + 600)
          .sign(privateKey);
      },
    };
  }

  async function workerEnv(jwksUrl: string) {
    const { DEFAULT_DATABASE_URL } = await import('@pencillift/db/testing');
    const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
    url.pathname = `/${api.db.name}`;
    const env: Record<string, unknown> = {
      ...TEST_ENV,
      SUPABASE_JWKS_URL: jwksUrl,
      HYPERDRIVE: { connectionString: url.toString() },
    };
    delete env.SUPABASE_JWT_SECRET;
    return env;
  }

  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined) };

  it('three parent requests fetch the signing keys once, not once per request', async () => {
    const worker = (await import('../src/index.ts')).default;
    const keys = await jwksServer({ failing: false });
    try {
      const fam = await seedFamily(api.db, { childCount: 1 });
      const token = await keys.token(fam.ownerId);
      const env = await workerEnv(keys.url);
      for (let i = 0; i < 3; i += 1) {
        const res = await worker.fetch(
          new Request('https://api.pencillift.test/v1/family', {
            headers: { authorization: `Bearer ${token}` },
          }),
          env as never,
          ctx,
        );
        expect(res.status).toBe(200);
      }
      expect(keys.hits()).toBe(1);
    } finally {
      await keys.close();
    }
  });

  it('when the key endpoint is down, a valid parent is not told to sign in again', async () => {
    const worker = (await import('../src/index.ts')).default;
    const keys = await jwksServer({ failing: true });
    try {
      const fam = await seedFamily(api.db, { childCount: 1 });
      const res = await worker.fetch(
        new Request('https://api.pencillift.test/v1/family', {
          headers: { authorization: `Bearer ${await keys.token(fam.ownerId)}` },
        }),
        (await workerEnv(keys.url)) as never,
        ctx,
      );
      expect(res.status).not.toBe(401);
      expect([502, 503]).toContain(res.status);
    } finally {
      await keys.close();
    }
  });
});
