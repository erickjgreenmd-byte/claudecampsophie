import { describe, expect, it } from 'vitest';
import type { PlacementResponse, ResourceItem, ResourcesResponse } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import type { AppMode } from '../lib/mode.ts';
import {
  apiLocale,
  buildResourcesView,
  buildSponsorCardView,
  CHILD_MODE_REFUSAL,
  gradeRange,
  monetizationError,
  NO_FILTERS,
  outboundPath,
  placementPath,
  resourcesPath,
  skillOptions,
} from './view-model.ts';

// Synthetic catalog and sponsor data only.
const ASSOCIATES = 'As an Amazon Associate I earn from qualifying purchases.';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

function item(overrides: Partial<ResourceItem> = {}): ResourceItem {
  return {
    id: '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c',
    title: 'Fraction practice workbook',
    description: 'Short daily pages that compare fractions with pictures and number lines.',
    kind: 'workbook',
    subjects: ['math'],
    skills: ['math.fractions.compare'],
    gradeMin: 3,
    gradeMax: 5,
    relevance: 11,
    mode: 'amazon_associates',
    merchant: 'amazon',
    disclosure: ASSOCIATES,
    price: null,
    priceNote: 'Check current price on Amazon.',
    availability: 'available',
    imageAssetRef: null,
    ...overrides,
  };
}

const exercise = item({
  id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
  title: 'Kitchen fraction hunt',
  kind: 'parent_exercise',
  mode: 'education_only',
  merchant: 'none',
  disclosure: null,
  priceNote: null,
});

function data(overrides: Partial<ResourcesResponse> = {}): ResourcesResponse {
  return {
    mode: 'amazon_associates',
    commercialHidden: false,
    items: [item(), exercise],
    ...overrides,
  };
}

const served: PlacementResponse = {
  card: {
    serveToken: TOKEN,
    placement: 'resources_browse',
    label: 'Sponsored by Bright Owl Tutoring',
    headline: 'Weekly reading coaching',
    body: 'Small-group reading sessions.',
    ctaLabel: 'Learn more',
    destinationHost: 'brightowl.example',
    imageAssetRef: null,
    whyShown: 'Shown in the parent resource directory.',
  },
  reason: 'served',
};
const visible = { hideAffiliate: false, hideSponsorCards: false };

describe('resources view model refuses outside parent mode (AC_MON_02/03)', () => {
  it.each<AppMode>(['child', 'signed_out'])('produces no cards in %s mode', (mode) => {
    const view = buildResourcesView(mode, data(), NO_FILTERS);
    expect(view).toEqual({ kind: 'refused', message: CHILD_MODE_REFUSAL });
    expect(JSON.stringify(view)).not.toMatch(/Amazon|Associate|Sponsored/);
    expect(buildSponsorCardView(mode, served, visible, 'resources_browse')).toBeNull();
  });

  it('produces cards only in parent mode', () => {
    const view = buildResourcesView('parent', data(), NO_FILTERS);
    expect(view.kind).toBe('ready');
    expect(buildSponsorCardView('parent', served, visible, 'resources_browse')).not.toBeNull();
  });
});

describe('resource cards (spec P10, P16.3; AC_MON_08/12)', () => {
  it('puts the Associates disclosure beside the link and in its accessibility hint', () => {
    const view = buildResourcesView('parent', data(), NO_FILTERS);
    if (view.kind !== 'ready') throw new Error('expected ready');
    const [workbook, free] = view.cards;
    expect(workbook!.link).toEqual({
      mode: 'amazon_associates',
      label: 'View on Amazon',
      disclosure: ASSOCIATES,
      a11yLabel: 'View on Amazon: Fraction practice workbook',
      a11yHint: `${ASSOCIATES} Opens in your browser, outside PencilLift.`,
    });
    expect(workbook!.priceNote).toBe('Check current price on Amazon.');
    expect(workbook!.meta).toBe('Workbook · Grades 3–5 · Math');
    expect(free!.link).toBeNull();
    expect(free!.freeNote).toBe('Free: no purchase needed.');
    expect(free!.priceNote).toBeNull();
    expect(view.orderNote).toMatch(/Commission never changes the order/);
    // Never a price.
    expect(JSON.stringify(view)).not.toMatch(/\$\s?\d/);
  });

  it('always uses the required Associates sentence in affiliate mode, whatever the server sent', () => {
    const view = buildResourcesView(
      'parent',
      data({ items: [item({ disclosure: 'Shop now' })] }),
      NO_FILTERS,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.cards[0]!.link!.disclosure).toBe(ASSOCIATES);
  });

  it('labels plain links "External link" and education-only items without a link', () => {
    const view = buildResourcesView(
      'parent',
      data({
        items: [
          item({ mode: 'plain_link', disclosure: 'External link' }),
          item({ id: '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', mode: 'education_only' }),
          item({ id: '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b', availability: 'unavailable' }),
        ],
      }),
      NO_FILTERS,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.cards[0]!.link!.disclosure).toBe('External link');
    expect(view.cards[1]!.link).toBeNull();
    expect(view.cards[1]!.noLinkNote).toMatch(/No outside link is offered here/);
    expect(view.cards[1]!.priceNote).toBeNull();
    expect(view.cards[2]!.link).toBeNull();
    expect(view.cards[2]!.availabilityNote).toBe('Currently unavailable.');
  });

  it('shows the changed disclosure for an item whose link mode changed', () => {
    const view = buildResourcesView(
      'parent',
      data({ items: [item({ mode: 'plain_link', disclosure: 'External link' })] }),
      NO_FILTERS,
      { [item().id]: 'amazon_associates' },
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.cards[0]!.link!.disclosure).toBe(ASSOCIATES);
  });

  it('notes hidden shopping links and empty results', () => {
    const hidden = buildResourcesView(
      'parent',
      data({ commercialHidden: true, items: [] }),
      NO_FILTERS,
    );
    if (hidden.kind !== 'ready') throw new Error('expected ready');
    expect(hidden.hiddenNote).toMatch(/Shopping links are hidden/);
    expect(hidden.emptyMessage).toMatch(/No resources match yet/);
  });

  it('marks items that practice the focus skill', () => {
    const view = buildResourcesView('parent', data(), {
      ...NO_FILTERS,
      skill: 'math.fractions.compare',
    });
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.cards[0]!.meta).toMatch(/Practices your focus skill/);
  });
});

describe('sponsor card view (spec P16.1; AC_MON_04/05)', () => {
  it('labels the card and explains why it is shown and where it leads', () => {
    const view = buildSponsorCardView('parent', served, visible, 'resources_browse');
    expect(view).toEqual({
      serveToken: TOKEN,
      label: 'Sponsored by Bright Owl Tutoring',
      whyShown: 'Shown in the parent resource directory.',
      headline: 'Weekly reading coaching',
      body: 'Small-group reading sessions.',
      ctaLabel: 'Learn more',
      leaveNote: 'Opens brightowl.example in your browser. You will leave PencilLift.',
      ctaA11yHint:
        'Sponsored by Bright Owl Tutoring. Opens brightowl.example in your browser. You will leave PencilLift.',
    });
  });

  it('shows nothing when hidden, not served, or for another placement', () => {
    expect(
      buildSponsorCardView(
        'parent',
        served,
        { hideAffiliate: false, hideSponsorCards: true },
        'resources_browse',
      ),
    ).toBeNull();
    expect(buildSponsorCardView('parent', served, null, 'resources_browse')).toBeNull();
    expect(
      buildSponsorCardView(
        'parent',
        { card: null, reason: 'ad_free' },
        visible,
        'resources_browse',
      ),
    ).toBeNull();
    expect(buildSponsorCardView('parent', served, visible, 'adult_dashboard')).toBeNull();
  });

  it('never presents an unlabeled card as anything but an advertisement', () => {
    const view = buildSponsorCardView(
      'parent',
      { ...served, card: { ...served.card!, label: 'Bright Owl Tutoring' } },
      visible,
      'resources_browse',
    );
    expect(view!.label).toBe('Advertisement: Bright Owl Tutoring');
  });
});

describe('request paths and errors', () => {
  it('builds parent-selected context queries without child data', () => {
    expect(
      resourcesPath({ subject: 'math', grade: 0, skill: 'math.fractions.compare' }, 'ios', 'en-US'),
    ).toBe(
      '/v1/resources?platform=ios&subject=math&grade=0&skill=math.fractions.compare&locale=en-US',
    );
    expect(resourcesPath(NO_FILTERS, 'android', null)).toBe('/v1/resources?platform=android');
    expect(outboundPath('abc', 'ios', 'en-US')).toBe(
      '/v1/resources/abc/outbound?platform=ios&locale=en-US',
    );
    expect(placementPath('resources_browse', 'ios', null)).toBe(
      '/v1/placements?placement=resources_browse&platform=ios',
    );
  });

  it('passes only well-formed device locales', () => {
    expect(apiLocale('en-US')).toBe('en-US');
    expect(apiLocale('en')).toBeNull();
    expect(apiLocale(undefined)).toBeNull();
  });

  it('lists skills from the loaded items plus the chosen one', () => {
    expect(skillOptions([item(), exercise], 'reading.main_idea')).toEqual([
      'math.fractions.compare',
      'reading.main_idea',
    ]);
    expect(gradeRange(0, 2)).toBe('Grades K–2');
    expect(gradeRange(4, 4)).toBe('Grade 4');
  });

  it('asks for the PIN on step-up and words other failures by context', () => {
    const stepUp = new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403);
    expect(monetizationError(stepUp, 'load')).toEqual({
      message: 'Enter your parent PIN to continue.',
      needsPin: true,
    });
    const gone = new ApiRequestError('NOT_FOUND', 'gone', 404);
    expect(monetizationError(gone, 'load').message).toMatch(/Create your family first/);
    expect(monetizationError(gone, 'link').message).toBe('This resource is no longer available.');
    const blocked = new ApiRequestError('BUSINESS_RULE', 'x', 422, 'LINKS_UNAVAILABLE');
    expect(monetizationError(blocked, 'link').message).toBe(
      'This resource has no outside link here.',
    );
    expect(monetizationError(new Error('boom'), 'load').message).toMatch(/couldn’t load/);
  });
});
