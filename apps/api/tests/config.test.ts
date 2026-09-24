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
});
