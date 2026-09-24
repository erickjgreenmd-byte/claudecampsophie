import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  REDEMPTION_EVENTS,
  REDEMPTION_STATES,
  isDuplicateDelivery,
  isLiveState,
  transitionRedemption,
  type RedemptionEvent,
  type RedemptionState,
} from './redemption-state.ts';

const ALLOWED: ReadonlyArray<[RedemptionState, RedemptionEvent, RedemptionState]> = [
  ['reserved', 'submit_to_provider', 'provider_pending'],
  ['reserved', 'reservation_timeout', 'expired'],
  ['provider_pending', 'provider_confirmed', 'confirmed'],
  ['provider_pending', 'provider_rejected', 'rejected'],
  ['provider_pending', 'reconcile_applied', 'confirmed'],
  ['provider_pending', 'reconcile_not_applied', 'rejected'],
  ['confirmed', 'period_completed', 'reconciled'],
];

function run(events: readonly RedemptionEvent[]): RedemptionState {
  let state: RedemptionState = 'reserved';
  for (const event of events) {
    const next = transitionRedemption(state, event);
    if (next.ok) state = next.value;
  }
  return state;
}

describe('P17 durable redemption state machine (AC_PROMO_05, AC_PROMO_09)', () => {
  it.each(ALLOWED)('%s --%s--> %s', (from, event, to) => {
    expect(transitionRedemption(from, event)).toEqual({ ok: true, value: to });
  });

  it('every other (state, event) pair is INVALID_TRANSITION', () => {
    for (const from of REDEMPTION_STATES) {
      for (const event of REDEMPTION_EVENTS) {
        if (ALLOWED.some(([f, e]) => f === from && e === event)) continue;
        const result = transitionRedemption(from, event);
        expect(result.ok, `${from} + ${event}`).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_TRANSITION');
          expect(result.error.details).toEqual({ from, event });
        }
      }
    }
  });

  it('an ambiguous provider_pending reservation never times out; only reconciliation decides', () => {
    expect(transitionRedemption('provider_pending', 'reservation_timeout').ok).toBe(false);
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...REDEMPTION_EVENTS), { maxLength: 12 }), (events) => {
        let state: RedemptionState = 'provider_pending';
        for (const event of events) {
          const next = transitionRedemption(state, event);
          if (next.ok) state = next.value;
          expect(state).not.toBe('expired');
        }
      }),
    );
  });

  it('rejected, expired and reconciled are terminal', () => {
    for (const terminal of ['rejected', 'expired', 'reconciled'] as const) {
      for (const event of REDEMPTION_EVENTS) {
        expect(transitionRedemption(terminal, event).ok).toBe(false);
      }
    }
  });

  it('once confirmed, no event sequence can un-confirm a granted benefit (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...REDEMPTION_EVENTS), { maxLength: 12 }), (events) => {
        const state = run(['submit_to_provider', 'provider_confirmed', ...events]);
        expect(['confirmed', 'reconciled']).toContain(state);
      }),
    );
  });

  it('live states (count against caps, budget and uniqueness) are reserved, provider_pending, confirmed, reconciled', () => {
    expect(REDEMPTION_STATES.filter(isLiveState)).toEqual([
      'reserved',
      'provider_pending',
      'confirmed',
      'reconciled',
    ]);
    expect(isLiveState('mystery' as RedemptionState)).toBe(true);
  });

  it('recognizes redelivered webhooks for an already-applied event as duplicates, not errors', () => {
    expect(isDuplicateDelivery('confirmed', 'provider_confirmed')).toBe(true);
    expect(isDuplicateDelivery('confirmed', 'reconcile_applied')).toBe(true);
    expect(isDuplicateDelivery('rejected', 'provider_rejected')).toBe(true);
    expect(isDuplicateDelivery('provider_pending', 'submit_to_provider')).toBe(true);
    expect(isDuplicateDelivery('reconciled', 'period_completed')).toBe(true);
    expect(isDuplicateDelivery('reconciled', 'provider_confirmed')).toBe(true);
    // A confirmation for a reservation that expired unsubmitted is NOT a duplicate: it needs review.
    expect(isDuplicateDelivery('expired', 'provider_confirmed')).toBe(false);
    // Conflicting provider outcomes are never silently absorbed.
    expect(isDuplicateDelivery('confirmed', 'provider_rejected')).toBe(false);
    expect(isDuplicateDelivery('rejected', 'provider_confirmed')).toBe(false);
  });
});
