import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_STATUSES,
  MAX_ACCESS_AFTER_PERIOD_END_MS,
  grantsAccess,
  type EntitlementStatus,
} from './status.ts';
import { NOW, PERIOD_END } from './test-fixtures.ts';

const anyInstant = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) })
  .map((ms) => new Date(ms));

describe('P11 access states (AC_BILLING_03)', () => {
  it('active grants access', () => {
    expect(grantsAccess('active', PERIOD_END, NOW)).toBe(true);
  });

  it('grace period retains paid access even after the nominal period end', () => {
    const afterPeriodEnd = new Date(PERIOD_END.getTime() + 3 * 86_400_000);
    expect(grantsAccess('grace_period', PERIOD_END, afterPeriodEnd)).toBe(true);
  });

  it('cancelled_active (auto-renew off) grants only until the paid period ends', () => {
    expect(grantsAccess('cancelled_active', PERIOD_END, NOW)).toBe(true);
    expect(grantsAccess('cancelled_active', PERIOD_END, new Date(PERIOD_END.getTime() - 1))).toBe(
      true,
    );
    expect(grantsAccess('cancelled_active', PERIOD_END, PERIOD_END)).toBe(false);
    expect(grantsAccess('cancelled_active', PERIOD_END, new Date(PERIOD_END.getTime() + 1))).toBe(
      false,
    );
  });

  it('active and grace_period are time-bounded: they lapse a fixed window after the period end', () => {
    const limit = new Date(PERIOD_END.getTime() + MAX_ACCESS_AFTER_PERIOD_END_MS);
    expect(MAX_ACCESS_AFTER_PERIOD_END_MS).toBe(30 * 86_400_000);
    for (const status of ['active', 'grace_period'] as const) {
      expect(grantsAccess(status, PERIOD_END, new Date(limit.getTime() - 1))).toBe(true);
      expect(grantsAccess(status, PERIOD_END, limit)).toBe(false);
      expect(grantsAccess(status, PERIOD_END, new Date(limit.getTime() + 365 * 86_400_000))).toBe(
        false,
      );
    }
  });

  it('property: no status grants access once the post-period window has passed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ENTITLEMENT_STATUSES),
        anyInstant,
        fc.integer({ min: 0, max: 5 * 365 * 86_400_000 }),
        (status, end, pastLimit) => {
          const now = new Date(end.getTime() + MAX_ACCESS_AFTER_PERIOD_END_MS + pastLimit);
          expect(grantsAccess(status, end, now)).toBe(false);
        },
      ),
    );
  });

  it('billing retry does not grant access (store grace is modelled as grace_period)', () => {
    expect(grantsAccess('billing_retry', PERIOD_END, NOW)).toBe(false);
  });

  it('pending/Ask to Buy, expired, revoked and refunded never grant, whatever the period end', () => {
    const neverGrant: EntitlementStatus[] = ['pending', 'expired', 'revoked', 'refunded'];
    fc.assert(
      fc.property(fc.constantFrom(...neverGrant), anyInstant, anyInstant, (status, end, now) => {
        expect(grantsAccess(status, end, now)).toBe(false);
      }),
    );
  });

  it('only active, grace_period and cancelled_active can ever grant', () => {
    const granting = ENTITLEMENT_STATUSES.filter((status) => grantsAccess(status, PERIOD_END, NOW));
    expect([...granting].sort()).toEqual(['active', 'cancelled_active', 'grace_period']);
  });

  it('an unknown status from untrusted provider data fails closed', () => {
    expect(grantsAccess('lifetime_free' as EntitlementStatus, PERIOD_END, NOW)).toBe(false);
  });

  it('rejects invalid instants as a programmer error', () => {
    expect(() => grantsAccess('active', new Date(Number.NaN), NOW)).toThrow(RangeError);
    expect(() => grantsAccess('active', PERIOD_END, new Date(Number.NaN))).toThrow(RangeError);
  });
});
