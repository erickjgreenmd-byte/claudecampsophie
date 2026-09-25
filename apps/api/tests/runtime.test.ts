import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockModerationClient, createMockResponsesClient } from '@pencillift/ai';
import { createTestDb, type TestDb } from '@pencillift/db/testing';
import {
  grantAdultUnlock,
  seedChild,
  seedFamily,
  seedOwnerAdmin,
} from '@pencillift/db/testing/fixtures';
import { cryptoRandom } from '@pencillift/domain';
import { generateSkillItems, seededRandom } from '@pencillift/domain/bank';
import { createApp } from '../src/app.ts';
import { createParentVerifier } from '../src/auth/parent.ts';
import {
  CONSENT_ADAPTERS,
  acceptsTestProviderConsent,
  loadConfig,
  productionReadiness,
  type ApiConfig,
} from '../src/config.ts';
import worker, {
  CONSENT_ADAPTER_FACTORIES,
  buildRuntime,
  selectBillingProviders,
  selectConsentProvider,
  selectStorageAndEmail,
  type WorkerEnv,
} from '../src/index.ts';
import { reconcileStaleEntitlements, type JobDeps } from '../src/jobs/dispatcher.ts';
import { loadChildContext, personalizeItems } from '../src/jobs/learning-jobs.ts';
import { createDbRateLimiter } from '../src/middleware/rate-limit.ts';
import type { ConsentProvider } from '../src/providers/index.ts';
import { hmacSha256, toHex } from '../src/security/crypto.ts';
import { TEST_ENV, createTestApi, parentToken, type TestApi } from './helpers.ts';

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

function withBilling(
  base: ApiConfig,
  billing: ApiConfig['providers']['billing'],
  webBilling: ApiConfig['providers']['webBilling'],
): ApiConfig {
  return { ...base, providers: { ...base.providers, billing, webBilling } };
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
 * Billing providers follow the configuration explicitly too (AC_DEPLOY_07). Before this, the Worker
 * quietly fell back to the labeled subscriber-state and Stripe mocks whenever a key was missing, in
 * every environment, and only POST /v1/billing/sync refused a mock: a staging or production webhook
 * or the stale-entitlement sweep asked the mock, got an empty list, and revoked paid plans.
 */
describe('buildRuntime wires billing from the configuration (AC_DEPLOY_07)', () => {
  it('development and test get the labeled billing mocks', () => {
    for (const APP_ENV of ['development', 'test']) {
      const built = build({ APP_ENV });
      if (!built.ok) throw new Error(`${APP_ENV} should build: ${built.code}`);
      const { subscriptions, stripe } = built.runtime.deps.providers;
      expect({
        APP_ENV,
        subscriptions: [subscriptions.name, subscriptions.isMock],
        stripe: [stripe.name, stripe.isMock],
      }).toEqual({
        APP_ENV,
        subscriptions: ['subscriber_state_mock', true],
        stripe: ['stripe_mock', true],
      });
    }
  });

  it('staging without billing keys gets no billing provider at all, never a mock', async () => {
    const built = build({ APP_ENV: 'staging' });
    if (!built.ok) throw new Error(`staging should build: ${built.code}`);
    const { subscriptions, stripe } = built.runtime.deps.providers;
    expect([subscriptions.name, subscriptions.isMock]).toEqual(['not_configured', false]);
    expect([stripe.name, stripe.isMock]).toEqual(['not_configured', false]);
    const now = new Date('2026-09-24T15:00:00Z');
    await expect(subscriptions.fetchSubscriptions('fam_runtime', now)).rejects.toThrow(
      /not configured/,
    );
    await expect(stripe.invoiceForCharge('ch_runtime', null)).rejects.toThrow(/not configured/);
    await expect(stripe.addDiscountToDraftInvoice('in_runtime', 'co_runtime')).rejects.toThrow(
      /not configured/,
    );
  });

  it('server keys select the real clients', () => {
    for (const APP_ENV of ['development', 'test', 'staging']) {
      const built = build({
        APP_ENV,
        REVENUECAT_SECRET_API_KEY: 'revenuecat-runtime-test-value',
        STRIPE_SECRET_KEY: 'stripe-runtime-test-value',
      });
      if (!built.ok) throw new Error(`${APP_ENV} should build: ${built.code}`);
      const { subscriptions, stripe } = built.runtime.deps.providers;
      expect({ APP_ENV, names: [subscriptions.name, stripe.name] }).toEqual({
        APP_ENV,
        names: ['revenuecat', 'stripe'],
      });
      expect(subscriptions.isMock || stripe.isMock).toBe(false);
    }
  });
});

describe('buildRuntime wires storage and email explicitly (AC_DEPLOY_07, L-016)', () => {
  it('development and test get the labeled storage and email mocks', () => {
    for (const APP_ENV of ['development', 'test']) {
      const built = build({ APP_ENV });
      if (!built.ok) throw new Error(`${APP_ENV} should build: ${built.code}`);
      const { storage, email } = built.runtime.deps.providers;
      expect([storage.isMock, email.isMock]).toEqual([true, true]);
    }
  });

  it('staging without storage keys or an email adapter gets providers that refuse, never mocks', async () => {
    const built = build({ APP_ENV: 'staging' });
    if (!built.ok) throw new Error(`staging should build: ${built.code}`);
    const { storage, email } = built.runtime.deps.providers;
    expect([storage.name, storage.isMock]).toEqual(['not_configured', false]);
    expect([email.name, email.isMock]).toEqual(['not_configured', false]);
    await expect(storage.createSignedUploadUrl('f/c/a/p.jpg', 60)).rejects.toThrow(
      /not configured/,
    );
    await expect(storage.exists('f/c/a/p.jpg')).rejects.toThrow(/not configured/);
    await expect(storage.stat('f/c/a/p.jpg')).rejects.toThrow(/not configured/);
    await expect(
      email.send({
        to: 'riley.parent@example.invalid',
        templateKey: 'guardian_invitation',
        params: {},
      }),
    ).rejects.toThrow(/not configured/);
  });

  it('staging with Supabase keys gets real storage; email stays unavailable without a Resend key', () => {
    const built = build({ APP_ENV: 'staging', ...REAL_STORAGE });
    if (!built.ok) throw new Error(`staging should build: ${built.code}`);
    const { storage, email } = built.runtime.deps.providers;
    expect(storage.isMock).toBe(false);
    expect(storage.name).not.toBe('not_configured');
    expect([email.name, email.isMock]).toEqual(['not_configured', false]);
  });

  it('staging with RESEND_API_KEY and EMAIL_FROM gets the Resend adapter; a refused value is NOT_CONFIGURED', () => {
    const built = build({
      APP_ENV: 'staging',
      ...REAL_STORAGE,
      RESEND_API_KEY: 're_test_key_value_not_real_1234567890',
      EMAIL_FROM: 'PencilLift <hello@pencillift.test>',
    });
    if (!built.ok) throw new Error(`staging should build: ${built.code}`);
    const { email } = built.runtime.deps.providers;
    expect([email.name, email.isMock]).toEqual(['resend', false]);
    // The sender is validated by loadConfig first (LRD-4): a bad one never reaches the adapter.
    const bad = build({
      APP_ENV: 'staging',
      ...REAL_STORAGE,
      RESEND_API_KEY: 're_test_key_value_not_real_1234567890',
      EMAIL_FROM: 'not an address',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('NOT_CONFIGURED');
  });
});

describe('selectBillingProviders is explicit and fails closed (AC_DEPLOY_07)', () => {
  it('production without keys gets the unavailable providers and readiness reports billing blocked', () => {
    const production = config({ APP_ENV: 'production', ...REAL_STORAGE });
    expect([production.providers.billing, production.providers.webBilling]).toEqual([
      'unavailable',
      'unavailable',
    ]);
    const selected = selectBillingProviders(production, env({ APP_ENV: 'production' }));
    if (!selected.ok) throw new Error(`production billing should select: ${selected.code}`);
    expect([selected.subscriptions.name, selected.subscriptions.isMock]).toEqual([
      'not_configured',
      false,
    ]);
    expect([selected.stripe.name, selected.stripe.isMock]).toEqual(['not_configured', false]);
    const billing = productionReadiness(production).find((i) => i.check === 'billing_provider');
    expect(billing?.status).toBe('blocked');
  });

  it('a mock is never served outside development and test, whatever the configuration says', () => {
    for (const APP_ENV of ['staging', 'production']) {
      const base = config({ APP_ENV, ...REAL_STORAGE });
      for (const [billing, webBilling] of [
        ['development_mock', 'unavailable'],
        ['unavailable', 'development_mock'],
      ] as const) {
        expect({
          APP_ENV,
          billing,
          webBilling,
          ...selectBillingProviders(withBilling(base, billing, webBilling), env({})),
        }).toEqual({
          APP_ENV,
          billing,
          webBilling,
          ok: false,
          code: 'BLOCKED_EXTERNAL',
          message: 'Service is not ready',
        });
      }
    }
  });

  it('a real provider the Worker has no key for is a configuration error, never the mock', () => {
    const staging = config({ APP_ENV: 'staging' });
    for (const [billing, webBilling] of [
      ['revenuecat', 'unavailable'],
      ['unavailable', 'stripe'],
    ] as const) {
      expect(selectBillingProviders(withBilling(staging, billing, webBilling), env({}))).toEqual({
        ok: false,
        code: 'NOT_CONFIGURED',
        message: 'Service is not configured',
      });
    }
  });
});

/**
 * The same defect end to end through the Worker's own runtime and database client: a staging Worker
 * that receives RevenueCat webhooks (REVENUECAT_WEBHOOK_AUTH set) but has no REVENUECAT_SECRET_API_KEY
 * used to ask the mock, which lists nothing, and revoke the family's paid plan.
 */
describe('a staging Worker without billing keys never acts on an empty mock state (AC_DEPLOY_07)', () => {
  const RC_AUTH = 'Bearer runtime-webhook-auth-test-value-0123456789';
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values ('app_store', 'pl_family_2', 'sandbox', 2)`;
  });
  afterAll(async () => {
    await db?.drop();
  });

  function stagingWorker(vars: Record<string, string> = {}) {
    const built = buildRuntime({
      ...env({ APP_ENV: 'staging', REVENUECAT_WEBHOOK_AUTH: RC_AUTH, ...vars }),
      HYPERDRIVE: { connectionString: db.url },
    });
    if (!built.ok) throw new Error(`the staging runtime should build: ${built.code}`);
    opened.push(built.runtime.sql);
    return built.runtime.deps;
  }

  /** A family with a live paid entitlement (the Worker's clock is the wall clock). */
  async function payingFamily(fetchedAt: Date) {
    const fam = await seedFamily(db);
    const [family] = await db.sql<{ billing_ref: string }[]>`
      select billing_ref from public.families where id = ${fam.familyId}`;
    const ref = family!.billing_ref;
    const day = 24 * 3600 * 1000;
    await db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots,
        status, environment, period_start, period_end, provider_updated_at, fetched_at)
      values (${fam.familyId}, 'app_store', ${`rc:${ref}:app_store:pl_family_2`}, 'pl_family_2', 2, 'active',
              'sandbox', ${new Date(Date.now() - 5 * day)}, ${new Date(Date.now() + 25 * day)},
              ${new Date(Date.now() - 5 * day)}, ${fetchedAt})`;
    const status = async () => {
      const rows = await db.sql<{ status: string }[]>`
        select status from public.family_entitlements where family_id = ${fam.familyId}`;
      return rows.map((r) => r.status);
    };
    return { fam, ref, status };
  }

  it('a RevenueCat webhook is refused for retry instead of revoking the paid plan', async () => {
    const app = createApp(stagingWorker());
    const { ref, status } = await payingFamily(new Date());
    const eventId = `runtime-${ref}`;
    const res = await app.request('/webhooks/revenuecat', {
      method: 'POST',
      headers: { authorization: RC_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        event: {
          id: eventId,
          type: 'RENEWAL',
          app_user_id: ref,
          product_id: 'pl_family_2',
          store: 'app_store',
          environment: 'SANDBOX',
          event_timestamp_ms: Date.now(),
        },
      }),
    });
    expect({ status: res.status, body: await res.text() }).toMatchObject({ status: 503 });
    expect(await status()).toEqual(['active']);
    const [event] = await db.sql<{ status: string }[]>`
      select status from public.billing_provider_events where provider = 'revenuecat' and provider_event_id = ${eventId}`;
    // Failed, so RevenueCat's retry reprocesses it once a real key is configured.
    expect(event?.status).toBe('failed');
  });

  it('a parent sync answers 503 and leaves the paid plan alone', async () => {
    const app = createApp(stagingWorker());
    const { fam, status } = await payingFamily(new Date());
    const res = await app.request('/v1/billing/sync', {
      method: 'POST',
      headers: { authorization: `Bearer ${await parentToken(fam.ownerId)}` },
    });
    expect({ status: res.status, body: await res.text() }).toMatchObject({ status: 503 });
    expect(await status()).toEqual(['active']);
  });

  it('a Stripe refund webhook is refused for retry instead of being dropped', async () => {
    // Web billing enabled and its webhook signed, but no STRIPE_SECRET_KEY: the refund cannot be
    // matched to its invoice. The mock answered "no invoice" and the event was settled and lost.
    const signing = 'runtime-stripe-signing-test-value';
    const app = createApp(
      stagingWorker({
        STRIPE_WEBHOOK_SECRET: signing,
        OPTIONAL_STRIPE_WEB_BILLING_ENABLED: 'true',
      }),
    );
    const { ref } = await payingFamily(new Date());
    const eventId = `evt_runtime_${ref}`;
    const raw = JSON.stringify({
      id: eventId,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_runtime_${ref}`,
          object: 'charge',
          invoice: null,
          amount: 3999,
          amount_refunded: 3999,
          refunded: true,
          metadata: { billing_ref: ref },
        },
      },
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = toHex(await hmacSha256(new TextEncoder().encode(signing), `${t}.${raw}`));
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${v1}`, 'content-type': 'application/json' },
      body: raw,
    });
    expect({ status: res.status, body: await res.text() }).toMatchObject({ status: 503 });
    const [event] = await db.sql<{ status: string }[]>`
      select status from public.billing_provider_events where provider = 'stripe' and provider_event_id = ${eventId}`;
    // Failed, so Stripe's retry reprocesses it once a real key is configured.
    expect(event?.status).toBe('failed');
  });

  it('the stale-entitlement sweep leaves the paid plan alone', async () => {
    const deps = stagingWorker();
    const { status } = await payingFamily(new Date(Date.now() - 2 * 24 * 3600 * 1000));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await reconcileStaleEntitlements(deps)).toBe(0);
      expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringContaining('entitlement_reconcile_failed'),
      );
    } finally {
      log.mockRestore();
    }
    expect(await status()).toEqual(['active']);
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

/**
 * LRD-4: a storage configuration the adapter refuses (SUPABASE_URL that is not an https URL, a
 * service key too short to be one) threw out of buildRuntime. The Worker's fetch then rejected
 * (an unstructured platform 500) and scheduled() threw without its log line. Configuration errors
 * fail closed with the structured NOT_CONFIGURED instead, and name the setting.
 */
describe('a malformed configuration is NOT_CONFIGURED, never an exception (LRD-4, LRD-5)', () => {
  const MALFORMED_STORAGE: [string, Record<string, string>, string][] = [
    [
      'SUPABASE_URL is not a URL',
      { SUPABASE_URL: 'not a url', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value' },
      'SUPABASE_URL',
    ],
    [
      'SUPABASE_URL is plain http to a remote host',
      {
        SUPABASE_URL: 'http://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value',
      },
      'SUPABASE_URL',
    ],
    [
      'SUPABASE_SERVICE_ROLE_KEY is too short to be a key',
      { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'short' },
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
  ];

  it('buildRuntime answers NOT_CONFIGURED and loadConfig names the setting', () => {
    for (const APP_ENV of ['staging', 'test']) {
      for (const [label, vars, name] of MALFORMED_STORAGE) {
        let outcome: unknown;
        try {
          outcome = build({ APP_ENV, ...vars });
        } catch (error) {
          outcome = `threw ${error instanceof Error ? error.message : String(error)}`;
        }
        expect({ APP_ENV, label, outcome }).toEqual({
          APP_ENV,
          label,
          outcome: { ok: false, code: 'NOT_CONFIGURED', message: 'Service is not configured' },
        });
        const loaded = loadConfig({ ...TEST_ENV, APP_ENV, ...vars });
        expect({ label, names: loaded.ok ? [] : loaded.errors.map((e) => e.name) }).toEqual({
          label,
          names: [name],
        });
      }
    }
  });

  it('local development may still use plain http to its own machine', () => {
    const built = build({
      APP_ENV: 'development',
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value',
    });
    if (!built.ok) throw new Error(`development should build: ${built.code}`);
    expect(built.runtime.deps.providers.storage.isMock).toBe(false);
  });

  it("the Worker's fetch answers a structured 503 and scheduled() logs scheduled_not_configured", async () => {
    const workerEnv = env({ APP_ENV: 'staging', ...MALFORMED_STORAGE[0]![1] });
    const ctx = { waitUntil: () => undefined };
    let res: Response | string;
    try {
      res = await worker.fetch(
        new Request('https://api.pencillift.test/v1/health'),
        workerEnv,
        ctx,
      );
    } catch (error) {
      res = `threw ${error instanceof Error ? error.message : String(error)}`;
    }
    if (typeof res === 'string') throw new Error(`fetch should answer, it ${res}`);
    expect({ status: res.status, body: (await res.json()) as unknown }).toEqual({
      status: 503,
      body: {
        error: {
          code: 'NOT_CONFIGURED',
          message: 'Service is not configured',
          requestId: 'config',
        },
      },
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await worker.scheduled({}, workerEnv, ctx);
      expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringContaining('scheduled_not_configured'),
      );
    } finally {
      log.mockRestore();
    }
  });

  /**
   * LRD-5: loadConfig defaulted a missing APP_ENV to development, so a deployed Worker whose vars
   * lost APP_ENV wired every labeled mock, including the consent mock that verifies anything.
   */
  it('the Worker refuses to build without an explicit APP_ENV', () => {
    const { APP_ENV: _omitted, ...withoutAppEnv } = TEST_ENV;
    for (const vars of [withoutAppEnv, { ...withoutAppEnv, APP_ENV: '' }]) {
      const result = buildRuntime({ HYPERDRIVE, ...vars });
      if (result.ok) opened.push(result.runtime.sql);
      expect(result).toEqual({
        ok: false,
        code: 'NOT_CONFIGURED',
        message: 'Service is not configured',
      });
      const loaded = loadConfig(vars);
      expect(loaded.ok ? [] : loaded.errors.map((e) => e.name)).toEqual(['APP_ENV']);
    }
  });

  /**
   * LRD-5 follow-up: wrangler.toml's top-level [vars] set APP_ENV = "development", so
   * `wrangler deploy` without --env shipped a development Worker with every labeled mock. APP_ENV
   * now lives only in the [env.<name>.vars] tables and, for `wrangler dev`, in the gitignored
   * apps/api/.dev.vars (committed template: .dev.vars.example), which a deploy never uploads.
   */
  it('a deploy without --env carries no APP_ENV and serves NOT_CONFIGURED', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const { tables, appEnvIn } = wranglerVars(toml);
    expect(appEnvIn).toEqual(['env.staging.vars', 'env.production.vars']);
    const { APP_ENV: _omitted, ...secrets } = TEST_ENV;
    const bare = buildRuntime({ HYPERDRIVE, ...secrets, ...tables['vars'] });
    if (bare.ok) opened.push(bare.runtime.sql);
    expect(bare).toEqual({
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'Service is not configured',
    });
    for (const name of ['staging', 'production']) {
      const loaded = loadConfig({ ...secrets, ...tables[`env.${name}.vars`] });
      expect(loaded.ok ? loaded.config.environment : loaded.errors).toBe(name);
    }
    const example = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
    expect(example).toMatch(/^APP_ENV=development$/m);
    const ignored = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8');
    expect(ignored.split('\n').map((l) => l.trim())).toContain('.dev.vars');
  });

  /*
   * LRD-4 has three fail-closed layers. Each is tested on its own, so removing one fails a test even
   * while the others still produce the 503: (1) loadConfig names the setting (above); (2)
   * selectStorageAndEmail answers NOT_CONFIGURED when the adapter refuses a value loadConfig let
   * through; (3) buildRuntime answers NOT_CONFIGURED for any other construction error and logs only
   * the error class.
   */
  it('layer 2: storage selection answers NOT_CONFIGURED when the adapter refuses a value', () => {
    const accepted = config({ APP_ENV: 'staging', ...REAL_STORAGE });
    expect(accepted.providers.storage).toBe('supabase');
    const refused = [
      { ...REAL_STORAGE, SUPABASE_URL: 'not a url' },
      { ...REAL_STORAGE, SUPABASE_SERVICE_ROLE_KEY: 'short' },
    ];
    for (const vars of refused) {
      let outcome: unknown;
      try {
        outcome = selectStorageAndEmail(accepted, { HYPERDRIVE, ...vars });
      } catch (error) {
        outcome = `threw ${error instanceof Error ? error.message : String(error)}`;
      }
      expect(outcome).toEqual({
        ok: false,
        code: 'NOT_CONFIGURED',
        message: 'Service is not configured',
      });
    }
    // The control: the values loadConfig accepted build the real adapter.
    expect(selectStorageAndEmail(accepted, { HYPERDRIVE, ...REAL_STORAGE })).toMatchObject({
      ok: true,
      storage: { isMock: false },
    });
  });

  it('layer 3: buildRuntime answers NOT_CONFIGURED for any other construction error and logs only its class', () => {
    const value = 'lrd4-configured-value-never-logged';
    const bindings: unknown[] = [
      undefined,
      {
        get connectionString(): string {
          throw new TypeError(`bad binding ${value}`);
        },
      },
    ];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (const binding of bindings) {
        log.mockClear();
        let outcome: unknown;
        try {
          outcome = buildRuntime({ ...TEST_ENV, HYPERDRIVE: binding } as unknown as WorkerEnv);
        } catch (error) {
          outcome = `threw ${error instanceof Error ? error.message : String(error)}`;
        }
        expect(outcome).toEqual({
          ok: false,
          code: 'NOT_CONFIGURED',
          message: 'Service is not configured',
        });
        expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
          JSON.stringify({ level: 'error', event: 'runtime_not_configured', error: 'TypeError' }),
        ]);
      }
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * The string vars of each wrangler.toml vars table ('vars' is the top level, 'env.<name>.vars' a
 * named environment), and every table in which a non-comment line mentions APP_ENV.
 */
function wranglerVars(toml: string): {
  tables: Record<string, Record<string, string>>;
  appEnvIn: string[];
} {
  const tables: Record<string, Record<string, string>> = {};
  const appEnvIn: string[] = [];
  let table = '<top level>';
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    if (line.includes('APP_ENV')) appEnvIn.push(table);
    const pair = /^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"$/.exec(line);
    if (pair && (table === 'vars' || /^env\.[a-z]+\.vars$/.test(table))) {
      (tables[table] ??= {})[pair[1]!] = pair[2]!;
    }
  }
  return { tables, appEnvIn };
}

/**
 * LRD-1: BUG-067 stopped a staging Worker from wiring the development consent mock, but the capture
 * gate still accepted a consent record the mock wrote (is_test_provider) everywhere except
 * production. Such a record in a staging database (written before BUG-067, by a development Worker
 * pointed at it, or by a seed) unlocked homework capture. Only development and test accept it.
 */
describe('staging never treats a development-mock consent record as verified consent (LRD-1)', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api?.close();
  });

  it('only development and test accept a test-provider consent record', () => {
    const environments = ['development', 'test', 'staging', 'production'] as const;
    expect(Object.fromEntries(environments.map((e) => [e, acceptsTestProviderConsent(e)]))).toEqual(
      { development: true, test: true, staging: false, production: false },
    );
  });

  /** The same database and providers, served by a Worker configured for `APP_ENV`. */
  function appFor(APP_ENV: string) {
    const cfg = config({ APP_ENV });
    return createApp({
      config: cfg,
      db: api.apiDb,
      clock: () => api.now.value,
      random: cryptoRandom,
      verifyParentToken: createParentVerifier(cfg),
      rateLimiter: createDbRateLimiter(api.apiDb),
      providers: api.providers,
      log: (e) => api.logs.push(e),
    });
  }

  it('create, resumed upload and finalize refuse it in staging and production', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const childId = fam.children[0]!.id;
    // Exactly the row the labeled development consent mock writes.
    await api.db.sql`
      insert into public.consent_records
        (family_id, adult_user_id, provider, provider_reference, method, purpose, policy_version, status,
         is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'development_mock', ${`mock-consent-${fam.familyId}`},
              'development_mock', 'child_data_processing', 'v1', 'verified', true, to_timestamp(0))`;
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')`;
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id)
      values (${fam.familyId}, ${childId})`;
    const token = await parentToken(fam.ownerId);
    const call = async (app: ReturnType<typeof createApp>, path: string, body: unknown) => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const rule = (JSON.parse(text) as { error?: { rule?: string } }).error?.rule ?? null;
      return { status: res.status, rule, json: () => JSON.parse(text) as Record<string, unknown> };
    };
    const createBody = () => ({ childId, pageCount: 1, idempotencyKey: randomUUID() });

    // A test Worker accepts the record (the control), and registers one page.
    const test = appFor('test');
    const created = await call(test, '/v1/assignments', createBody());
    expect({ status: created.status, rule: created.rule }).toEqual({ status: 201, rule: null });
    const id = (created.json() as { assignment: { id: string } }).assignment.id;
    const pages = [
      {
        pageNumber: 1,
        mimeType: 'image/jpeg',
        byteSize: 250_000,
        sha256: createHash('sha256').update(`lrd-1-${id}`).digest('hex'),
      },
    ];
    const uploaded = await call(test, `/v1/assignments/${id}/uploads`, { pages });
    expect(uploaded.status).toBe(200);
    const [page] = await api.db.sql<{ storage_path: string }[]>`
      select storage_path from public.source_pages where assignment_id = ${id}`;
    api.providers.storage.put(page!.storage_path, new Uint8Array(250_000));

    for (const APP_ENV of ['staging', 'production']) {
      const app = appFor(APP_ENV);
      const outcomes = {
        create: await call(app, '/v1/assignments', createBody()),
        resume: await call(app, `/v1/assignments/${id}/uploads`, { pages }),
        finalize: await call(app, `/v1/assignments/${id}/finalize`, {
          idempotencyKey: randomUUID(),
        }),
      };
      expect({
        APP_ENV,
        ...Object.fromEntries(
          Object.entries(outcomes).map(([step, o]) => [step, [o.status, o.rule]]),
        ),
      }).toEqual({
        APP_ENV,
        create: [422, 'CONSENT_REQUIRED'],
        resume: [422, 'CONSENT_REQUIRED'],
        finalize: [422, 'CONSENT_REQUIRED'],
      });
    }
    const [row] = await api.db.sql<{ status: string; jobs: number }[]>`
      select a.status, (select count(*)::int from public.jobs j where j.idempotency_key like ${`scan:${id}:%`}) as jobs
        from public.assignments a where a.id = ${id}`;
    expect(row).toEqual({ status: 'uploading', jobs: 0 });
  });

  /** Exactly the row the labeled development consent mock writes. */
  async function mockConsent(fam: { familyId: string; ownerId: string }) {
    await api.db.sql`
      insert into public.consent_records
        (family_id, adult_user_id, provider, provider_reference, method, purpose, policy_version, status,
         is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'development_mock', ${`mock-consent-${fam.familyId}`},
              'development_mock', 'child_data_processing', 'v1', 'verified', true, to_timestamp(0))`;
  }

  it('child activation refuses it in staging and production (a test Worker accepts it)', async () => {
    const fam = await seedFamily(api.db, { childCount: 0 });
    await mockConsent(fam);
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')`;
    const riley = await seedChild(api.db, fam.familyId, 'Riley', 'draft');
    const session = randomUUID();
    await grantAdultUnlock(api.db, fam.ownerId, session, 3600);
    const token = await parentToken(fam.ownerId, { sessionId: session });
    const activate = async (APP_ENV: string) => {
      const res = await appFor(APP_ENV).request(`/v1/children/${riley.id}/activate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { error?: { rule?: string } };
      const [child] = await api.db.sql<{ status: string }[]>`
        select status from public.child_profiles where id = ${riley.id}`;
      return { status: res.status, rule: body.error?.rule ?? null, child: child!.status };
    };
    expect({
      staging: await activate('staging'),
      production: await activate('production'),
    }).toEqual({
      staging: { status: 422, rule: 'CONSENT_REQUIRED', child: 'draft' },
      production: { status: 422, rule: 'CONSENT_REQUIRED', child: 'draft' },
    });
    // The control: the same record, family and slot activate the child in a test Worker.
    expect(await activate('test')).toEqual({ status: 200, rule: null, child: 'active' });
  });

  it('AI re-theming in the learning jobs makes no AI call on it in staging', async () => {
    // Staging spends only under an owner budget; this one leaves room for the control's call.
    await api.db.sql`
      insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
      values ('global', '2026-09', 1000000000, ${await seedOwnerAdmin(api.db)})`;
    const wordProblems = generateSkillItems('math.word_problems', {
      random: seededRandom('lrd-1'),
      grade: 3,
      category: 'standard',
      count: 2,
    });
    const staging: JobDeps = {
      db: api.apiDb,
      config: config({ APP_ENV: 'staging' }),
      clock: () => api.now.value,
      random: cryptoRandom,
      providers: api.providers,
      log: (e) => api.logs.push(e),
    };
    const personalize = async (fam: { familyId: string; children: { id: string }[] }) => {
      // LABELED MOCK client: it records the requests it would have sent and answers nothing useful.
      const client = createMockResponsesClient(() => ({
        kind: 'ok',
        text: JSON.stringify({ intro: null, items: [] }),
        usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 20 },
        modelId: 'gpt-6-astra',
        latencyMs: 5,
      }));
      const ctx = await api.apiDb.asService((tx) =>
        loadChildContext(tx, fam.familyId, fam.children[0]!.id),
      );
      const from = api.logs.length;
      await personalizeItems(
        staging,
        { ai: client, moderation: createMockModerationClient(), sleep: () => Promise.resolve() },
        ctx!,
        wordProblems,
        'daily_set',
        [],
      );
      const skipped = api.logs
        .slice(from)
        .filter((e) => e.event === 'practice_ai_skipped')
        .map((e) => e.code);
      return { calls: client.requests.length, skipped };
    };

    const mockOnly = await seedFamily(api.db, { childCount: 1 });
    await mockConsent(mockOnly);
    expect(await personalize(mockOnly)).toEqual({ calls: 0, skipped: ['CONSENT_REQUIRED'] });

    // The control: a record from a real provider passes the consent gate in staging.
    const real = await seedFamily(api.db, { childCount: 1 });
    await api.db.sql`
      insert into public.consent_records
        (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${real.familyId}, ${real.ownerId}, 'acme-consent', 'acme', 'child_data_processing', 'v1',
              'verified', false, now())`;
    const control = await personalize(real);
    expect(control.skipped).not.toContain('CONSENT_REQUIRED');
    expect(control.calls).toBeGreaterThan(0);
  });

  it('every consent gate in the API decides test-provider records with acceptsTestProviderConsent', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('services/consent.ts'),
    );
    const gates: Record<string, string[]> = {};
    for (const file of files) {
      const source = readFileSync(`${srcDir}${file}`, 'utf8');
      if (!source.includes('hasVerifiedConsent(')) continue;
      gates[file] = [...source.matchAll(/allowTestProvider\s*[:=]\s*([^,;\n]+)/g)].map((m) =>
        m[1]!.trim(),
      );
    }
    // The four child-data gates at the time of writing; a new one joins the check automatically.
    expect(Object.keys(gates)).toEqual(
      expect.arrayContaining([
        'routes/family.ts',
        'routes/homework.ts',
        'jobs/scan-process.ts',
        'jobs/learning-jobs.ts',
      ]),
    );
    const offending = Object.fromEntries(
      Object.entries(gates).map(([file, values]) => [
        file,
        values.length === 0
          ? ['<no allowTestProvider>']
          : values.filter((v) => !v.startsWith('acceptsTestProviderConsent(')),
      ]),
    );
    expect(offending).toEqual(Object.fromEntries(Object.keys(gates).map((f) => [f, []])));
  });
});
