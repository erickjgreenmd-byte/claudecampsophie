import { describe, expect, it } from 'vitest';
import {
  assertWebEnv,
  formatEffectiveDate,
  isLegalReviewed,
  readLegalConfig,
  readWebConfig,
  REQUIRED_PRODUCTION_VARS,
} from './config.ts';

const release = {
  VITE_API_BASE_URL: 'https://api.pencillift.example',
  VITE_SUPABASE_URL: 'https://project.supabase.example',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_key_for_tests',
};

describe('readWebConfig (WEB-01: production builds fail loudly without the public values)', () => {
  it('keeps the local defaults in test and dev builds', () => {
    expect(readWebConfig({})).toEqual({
      apiBaseUrl: '/api',
      supabaseUrl: null,
      supabasePublishableKey: null,
    });
    expect(readWebConfig({ DEV: true, PROD: false })).toEqual({
      apiBaseUrl: '/api',
      supabaseUrl: null,
      supabasePublishableKey: null,
    });
  });

  it('throws in a production build when any public value is missing, naming every missing one', () => {
    expect(() => readWebConfig({ PROD: true })).toThrow(
      /VITE_API_BASE_URL.*VITE_SUPABASE_URL.*VITE_SUPABASE_PUBLISHABLE_KEY/s,
    );
    expect(() => readWebConfig({ PROD: true, ...release, VITE_SUPABASE_URL: '' })).toThrow(
      /VITE_SUPABASE_URL/,
    );
    expect(() =>
      readWebConfig({ PROD: true, ...release, VITE_SUPABASE_PUBLISHABLE_KEY: '   ' }),
    ).toThrow(/VITE_SUPABASE_PUBLISHABLE_KEY/);
  });

  it('returns the release values in a production build when all are present', () => {
    expect(readWebConfig({ PROD: true, ...release })).toEqual({
      apiBaseUrl: 'https://api.pencillift.example',
      supabaseUrl: 'https://project.supabase.example',
      supabasePublishableKey: 'sb_publishable_synthetic_key_for_tests',
    });
    expect(REQUIRED_PRODUCTION_VARS).toEqual([
      'VITE_API_BASE_URL',
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ]);
  });

  it('treats only a boolean true PROD as a production build', () => {
    // vitest exposes PROD=false; a string "true" never appears in a real Vite env object.
    expect(() => readWebConfig({ PROD: 'true' })).not.toThrow();
  });
});

describe('isLegalReviewed', () => {
  it('is true only for the exact string "true"', () => {
    expect(isLegalReviewed({ VITE_LEGAL_REVIEWED: 'true' })).toBe(true);
    expect(isLegalReviewed({ VITE_LEGAL_REVIEWED: 'TRUE' })).toBe(false);
    expect(isLegalReviewed({ VITE_LEGAL_REVIEWED: '1' })).toBe(false);
    expect(isLegalReviewed({})).toBe(false);
  });
});

describe('readLegalConfig (WEB-06 / APL-20: reviewed pages need a date and a mailbox)', () => {
  it('is a draft with no date or mailbox when nothing is configured', () => {
    expect(readLegalConfig({})).toEqual({
      reviewed: false,
      effectiveDate: null,
      supportEmail: null,
    });
  });

  it('returns the configured values when the build records legal review', () => {
    expect(
      readLegalConfig({
        VITE_LEGAL_REVIEWED: 'true',
        VITE_LEGAL_EFFECTIVE_DATE: '2026-10-01',
        VITE_SUPPORT_EMAIL: 'support@example.test',
      }),
    ).toEqual({
      reviewed: true,
      effectiveDate: '2026-10-01',
      supportEmail: 'support@example.test',
    });
  });

  it('throws when review is recorded but the effective date or mailbox is missing', () => {
    expect(() => readLegalConfig({ VITE_LEGAL_REVIEWED: 'true' })).toThrow(
      /VITE_LEGAL_EFFECTIVE_DATE.*VITE_SUPPORT_EMAIL/s,
    );
    expect(() =>
      readLegalConfig({ VITE_LEGAL_REVIEWED: 'true', VITE_LEGAL_EFFECTIVE_DATE: '2026-10-01' }),
    ).toThrow(/VITE_SUPPORT_EMAIL/);
    expect(() =>
      readLegalConfig({ VITE_LEGAL_REVIEWED: 'true', VITE_SUPPORT_EMAIL: 'support@example.test' }),
    ).toThrow(/VITE_LEGAL_EFFECTIVE_DATE/);
  });

  it('rejects a malformed date or mailbox in any mode (a typo must not ship)', () => {
    expect(() => readLegalConfig({ VITE_LEGAL_EFFECTIVE_DATE: 'October 1, 2026' })).toThrow(
      /VITE_LEGAL_EFFECTIVE_DATE/,
    );
    expect(() => readLegalConfig({ VITE_LEGAL_EFFECTIVE_DATE: '2026-02-30' })).toThrow(
      /VITE_LEGAL_EFFECTIVE_DATE/,
    );
    expect(() => readLegalConfig({ VITE_SUPPORT_EMAIL: 'not an address' })).toThrow(
      /VITE_SUPPORT_EMAIL/,
    );
    expect(() => readLegalConfig({ VITE_SUPPORT_EMAIL: 'support@' })).toThrow(/VITE_SUPPORT_EMAIL/);
  });

  it('keeps a valid date and mailbox available while still a draft', () => {
    expect(
      readLegalConfig({
        VITE_LEGAL_REVIEWED: 'false',
        VITE_LEGAL_EFFECTIVE_DATE: '2026-10-01',
        VITE_SUPPORT_EMAIL: 'support@example.test',
      }),
    ).toEqual({
      reviewed: false,
      effectiveDate: '2026-10-01',
      supportEmail: 'support@example.test',
    });
  });
});

describe('formatEffectiveDate', () => {
  it('formats the ISO date as a long US date, independent of the browser time zone', () => {
    expect(formatEffectiveDate('2026-10-01')).toBe('October 1, 2026');
    expect(formatEffectiveDate('2027-01-31')).toBe('January 31, 2027');
  });
});

describe('assertWebEnv (runs once at startup from config.ts)', () => {
  it('passes for the test environment and for a complete release environment', () => {
    expect(() => assertWebEnv({})).not.toThrow();
    expect(() =>
      assertWebEnv({
        PROD: true,
        ...release,
        VITE_LEGAL_REVIEWED: 'true',
        VITE_LEGAL_EFFECTIVE_DATE: '2026-10-01',
        VITE_SUPPORT_EMAIL: 'support@example.test',
      }),
    ).not.toThrow();
  });

  it('fails loudly for a production build without public values or a reviewed build without legal values', () => {
    expect(() => assertWebEnv({ PROD: true })).toThrow(/VITE_API_BASE_URL/);
    expect(() => assertWebEnv({ VITE_LEGAL_REVIEWED: 'true' })).toThrow(/VITE_SUPPORT_EMAIL/);
  });
});
