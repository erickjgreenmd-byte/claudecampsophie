import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  planAdjustment,
  type AccrualForAdjustment,
  type AdjustmentEvent,
  type DonationAdjustment,
  type ProviderPeriodState,
} from './adjustments.ts';

const UNPAID: AccrualForAdjustment = {
  id: 'acc_riley_2026_09',
  amountCents: 100,
  payoutStatus: 'unpaid',
};
const PAID: AccrualForAdjustment = { ...UNPAID, payoutStatus: 'paid' };

function apply(
  accrual: AccrualForAdjustment,
  events: readonly AdjustmentEvent[],
  providerState?: (event: AdjustmentEvent) => ProviderPeriodState,
): DonationAdjustment[] {
  const keys = new Set<string>();
  const made: DonationAdjustment[] = [];
  for (const event of events) {
    const adjustment = planAdjustment({
      accrual,
      event,
      existingAdjustmentKeys: keys,
      ...(providerState ? { providerState: providerState(event) } : {}),
    });
    if (adjustment) {
      expect(keys.has(adjustment.idempotencyKey)).toBe(false);
      keys.add(adjustment.idempotencyKey);
      made.push(adjustment);
    }
  }
  return made;
}

const net = (adjustments: readonly DonationAdjustment[]): number =>
  100 + adjustments.reduce((sum, a) => sum + a.amountCents, 0);

describe('planAdjustment — refunds and chargebacks never delete ledger rows (AC_PROMO_12)', () => {
  it.each(['refund', 'partial_refund', 'chargeback'] as const)(
    'a %s reverses an unpaid accrual by exactly -100',
    (event) => {
      const adjustment = planAdjustment({
        accrual: UNPAID,
        event,
        existingAdjustmentKeys: new Set(),
      });
      expect(adjustment).toEqual({
        idempotencyKey: 'acc_riley_2026_09:reversal',
        accrualId: 'acc_riley_2026_09',
        kind: 'reversal',
        amountCents: -100,
        event,
        carriedForward: false,
      });
    },
  );

  it('a refund after payout creates a negative adjustment carried to the next payout batch', () => {
    const adjustment = planAdjustment({
      accrual: PAID,
      event: 'refund',
      existingAdjustmentKeys: new Set(),
    });
    expect(adjustment).toMatchObject({ amountCents: -100, carriedForward: true, kind: 'reversal' });
  });

  it('the reversal applies once: replayed refunds, a later partial refund or chargeback add nothing', () => {
    const made = apply(UNPAID, ['refund', 'refund', 'partial_refund', 'chargeback']);
    expect(made.map((a) => a.idempotencyKey)).toEqual(['acc_riley_2026_09:reversal']);
    expect(net(made)).toBe(0);
  });

  it('a chargeback reversal after a chargeback reinstates +100 exactly once', () => {
    const made = apply(PAID, ['chargeback', 'chargeback_reversed', 'chargeback_reversed']);
    expect(made.map((a) => [a.idempotencyKey, a.amountCents])).toEqual([
      ['acc_riley_2026_09:reversal', -100],
      ['acc_riley_2026_09:reinstatement', 100],
    ]);
    expect(made[1]?.carriedForward).toBe(true);
    expect(net(made)).toBe(100);
  });

  it('a chargeback reversal without a prior reversal does nothing', () => {
    expect(
      planAdjustment({
        accrual: UNPAID,
        event: 'chargeback_reversed',
        existingAdjustmentKeys: new Set(),
      }),
    ).toBeNull();
  });

  it('a won dispute does not reinstate while the provider still shows a refund on the period', () => {
    const adjustment = planAdjustment({
      accrual: PAID,
      event: 'chargeback_reversed',
      existingAdjustmentKeys: new Set(['acc_riley_2026_09:reversal']),
      providerState: { settlement: 'partially_refunded', refundedCents: 1000 },
    });
    expect(adjustment).toBeNull();
  });

  it('a refund after a reinstatement reverses one final time, then nothing further', () => {
    const made = apply(PAID, [
      'chargeback',
      'chargeback_reversed',
      'refund',
      'chargeback_reversed',
      'refund',
    ]);
    expect(made.map((a) => a.kind)).toEqual(['reversal', 'reinstatement', 'final_reversal']);
    expect(net(made)).toBe(0);
  });

  it('never mutates the accrual or the existing key set', () => {
    const accrual = Object.freeze({ ...UNPAID });
    const keys = new Set<string>();
    planAdjustment({ accrual, event: 'refund', existingAdjustmentKeys: keys });
    expect(accrual).toEqual(UNPAID);
    expect(keys.size).toBe(0);
  });

  it('rejects an accrual that is not a 100-cent donation (programmer error)', () => {
    expect(() =>
      planAdjustment({
        accrual: { ...UNPAID, amountCents: 200 },
        event: 'refund',
        existingAdjustmentKeys: new Set(),
      }),
    ).toThrow(RangeError);
  });

  it('property: over any provider event sequence the accrual nets to 0 or 100, and never pays for a refunded or disputed period', () => {
    const eventArb = fc.constantFrom<AdjustmentEvent>(
      'refund',
      'partial_refund',
      'chargeback',
      'chargeback_reversed',
    );
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 12 }), fc.boolean(), (events, paid) => {
        // Simulated provider truth: refunds are permanent; a chargeback is open until reversed.
        let refunded = false;
        let disputeOpen = false;
        const keys = new Set<string>();
        let total = 100;
        for (const event of events) {
          if (event === 'chargeback_reversed' && !disputeOpen) continue; // providers never send this
          if (event === 'refund' || event === 'partial_refund') refunded = true;
          if (event === 'chargeback') disputeOpen = true;
          if (event === 'chargeback_reversed') disputeOpen = false;
          const providerState: ProviderPeriodState = refunded
            ? { settlement: 'partially_refunded', refundedCents: 500 }
            : disputeOpen
              ? { settlement: 'chargeback', refundedCents: 4998 }
              : { settlement: 'settled', refundedCents: 0 };
          const adjustment = planAdjustment({
            accrual: paid ? PAID : UNPAID,
            event,
            existingAdjustmentKeys: keys,
            providerState,
          });
          if (adjustment) {
            expect(keys.has(adjustment.idempotencyKey)).toBe(false);
            expect(adjustment.carriedForward).toBe(paid);
            keys.add(adjustment.idempotencyKey);
            total += adjustment.amountCents;
          }
          expect([0, 100]).toContain(total);
          if (refunded || disputeOpen) expect(total).toBe(0);
        }
      }),
    );
  });
});
