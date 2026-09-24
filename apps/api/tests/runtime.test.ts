import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@pencillift/db/testing';
import { grantAdultUnlock, seedFamily, seedOwnerAdmin } from '@pencillift/db/testing/fixtures';
import { createApp } from '../src/app.ts';
import {
  CONSENT_ADAPTERS,
  loadConfig,
  productionReadiness,
  type ApiConfig,
} from '../src/config.ts';
import {
  CONSENT_ADAPTER_FACTORIES,
  buildRuntime,
  selectBillingProviders,
  selectConsentProvider,
  type WorkerEnv,
} from '../src/index.ts';
import { reconcileStaleEntitlements } from '../src/jobs/dispatcher.ts';
import type { ConsentProvider } from '../src/providers/index.ts';
import { hmacSha256, toHex } from '../src/security/crypto.ts';
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

  it('staging with Supabase keys gets real storage; email stays unavailable (no adapter exists)', () => {
    const built = build({ APP_ENV: 'staging', ...REAL_STORAGE });
    if (!built.ok) throw new Error(`staging should build: ${built.code}`);
    const { storage, email } = built.runtime.deps.providers;
    expect(storage.isMock).toBe(false);
    expect(storage.name).not.toBe('not_configured');
    expect([email.name, email.isMock]).toEqual(['not_configured', false]);
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
