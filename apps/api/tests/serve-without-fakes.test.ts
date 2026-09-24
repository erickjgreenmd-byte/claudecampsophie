import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seedOwnerAdmin } from '@pencillift/db/testing/fixtures';
import { loadCampaignCandidates, loadCatalog } from '../src/services/monetization-data.ts';
import { setLinkCheckFetchForTests } from '../src/services/monetization-links.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';
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

/**
 * LRD-2: 0770 counts an 'available' merchant row as fake unless the catalog's own link check passed,
 * and relies on 'available' only ever being written together with a passing check. Changing the
 * merchant URL kept the previous URL's 'ok' check, so a URL nobody checked was served as available
 * (and a database marked production accepted it). A new URL now starts unchecked, whoever writes it.
 */
describe('a changed merchant URL never keeps the previous link check (LRD-2)', () => {
  const CHECKED_URL = 'https://www.amazon.com/dp/B000LRD2OK';
  const NEW_URL = 'https://www.amazon.com/dp/B000LRD2NW';

  afterEach(() => {
    setLinkCheckFetchForTests(null);
  });

  async function row(id: string) {
    const [r] = await api.db.sql<
      {
        merchant_url: string;
        availability: string;
        last_link_check_status: string | null;
        last_link_check_at: Date | null;
        fake: boolean;
      }[]
    >`
      select merchant_url, availability, last_link_check_status, last_link_check_at,
             app.resource_is_fake(r) as fake
        from public.resource_catalog r where id = ${id}`;
    return r!;
  }

  const served = async () =>
    (
      await api.apiDb.asService((tx) => loadCatalog(tx, { approvedOnly: true, withoutFakes: true }))
    ).map((r) => [r.id, r.merchant_url, r.availability]);

  it('through the admin API: a PATCHed URL is unchecked, and approving it again does not check it', async () => {
    const token = await parentToken(adminId, { aal: 'aal2' });
    const call = (method: string, path: string, body: unknown = {}) =>
      api.request(`/v1/admin/monetization/catalog${path}`, { method, token, body });
    const created = await call('POST', '', {
      stableKey: 'lrd-two-workbook',
      title: 'Fraction workbook',
      description: 'A reviewed synthetic learning resource for fractions.',
      skills: [],
      subjects: ['math'],
      gradeMin: 3,
      gradeMax: 4,
      kind: 'workbook',
      merchant: 'amazon',
      merchantUrl: CHECKED_URL,
      imageAssetRef: null,
      imageLicenseRef: null,
    });
    expect(created.status).toBe(201);
    const { id } = await json<{ id: string }>(created);
    const checkedUrls: string[] = [];
    setLinkCheckFetchForTests((url) => {
      checkedUrls.push(url);
      return Promise.resolve({ status: url === CHECKED_URL ? 200 : 404 });
    });
    expect((await call('POST', `/${id}/link-check`)).status).toBe(200);
    expect((await call('POST', `/${id}/approve`)).status).toBe(200);
    expect(await served()).toContainEqual([id, CHECKED_URL, 'available']);

    expect((await call('PATCH', `/${id}`, { merchantUrl: NEW_URL })).status).toBe(200);
    expect((await call('POST', `/${id}/approve`)).status).toBe(200);
    expect(await row(id)).toEqual({
      merchant_url: NEW_URL,
      availability: 'unknown',
      last_link_check_status: null,
      last_link_check_at: null,
      fake: false,
    });
    expect(checkedUrls).toEqual([CHECKED_URL]);
    // Served like any never-checked product: never as available.
    const now = (await served()).filter(([rowId]) => rowId === id);
    expect(now).toEqual([[id, NEW_URL, 'unknown']]);

    // Only a check of the new URL can claim availability again (the stub answers 404 for it).
    expect((await call('POST', `/${id}/link-check`)).status).toBe(200);
    expect((await row(id)).availability).toBe('unavailable');
  });

  it('in the database: any writer that changes the URL clears the check, other edits keep it', async () => {
    const id = await fixtureResource(api.db, adminId, {
      key: 'lrd-two-direct',
      url: 'https://www.amazon.com/dp/B000LRD2DB',
    });
    await api.db.sql`
      update public.resource_catalog set availability = 'available', last_link_check_status = 'ok',
             last_link_check_at = now() where id = ${id}`;
    // A title edit keeps the check of the unchanged URL.
    await api.db
      .sql`update public.resource_catalog set title = 'Fraction strips set' where id = ${id}`;
    expect(await row(id)).toMatchObject({
      availability: 'available',
      last_link_check_status: 'ok',
    });
    // A URL change (even one that restates 'available') starts unchecked.
    await api.db.sql`
      update public.resource_catalog set merchant_url = 'https://www.amazon.com/dp/B000LRD2D2',
             availability = 'available' where id = ${id}`;
    expect(await row(id)).toMatchObject({
      availability: 'unknown',
      last_link_check_status: null,
      last_link_check_at: null,
      fake: false,
    });
  });
});
