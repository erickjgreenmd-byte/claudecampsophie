import { describe, expect, it } from 'vitest';
import { loadConfig, productionReadiness } from '../src/config.ts';
import { TEST_ENV } from './helpers.ts';

describe('provider configuration is honest (AC_DEPLOY_07)', () => {
  it('naming a consent provider without an implemented adapter is a configuration error', () => {
    const loaded = loadConfig({ ...TEST_ENV, CONSENT_PROVIDER: 'some-vendor' });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.map((e) => e.name)).toContain('CONSENT_PROVIDER');
  });

  it('an unknown consent adapter name fails configuration in every environment', () => {
    for (const APP_ENV of ['development', 'test', 'staging', 'production']) {
      for (const CONSENT_PROVIDER of ['some-vendor', 'development_mock', 'mock']) {
        const loaded = loadConfig({ ...TEST_ENV, APP_ENV, CONSENT_PROVIDER });
        expect({ APP_ENV, CONSENT_PROVIDER, ok: loaded.ok }).toEqual({
          APP_ENV,
          CONSENT_PROVIDER,
          ok: false,
        });
      }
    }
  });

  it('the development consent mock is selected only in development and test', () => {
    const selected = (APP_ENV: string) => {
      const loaded = loadConfig({ ...TEST_ENV, APP_ENV });
      if (!loaded.ok) throw new Error(`config should load for ${APP_ENV}`);
      return {
        consent: loaded.config.providers.consent,
        adapter: loaded.config.providers.consentAdapter,
      };
    };
    expect(selected('development')).toEqual({ consent: 'development_mock', adapter: null });
    expect(selected('test')).toEqual({ consent: 'development_mock', adapter: null });
    // Staging and production without an adapter have no consent provider at all, never the mock.
    expect(selected('staging')).toEqual({ consent: 'unavailable', adapter: null });
    expect(selected('production')).toEqual({ consent: 'unavailable', adapter: null });
  });

  it('storage is real only with both Supabase settings; email and consent stay blocked', () => {
    const partial = loadConfig({ ...TEST_ENV, SUPABASE_URL: 'https://example.supabase.co' });
    expect(partial.ok && partial.config.providers.storage).toBe('development_mock');
    const full = loadConfig({
      ...TEST_ENV,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value',
    });
    if (!full.ok) throw new Error('config should load');
    expect(full.config.providers.storage).toBe('supabase');
    const status = Object.fromEntries(
      productionReadiness(full.config).map((i) => [i.check, i.status]),
    );
    expect(status).toMatchObject({
      storage_provider: 'ready',
      email_provider: 'blocked',
      consent_provider: 'blocked',
    });
  });

  /**
   * The adult ID check (migration 0980) is a PRODUCTION GATE: without a provider that can do both halves
   * of it, no family can be given a child pairing code. These cases pin the gate itself, because a
   * readiness item nothing asserts can be deleted with CI green — and this one is the difference between
   * verifying adults and not.
   */
  describe('the adult ID check is selected explicitly and readiness reports it', () => {
    const identity = (env: Record<string, string>) => {
      const loaded = loadConfig({ ...TEST_ENV, ...env });
      if (!loaded.ok) return { ok: false as const, errors: loaded.errors.map((e) => e.name) };
      return {
        ok: true as const,
        selected: loaded.config.providers.identity,
        readiness: productionReadiness(loaded.config).find((i) => i.check === 'identity_provider'),
      };
    };

    it('defaults to the labeled mock in development and test, and to unavailable elsewhere', () => {
      for (const APP_ENV of ['development', 'test']) {
        const out = identity({ APP_ENV });
        expect(out.ok, APP_ENV).toBe(true);
        if (out.ok) expect(out.selected, APP_ENV).toBe('development_mock');
      }
      for (const APP_ENV of ['staging', 'production']) {
        const out = identity({ APP_ENV });
        expect(out.ok, APP_ENV).toBe(true);
        if (out.ok) expect(out.selected, APP_ENV).toBe('unavailable');
      }
    });

    it('refuses to wire the mock outside development and test, as a configuration error', () => {
      for (const APP_ENV of ['staging', 'production']) {
        const out = identity({ APP_ENV, IDENTITY_PROVIDER: 'development_mock' });
        expect(out.ok, APP_ENV).toBe(false);
        if (!out.ok) expect(out.errors, APP_ENV).toContain('IDENTITY_PROVIDER');
      }
    });

    it('refuses to load at all for an unrecognised provider name', () => {
      // A deployment that meant to verify adults must not quietly stop doing so. What carries that is
      // the CONFIGURATION FAILING, not the value the branch returns: on a failure the Worker never
      // starts (src/index.ts returns NOT_CONFIGURED), so whatever `identityProvider` returns there is
      // unreachable. Asserting the returned value instead would be asserting dead code — proved by
      // mutating that branch to return the mock, which changed nothing observable (L-054).
      const out = identity({ APP_ENV: 'staging', IDENTITY_PROVIDER: 'some-vendor' });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.errors).toContain('IDENTITY_PROVIDER');
    });

    it('is BLOCKED for the mock and for openai_document, and its detail says why', () => {
      // openai_document reads the document and cannot compare faces, so it can never confirm an adult.
      // Readiness must say so before anyone tries to serve real families on it.
      const mock = identity({ APP_ENV: 'test' });
      expect(mock.ok && mock.readiness?.status).toBe('blocked');
      const openai = identity({ APP_ENV: 'staging', IDENTITY_PROVIDER: 'openai_document' });
      expect(openai.ok).toBe(true);
      if (!openai.ok) return;
      expect(openai.selected).toBe('openai_document');
      // The item must EXIST — a deleted readiness item would leave `find` undefined and every
      // status assertion vacuous, which is how a production gate disappears with CI green.
      expect(openai.readiness, 'the identity_provider readiness item is missing').toBeDefined();
      expect(openai.readiness?.status).toBe('blocked');
      expect(openai.readiness?.detail).toMatch(/face comparison/i);
      expect(openai.readiness?.detail).toMatch(/identity vendor is required/i);
    });
  });

  it('email is Resend only with a well-formed key and a sender; the mock never outside development/test', () => {
    const withKey = loadConfig({
      ...TEST_ENV,
      APP_ENV: 'staging',
      RESEND_API_KEY: 're_test_key_value_not_real_1234567890',
      EMAIL_FROM: 'PencilLift <hello@pencillift.test>',
    });
    if (!withKey.ok) throw new Error(`config should load: ${JSON.stringify(withKey.errors)}`);
    expect(withKey.config.providers.email).toBe('resend');
    const status = Object.fromEntries(
      productionReadiness(withKey.config).map((i) => [i.check, i.status]),
    );
    expect(status['email_provider']).toBe('ready');

    const staging = loadConfig({ ...TEST_ENV, APP_ENV: 'staging' });
    expect(staging.ok && staging.config.providers.email).toBe('unavailable');

    const badKey = loadConfig({
      ...TEST_ENV,
      RESEND_API_KEY: 'sk_live_wrong_kind_of_key_123456',
      EMAIL_FROM: 'hello@pencillift.test',
    });
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.errors.map((e) => e.name)).toEqual(['RESEND_API_KEY']);
    const noFrom = loadConfig({
      ...TEST_ENV,
      RESEND_API_KEY: 're_test_key_value_not_real_1234567890',
    });
    expect(noFrom.ok).toBe(false);
    if (!noFrom.ok) expect(noFrom.errors.map((e) => e.name)).toEqual(['EMAIL_FROM']);
  });

  it('unapproved child safety messages and missing provider moderation block production (AC_SECURITY_02)', () => {
    const loaded = loadConfig({ ...TEST_ENV, APP_ENV: 'production' });
    if (!loaded.ok) throw new Error('config should load');
    const byCheck = Object.fromEntries(productionReadiness(loaded.config).map((i) => [i.check, i]));
    expect(byCheck.safety_templates?.status).toBe('blocked');
    expect(byCheck.safety_templates?.detail).toMatch(/owner, educator and counsel approval/);
    expect(byCheck.ai_moderation?.status).toBe('blocked');
  });

  it('the billing mocks are selected only in development and test (AC_DEPLOY_07)', () => {
    const selected = (vars: Record<string, string>) => {
      const loaded = loadConfig({ ...TEST_ENV, ...vars });
      if (!loaded.ok) throw new Error(`config should load: ${JSON.stringify(loaded.errors)}`);
      return [loaded.config.providers.billing, loaded.config.providers.webBilling];
    };
    for (const APP_ENV of ['development', 'test']) {
      expect({ APP_ENV, billing: selected({ APP_ENV }) }).toEqual({
        APP_ENV,
        billing: ['development_mock', 'development_mock'],
      });
    }
    // Staging and production without server keys have no billing provider, never the mocks.
    for (const APP_ENV of ['staging', 'production']) {
      expect({ APP_ENV, billing: selected({ APP_ENV }) }).toEqual({
        APP_ENV,
        billing: ['unavailable', 'unavailable'],
      });
    }
    for (const APP_ENV of ['development', 'test', 'staging', 'production']) {
      const keys = {
        REVENUECAT_SECRET_API_KEY: 'revenuecat-config-test-value',
        STRIPE_SECRET_KEY: 'stripe-config-test-value',
      };
      expect({ APP_ENV, billing: selected({ APP_ENV, ...keys }) }).toEqual({
        APP_ENV,
        billing: ['revenuecat', 'stripe'],
      });
    }
  });

  it('optional web billing blocks readiness only when it is enabled without Stripe credentials', () => {
    const webBilling = (vars: Record<string, string>) => {
      const loaded = loadConfig({ ...TEST_ENV, APP_ENV: 'production', ...vars });
      if (!loaded.ok) throw new Error('config should load');
      return productionReadiness(loaded.config).find((i) => i.check === 'web_billing_provider')
        ?.status;
    };
    expect(webBilling({})).toBe('ready');
    expect(webBilling({ OPTIONAL_STRIPE_WEB_BILLING_ENABLED: 'true' })).toBe('blocked');
    expect(
      webBilling({
        OPTIONAL_STRIPE_WEB_BILLING_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'stripe-config-test-value',
      }),
    ).toBe('ready');
  });
});
