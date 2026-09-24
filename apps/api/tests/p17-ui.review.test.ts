import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listCampaignsResponseSchema } from '@pencillift/contracts';
import { seedOwnerAdmin } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Independent adversarial review of the p17-ui vertical: the owner console's requests replayed
 * against the real API and a real Postgres database (no mocks on the path under test).
 *
 * Bodies below are exactly what apps/web/src/pages/admin/components/template-form.ts
 * (validateTemplateForm) produces for the described form state: optional fields that are empty in
 * the form are omitted, because promoTemplateInputSchema has no way to send "none".
 */

let api: TestApi;
let adminToken: string;

beforeAll(async () => {
  api = await createTestApi();
  const adminId = await seedOwnerAdmin(api.db);
  adminToken = await parentToken(adminId, { aal: 'aal2' });
});

afterAll(async () => {
  await api?.close();
});

const admin = (path: string, method = 'GET', body?: unknown) =>
  api.request(`/v1/admin${path}`, {
    method,
    token: adminToken,
    ...(body === undefined ? {} : { body }),
  });

/** A console "full edit" body (TemplatesSection.save sends the whole validated form). */
const base = {
  schoolId: null,
  percentOff: 25,
  eligibleTiers: [1, 2],
  subscriberEligibility: ['existing'],
  redemptionCap: 300,
  budgetCapCents: 250_000,
  calendarTimezone: 'UTC',
  timezoneConfirmed: true,
  windowStartDay: 1,
  windowEndDay: 'end_of_month',
  channels: ['play_store'],
} as const;

type Template = {
  id: string;
  enabled: boolean;
  codeMode: string;
  individualCodeCount?: number;
  sharedCodeUsageCap?: number;
};

describe('[RV-p17-ui-3] the console template edit can change code settings', () => {
  it('[RV-p17-ui-3] switching an individual-code template to one shared code keeps it activatable', async () => {
    const created = await json<Template>(
      await admin('/promo-templates', 'POST', {
        ...base,
        name: 'Individual codes',
        codeMode: 'individual',
        individualCodeCount: 100,
      }),
    );
    expect(
      (await json<{ ok: boolean }>(await admin(`/promo-templates/${created.id}/activate`, 'POST')))
        .ok,
    ).toBe(true);

    // The owner opens Edit, picks "One shared code for the audience" and leaves the optional
    // usage cap empty. The form then sends codeMode 'shared' with neither count nor cap.
    const saved = await admin(`/promo-templates/${created.id}`, 'PATCH', {
      ...base,
      name: 'Individual codes',
      codeMode: 'shared',
    });
    expect(saved.status).toBe(200);
    const after = await json<Template>(saved);
    expect(after.codeMode).toBe('shared');

    // The console's Activate button must be able to bring it back.
    const activation = await json<{ ok: boolean; problems: string[] }>(
      await admin(`/promo-templates/${created.id}/activate`, 'POST'),
    );
    expect(activation).toEqual({ ok: true, problems: [] });
  });

  it('[RV-p17-ui-3] clearing the optional shared-code usage cap in the form removes the cap', async () => {
    const created = await json<Template>(
      await admin('/promo-templates', 'POST', {
        ...base,
        name: 'Capped shared code',
        codeMode: 'shared',
        sharedCodeUsageCap: 50,
      }),
    );
    expect(created.sharedCodeUsageCap).toBe(50);
    // The owner empties "Shared code usage cap (optional)" and saves; the console then reports
    // "Template updated."
    const after = await json<Template>(
      await admin(`/promo-templates/${created.id}`, 'PATCH', {
        ...base,
        name: 'Capped shared code',
        codeMode: 'shared',
      }),
    );
    expect(after.sharedCodeUsageCap).toBeUndefined();
  });
});

describe('[RV-p17-ui-2] a budget the console accepts yields a campaign list the console can read', () => {
  it('[RV-p17-ui-2] a $150,000 template budget still produces a contract-valid GET /v1/admin/campaigns', async () => {
    // The console form accepts "150000" dollars (parseDollarsToCents -> 15,000,000 cents).
    const created = await json<Template>(
      await admin('/promo-templates', 'POST', {
        ...base,
        name: 'Big month',
        percentOff: 100,
        redemptionCap: 3000,
        budgetCapCents: 15_000_000,
        codeMode: 'shared',
      }),
    );
    expect(
      (await json<{ ok: boolean }>(await admin(`/promo-templates/${created.id}/activate`, 'POST')))
        .ok,
    ).toBe(true);
    const run = await admin('/promo-generation/run', 'POST', { month: '2026-12' });
    expect(run.status).toBe(200);

    const listed = await admin('/campaigns?month=2026-12');
    expect(listed.status).toBe(200);
    const body = await json(listed);
    // The web console parses this response with listCampaignsResponseSchema; if it fails, the
    // whole month's campaign section (including pause and revoke) shows only an error.
    const parsed = listCampaignsResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.map((i) => i.path))).toBe(true);
  });
});
