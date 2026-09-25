import { ACCOUNT_CLOSE_RULES } from '@pencillift/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cryptoRandom } from '@pencillift/domain';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { loadConfig, productionReadiness } from '../src/config.ts';
import { selectAuthAdmin, type WorkerEnv } from '../src/index.ts';
import {
  accountCloseHandler,
  DEFAULT_HANDLERS,
  runJobs,
  type JobDeps,
  type JobRow,
} from '../src/jobs/dispatcher.ts';
import {
  AuthAdminRequestError,
  createRefusingAuthAdmin,
  createSupabaseAuthAdmin,
} from '../src/providers/auth-admin.ts';
import { createLocalAuthAdminDouble, type AuthAdminProvider } from '../src/providers/index.ts';
import { createTestApi, json, parentToken, TEST_ENV, type TestApi } from './helpers.ts';

/**
 * Account closure (Apple 5.1.1(v), Google Play account deletion; migration 0830): the parent's own
 * sign-in. Real local Postgres; the auth-admin provider is the labeled local double that emulates
 * Supabase's soft delete. Synthetic adults and children (Riley) only.
 */

interface ErrorBody {
  error: { code: string; message: string; rule?: string };
}

let api: TestApi;
let deps: JobDeps;
let localDouble: AuthAdminProvider;

/** Swaps the provider the app and the jobs see (the same object createApp received). */
function useAuthAdmin(provider: AuthAdminProvider | undefined): void {
  Object.assign(api.providers, { authAdmin: provider });
}

async function unlockedToken(userId: string): Promise<string> {
  const session = randomUUID();
  await grantAdultUnlock(api.db, userId, session, 3600);
  return parentToken(userId, { sessionId: session });
}

const close = (token: string, body: unknown = { confirm: true }) =>
  api.request('/v1/account/close', { method: 'POST', token, body });

async function isClosed(userId: string): Promise<boolean> {
  const [row] = await api.db.sql<{ closed: boolean }[]>`
    select app.auth_user_closed(${userId}::uuid) as closed`;
  return row!.closed;
}

async function closeJobs(userId: string): Promise<(JobRow & { status: string })[]> {
  return api.db.sql<(JobRow & { status: string })[]>`
    select id, kind, family_id, child_id, payload, attempts, max_attempts, status
      from public.jobs where kind = 'account_close' and payload->>'userId' = ${userId}
     order by created_at`;
}

async function addGuardian(fam: SeededFamily): Promise<string> {
  const guardianId = await api.db.createUser();
  await api.db.sql`
    insert into public.family_memberships (family_id, user_id, role, invited_by)
    values (${fam.familyId}, ${guardianId}, 'guardian', ${fam.ownerId})`;
  return guardianId;
}

async function requestFamilyDeletion(fam: SeededFamily, token: string): Promise<string> {
  const res = await api.request('/v1/deletion', {
    method: 'POST',
    token,
    body: { scope: 'family' },
  });
  expect(res.status).toBe(202);
  const [row] = await api.db.sql<{ deleted_at: Date | null }[]>`
    select deleted_at from public.families where id = ${fam.familyId}`;
  expect(row!.deleted_at).not.toBeNull();
  return (await json<{ deletion: { id: string } }>(res)).deletion.id;
}

beforeAll(async () => {
  api = await createTestApi();
  localDouble = createLocalAuthAdminDouble(() => api.apiDb);
  useAuthAdmin(localDouble);
  deps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
});

afterAll(async () => {
  await api?.close();
});

describe('POST /v1/account/close (APL-07 / PLAY-10)', () => {
  it('refuses an unconfirmed or padded body and a missing step-up before touching anything', async () => {
    const fam = await seedFamily(api.db);
    const locked = await parentToken(fam.ownerId, { sessionId: randomUUID() });
    expect((await api.request('/v1/account/close', { method: 'POST' })).status).toBe(401);
    const token = await unlockedToken(fam.ownerId);
    for (const body of [
      {},
      { confirm: false },
      { confirm: 'yes' },
      { confirm: true, userId: 'x' },
    ]) {
      const res = await close(token, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    const res = await close(locked);
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error.code).toBe('STEP_UP_REQUIRED');
    expect(await closeJobs(fam.ownerId)).toHaveLength(0);
    expect(await isClosed(fam.ownerId)).toBe(false);
  });

  it('a family owner must delete the family account first: 409 with the rule, nothing queued', async () => {
    const fam = await seedFamily(api.db);
    const token = await unlockedToken(fam.ownerId);
    const res = await close(token);
    expect(res.status).toBe(409);
    const body = await json<ErrorBody>(res);
    expect(body.error).toMatchObject({ code: 'CONFLICT', rule: 'FAMILY_DELETION_REQUIRED' });
    expect(await closeJobs(fam.ownerId)).toHaveLength(0);
    expect(await isClosed(fam.ownerId)).toBe(false);
    // The sign-in still works: nothing about the family changed.
    expect((await api.request('/v1/family', { token })).status).toBe(200);
    const [family] = await api.db.sql<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${fam.familyId}`;
    expect(family!.deleted_at).toBeNull();
  });

  it('owner path: pending until the family purge, then the job closes the sign-in and the token is refused', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const token = await unlockedToken(fam.ownerId);
    await requestFamilyDeletion(fam, token);

    const res = await close(token);
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ status: 'pending', signOut: true });
    const [job] = await closeJobs(fam.ownerId);
    expect(job).toMatchObject({
      kind: 'account_close',
      family_id: null,
      child_id: null,
      payload: { userId: fam.ownerId },
      status: 'queued',
    });
    // Asking twice queues nothing more and closes nothing early.
    expect((await close(token)).status).toBe(202);
    expect(await closeJobs(fam.ownerId)).toHaveLength(1);

    // Before the purge the job pauses without spending an attempt; the sign-in still works so the
    // parent can check on the deletion.
    const paused = await accountCloseHandler(deps, job!);
    expect(paused).toMatchObject({ kind: 'defer', code: 'PURGE_PENDING' });
    expect(await isClosed(fam.ownerId)).toBe(false);
    expect((await api.request('/v1/deletion', { token })).status).toBe(200);

    // The tick runs the purge first (queued earlier), then the closure.
    const report = await runJobs(deps, DEFAULT_HANDLERS);
    expect(report.succeeded).toBeGreaterThanOrEqual(2);
    expect(await isClosed(fam.ownerId)).toBe(true);
    expect((await closeJobs(fam.ownerId))[0]!.status).toBe('succeeded');
    const [membership] = await api.db.sql<{ status: string }[]>`
      select status from public.family_memberships where user_id = ${fam.ownerId}`;
    expect(membership!.status).toBe('revoked');

    // The JWT is still valid; the API refuses it because the user is closed (spec P3).
    const refused = await api.request('/v1/deletion', { token });
    expect(refused.status).toBe(401);
    expect((await json<ErrorBody>(refused)).error.code).toBe('UNAUTHENTICATED');
    expect((await close(token)).status).toBe(401);

    // Running the job again is a no-op (idempotent).
    expect(await accountCloseHandler(deps, job!)).toBeUndefined();

    // Audit rows: ids and codes only, never the address.
    const audit = await api.db.sql<
      { action: string; actor_kind: string; target_id: string; metadata: string }[]
    >`
      select action, actor_kind, target_id, metadata::text as metadata from public.audit_events
       where target_type = 'auth_user' and target_id = ${fam.ownerId} order by id`;
    // Both requests were recorded; the closure once.
    expect(audit.map((a) => [a.action, a.actor_kind])).toEqual([
      ['account.close_requested', 'parent'],
      ['account.close_requested', 'parent'],
      ['account.closed', 'system'],
    ]);
    for (const row of audit) {
      expect(row.metadata).not.toMatch(/@|example\.test/);
    }
    expect(audit[2]!.metadata).toContain('local_double');
    expect(api.logs.some((l) => l.event === 'account_closed' && l.code === 'closed')).toBe(true);
    expect(JSON.stringify(api.logs)).not.toMatch(/example\.test/);
  });

  it('guardian path: removed from the family and closed at once; the owner and the children are untouched', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const guardianId = await addGuardian(fam);
    const guardianToken = await unlockedToken(guardianId);
    const ownerToken = await unlockedToken(fam.ownerId);

    const res = await close(guardianToken);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: 'closed', signOut: true });

    expect(await isClosed(guardianId)).toBe(true);
    const [membership] = await api.db.sql<{ status: string; revoked_by: string | null }[]>`
      select status, revoked_by from public.family_memberships where user_id = ${guardianId}`;
    expect(membership).toEqual({ status: 'revoked', revoked_by: guardianId });
    const unlocks = await api.db.sql<{ revoked: boolean }[]>`
      select revoked_at is not null as revoked from private.adult_unlocks where user_id = ${guardianId}`;
    expect(unlocks.every((u) => u.revoked)).toBe(true);
    // The queued backstop job finds nothing left to do.
    const [job] = await closeJobs(guardianId);
    expect(job?.status).toBe('queued');
    await runJobs(deps, DEFAULT_HANDLERS);
    expect((await closeJobs(guardianId))[0]!.status).toBe('succeeded');

    // The guardian's still-valid JWT is refused; the owner and the child device are untouched.
    expect((await api.request('/v1/family', { token: guardianToken })).status).toBe(401);
    expect((await api.request('/v1/family', { token: ownerToken })).status).toBe(200);
    expect(await isClosed(fam.ownerId)).toBe(false);
    const [family] = await api.db.sql<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${fam.familyId}`;
    expect(family!.deleted_at).toBeNull();
    const [sessions] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.child_sessions
       where family_id = ${fam.familyId} and revoked_at is null`;
    expect(sessions!.n).toBe(1);
    const audit = await api.db.sql<{ action: string }[]>`
      select action from public.audit_events
       where family_id = ${fam.familyId} and actor_user_id = ${guardianId} order by id`;
    expect(audit.map((a) => a.action)).toEqual(['guardian.left', 'account.close_requested']);
  });

  it('guardian path when the auth service refuses: removed now, closure queued and retried by the job', async () => {
    const fam = await seedFamily(api.db);
    const guardianId = await addGuardian(fam);
    const token = await unlockedToken(guardianId);
    useAuthAdmin(createRefusingAuthAdmin());
    try {
      const res = await close(token);
      expect(res.status).toBe(202);
      expect(await json(res)).toEqual({ status: 'pending', signOut: true });
      expect(await isClosed(guardianId)).toBe(false);
      const [membership] = await api.db.sql<{ status: string }[]>`
        select status from public.family_memberships where user_id = ${guardianId}`;
      expect(membership!.status).toBe('revoked');
      expect(api.logs.some((l) => l.event === 'account_close_deferred')).toBe(true);
      // The job fails while the service refuses (retried with backoff, dead-lettered like the others).
      const failing = await runJobs(deps, DEFAULT_HANDLERS);
      expect(failing.retried).toBe(1);
      expect((await closeJobs(guardianId))[0]!.status).toBe('failed_retryable');
    } finally {
      useAuthAdmin(localDouble);
    }
    // The service is back: the retry closes the user.
    api.now.value = new Date(api.now.value.getTime() + 2 * 60_000);
    try {
      await runJobs(deps, DEFAULT_HANDLERS);
    } finally {
      api.now.value = new Date(api.now.value.getTime() - 2 * 60_000);
    }
    expect(await isClosed(guardianId)).toBe(true);
    expect((await closeJobs(guardianId))[0]!.status).toBe('succeeded');
  });

  it('a dead-lettered closure is not resurrected: a fresh request queues a versioned successor', async () => {
    const fam = await seedFamily(api.db);
    const guardianId = await addGuardian(fam);
    const token = await unlockedToken(guardianId);
    useAuthAdmin(createRefusingAuthAdmin());
    try {
      expect((await close(token)).status).toBe(202);
      const [first] = await closeJobs(guardianId);
      await api.db.sql`update public.jobs set status = 'dead_letter' where id = ${first!.id}`;
      // A second request (the parent tries again) queues a new job; the sign-in still works
      // meanwhile because nothing closed it yet. Leaving the family revoked the step-up with the
      // membership (AC_ACCESS_09), so the retry needs a fresh PIN unlock.
      expect((await close(token)).status).toBe(403);
      expect((await close(await unlockedToken(guardianId))).status).toBe(202);
      const jobs = await closeJobs(guardianId);
      expect(jobs.map((j) => j.status)).toEqual(['dead_letter', 'queued']);
      const [keys] = await api.db.sql<{ keys: string[] }[]>`
        select array_agg(idempotency_key order by created_at) as keys from public.jobs
         where kind = 'account_close' and payload->>'userId' = ${guardianId}`;
      expect(keys!.keys).toEqual([`account_close:${guardianId}`, `account_close:${guardianId}:v2`]);
    } finally {
      useAuthAdmin(localDouble);
    }
    await runJobs(deps, DEFAULT_HANDLERS);
    expect(await isClosed(guardianId)).toBe(true);
  });

  it('an adult without a family closes their sign-in at once', async () => {
    const userId = await api.db.createUser();
    const token = await unlockedToken(userId);
    const res = await close(token);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: 'closed', signOut: true });
    expect(await isClosed(userId)).toBe(true);
    expect((await api.request('/v1/family', { token })).status).toBe(401);
  });

  it('a user soft-deleted by Supabase (deleted_at) is refused while the JWT is still valid and the session row is untouched', async () => {
    // GoTrue sets deleted_at on the auth user; the access token it issued keeps verifying until it
    // expires. Nothing here ends the session (no auth.sessions delete, so the 0720 trigger records
    // nothing): deleted_at alone must make requireParent answer 401.
    const userId = await api.db.createUser();
    const session = randomUUID();
    await api.db.sql`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
      values (${session}, ${userId}, now(), now(), 'aal1', null)`;
    const token = await parentToken(userId, { sessionId: session });
    expect((await api.request('/v1/family', { token })).status).toBe(404);

    await api.db.sql`update auth.users set deleted_at = now() where id = ${userId}`;

    const refused = await api.request('/v1/family', { token });
    expect(refused.status).toBe(401);
    expect((await json<ErrorBody>(refused)).error.code).toBe('UNAUTHENTICATED');
    const [live] = await api.db.sql<{ n: number; ended: number }[]>`
      select (select count(*)::int from auth.sessions where id = ${session}) as n,
             (select count(*)::int from private.ended_auth_sessions where user_id = ${userId}) as ended`;
    expect(live).toEqual({ n: 1, ended: 0 });
    expect(await isClosed(userId)).toBe(true);
  });

  it('without a provider the route fails closed (503) and changes nothing', async () => {
    const userId = await api.db.createUser();
    const token = await unlockedToken(userId);
    useAuthAdmin(undefined);
    try {
      const res = await close(token);
      expect(res.status).toBe(503);
      expect((await json<ErrorBody>(res)).error.code).toBe('NOT_CONFIGURED');
    } finally {
      useAuthAdmin(localDouble);
    }
    expect(await isClosed(userId)).toBe(false);
    expect(await closeJobs(userId)).toHaveLength(0);
  });
});

describe('the account_close job', () => {
  async function queueFor(userId: string, maxAttempts = 5): Promise<JobRow> {
    const [row] = await api.db.sql<JobRow[]>`
      insert into public.jobs (kind, idempotency_key, payload, max_attempts, run_after)
      values ('account_close', ${'account_close:' + userId + ':test'}, ${JSON.stringify({ userId })}::text::jsonb,
              ${maxAttempts}, ${api.now.value})
      returning id, kind, family_id, child_id, payload, attempts, max_attempts`;
    return row!;
  }

  it('never closes the owner of a live family: the job fails, retries and dead-letters', async () => {
    const fam = await seedFamily(api.db);
    await queueFor(fam.ownerId, 1);
    const report = await runJobs(deps, DEFAULT_HANDLERS);
    expect(report.deadLettered).toBe(1);
    expect(await isClosed(fam.ownerId)).toBe(false);
    expect(
      api.logs.some((l) => l.event === 'account_close_blocked' && l.code === 'FAMILY_ACTIVE'),
    ).toBe(true);
  });

  it('refuses a malformed payload and a mock provider outside development/test', async () => {
    const bad: JobRow = {
      id: randomUUID(),
      kind: 'account_close',
      family_id: null,
      child_id: null,
      payload: { userId: 'not-a-uuid' },
      attempts: 1,
      max_attempts: 5,
    };
    await expect(accountCloseHandler(deps, bad)).rejects.toThrow(/without user/);

    const userId = await api.db.createUser();
    const staging = loadConfig({ ...TEST_ENV, APP_ENV: 'staging' });
    if (!staging.ok) throw new Error('config should load');
    const job = await queueFor(userId);
    await expect(accountCloseHandler({ ...deps, config: staging.config }, job)).rejects.toThrow(
      'AUTH_ADMIN_MOCK',
    );
    expect(await isClosed(userId)).toBe(false);
    // The same job with the development/test configuration closes the user.
    await expect(accountCloseHandler(deps, job)).resolves.toBeUndefined();
    expect(await isClosed(userId)).toBe(true);
  });
});

describe('configuration, selection and readiness (AC_DEPLOY_07)', () => {
  const env = (extra: Record<string, string> = {}): WorkerEnv => ({
    HYPERDRIVE: { connectionString: 'postgres://unused' },
    ...TEST_ENV,
    ...extra,
  });
  const KEYS = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value-not-real',
  };
  const config = (extra: Record<string, string> = {}) => {
    const loaded = loadConfig({ ...TEST_ENV, ...extra });
    if (!loaded.ok) throw new Error(`config should load: ${JSON.stringify(loaded.errors)}`);
    return loaded.config;
  };
  const noDb = () => {
    throw new Error('not used');
  };

  it('the local double only in development and test; the service key selects the Supabase adapter', () => {
    expect(config({ APP_ENV: 'development' }).providers.authAdmin).toBe('development_mock');
    expect(config({ APP_ENV: 'test' }).providers.authAdmin).toBe('development_mock');
    expect(config({ APP_ENV: 'staging' }).providers.authAdmin).toBe('unavailable');
    expect(config({ APP_ENV: 'production' }).providers.authAdmin).toBe('unavailable');
    expect(config({ APP_ENV: 'production', ...KEYS }).providers.authAdmin).toBe('supabase');

    const dev = selectAuthAdmin(config(), env(), noDb);
    expect(dev.ok && [dev.provider.name, dev.provider.isMock]).toEqual(['local_double', true]);
    const staging = selectAuthAdmin(
      config({ APP_ENV: 'staging' }),
      env({ APP_ENV: 'staging' }),
      noDb,
    );
    expect(staging.ok && [staging.provider.name, staging.provider.isMock]).toEqual([
      'not_configured',
      false,
    ]);
    const real = selectAuthAdmin(config({ APP_ENV: 'staging', ...KEYS }), env(KEYS), noDb);
    expect(real.ok && [real.provider.name, real.provider.isMock]).toEqual([
      'supabase_auth_admin',
      false,
    ]);
    // A double is never served outside development/test, whatever the configuration says.
    const forced = selectAuthAdmin(
      { ...config({ APP_ENV: 'staging' }), providers: { ...config().providers } },
      env({ APP_ENV: 'staging' }),
      noDb,
    );
    expect(forced).toMatchObject({ ok: false, code: 'BLOCKED_EXTERNAL' });
  });

  it('readiness reports auth_admin blocked without the service key and ready with it', () => {
    const item = (extra: Record<string, string>) =>
      productionReadiness(config(extra)).find((i) => i.check === 'auth_admin')!;
    expect(item({ APP_ENV: 'production' }).status).toBe('blocked');
    expect(item({ APP_ENV: 'test' }).status).toBe('blocked');
    expect(item({ APP_ENV: 'production', ...KEYS }).status).toBe('ready');
    expect(item({ APP_ENV: 'production' }).detail).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe('Supabase Auth Admin adapter (labeled fake fetch; untested against a live service)', () => {
  const KEY = 'service-role-test-value-not-real-1234567890';
  const USER = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';

  function fakeFetch(status: number, body: unknown = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: href, init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('refuses a URL or key it cannot use at construction (LRD-4)', () => {
    expect(() =>
      createSupabaseAuthAdmin({ supabaseUrl: 'http://example.com', serviceRoleKey: KEY }),
    ).toThrow(/https/);
    expect(() =>
      createSupabaseAuthAdmin({
        supabaseUrl: 'https://example.supabase.co',
        serviceRoleKey: 'short',
      }),
    ).toThrow(/service key/);
  });

  it('soft-deletes through DELETE /auth/v1/admin/users/{id} with the service role headers', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { id: USER });
    const admin = createSupabaseAuthAdmin({
      supabaseUrl: 'https://example.supabase.co/',
      serviceRoleKey: KEY,
      fetchImpl,
    });
    expect(admin.isMock).toBe(false);
    expect(await admin.closeUser(USER.toUpperCase())).toEqual({ outcome: 'closed' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://example.supabase.co/auth/v1/admin/users/${USER}`);
    expect(calls[0]!.init.method).toBe('DELETE');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers.apikey).toBe(KEY);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ should_soft_delete: true });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('an unknown user is already closed; any other refusal is an error the job retries', async () => {
    const gone = createSupabaseAuthAdmin({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: KEY,
      fetchImpl: fakeFetch(404, { msg: 'User not found' }).fetchImpl,
    });
    expect(await gone.closeUser(USER)).toEqual({ outcome: 'already_closed' });
    const down = createSupabaseAuthAdmin({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: KEY,
      fetchImpl: fakeFetch(500).fetchImpl,
    });
    await expect(down.closeUser(USER)).rejects.toMatchObject({
      name: 'AuthAdminRequestError',
      status: 500,
    });
    await expect(down.closeUser(USER)).rejects.toBeInstanceOf(AuthAdminRequestError);
  });

  it('never puts anything but a UUID into the path', async () => {
    const { calls, fetchImpl } = fakeFetch(200);
    const admin = createSupabaseAuthAdmin({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: KEY,
      fetchImpl,
    });
    await expect(admin.closeUser('../admin/users?x=1')).rejects.toThrow(/UUID/);
    expect(calls).toHaveLength(0);
  });
});

describe('a live second family blocks the closure (DB-R1-02 follow-up)', () => {
  for (const purgeFirst of [true, false]) {
    it(`an owner who deleted a family and started another is refused (first purge ${
      purgeFirst ? 'completed' : 'still pending'
    })`, async () => {
      const fam = await seedFamily(api.db, { childCount: 1 });
      const token = await unlockedToken(fam.ownerId);
      await requestFamilyDeletion(fam, token);
      if (purgeFirst) {
        const report = await runJobs(deps, DEFAULT_HANDLERS);
        expect(report.succeeded).toBeGreaterThanOrEqual(1);
        const [req] = await api.db.sql<{ status: string }[]>`
          select status from public.deletion_requests where family_id = ${fam.familyId}`;
        expect(req!.status).toBe('completed');
      }
      // Possible before the purge since memberships are released at request time.
      const create = await api.request('/v1/families', {
        method: 'POST',
        token,
        body: { displayName: 'Fresh start', timezone: 'America/Chicago' },
      });
      expect(create.status).toBe(201);
      const res = await close(token);
      expect(res.status).toBe(409);
      expect((await json<{ error: { rule: string } }>(res)).error.rule).toBe(
        ACCOUNT_CLOSE_RULES.familyDeletionRequired,
      );
      expect(await closeJobs(fam.ownerId)).toHaveLength(0);
      expect(await isClosed(fam.ownerId)).toBe(false);
    });
  }
});
