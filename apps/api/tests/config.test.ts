import { describe, expect, it } from 'vitest';
import { loadConfig, productionReadiness } from '../src/config.ts';
import { TEST_ENV } from './helpers.ts';

describe('provider configuration is honest (AC_DEPLOY_07)', () => {
  it('naming a consent provider without an implemented adapter is a configuration error', () => {
    const loaded = loadConfig({ ...TEST_ENV, CONSENT_PROVIDER: 'some-vendor' });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.map((e) => e.name)).toContain('CONSENT_PROVIDER');
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
