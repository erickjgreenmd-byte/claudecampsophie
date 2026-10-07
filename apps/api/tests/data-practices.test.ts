import { checkChildDataGate } from '@pencillift/ai';
import {
  DATA_PRACTICE_ADULT_ID_STATES,
  DATA_PRACTICE_CHILD_WORK_STATES,
  dataPracticesResponseSchema,
} from '@pencillift/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type ApiConfig } from '../src/config.ts';
import { dataPracticesFor } from '../src/routes/data-practices.ts';
import { createTestApi, TEST_ENV, type TestApi } from './helpers.ts';

/**
 * The data-practices notice (spec P4, P15; AC_ACCESS_03). Synthetic values only: the "reference"
 * below is an invented string of the shape an approval identifier takes, not anyone's approval.
 */

const NOW = new Date('2026-10-07T12:00:00Z');
/** Looks like a real approval identifier so the leak test has something recognisable to hunt. */
const SYNTHETIC_REFERENCE = 'OAI-ZDR-2026-SYNTHETIC-00042';
/*
 * NOT shaped like a key. `loadConfig` only checks that OPENAI_API_KEY is non-empty, so there is
 * nothing to gain from a realistic one — and `scripts/scan-secrets.mjs` correctly flagged the
 * first version of this line (`sk-` plus enough characters) the moment the file became tracked.
 * A fixture that trips the secret scanner teaches the next author to quieten the scanner.
 */
const KEY = { OPENAI_API_KEY: 'synthetic-openai-credential-present' };
const EVIDENCE = {
  ZDR_APPROVAL_EVIDENCE_REFERENCE: SYNTHETIC_REFERENCE,
  ZDR_APPROVAL_VERIFIED_AT: '2026-10-01',
};

function configFor(overrides: Record<string, string>): ApiConfig {
  const loaded = loadConfig({ ...TEST_ENV, ...overrides });
  if (!loaded.ok) throw new Error(`bad config: ${JSON.stringify(loaded.errors)}`);
  return loaded.config;
}

describe('what the notice publishes is what the gate would do', () => {
  /*
   * The point of the whole mechanism. A second switch beside the gate is how the public privacy page
   * came to assert "OpenAI, under zero data retention" while the server refused every child request
   * for want of that approval (BUG-430), so this asserts AGREEMENT with the gate across the matrix —
   * and then pins four of the cells by hand as well, because a derivation asserted only against its
   * own source is unfalsifiable however many cells it covers (L-078).
   */
  const CASES = [
    {
      name: 'production, key, verified evidence',
      env: { APP_ENV: 'production' },
      extra: { ...KEY, ...EVIDENCE },
    },
    { name: 'production, key, no evidence', env: { APP_ENV: 'production' }, extra: KEY },
    { name: 'production, no key', env: { APP_ENV: 'production' }, extra: {} },
    {
      name: 'staging, key, verified evidence',
      env: { APP_ENV: 'staging' },
      extra: { ...KEY, ...EVIDENCE },
    },
    { name: 'staging, key, no evidence', env: { APP_ENV: 'staging' }, extra: KEY },
    { name: 'development, no key', env: { APP_ENV: 'development' }, extra: {} },
    {
      name: 'development, key, verified evidence',
      env: { APP_ENV: 'development' },
      extra: { ...KEY, ...EVIDENCE },
    },
    { name: 'test, no key', env: { APP_ENV: 'test' }, extra: {} },
  ] as const;

  it.each(CASES)('$name: the published state matches the gate’s own answer', ({ env, extra }) => {
    const config = configFor({ ...env, ...extra });
    const gate = checkChildDataGate({
      containsChildPersonalData: true,
      ageBand: null,
      zdrEvidence: config.zdrEvidence,
      environment: config.environment,
      providerIsMock: config.providers.ai !== 'openai',
      now: NOW,
    });
    const sendsRealChildData = gate.ok && gate.value.zdrReference !== null;
    expect(dataPracticesFor(config, NOW).childWork).toBe(
      sendsRealChildData ? 'openai_under_zdr' : 'not_sent',
    );
  });

  it('pins the four cells that matter, by hand', () => {
    const state = (overrides: Record<string, string>) =>
      dataPracticesFor(configFor(overrides), NOW).childWork;
    // Approval recorded and a real provider: the one state in which the notice may say so.
    expect(state({ APP_ENV: 'production', ...KEY, ...EVIDENCE })).toBe('openai_under_zdr');
    // A real provider and NO approval: the gate refuses, so nothing is sent.
    expect(state({ APP_ENV: 'production', ...KEY })).toBe('not_sent');
    // A labeled mock sends nothing, approval or not.
    expect(state({ APP_ENV: 'development', ...EVIDENCE })).toBe('not_sent');
    expect(state({ APP_ENV: 'test' })).toBe('not_sent');
  });

  it('a switch-like reference or a future verification date never reads as approval', () => {
    for (const reference of ['approved', 'true', 'yes', 'pending', 'TBD']) {
      expect(
        dataPracticesFor(
          configFor({
            APP_ENV: 'production',
            ...KEY,
            ZDR_APPROVAL_EVIDENCE_REFERENCE: reference,
            ZDR_APPROVAL_VERIFIED_AT: '2026-10-01',
          }),
          NOW,
        ),
        reference,
      ).toEqual({ childWork: 'not_sent', adultId: 'not_sent' });
    }
    // Verified "tomorrow": a date nobody can have checked yet.
    expect(
      dataPracticesFor(
        configFor({
          APP_ENV: 'production',
          ...KEY,
          ZDR_APPROVAL_EVIDENCE_REFERENCE: SYNTHETIC_REFERENCE,
          ZDR_APPROVAL_VERIFIED_AT: '2026-10-08',
        }),
        NOW,
      ).childWork,
    ).toBe('not_sent');
  });
});

describe('the adult ID check carries its own evidence, and a vendor can never read as “not sent”', () => {
  it('the document read is published only with verified evidence, as its adapter requires', () => {
    const adultId = (overrides: Record<string, string>) =>
      dataPracticesFor(configFor(overrides), NOW).adultId;
    expect(adultId({ APP_ENV: 'staging', IDENTITY_PROVIDER: 'openai_document', ...EVIDENCE })).toBe(
      'openai_under_zdr',
    );
    // providers/identity-openai.ts refuses to send a document without evidence, so nothing leaves.
    expect(adultId({ APP_ENV: 'staging', IDENTITY_PROVIDER: 'openai_document' })).toBe('not_sent');
    expect(adultId({ APP_ENV: 'test' })).toBe('not_sent'); // development_mock
    expect(adultId({ APP_ENV: 'staging' })).toBe('not_sent'); // unavailable
  });

  it('a configured identity vendor is published as a vendor', () => {
    /*
     * `loadConfig` CANNOT produce `identity: 'vendor'` today — naming one is a configuration error
     * because no adapter is implemented — so this builds the config value directly. The branch is
     * not dead code waiting for a caller (L-074): without it, the day a vendor is wired a parent's
     * photo ID would start travelling to a new company while this notice still read "not sent",
     * which is the one direction a privacy notice must never fail in.
     */
    const withVendor: ApiConfig = {
      ...configFor({ APP_ENV: 'production', ...KEY, ...EVIDENCE }),
      providers: {
        ...configFor({ APP_ENV: 'production', ...KEY, ...EVIDENCE }).providers,
        identity: 'vendor',
      },
    };
    expect(dataPracticesFor(withVendor, NOW).adultId).toBe('identity_vendor');
  });

  it('every state in both unions is reachable from some configuration', () => {
    // Otherwise a state carries copy no parent can ever be shown, or — worse — a state exists that
    // nothing publishes and a surface silently falls through to the reassuring sentence.
    const seenChild = new Set<string>();
    const seenAdult = new Set<string>();
    const base = { APP_ENV: 'production', ...KEY };
    for (const overrides of [
      { ...base, ...EVIDENCE },
      base,
      { APP_ENV: 'test' },
      { APP_ENV: 'staging', IDENTITY_PROVIDER: 'openai_document', ...EVIDENCE },
    ]) {
      const published = dataPracticesFor(configFor(overrides), NOW);
      seenChild.add(published.childWork);
      seenAdult.add(published.adultId);
    }
    seenAdult.add('identity_vendor'); // proved reachable by the case above
    expect([...seenChild].sort()).toEqual([...DATA_PRACTICE_CHILD_WORK_STATES].sort());
    expect([...seenAdult].sort()).toEqual([...DATA_PRACTICE_ADULT_ID_STATES].sort());
  });
});

describe('the notice never leaks the approval reference', () => {
  it('no part of the published body carries it, under any configuration', () => {
    for (const APP_ENV of ['development', 'test', 'staging', 'production']) {
      const body = dataPracticesFor(
        configFor({ APP_ENV, ...KEY, ...EVIDENCE, IDENTITY_PROVIDER: 'openai_document' }),
        NOW,
      );
      // The whole body as text, so a field added in future is caught rather than a named one.
      expect(JSON.stringify(body), APP_ENV).not.toContain(SYNTHETIC_REFERENCE);
      expect(JSON.stringify(body), APP_ENV).not.toContain('2026-10-01');
      // And the shape is exactly two enums: a strict schema refuses anything else.
      expect(dataPracticesResponseSchema.parse(body)).toEqual(body);
    }
  });

  it('the response schema refuses “unknown”: a server never reports ignorance as a fact', () => {
    expect(
      dataPracticesResponseSchema.safeParse({ childWork: 'unknown', adultId: 'not_sent' }).success,
    ).toBe(false);
    expect(
      dataPracticesResponseSchema.safeParse({
        childWork: 'not_sent',
        adultId: 'not_sent',
        zdrReference: SYNTHETIC_REFERENCE,
      }).success,
    ).toBe(false);
  });
});

describe('the endpoint is reachable by a page nobody has signed in to', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api?.close();
  });

  it('answers without a token, and does not opt out of the no-store default', async () => {
    const response = await api.request('/v1/data-practices');
    expect(response.status).toBe(200);
    // app.ts sets this on every response. A public route is exactly where someone would be tempted
    // to add a max-age, and a cached notice keeps saying "not sent" after that stopped being true.
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = dataPracticesResponseSchema.parse(await response.json());
    // The test harness has no OPENAI_API_KEY, so the AI provider is the labeled mock.
    expect(body).toEqual({ childWork: 'not_sent', adultId: 'not_sent' });
  });
});
