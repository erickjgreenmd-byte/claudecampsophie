import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  approvalSchema,
  campaignSchema,
  catalogItemSchema,
  creativeSchema,
  monetizationStatusSchema,
  sponsorSchema,
  MonetizationReport,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import MonetizationAdminPage from './MonetizationAdminPage.tsx';

// Synthetic data only. Sponsors, properties and evidence references are invented.
const APPROVAL = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SPONSOR = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const CREATIVE = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const CAMPAIGN = '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
const ITEM = 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';
const ENTRY = 'be6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d';
const AT = '2026-09-20T15:00:00.000Z';

type Status = z.infer<typeof monetizationStatusSchema>;
type Approval = z.infer<typeof approvalSchema>;
type Sponsor = z.infer<typeof sponsorSchema>;
type Creative = z.infer<typeof creativeSchema>;
type Campaign = z.infer<typeof campaignSchema>;
type CatalogItem = z.infer<typeof catalogItemSchema>;

function status(overrides: Partial<Status> = {}): Status {
  return {
    environment: 'test',
    switches: [
      { key: 'global', enabled: false, changedAt: AT, reason: null },
      { key: 'provider:amazon_associates', enabled: false, changedAt: AT, reason: null },
      { key: 'provider:ad_network', enabled: false, changedAt: AT, reason: null },
      { key: 'provider:sponsor_direct', enabled: false, changedAt: AT, reason: null },
    ],
    providers: [
      {
        provider: 'sponsor_direct',
        platform: 'web',
        propertyIdentifier: 'https://app.pencillift.example',
        enabled: false,
        fixture: false,
        reasons: ['GLOBAL_SWITCH_OFF', 'PROVIDER_SWITCH_OFF', 'NO_APPROVAL'],
      },
      {
        provider: 'ad_network',
        platform: 'ios',
        propertyIdentifier: 'com.pencillift.app',
        enabled: false,
        fixture: false,
        reasons: ['NO_NETWORK_ADAPTER'],
      },
      {
        provider: 'amazon_associates',
        platform: 'web',
        propertyIdentifier: 'https://app.pencillift.example',
        enabled: true,
        fixture: true,
        reasons: [],
      },
    ],
    ...overrides,
  };
}

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: APPROVAL,
    provider: 'sponsor_direct',
    platform: 'web',
    propertyIdentifier: 'https://app.pencillift.example',
    locale: 'en-US',
    intendedAudience: 'Adults in the parent area',
    vendorSdkVersion: null,
    policyReviewedAt: AT,
    evidenceRef: 'fixture:sponsor-web-review',
    evidenceQuality: 'fixture',
    approvalScope: 'Parent resource directory sponsor cards',
    publisherTag: null,
    linkingToolRef: null,
    status: 'approved',
    statusReason: null,
    expiresAt: '2027-09-20T15:00:00.000Z',
    createdAt: AT,
    ...overrides,
  };
}

const sponsor: Sponsor = {
  id: SPONSOR,
  businessName: 'Bright Owl Tutoring',
  contactRef: 'Contract BO-2026',
  allowedDomains: ['brightowl.example'],
  status: 'active',
  createdAt: AT,
};

function creative(overrides: Partial<Creative> = {}): Creative {
  return {
    id: CREATIVE,
    sponsorId: SPONSOR,
    version: 2,
    sponsorName: 'Bright Owl Tutoring',
    headline: '<script>alert(1)</script> Reading coaching',
    body: 'Small-group reading sessions with certified teachers.',
    ctaLabel: 'Learn more',
    destinationUrl: 'https://brightowl.example/reading',
    imageAssetRef: null,
    imageLicenseRef: null,
    reviewStatus: 'in_review',
    selfReviewed: false,
    reviewedAt: null,
    createdAt: AT,
    ...overrides,
  };
}

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: CAMPAIGN,
    sponsorId: SPONSOR,
    creativeId: CREATIVE,
    name: 'Fall reading push',
    placement: 'resources_browse',
    platforms: ['web', 'ios'],
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-11-01T00:00:00.000Z',
    impressionCap: 5000,
    feeModel: 'fixed_fee',
    contractedFeeCents: 50000,
    invoiceStatus: 'not_invoiced',
    status: 'draft',
    pausedReason: null,
    servableNow: false,
    notServableReason: 'STATUS',
    viewableImpressions: 120,
    ...overrides,
  };
}

function catalogItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: ITEM,
    stableKey: 'fraction-workbook',
    title: 'Fraction practice workbook',
    description: 'Short daily pages that compare fractions with pictures.',
    skills: ['math.fractions.compare'],
    subjects: ['math'],
    gradeMin: 3,
    gradeMax: 5,
    kind: 'workbook',
    merchant: 'amazon',
    merchantUrl: 'https://www.amazon.com/dp/B000000001',
    imageAssetRef: null,
    imageLicenseRef: null,
    availability: 'unknown',
    lastLinkCheckAt: null,
    lastLinkCheckStatus: null,
    status: 'draft',
    reviewedAt: null,
    ...overrides,
  };
}

function report(overrides: Partial<MonetizationReport> = {}): MonetizationReport {
  return {
    month: '2026-09',
    minCohort: 10,
    events: [
      {
        campaignId: null,
        catalogId: null,
        platform: 'web',
        placement: 'resources_browse',
        kind: 'opportunity',
        count: 240,
        suppressed: false,
      },
      {
        campaignId: CAMPAIGN,
        catalogId: null,
        platform: 'web',
        placement: 'resources_browse',
        kind: 'served',
        count: 120,
        suppressed: false,
      },
      {
        campaignId: CAMPAIGN,
        catalogId: null,
        platform: 'web',
        placement: 'resources_browse',
        kind: 'viewable_impression',
        count: 80,
        suppressed: false,
      },
      {
        campaignId: CAMPAIGN,
        catalogId: null,
        platform: 'web',
        placement: 'resources_browse',
        kind: 'click',
        count: null,
        suppressed: true,
      },
      {
        campaignId: null,
        catalogId: ITEM,
        platform: 'web',
        placement: 'resources_browse',
        kind: 'click',
        count: 0,
        suppressed: false,
      },
    ],
    revenue: {
      projectedCents: 900000,
      contractedCents: 50000,
      recognizedCents: 40000,
      receivedCents: 20000,
      affiliateReportedCents: 0,
      adjustments: { refund: -1500, reversal: 0, correction: 0 },
      excludedDoubleCountCents: 7000,
      conflicts: [
        {
          category: 'recognized',
          placement: 'resources_browse',
          periodMonth: '2026-09',
          excludedNetworkCents: 7000,
        },
      ],
      activeFamilies: 400,
      adEligibleAdults: 250,
      recognizedPerActiveFamilyCents: 100,
      recognizedPerAdEligibleAdultCents: 160,
    },
    revenueFromImportsOnly: true,
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Responder = (call: Call) => unknown;

const BASE = '/v1/admin/monetization';

/** Fake API routed by "METHOD path"; every value passes through the real contract schemas. */
function fakeApi(routes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const defaults: Record<string, unknown> = {
    [`GET ${BASE}/status`]: status(),
    [`GET ${BASE}/sponsors`]: { sponsors: [sponsor] },
    [`GET ${BASE}/placement-rules`]: {
      rules: [
        {
          placement: 'adult_dashboard',
          maxCardsPerScreen: 1,
          maxNewCardsPerSession: 3,
          minVisibleMs: 1000,
          minVisibleRatio: 0.5,
          enabled: true,
        },
      ],
    },
    [`GET ${BASE}/approvals`]: { approvals: [approval()] },
    [`GET ${BASE}/sponsors/${SPONSOR}/creatives`]: { creatives: [creative()] },
    [`GET ${BASE}/campaigns`]: { campaigns: [campaign()] },
    [`GET ${BASE}/catalog`]: { items: [catalogItem()] },
    [`GET ${BASE}/ad-reports`]: { reports: [] },
    [`GET ${BASE}/report`]: report(),
  };
  const table = { ...defaults, ...routes };
  const respond = (call: Call): unknown => {
    const key = `${call.method} ${call.path.split('?')[0]}`;
    if (!(key in table)) return new Error(`unexpected ${key}`);
    const value = table[key];
    return typeof value === 'function' ? (value as Responder)(call) : value;
  };
  const settle = <S extends z.ZodType>(call: Call, schema: S) => {
    calls.push(call);
    try {
      const value = respond(call);
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const api: Partial<ApiClient> = {
    get: (path, schema) => settle({ method: 'GET', path, body: undefined }, schema),
    send: (method, path, body, schema) => settle({ method, path, body }, schema),
  };
  const sent = () => calls.filter((c) => c.method !== 'GET');
  return { api, calls, sent };
}

// Vitest globals are off, so Testing Library cannot register its automatic cleanup.
afterEach(() => {
  cleanup();
});

async function region(name: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole('region', { name });
}

describe('MonetizationAdminPage access and honesty (spec P16.2, P16.5; AC_MON_09/15)', () => {
  it('shows only the MFA-required state when the owner session is refused', async () => {
    const { api } = fakeApi({
      [`GET ${BASE}/status`]: new ApiRequestError(
        'FORBIDDEN',
        'Owner administration requires an MFA session',
        403,
      ),
    });
    renderPage(<MonetizationAdminPage />, { api });
    expect(await screen.findByText(/Owner administration requires an MFA session/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /two-step verification/i })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /Kill switches/ })).toBeNull();
    expect(screen.queryByText(/Sponsors and creatives/)).toBeNull();
  });

  it('states that monetization is off by default and live activation is blocked', async () => {
    const { api } = fakeApi();
    renderPage(<MonetizationAdminPage />, { api });
    const banner = await screen.findByRole('note', { name: 'Monetization is off by default' });
    expect(within(banner).getByText(/Monetization is OFF by default/)).toBeTruthy();
    expect(
      within(banner).getByText(
        /Live Amazon Associates links and any ad network stay blocked until real approvals exist/,
      ),
    ).toBeTruthy();
    const status = await region('Kill switches and provider status');
    // A fixture never reads as live; blocked providers say why.
    expect(within(status).getByText(/labeled test fixture \(mock\)\. Not live\./)).toBeTruthy();
    expect(within(status).getByText('No ad network adapter ships in this build')).toBeTruthy();
    expect(within(status).queryByText(/^Live$/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bis live\b|\bgoing live\b|\blive now\b/i);
  });
});

describe('Kill switches (AC_MON_14)', () => {
  it('needs a reason and confirmation, then updates the switch and reloads status', async () => {
    const { api, calls, sent } = fakeApi({
      [`PUT ${BASE}/switches/global`]: (call: Call) => ({
        key: 'global',
        enabled: true,
        changedAt: AT,
        reason: (call.body as { reason: string }).reason,
      }),
    });
    renderPage(<MonetizationAdminPage />, { api });
    const status = await region('Kill switches and provider status');
    await userEvent.click(
      within(status).getByRole('button', { name: 'Turn on Global (all monetization)' }),
    );
    const form = within(status).getByRole('form', { name: 'Turn on Global (all monetization)' });
    expect(within(form).getByText(/This alone activates nothing/)).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: 'Turn on' }));
    expect(await within(form).findByText(/at least 3 characters/)).toBeTruthy();
    expect(sent()).toHaveLength(0);
    await userEvent.type(within(form).getByLabelText('Reason'), 'Fixture walkthrough');
    await userEvent.click(within(form).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'PUT',
      path: `${BASE}/switches/global`,
      body: { enabled: true, reason: 'Fixture walkthrough' },
    });
    expect(await screen.findByText('Global (all monetization) is now on.')).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === `${BASE}/status`).length).toBeGreaterThanOrEqual(2),
    );
  });
});

describe('Approvals (AC_MON_09/10)', () => {
  it('lists provider, platform, property, evidence, expiry and status, and revokes with a reason', async () => {
    const { api, sent } = fakeApi({
      [`POST ${BASE}/approvals/${APPROVAL}/revoke`]: approval({
        status: 'revoked',
        statusReason: 'Policy changed',
      }),
    });
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Provider and platform approvals');
    const table = await within(section).findByRole('table');
    expect(within(table).getByText('fixture:sponsor-web-review')).toBeTruthy();
    expect(
      within(table).getByText(/Fixture: labeled test mock, never counts in production/),
    ).toBeTruthy();
    expect(within(table).getByText('Sep 20, 2027, 15:00 UTC')).toBeTruthy();
    expect(within(table).getByText('Approved')).toBeTruthy();
    await userEvent.click(
      within(table).getByRole('button', { name: 'Revoke Direct sponsor Web approval' }),
    );
    await userEvent.type(within(table).getByLabelText('Reason'), 'Policy changed');
    await userEvent.click(within(table).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'POST',
      path: `${BASE}/approvals/${APPROVAL}/revoke`,
      body: { reason: 'Policy changed' },
    });
    expect(await within(section).findByText(/approval is now revoked/)).toBeTruthy();
  });

  it('records an approval and explains a placeholder evidence refusal', async () => {
    const { api, sent } = fakeApi({
      [`POST ${BASE}/approvals`]: new ApiRequestError(
        'BUSINESS_RULE',
        'Record a reference',
        422,
        'EVIDENCE_INVALID',
      ),
    });
    renderPage(<MonetizationAdminPage />, { api });
    const form = await screen.findByRole('form', { name: 'Record an approval' });
    await userEvent.selectOptions(within(form).getByLabelText('Provider'), 'amazon_associates');
    await userEvent.type(
      within(form).getByLabelText(/Property identifier/),
      'https://app.pencillift.example',
    );
    await userEvent.type(
      within(form).getByLabelText('Intended audience'),
      'Adults in the parent area',
    );
    await userEvent.type(within(form).getByLabelText(/Policy review date/), '2026-09-01T10:00');
    await userEvent.type(within(form).getByLabelText('Evidence reference'), 'approved');
    await userEvent.type(within(form).getByLabelText('Approval scope'), 'Resource browser links');
    await userEvent.type(within(form).getByLabelText(/Publisher-level tag/), 'pencillift-20');
    await userEvent.type(within(form).getByLabelText(/Expiry or revalidation/), '2027-09-01T10:00');
    await userEvent.click(within(form).getByRole('button', { name: 'Record approval' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.body).toEqual({
      provider: 'amazon_associates',
      platform: 'web',
      propertyIdentifier: 'https://app.pencillift.example',
      locale: 'en-US',
      intendedAudience: 'Adults in the parent area',
      vendorSdkVersion: null,
      policyReviewedAt: '2026-09-01T10:00:00.000Z',
      evidenceRef: 'approved',
      approvalScope: 'Resource browser links',
      publisherTag: 'pencillift-20',
      status: 'pending',
      expiresAt: '2027-09-01T10:00:00.000Z',
    });
    expect(
      await within(form).findByText(/A checkbox, account key or placeholder is not evidence/),
    ).toBeTruthy();
  });
});

describe('Amazon mobile linking tool (RV-MON-09, AC_MON_10)', () => {
  it('asks an iOS/Android Amazon approval for its permitted linking tool and explains a refusal', async () => {
    const { api, sent } = fakeApi({
      [`POST ${BASE}/approvals`]: new ApiRequestError(
        'BUSINESS_RULE',
        'Linking tool required',
        422,
        'LINKING_TOOL_REQUIRED',
      ),
    });
    renderPage(<MonetizationAdminPage />, { api });
    const form = await screen.findByRole('form', { name: 'Record an approval' });
    await userEvent.selectOptions(within(form).getByLabelText('Provider'), 'amazon_associates');
    expect(within(form).queryByLabelText(/Permitted linking tool/)).toBeNull();
    await userEvent.selectOptions(within(form).getByLabelText('Platform'), 'ios');
    await userEvent.type(within(form).getByLabelText(/Property identifier/), 'com.pencillift.app');
    await userEvent.type(
      within(form).getByLabelText('Intended audience'),
      'Adults in the parent area',
    );
    await userEvent.type(within(form).getByLabelText(/Policy review date/), '2026-09-01T10:00');
    await userEvent.type(
      within(form).getByLabelText('Evidence reference'),
      'OWNER-DOC/amazon-ios-2026-09#12',
    );
    await userEvent.type(within(form).getByLabelText('Approval scope'), 'Resource browser links');
    await userEvent.type(within(form).getByLabelText(/Publisher-level tag/), 'pencillift-20');
    await userEvent.type(
      within(form).getByLabelText(/Permitted linking tool/),
      'OWNER-DOC/amazon-linking-2026-09#13',
    );
    await userEvent.type(within(form).getByLabelText(/Expiry or revalidation/), '2027-09-01T10:00');
    await userEvent.click(within(form).getByRole('button', { name: 'Record approval' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.body).toMatchObject({
      provider: 'amazon_associates',
      platform: 'ios',
      linkingToolRef: 'OWNER-DOC/amazon-linking-2026-09#13',
    });
    expect(
      await within(form).findByText(/app needs its permitted linking tool or API recorded/),
    ).toBeTruthy();
  });

  it('shows whether an Amazon app approval records its linking tool', async () => {
    const { api } = fakeApi({
      [`GET ${BASE}/approvals`]: {
        approvals: [
          approval({
            provider: 'amazon_associates',
            platform: 'ios',
            publisherTag: 'pencillift-20',
          }),
        ],
      },
    });
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Provider and platform approvals');
    expect(
      await within(section).findByText(/Linking tool: not recorded \(affiliate links stay off\)/),
    ).toBeTruthy();
  });
});

describe('Sponsors and creatives (AC_MON_06)', () => {
  it('previews creative text as plain text and approves a version in review', async () => {
    const { api, sent } = fakeApi({
      [`POST ${BASE}/creatives/${CREATIVE}/approve`]: creative({
        reviewStatus: 'approved',
        selfReviewed: true,
        reviewedAt: AT,
      }),
    });
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Sponsors and creatives');
    await userEvent.click(await within(section).findByRole('button', { name: 'Creatives' }));
    const preview = await within(section).findByRole('group', { name: 'Preview of version 2' });
    expect(within(preview).getByText(/<script>alert\(1\)<\/script> Reading coaching/)).toBeTruthy();
    expect(within(preview).getByText('Sponsored by Bright Owl Tutoring')).toBeTruthy();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.querySelector('a, img, iframe')).toBeNull();

    await userEvent.click(within(section).getByRole('button', { name: 'Approve version 2' }));
    const form = within(section).getByRole('form', { name: 'Approve version 2' });
    await userEvent.click(within(form).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'POST',
      path: `${BASE}/creatives/${CREATIVE}/approve`,
      body: {},
    });
    expect(await within(section).findByText(/self-reviewed by the sole owner admin/)).toBeTruthy();
  });

  it('previews the reviewed "Sponsored by" name frozen with the version, not a later rename (RV-MON-05)', async () => {
    const { api } = fakeApi({
      [`GET ${BASE}/sponsors/${SPONSOR}/creatives`]: {
        creatives: [creative({ sponsorName: 'Bright Owl Learning', reviewStatus: 'approved' })],
      },
    });
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Sponsors and creatives');
    await userEvent.click(await within(section).findByRole('button', { name: 'Creatives' }));
    const preview = await within(section).findByRole('group', { name: 'Preview of version 2' });
    expect(within(preview).getByText('Sponsored by Bright Owl Learning')).toBeTruthy();
    expect(within(preview).queryByText('Sponsored by Bright Owl Tutoring')).toBeNull();
  });

  it('suspends a sponsor after confirmation', async () => {
    const { api, sent } = fakeApi({
      [`PATCH ${BASE}/sponsors/${SPONSOR}`]: { ...sponsor, status: 'suspended' },
    });
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Sponsors and creatives');
    await userEvent.click(
      await within(section).findByRole('button', { name: 'Suspend Bright Owl Tutoring' }),
    );
    await userEvent.click(within(section).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'PATCH',
      path: `${BASE}/sponsors/${SPONSOR}`,
      body: { status: 'suspended' },
    });
  });
});

describe('Campaigns (AC_MON_06/14)', () => {
  it('shows caps and dates and offers only the transitions the state allows', async () => {
    const { api, sent } = fakeApi({
      [`POST ${BASE}/campaigns/${CAMPAIGN}/transition`]: campaign({ status: 'in_review' }),
    });
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Campaigns');
    const table = await within(section).findByRole('table');
    expect(within(table).getByText(/120 of 5,000 viewable impressions/)).toBeTruthy();
    expect(
      within(table).getByText(/Oct 1, 2026, 00:00 UTC to Nov 1, 2026, 00:00 UTC/),
    ).toBeTruthy();
    expect(within(table).getByText('Fixed fee $500.00')).toBeTruthy();
    expect(within(table).getByText(/Not servable: Not scheduled or active/)).toBeTruthy();
    expect(within(table).queryByRole('button', { name: /^Activate/ })).toBeNull();
    await userEvent.click(
      within(table).getByRole('button', { name: 'Submit for review Fall reading push' }),
    );
    await userEvent.click(within(table).getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'POST',
      path: `${BASE}/campaigns/${CAMPAIGN}/transition`,
      body: { action: 'submit' },
    });
    expect(
      await within(section).findByText('Fall reading push is now in human review.'),
    ).toBeTruthy();
  });

  it('requires a reason to pause an active campaign', async () => {
    const { api, sent } = fakeApi({
      [`GET ${BASE}/campaigns`]: {
        campaigns: [campaign({ status: 'active', servableNow: true, notServableReason: null })],
      },
      [`POST ${BASE}/campaigns/${CAMPAIGN}/transition`]: campaign({
        status: 'paused',
        pausedReason: 'Sponsor asked to pause',
      }),
    });
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Campaigns');
    await userEvent.click(
      await within(section).findByRole('button', { name: 'Pause Fall reading push' }),
    );
    const form = within(section).getByRole('form', { name: 'Pause Fall reading push' });
    await userEvent.click(within(form).getByRole('button', { name: 'Pause' }));
    expect(await within(form).findByText(/at least 3 characters/)).toBeTruthy();
    await userEvent.type(within(form).getByLabelText('Reason'), 'Sponsor asked to pause');
    await userEvent.click(within(form).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.body).toEqual({ action: 'pause', reason: 'Sponsor asked to pause' });
  });

  it('edits the cap and dates as UTC instants', async () => {
    const { api, sent } = fakeApi({
      [`PATCH ${BASE}/campaigns/${CAMPAIGN}`]: campaign({ impressionCap: 8000 }),
    });
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Campaigns');
    await userEvent.click(
      await within(section).findByRole('button', {
        name: 'Edit caps and dates for Fall reading push',
      }),
    );
    const form = within(section).getByRole('form', {
      name: 'Caps and dates for Fall reading push',
    });
    const cap = within(form).getByLabelText('Viewable impression cap');
    await userEvent.clear(cap);
    await userEvent.type(cap, '8000');
    await userEvent.click(within(form).getByRole('button', { name: 'Save campaign' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.body).toEqual({
      impressionCap: 8000,
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-11-01T00:00:00.000Z',
      invoiceStatus: 'not_invoiced',
    });
  });
});

describe('Resource catalog (spec P10, P16.3; AC_MON_12)', () => {
  it('runs a link check and shows its result', async () => {
    const { api, sent } = fakeApi({
      [`POST ${BASE}/catalog/${ITEM}/link-check`]: {
        status: 'skipped',
        httpStatus: null,
        availability: 'unknown',
        note: 'No live request is made in the test environment.',
      },
    });
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Resource catalog');
    await userEvent.click(
      await within(section).findByRole('button', {
        name: 'Check link for Fraction practice workbook',
      }),
    );
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.path).toBe(`${BASE}/catalog/${ITEM}/link-check`);
    expect(
      await within(section).findByText(
        /Check skipped \(no network request made\)\. No live request/,
      ),
    ).toBeTruthy();
  });

  it('explains why a tagged Amazon link is refused', async () => {
    const { api } = fakeApi({
      [`POST ${BASE}/catalog`]: new ApiRequestError(
        'BUSINESS_RULE',
        'Affiliate parameters present',
        422,
        'AFFILIATE_PARAMS_PRESENT',
      ),
    });
    renderPage(<MonetizationAdminPage />, { api });
    const form = await screen.findByRole('form', { name: 'Add a catalog item' });
    await userEvent.type(within(form).getByLabelText('Stable key'), 'place-value-cards');
    await userEvent.type(within(form).getByLabelText('Title'), 'Place value cards');
    await userEvent.type(
      within(form).getByLabelText('Our own description'),
      'Cards that show ones, tens and hundreds.',
    );
    await userEvent.type(
      within(form).getByLabelText(/Plain product link/),
      'https://www.amazon.com/dp/B000000002?tag=someone-20',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Add item' }));
    expect(await within(form).findByText(/without a tag or tracking parameters/)).toBeTruthy();
  });
});

describe('Revenue imports and adjustments (AC_MON_17/18)', () => {
  it('validates pasted rows, imports them, and explains a duplicate import', async () => {
    let attempt = 0;
    const { api, sent } = fakeApi({
      [`POST ${BASE}/revenue/imports`]: () => {
        attempt += 1;
        return attempt === 1
          ? { importId: ENTRY, fileSha256: 'a'.repeat(64), rowCount: 1 }
          : new ApiRequestError('CONFLICT', 'Already imported', 409, 'DUPLICATE_IMPORT');
      },
    });
    renderPage(<MonetizationAdminPage />, { api });
    const form = await screen.findByRole('form', { name: 'Import revenue' });
    const rows = within(form).getByLabelText('Rows (JSON)');
    await userEvent.type(rows, 'not json');
    await userEvent.click(within(form).getByRole('button', { name: 'Import rows' }));
    expect(await within(form).findByText(/not valid JSON/)).toBeTruthy();
    expect(sent()).toHaveLength(0);

    const row = {
      externalRef: 'INV-1001',
      category: 'contracted',
      provider: 'sponsor_direct',
      campaignId: CAMPAIGN,
      placement: 'resources_browse',
      amountCents: 50000,
    };
    await userEvent.clear(rows);
    await userEvent.click(rows);
    await userEvent.paste(JSON.stringify([row]));
    await userEvent.clear(within(form).getByLabelText('Period month'));
    await userEvent.type(within(form).getByLabelText('Period month'), '2026-09');
    await userEvent.click(within(form).getByRole('button', { name: 'Import rows' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.body).toEqual({
      source: 'sponsor_invoice',
      periodMonth: '2026-09',
      note: null,
      rows: [row],
    });
    expect(await within(form).findByText(/Imported 1 row for September 2026/)).toBeTruthy();

    await userEvent.click(rows);
    await userEvent.paste(JSON.stringify([row]));
    await userEvent.click(within(form).getByRole('button', { name: 'Import rows' }));
    expect(
      await within(form).findByText('This file was already imported. Nothing was added.'),
    ).toBeTruthy();
  });

  it('rejects a positive refund and reuses the idempotency key on retry', async () => {
    let attempt = 0;
    const { api, sent } = fakeApi({
      [`POST ${BASE}/revenue/adjustments`]: () => {
        attempt += 1;
        return attempt === 1
          ? new ApiRequestError('NETWORK', 'You appear to be offline.', 0)
          : { id: CAMPAIGN, replayed: false };
      },
    });
    renderPage(<MonetizationAdminPage />, { api });
    const form = await screen.findByRole('form', { name: 'Record an adjustment' });
    await userEvent.type(within(form).getByLabelText('Revenue entry ID'), ENTRY);
    await userEvent.type(within(form).getByLabelText(/Amount \(USD/), '15');
    await userEvent.type(within(form).getByLabelText('Reason'), 'Sponsor refund');
    await userEvent.click(within(form).getByRole('button', { name: 'Record adjustment' }));
    expect(
      await within(form).findByText(/Refunds and reversals are negative amounts/),
    ).toBeTruthy();
    expect(sent()).toHaveLength(0);

    await userEvent.clear(within(form).getByLabelText(/Amount \(USD/));
    await userEvent.type(within(form).getByLabelText(/Amount \(USD/), '-15.00');
    await userEvent.click(within(form).getByRole('button', { name: 'Record adjustment' }));
    expect(await within(form).findByText(/offline/)).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: 'Record adjustment' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    const bodies = sent().map((c) => c.body as { idempotencyKey: string; amountCents: number });
    expect(bodies[0]!.amountCents).toBe(-1500);
    expect(bodies[0]!.idempotencyKey).toMatch(/^adj:[0-9a-f-]{36}$/);
    expect(bodies[1]!.idempotencyKey).toBe(bodies[0]!.idempotencyKey);
    expect(await within(form).findByText('Recorded a refund of -$15.00.')).toBeTruthy();
  });
});

describe('Monthly report (AC_MON_16/17/18)', () => {
  it('separates projected, contracted, recognized and received amounts and explains suppression', async () => {
    const { api } = fakeApi();
    renderPage(<MonetizationAdminPage />, { api });
    const section = await region('Monthly report');
    const banner = within(section).getByRole('note', { name: 'Projected amounts are not revenue' });
    expect(within(banner).getByText('Projected amounts are not revenue.')).toBeTruthy();
    await within(section).findByText(/Placement activity for September 2026/);

    const totals = within(section).getByRole('group', { name: 'Activity totals' });
    const row = (label: string) => within(totals).getByText(label).closest('tr')!;
    expect(within(row('Opportunities')).getByText('240')).toBeTruthy();
    expect(within(row('Served')).getByText('120')).toBeTruthy();
    expect(within(row('Viewable impressions')).getByText('80')).toBeTruthy();
    expect(within(row('Clicks')).getByText('1 group of <10 not included')).toBeTruthy();
    const detail = within(section).getByRole('group', { name: 'Activity detail' });
    expect(within(detail).getByText('<10')).toBeTruthy();
    expect(within(detail).getByText('0')).toBeTruthy();
    expect(
      within(section).getByText(/shown as “<10” so a small group can never be singled out/),
    ).toBeTruthy();

    const revenue = within(section).getByRole('group', { name: 'Revenue' });
    const line = (label: string | RegExp) => within(revenue).getByText(label).closest('tr')!;
    expect(within(line('Projected (not revenue)')).getByText('$9,000.00')).toBeTruthy();
    expect(within(line('Contracted sponsorship')).getByText('$500.00')).toBeTruthy();
    expect(within(line('Recognized revenue')).getByText('$400.00')).toBeTruthy();
    expect(within(line('Cash received')).getByText('$200.00')).toBeTruthy();
    expect(within(line(/Affiliate reported/)).getByText('$0.00')).toBeTruthy();
    expect(within(line('Refunds')).getByText('-$15.00')).toBeTruthy();
    expect(
      within(section).getByText(/Excluded \$70\.00 of network recognized revenue/),
    ).toBeTruthy();

    expect(
      within(section).getByText(
        /per active family \(all 400 families, including non-buyers and ad-free families\)/,
      ),
    ).toBeTruthy();
    expect(within(section).getByText('$1.00')).toBeTruthy();
    expect(within(section).getByText(/per ad-eligible adult \(250 adults/)).toBeTruthy();
    expect(within(section).getByText('$1.60')).toBeTruthy();
  });
});
