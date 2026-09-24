import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CAMPAIGN_TRANSITIONS,
  CAMPAIGN_STATES,
  campaignServableReason,
  campaignTransition,
  type CampaignEvent,
  type CampaignState,
} from './index.ts';
import { NOW, campaign } from './test-fixtures.ts';

const END = new Date('2026-10-01T00:00:00Z');

describe('campaignTransition (spec P16.5, AC_MON_06)', () => {
  it('walks draft -> review -> scheduled -> active -> paused -> active -> ended', () => {
    let state: CampaignState = 'draft';
    const events: CampaignEvent[] = [
      { type: 'submit' },
      { type: 'approve', creativeApproved: true },
      { type: 'activate', creativeApproved: true, now: NOW, endsAt: END },
      { type: 'pause' },
      { type: 'resume', now: NOW, endsAt: END },
      { type: 'end' },
    ];
    const seen: CampaignState[] = [];
    for (const event of events) {
      const next = campaignTransition(state, event);
      expect(next.ok).toBe(true);
      if (next.ok) state = next.value;
      seen.push(state);
    }
    expect(seen).toEqual(['in_review', 'scheduled', 'active', 'paused', 'active', 'ended']);
  });

  it('cannot approve or activate with an unapproved creative', () => {
    const approve = campaignTransition('in_review', { type: 'approve', creativeApproved: false });
    expect(approve.ok ? null : approve.error.code).toBe('CREATIVE_NOT_APPROVED');
    const activate = campaignTransition('scheduled', {
      type: 'activate',
      creativeApproved: false,
      now: NOW,
      endsAt: END,
    });
    expect(activate.ok ? null : activate.error.code).toBe('CREATIVE_NOT_APPROVED');
  });

  it('a creative change sends reviewed campaigns back to review', () => {
    for (const state of ['scheduled', 'active', 'paused'] as const) {
      expect(campaignTransition(state, { type: 'creative_changed' })).toEqual({
        ok: true,
        value: 'in_review',
      });
    }
    expect(campaignTransition('draft', { type: 'creative_changed' })).toEqual({
      ok: true,
      value: 'draft',
    });
    expect(campaignTransition('ended', { type: 'creative_changed' }).ok).toBe(false);
  });

  it('refuses activation or resume after the end date', () => {
    const late = new Date('2026-10-02T00:00:00Z');
    const r = campaignTransition('paused', { type: 'resume', now: late, endsAt: END });
    expect(r.ok ? null : r.error.code).toBe('CAMPAIGN_ENDED');
  });

  it('every successful transition is in the DB guard table; ended is terminal (property)', () => {
    const eventArb: fc.Arbitrary<CampaignEvent> = fc.oneof(
      fc.constant({ type: 'submit' } as const),
      fc.record({ type: fc.constant('approve' as const), creativeApproved: fc.boolean() }),
      fc.constant({ type: 'reject' } as const),
      fc.record({
        type: fc.constant('activate' as const),
        creativeApproved: fc.boolean(),
        now: fc.constant(NOW),
        endsAt: fc.constantFrom(END, new Date('2026-09-01T00:00:00Z')),
      }),
      fc.constant({ type: 'pause' } as const),
      fc.record({
        type: fc.constant('resume' as const),
        now: fc.constant(NOW),
        endsAt: fc.constant(END),
      }),
      fc.constant({ type: 'end' } as const),
      fc.constant({ type: 'creative_changed' } as const),
      fc.constant({ type: 'revise' } as const),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...CAMPAIGN_STATES),
        fc.array(eventArb, { maxLength: 20 }),
        (start, events) => {
          let state: CampaignState = start;
          for (const event of events) {
            const next = campaignTransition(state, event);
            if (!next.ok) continue;
            if (next.value !== state && !ALLOWED_CAMPAIGN_TRANSITIONS[state].includes(next.value))
              return false;
            if (state === 'ended') return false;
            if (next.value === 'active' && 'creativeApproved' in event && !event.creativeApproved)
              return false;
            state = next.value;
          }
          return true;
        },
      ),
    );
  });
});

describe('campaignServableReason (AC_MON_06, AC_MON_14)', () => {
  const where = { placement: 'resources_browse' as const, platform: 'ios' as const, now: NOW };

  it('serves an active, in-window, under-cap campaign and a scheduled one once its window opens', () => {
    expect(campaignServableReason(campaign(), where)).toBeNull();
    expect(campaignServableReason(campaign({ status: 'scheduled' }), where)).toBeNull();
  });

  it.each([
    [{ status: 'paused' as const }, 'STATUS'],
    [{ status: 'ended' as const }, 'STATUS'],
    [{ status: 'in_review' as const }, 'STATUS'],
    [{ sponsorActive: false }, 'SPONSOR_SUSPENDED'],
    [{ creativeApproved: false }, 'CREATIVE_NOT_APPROVED'],
    [{ placement: 'adult_dashboard' as const }, 'WRONG_PLACEMENT'],
    [{ platforms: ['web' as const] }, 'WRONG_PLATFORM'],
    [{ startsAt: new Date('2026-09-25T00:00:00Z') }, 'NOT_STARTED'],
    [{ endsAt: NOW }, 'EXPIRED'],
    [{ impressionCap: 10, viewableImpressions: 10 }, 'CAP_REACHED'],
  ])('%j -> %s', (overrides, reason) => {
    expect(campaignServableReason(campaign(overrides), where)).toBe(reason);
  });
});
