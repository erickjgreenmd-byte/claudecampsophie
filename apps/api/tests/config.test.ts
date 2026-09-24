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
