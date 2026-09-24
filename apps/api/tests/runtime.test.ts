import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@pencillift/db/testing';
import { grantAdultUnlock, seedFamily, seedOwnerAdmin } from '@pencillift/db/testing/fixtures';
import { createApp } from '../src/app.ts';
import { CONSENT_ADAPTERS, loadConfig, type ApiConfig } from '../src/config.ts';
import {
  CONSENT_ADAPTER_FACTORIES,
  buildRuntime,
  selectConsentProvider,
  type WorkerEnv,
} from '../src/index.ts';
import type { ConsentProvider } from '../src/providers/index.ts';
import { TEST_ENV, parentToken } from './helpers.ts';

/**
 * Worker runtime wiring (AC_DEPLOY_07): the consent provider the Worker serves with follows the
 * configuration explicitly. The labeled development mock exists only in development and test;
 * staging and production never get it; an unknown adapter name is a configuration error.
 * The consent tests contact no database: postgres.js connects lazily and those clients are closed
 * unused. The last block runs requests through the Worker's own client against a test database.
 */

const HYPERDRIVE = { connectionString: 'postgres://runtime-test:unused@127.0.0.1:1/unused' };
const REAL_STORAGE = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value',
};
const opened: postgres.Sql[] = [];

afterEach(async () => {
  for (const sql of opened.splice(0)) await sql.end({ timeout: 0 });
});

function env(vars: Record<string, string>): WorkerEnv {
  return { HYPERDRIVE, ...TEST_ENV, ...vars };
}

function build(vars: Record<string, string>) {
  const result = buildRuntime(env(vars));
  if (result.ok) opened.push(result.runtime.sql);
  return result;
}

function config(vars: Record<string, string>): ApiConfig {
  const loaded = loadConfig({ ...TEST_ENV, ...vars });
  if (!loaded.ok) throw new Error(`config should load: ${JSON.stringify(loaded.errors)}`);
  return loaded.config;
}

function withConsent(
  base: ApiConfig,
  consent: ApiConfig['providers']['consent'],
  consentAdapter: string | null,
): ApiConfig {
  return { ...base, providers: { ...base.providers, consent, consentAdapter } };
}

/** A synthetic stand-in for a real adapter (labeled: it never talks to a vendor). */
function fakeAdapter(isMock: boolean): ConsentProvider {
  return {
    name: 'acme-consent',
    isMock,
    start: () => Promise.resolve({ providerReference: 'acme-ref', redirectUrl: null }),
    status: () => Promise.resolve({ status: 'pending', method: 'acme', verifiedAt: null }),
  };
}

const START = {
  familyId: '00000000-0000-4000-8000-000000000001',
  adultUserId: '00000000-0000-4000-8000-000000000002',
  policyVersion: 'v1',
};

describe('buildRuntime wires consent from the configuration (AC_DEPLOY_07)', () => {
  it('development and test get the labeled development mock', () => {
    for (const APP_ENV of ['development', 'test']) {
      const built = build({ APP_ENV });
      if (!built.ok) throw new Error(`${APP_ENV} should build: ${built.code}`);
      const consent = built.runtime.deps.providers.consent;
      expect({ APP_ENV, name: consent.name, isMock: consent.isMock }).toEqual({
        APP_ENV,
        name: 'development_mock',
        isMock: true,
      });
    }
  });

  it('staging never gets the mock: nothing can be verified until a real adapter is configured', async () => {
    const built = build({ APP_ENV: 'staging' });
    if (!built.ok) throw new Error(`staging should build: ${built.code}`);
    const consent = built.runtime.deps.providers.consent;
    expect(consent.name).toBe('not_configured');
    expect(consent.isMock).toBe(false);
    await expect(consent.start(START)).rejects.toThrow(/not configured/);
    await expect(consent.status('mock-consent-anything')).rejects.toThrow(/not configured/);
  });

  it('production without a consent adapter refuses to serve', () => {
    expect(build({ APP_ENV: 'production', ...REAL_STORAGE })).toEqual({
      ok: false,
      code: 'BLOCKED_EXTERNAL',
      message: 'Service is not ready',
    });
  });

  it('an unknown adapter name is a configuration error in every environment, never the mock', () => {
    for (const APP_ENV of ['development', 'test', 'staging', 'production']) {
      expect({
        APP_ENV,
        ...build({ APP_ENV, CONSENT_PROVIDER: 'some-vendor', ...REAL_STORAGE }),
      }).toEqual({
        APP_ENV,
        ok: false,
        code: 'NOT_CONFIGURED',
        message: 'Service is not configured',
      });
    }
  });
});

describe('selectConsentProvider is explicit and fails closed (AC_DEPLOY_07)', () => {
  it('a configured adapter is wired by its name, and one without an implementation is refused', () => {
    const production = withConsent(
      config({ APP_ENV: 'production', ...REAL_STORAGE }),
      'configured',
      'acme-consent',
    );
    const adapter = fakeAdapter(false);
    expect(selectConsentProvider(production, env({}), { 'acme-consent': () => adapter })).toEqual({
      ok: true,
      provider: adapter,
    });
    // A name the configuration accepts but this Worker cannot build never falls back to the mock.
    for (const adapters of [{}, { 'other-vendor': () => fakeAdapter(false) }]) {
      expect(selectConsentProvider(production, env({}), adapters)).toEqual({
        ok: false,
        code: 'NOT_CONFIGURED',
        message: 'Service is not configured',
      });
    }
    expect(
      selectConsentProvider(withConsent(production, 'configured', null), env({}), {
        'acme-consent': () => adapter,
      }).ok,
    ).toBe(false);
  });

  it('a mock is never served outside development and test, whatever the configuration says', () => {
    for (const APP_ENV of ['staging', 'production']) {
      const base = config({ APP_ENV, ...REAL_STORAGE });
      expect(selectConsentProvider(withConsent(base, 'development_mock', null), env({}))).toEqual({
        ok: false,
        code: 'BLOCKED_EXTERNAL',
        message: 'Service is not ready',
      });
      // An adapter that turns out to be a mock is refused too.
      expect(
        selectConsentProvider(withConsent(base, 'configured', 'acme-consent'), env({}), {
          'acme-consent': () => fakeAdapter(true),
        }),
      ).toEqual({ ok: false, code: 'BLOCKED_EXTERNAL', message: 'Service is not ready' });
    }
    const dev = selectConsentProvider(config({ APP_ENV: 'development' }), env({}));
    expect(dev.ok && dev.provider.isMock).toBe(true);
  });

  it('every consent adapter the configuration accepts has an implementation wired in the Worker', () => {
    expect([...CONSENT_ADAPTERS].sort()).toEqual(Object.keys(CONSENT_ADAPTER_FACTORIES).sort());
  });
});

/**
 * BUG-063: the Worker built its client with `fetch_types: false`, so every JavaScript array
 * parameter failed with "malformed array literal" while the tests (default client options)
 * passed. Capacity changes (`keep_child_ids` uuid[]) and the admin revenue cohort (a uuid[] of
 * ad-free families, AC_MON_04/16) always answered 500 in the deployed Worker. These requests go
 * through the database client buildRuntime itself builds, not a test client.
 */
describe("the Worker's own database client serves the billing and revenue routes (BUG-063)", () => {
  const SESSION = '0c111111-2222-4333-8444-555555555555';
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  function worker() {
    const built = buildRuntime({ ...env({}), HYPERDRIVE: { connectionString: db.url } });
    if (!built.ok) throw new Error(`the test runtime should build: ${built.code}`);
    opened.push(built.runtime.sql);
    const app = createApp(built.runtime.deps);
    return async (path: string, token: string, body?: unknown) => {
      const res = await app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
    };
  }

  it('POST /v1/billing/capacity-changes records the request with its uuid[] keep list', async () => {
    const request = worker();
    const fam = await seedFamily(db, { childCount: 1 });
    await grantAdultUnlock(db, fam.ownerId, SESSION, 3600);
    const token = await parentToken(fam.ownerId, { sessionId: SESSION });
    const res = await request('/v1/billing/capacity-changes', token, {
      kind: 'upgrade',
      toSlots: 1,
    });
    expect({ status: res.status, body: res.text }).toMatchObject({ status: 201 });
    expect(res.json()).toMatchObject({ kind: 'upgrade', toSlots: 1, keepChildIds: [] });
    const rows = await db.sql<{ keep_child_ids: string[]; status: string }[]>`
      select keep_child_ids, status from public.capacity_changes where family_id = ${fam.familyId}`;
    expect(rows).toEqual([{ keep_child_ids: [], status: 'pending_purchase' }]);
  });

  it('the revenue summary and report count the ad-eligible cohort with a uuid[] of ad-free families', async () => {
    const request = worker();
    const admin = await parentToken(await seedOwnerAdmin(db), { aal: 'aal2' });
    const adFree = await seedFamily(db);
    await seedFamily(db);
    const eligible = async (path: string, pick: (body: Record<string, unknown>) => unknown) => {
      const res = await request(`/v1/admin/monetization${path}?month=2026-09`, admin);
      expect({ path, status: res.status, body: res.text }).toMatchObject({ status: 200 });
      return pick(res.json()) as number;
    };
    const summary = () => eligible('/revenue/summary', (b) => b.adEligibleAdults);
    const report = () =>
      eligible('/report', (b) => (b.revenue as { adEligibleAdults: number }).adEligibleAdults);

    // No ad-free family yet: the bound array is empty.
    const before = await summary();
    expect(await report()).toBe(before);
    const [adults] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.family_memberships
       where family_id = ${adFree.familyId} and status = 'active'`;
    expect(adults!.n).toBeGreaterThan(0);

    // The Worker's clock is the wall clock, so the purchase runs from it.
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await db.sql`
      insert into public.store_feature_mappings (channel, product_id, environment, feature, active)
      values ('app_store', 'fixture.runtime.adfree', 'sandbox', 'ad_free', true)`;
    await db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
        environment, period_start, period_end, provider_updated_at, fetched_at)
      values (${adFree.familyId}, 'app_store', 'runtime_adfree_1', 'fixture.runtime.adfree', 0, 'active',
              'sandbox', now(), ${periodEnd}, now(), now())`;

    // One ad-free family: the bound array has an element and its adults leave the cohort.
    expect(await summary()).toBe(before - adults!.n);
    expect(await report()).toBe(before - adults!.n);
  });
});
