// Synthetic fixtures for promotions tests. Not exported from the module's public API.
import type { CampaignTemplate } from './templates.ts';

export const TEMPLATE_A = '00000000-0000-4000-8000-00000000000a';
export const TEMPLATE_B = '00000000-0000-4000-8000-00000000000b';
export const TEMPLATE_C = '00000000-0000-4000-8000-00000000000c';
export const SCHOOL_MAPLE = '00000000-0000-4000-8000-0000000005c1';
export const SCHOOL_BIRCH = '00000000-0000-4000-8000-0000000005c2';
export const FAMILY_RILEY = '00000000-0000-4000-8000-00000000fa01';

/** A fully valid, enabled, UTC-confirmed shared-code template (50% off, all tiers/classes/channels). */
export function makeTemplate(overrides: Partial<CampaignTemplate> = {}): CampaignTemplate {
  return {
    id: TEMPLATE_A,
    enabled: true,
    paused: false,
    schoolId: null,
    percentOff: 50,
    eligibleTiers: [1, 2, 3, 4],
    subscriberEligibility: ['new', 'existing', 'lapsed'],
    redemptionCap: 500,
    budgetCapCents: 1_000_000,
    calendarTimezone: 'UTC',
    timezoneConfirmed: true,
    redemptionWindow: { startDay: 1, endDay: 'end_of_month' },
    codeMode: 'shared',
    sharedCodeUsageCap: 500,
    channels: ['app_store', 'play_store', 'stripe'],
    ...overrides,
  };
}

/** The same template in individual-code mode (no shared usage cap). */
export function makeIndividualTemplate(
  overrides: Partial<CampaignTemplate> = {},
): CampaignTemplate {
  const { sharedCodeUsageCap: _omit, ...shared } = makeTemplate();
  return { ...shared, codeMode: 'individual', individualCodeCount: 200, ...overrides };
}

export const iso = (value: string): Date => new Date(value);
