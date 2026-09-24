import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOwnerAdmin } from '@pencillift/db/testing/fixtures';
import { loadConfig, productionReadiness, type ApiConfig } from '../src/config.ts';
import { createTestApi, json, parentToken, TEST_ENV, type TestApi } from './helpers.ts';

/**
 * Owner readiness report (AC_DEPLOY_07, AC_RELEASE_02): it must match what the enforcing gates do
 * (RV-lead-identity-access-4) and include this month's owner-set AI spend cap (spec F4, review
 * note f). Real local Postgres; synthetic owner admin.
 */

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

function config(env: Record<string, string> = {}): ApiConfig {
  const loaded = loadConfig({ ...TEST_ENV, ...env });
  if (!loaded.ok) throw new Error('config should load');
  return loaded.config;
}

const zdrStatus = (c: ApiConfig, now: Date) =>
  productionReadiness(c, { now }).find((i) => i.check === 'zdr_evidence')!.status;

describe('ZDR evidence in readiness matches the child-data gate (RV-lead-identity-access-4)', () => {
  const NOW = new Date('2026-09-24T15:00:00Z');

  it('documented evidence verified in the past is ready', () => {
    const c = config({
      ZDR_APPROVAL_EVIDENCE_REFERENCE: 'ZDR-TICKET-4471',
      ZDR_APPROVAL_VERIFIED_AT: '2026-09-01',
    });
    expect(zdrStatus(c, NOW)).toBe('ready');
  });

  it('the verification date is judged against the injected instant', () => {
    const c = config({
      ZDR_APPROVAL_EVIDENCE_REFERENCE: 'ZDR-TICKET-4471',
      ZDR_APPROVAL_VERIFIED_AT: '2026-10-01',
    });
    expect(zdrStatus(c, NOW)).toBe('blocked');
    expect(zdrStatus(c, new Date('2026-10-02T00:00:00Z'))).toBe('ready');
  });

  it('missing, short or switch-like evidence is blocked', () => {
    expect(zdrStatus(config(), NOW)).toBe('blocked');
    for (const reference of ['yes', 'TRUE', ' approved ', 'abc']) {
      const c = config({
        ZDR_APPROVAL_EVIDENCE_REFERENCE: reference,
        ZDR_APPROVAL_VERIFIED_AT: '2026-09-01',
      });
      expect({ reference, status: zdrStatus(c, NOW) }).toEqual({ reference, status: 'blocked' });
    }
  });
});

describe('this month’s AI spend cap (review note f, spec F4)', () => {
  it('readiness is blocked until the owner sets the cap for the current UTC month', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    const token = await parentToken(adminId, { aal: 'aal2' });
    const budget = async () => {
      const res = await api.request('/v1/admin/readiness', { token });
      expect(res.status).toBe(200);
      const body = await json<{ checks: { check: string; status: string; detail: string }[] }>(res);
      return body.checks.find((c) => c.check === 'ai_spend_budget')!;
    };

    expect((await budget()).status).toBe('blocked');
    expect((await budget()).detail).toContain('2026-09');

    // Next month's cap alone does not cover this month.
    await api.db.sql`
      insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
      values ('global', '2026-10', 50000000, ${adminId})`;
    expect((await budget()).status).toBe('blocked');

    await api.db.sql`
      insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
      values ('global', '2026-09', 50000000, ${adminId})`;
    expect((await budget()).status).toBe('ready');

    // A new month without its own cap is blocked again (the owner must set it).
    api.now.value = new Date('2026-11-01T00:00:00Z');
    try {
      expect((await budget()).status).toBe('blocked');
    } finally {
      api.now.value = new Date('2026-09-24T15:00:00Z');
    }
  });

  it('without the database facts the cap is reported as blocked, never assumed', () => {
    const item = productionReadiness(config()).find((i) => i.check === 'ai_spend_budget')!;
    expect(item.status).toBe('blocked');
  });

  it('still requires an owner admin with MFA', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    expect(
      (await api.request('/v1/admin/readiness', { token: await parentToken(adminId) })).status,
    ).toBe(403);
    expect((await api.request('/v1/admin/readiness')).status).toBe(401);
  });
});
