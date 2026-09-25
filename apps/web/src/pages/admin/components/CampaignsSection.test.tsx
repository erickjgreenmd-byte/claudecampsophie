import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { channelSchema, type campaignSummarySchema } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../../test/render.tsx';
import { CampaignsSection } from './CampaignsSection.tsx';
import { CHANNEL_LABEL } from './template-form.ts';

// Synthetic data only.
const TEMPLATE = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const CAMPAIGN = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

type Campaign = z.infer<typeof campaignSummarySchema>;

const campaign: Campaign = {
  id: CAMPAIGN,
  templateId: TEMPLATE,
  campaignMonth: '2026-10',
  status: 'active',
  percentOff: 10,
  schoolId: null,
  opensAt: '2026-10-01T05:00:00.000Z',
  closesAt: '2026-11-01T05:00:00.000Z',
  redemptionCap: 500,
  liveRedemptions: 0,
  confirmedRedemptions: 0,
  budgetCapCents: 1_000_000,
  committedDiscountCents: 0,
  offerMappings: [],
};

/** Labeled fake API: answers only the campaign list. */
function fakeApi(): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(path: string, schema: S) =>
      path.startsWith('/v1/admin/campaigns?')
        ? Promise.resolve(schema.parse({ campaigns: [campaign] }))
        : Promise.reject(new Error(`unexpected GET ${path}`)),
  };
}

afterEach(() => {
  cleanup();
});

describe('CampaignsSection — store offer mappings (R2C-WEB-2)', () => {
  it('lists every billing channel from channelSchema, the Amazon Appstore included', async () => {
    renderPage(
      <CampaignsSection
        month="2026-10"
        version={0}
        templateNames={new Map([[TEMPLATE, 'Back to school']])}
        schoolNames={new Map()}
      />,
      { api: fakeApi() },
    );
    const table = await screen.findByRole('table', { name: 'Store offer mappings' });
    const rowHeaders = within(table)
      .getAllByRole('rowheader')
      .map((h) => h.textContent);
    expect(rowHeaders).toEqual(channelSchema.options.map((c) => CHANNEL_LABEL[c]));
    expect(rowHeaders).toContain(CHANNEL_LABEL.amazon_appstore);
    expect(
      within(table).getByRole('button', { name: `Edit ${CHANNEL_LABEL.amazon_appstore}, 1 child` }),
    ).toBeTruthy();
  });
});
