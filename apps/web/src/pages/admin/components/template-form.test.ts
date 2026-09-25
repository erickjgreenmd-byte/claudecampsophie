import { describe, expect, it } from 'vitest';
import {
  campaignSummarySchema,
  channelSchema,
  MAX_PROMO_BUDGET_CENTS,
  promoTemplateInputSchema,
} from '@pencillift/contracts';
import {
  emptyTemplateForm,
  MAX_BUDGET_CENTS,
  templateToForm,
  unsavedSettings,
  validateTemplateForm,
  type PromoTemplate,
  type TemplateFormValues,
} from './template-form.ts';

// Synthetic data only.
const TEMPLATE = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';

function saved(overrides: Partial<PromoTemplate> = {}): PromoTemplate {
  return {
    id: TEMPLATE,
    name: 'October families',
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
    codeMode: 'shared',
    channels: ['play_store'],
    enabled: true,
    paused: false,
    createdAt: '2026-09-20T15:00:00.000Z',
    ...overrides,
  };
}

function form(overrides: Partial<TemplateFormValues> = {}): TemplateFormValues {
  return {
    ...emptyTemplateForm(),
    name: 'October families',
    percentOff: '25',
    eligibleTiers: [1],
    subscriberEligibility: ['existing'],
    redemptionCap: '300',
    budgetDollars: '2500',
    timezoneConfirmed: true,
    channels: ['play_store'],
    ...overrides,
  };
}

describe('budget cap bound (RV-p17-ui-2)', () => {
  it('only accepts budgets the campaign list contract can carry', () => {
    // Invariant: a budget the console accepts is copied into campaigns and must be listable.
    expect(MAX_BUDGET_CENTS).toBe(MAX_PROMO_BUDGET_CENTS);
    expect(campaignSummarySchema.shape.budgetCapCents.safeParse(MAX_BUDGET_CENTS).success).toBe(
      true,
    );
    expect(
      promoTemplateInputSchema.shape.budgetCapCents.safeParse(MAX_BUDGET_CENTS + 1).success,
    ).toBe(false);
  });

  it('accepts exactly $1,000,000.00 and rejects one cent more', () => {
    const at = validateTemplateForm(form({ budgetDollars: '1000000.00' }));
    expect(at.ok && at.input.budgetCapCents).toBe(100_000_000);
    const over = validateTemplateForm(form({ budgetDollars: '1000000.01' }));
    expect(over.ok ? null : over.errors.budgetDollars).toBe(
      'The monthly budget cap can be at most $1,000,000.00.',
    );
  });
});

describe('code-setting edits the server now applies (RV-p17-ui-3)', () => {
  // PATCH replaces the code settings as a group whenever codeMode is sent, so the form sends
  // exactly the settings on screen and leaves out what the owner emptied.
  it('switching individual codes to one shared code sends no individual count', () => {
    const original = saved({ codeMode: 'individual', individualCodeCount: 100 });
    const result = validateTemplateForm({ ...templateToForm(original), codeMode: 'shared' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.codeMode).toBe('shared');
    expect(result.input.individualCodeCount).toBeUndefined();
  });

  it('clearing a saved usage cap sends no cap', () => {
    const original = saved({ sharedCodeUsageCap: 50 });
    const cleared = validateTemplateForm({ ...templateToForm(original), sharedCodeUsageCap: '' });
    expect(cleared.ok && cleared.input.sharedCodeUsageCap).toBeUndefined();
    expect(cleared.ok && cleared.input.codeMode).toBe('shared');
  });

  it('switching a capped shared code to individual codes sends no cap', () => {
    const original = saved({ sharedCodeUsageCap: 50 });
    const result = validateTemplateForm({
      ...templateToForm(original),
      codeMode: 'individual',
      individualCodeCount: '250',
    });
    expect(result.ok && result.input.sharedCodeUsageCap).toBeUndefined();
    expect(result.ok && result.input.individualCodeCount).toBe(250);
  });
});

describe('unsavedSettings compares the stored template with the submitted form', () => {
  it('finds a value the server kept', () => {
    const result = validateTemplateForm(form());
    if (!result.ok) throw new Error('expected a valid form');
    const stored = saved({
      eligibleTiers: [1],
      budgetCapCents: 250_000,
      sharedCodeUsageCap: 50,
    });
    expect(unsavedSettings(result.input, stored)).toEqual(['sharedCodeUsageCap']);
  });

  it('treats lists as sets', () => {
    const result = validateTemplateForm(form({ eligibleTiers: [1, 2] }));
    if (!result.ok) throw new Error('expected a valid form');
    expect(unsavedSettings(result.input, saved({ eligibleTiers: [2, 1] }))).toEqual([]);
  });
});

describe('Amazon Appstore channel (R2C-WEB-2)', () => {
  it('keeps every contract channel, in channelSchema order, when the form is validated', () => {
    const result = validateTemplateForm(
      form({ channels: ['amazon_appstore', 'stripe', 'play_store', 'app_store'] }),
    );
    expect(result.ok && result.input.channels).toEqual(channelSchema.options);
  });

  it('round-trips a saved Amazon template through the edit form unchanged', () => {
    const result = validateTemplateForm(templateToForm(saved({ channels: ['amazon_appstore'] })));
    expect(result.ok && result.input.channels).toEqual(['amazon_appstore']);
  });
});
