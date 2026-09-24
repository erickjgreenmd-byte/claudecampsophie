import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOwnerAdmin } from '@pencillift/db/testing/fixtures';
import { loadCampaignCandidates, loadCatalog } from '../src/services/monetization-data.ts';
import { createTestApi, type TestApi } from './helpers.ts';
import { fixtureCampaign, fixtureResource } from './monetization-fixtures.ts';

/**
 * AC_DEPLOY_07 fake-catalog clause on the serve path: a production Worker leaves fixture and fake
 * catalog rows out of what it serves even when its database is not marked production yet (0770
 * refuses them only once it is). The filter runs inside the API's service-role transaction, so the
 * predicates must be executable there.
 */
let api: TestApi;
let adminId: string;

beforeAll(async () => {
  api = await createTestApi();
  adminId = await seedOwnerAdmin(api.db);
});

afterAll(async () => {
  await api?.close();
});

describe('serve path without fakes (production)', () => {
  it('leaves fixture and unverified resources out, keeps checked ones', async () => {
    const fake = await fixtureResource(api.db, adminId, { key: 'fixture-workbook-1' });
    const unchecked = await fixtureResource(api.db, adminId, { key: 'unchecked-workbook' });
    const checked = await fixtureResource(api.db, adminId, {
      key: 'checked-workbook',
      merchant: 'none',
      url: null,
    });
    const all = await api.apiDb.asService((tx) => loadCatalog(tx, { approvedOnly: true }));
    expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([fake, unchecked, checked]));
    const served = await api.apiDb.asService((tx) =>
      loadCatalog(tx, { approvedOnly: true, withoutFakes: true }),
    );
    const ids = served.map((r) => r.id);
    expect(ids).toContain(checked);
    expect(ids).not.toContain(fake);
    expect(ids).not.toContain(unchecked);
  });

  it('leaves campaigns on reserved test domains out', async () => {
    const { campaignId } = await fixtureCampaign(api.db, adminId);
    const all = await api.apiDb.asService((tx) => loadCampaignCandidates(tx, { campaignId }));
    const served = await api.apiDb.asService((tx) =>
      loadCampaignCandidates(tx, { campaignId, withoutFakes: true }),
    );
    expect(all).toHaveLength(1);
    expect(served).toHaveLength(0);
  });

  it('every serve route asks for the filter when the environment is production', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/routes/monetization.ts', import.meta.url), 'utf8');
    const calls = source.match(/load(Catalog|CampaignCandidates)\(tx, \{[^}]*\}/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call).toMatch(/withoutFakes: (deps\.)?config\.environment === 'production'/);
    }
  });
});
