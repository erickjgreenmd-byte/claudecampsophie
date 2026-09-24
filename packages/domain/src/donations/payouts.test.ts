import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planAdjustment } from './adjustments.ts';
import {
  PAYOUT_STATUSES,
  buildPayoutBatch,
  previewPayoutBatch,
  transitionPayout,
  type PayoutAccrualInput,
  type PayoutAdjustmentInput,
  type PayoutEvent,
  type PayoutStatus,
} from './payouts.ts';
import { MAPLE, OAK } from './test-fixtures.ts';

const accrual = (id: string, donationMonth = '2026-09'): PayoutAccrualInput => ({
  id,
  schoolId: MAPLE,
  donationMonth,
  amountCents: 100,
});

const BASE = {
  schoolId: MAPLE,
  batchKey: 'payout_maple_2026_10',
  recipientVerified: true,
  transfersEnabled: true,
} as const;

describe('buildPayoutBatch — accrual is not payment (AC_PROMO_12)', () => {
  it('sums unpaid accruals and unapplied adjustments into one accrued batch with ordered lines', () => {
    const result = buildPayoutBatch({
      ...BASE,
      accruals: [
        accrual('acc_b', '2026-09'),
        accrual('acc_a', '2026-08'),
        accrual('acc_c', '2026-09'),
      ],
      adjustments: [
        {
          idempotencyKey: 'acc_z:reversal',
          accrualId: 'acc_z',
          schoolId: MAPLE,
          amountCents: -100,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      status: 'accrued',
      schoolId: MAPLE,
      batchKey: 'payout_maple_2026_10',
      totalCents: 200,
    });
    expect(result.value.lines).toEqual([
      { kind: 'accrual', accrualId: 'acc_a', donationMonth: '2026-08', amountCents: 100 },
      { kind: 'accrual', accrualId: 'acc_b', donationMonth: '2026-09', amountCents: 100 },
      { kind: 'accrual', accrualId: 'acc_c', donationMonth: '2026-09', amountCents: 100 },
      {
        kind: 'adjustment',
        adjustmentKey: 'acc_z:reversal',
        accrualId: 'acc_z',
        amountCents: -100,
      },
    ]);
  });

  it('a refund after payout is carried forward: alone it produces no transfer, then reduces the next batch', () => {
    const reversal = planAdjustment({
      accrual: { id: 'acc_paid', amountCents: 100, payoutStatus: 'paid' },
      event: 'refund',
      existingAdjustmentKeys: new Set(),
    });
    if (!reversal) throw new Error('expected a reversal');
    expect(reversal.carriedForward).toBe(true);
    const carried: PayoutAdjustmentInput = {
      idempotencyKey: reversal.idempotencyKey,
      accrualId: reversal.accrualId,
      schoolId: MAPLE,
      amountCents: reversal.amountCents,
    };

    const alone = buildPayoutBatch({ ...BASE, accruals: [], adjustments: [carried] });
    expect(alone).toEqual({
      ok: true,
      value: expect.objectContaining({ status: 'carried_forward', totalCents: -100 }),
    });

    const next = buildPayoutBatch({
      ...BASE,
      accruals: [accrual('acc_nov_1', '2026-11'), accrual('acc_nov_2', '2026-11')],
      adjustments: [carried],
    });
    expect(next.ok && next.value.status).toBe('accrued');
    expect(next.ok && next.value.totalCents).toBe(100);
  });

  it('an empty or zero-net batch is carried forward without needing transfers or verification', () => {
    const result = buildPayoutBatch({
      ...BASE,
      recipientVerified: false,
      transfersEnabled: false,
      accruals: [accrual('acc_a')],
      adjustments: [
        {
          idempotencyKey: 'acc_a:reversal',
          accrualId: 'acc_a',
          schoolId: MAPLE,
          amountCents: -100,
        },
      ],
    });
    expect(result.ok && result.value.status).toBe('carried_forward');
    expect(result.ok && result.value.totalCents).toBe(0);
  });

  it('requires a verified school recipient', () => {
    const result = buildPayoutBatch({
      ...BASE,
      recipientVerified: false,
      accruals: [accrual('acc_a')],
      adjustments: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RECIPIENT_NOT_VERIFIED');
  });

  it('refuses a payable batch while transfers are disabled (development)', () => {
    const result = buildPayoutBatch({
      ...BASE,
      transfersEnabled: false,
      accruals: [accrual('acc_a')],
      adjustments: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TRANSFERS_DISABLED');
  });

  it('the admin preview shows amount owed even while transfers are disabled', () => {
    const preview = previewPayoutBatch({
      schoolId: MAPLE,
      batchKey: 'preview',
      accruals: [accrual('acc_a'), accrual('acc_b')],
      adjustments: [],
    });
    expect(preview.totalCents).toBe(200);
  });

  it('refuses accruals or adjustments of another school, duplicates and non-$1 amounts', () => {
    const build =
      (accruals: PayoutAccrualInput[], adjustments: PayoutAdjustmentInput[] = []) =>
      () =>
        buildPayoutBatch({ ...BASE, accruals, adjustments });
    expect(build([{ ...accrual('acc_a'), schoolId: OAK }])).toThrow(RangeError);
    expect(build([accrual('acc_a'), accrual('acc_a')])).toThrow(RangeError);
    expect(build([{ ...accrual('acc_a'), amountCents: 150 }])).toThrow(RangeError);
    const adj: PayoutAdjustmentInput = {
      idempotencyKey: 'k',
      accrualId: 'acc_x',
      schoolId: MAPLE,
      amountCents: -100,
    };
    expect(build([], [adj, adj])).toThrow(RangeError);
    expect(build([], [{ ...adj, schoolId: OAK }])).toThrow(RangeError);
    expect(build([], [{ ...adj, amountCents: -250 }])).toThrow(RangeError);
  });

  it('property: total equals the sum of its lines; only a positive total becomes a payable batch', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc.array(fc.constantFrom(-100, 100), { maxLength: 8 }),
        (accrualCount, adjustmentAmounts) => {
          const result = buildPayoutBatch({
            ...BASE,
            accruals: Array.from({ length: accrualCount }, (_, i) => accrual(`acc_${i}`)),
            adjustments: adjustmentAmounts.map((amountCents, i) => ({
              idempotencyKey: `acc_old_${i}:reversal`,
              accrualId: `acc_old_${i}`,
              schoolId: MAPLE,
              amountCents,
            })),
          });
          if (!result.ok) throw new Error(result.error.code);
          const sum = result.value.lines.reduce((s, l) => s + l.amountCents, 0);
          expect(result.value.totalCents).toBe(sum);
          expect(sum).toBe(accrualCount * 100 + adjustmentAmounts.reduce((s, a) => s + a, 0));
          expect(result.value.status).toBe(sum > 0 ? 'accrued' : 'carried_forward');
        },
      ),
    );
  });
});

describe('transitionPayout — statuses accrued, approved, paid, failed, adjusted', () => {
  const approve: PayoutEvent = {
    type: 'approve',
    batchKey: 'payout_maple_2026_10',
    recipientVerified: true,
    transfersEnabled: true,
  };

  it('accrued → approved → paid with an external transfer reference', () => {
    const approved = transitionPayout('accrued', approve);
    expect(approved).toEqual({
      ok: true,
      value: { status: 'approved', transferIdempotencyKey: 'payout_maple_2026_10' },
    });
    const paid = transitionPayout('approved', {
      type: 'mark_paid',
      transferReference: 'tr_sandbox_0001',
    });
    expect(paid).toEqual({
      ok: true,
      value: { status: 'paid', transferReference: 'tr_sandbox_0001' },
    });
  });

  it.each(['', '   '])(
    'marking paid requires an external transfer reference (%j)',
    (transferReference) => {
      const result = transitionPayout('approved', { type: 'mark_paid', transferReference });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('MISSING_TRANSFER_REFERENCE');
    },
  );

  it('rejects a transfer reference with control characters or excessive length', () => {
    for (const transferReference of ['tr_1\u0000', 'x'.repeat(201)]) {
      const result = transitionPayout('approved', { type: 'mark_paid', transferReference });
      expect(!result.ok && result.error.code).toBe('INVALID_TRANSFER_REFERENCE');
    }
  });

  it('a reference with no readable letter or digit is missing, however it is padded (RV-donations-3)', () => {
    for (const transferReference of [
      '\u200b',
      '\ufeff',
      '\u3164', // HANGUL FILLER: a default-ignorable letter
      '\u2800', // BRAILLE PATTERN BLANK
      ' \u200b\u00a0',
      '---',
    ]) {
      const result = transitionPayout('approved', { type: 'mark_paid', transferReference });
      expect(!result.ok && result.error.code, JSON.stringify(transferReference)).toBe(
        'MISSING_TRANSFER_REFERENCE',
      );
    }
  });

  it('a reference hiding invisible or bidi characters is rejected, not silently cleaned (RV-donations-3)', () => {
    for (const transferReference of [
      'tr_\u200b1',
      'tr_1\u2060',
      'tr_\u202e1', // right-to-left override
      'tr_1\u00ad',
      'tr_\u20281', // line separator inside (trim() only removes it at the ends)
      'tr_\ue0001', // private use
    ]) {
      const result = transitionPayout('approved', { type: 'mark_paid', transferReference });
      expect(!result.ok && result.error.code, JSON.stringify(transferReference)).toBe(
        'INVALID_TRANSFER_REFERENCE',
      );
    }
  });

  it('ordinary references, including inner spaces and accented letters, are accepted as trimmed', () => {
    for (const [input, stored] of [
      ['ACH 000123', 'ACH 000123'],
      ['  réf-2026-10  ', 'réf-2026-10'],
      ['tr_1Abc', 'tr_1Abc'],
    ] as const) {
      expect(transitionPayout('approved', { type: 'mark_paid', transferReference: input })).toEqual(
        { ok: true, value: { status: 'paid', transferReference: stored } },
      );
    }
  });

  it('a failed transfer is retried with the same batch idempotency key, so it can never become a second transfer', () => {
    const first = transitionPayout('accrued', approve);
    const failed = transitionPayout('approved', { type: 'mark_failed' });
    expect(failed).toEqual({ ok: true, value: { status: 'failed' } });
    const retry = transitionPayout('failed', approve);
    expect(retry.ok && retry.value).toEqual(first.ok && first.value);
  });

  it('an approved or paid batch cannot be submitted again', () => {
    for (const status of ['approved', 'paid', 'adjusted'] as const) {
      const result = transitionPayout(status, approve);
      expect(!result.ok && result.error.code).toBe('INVALID_TRANSITION');
    }
  });

  it('approval re-checks recipient verification and the transfer switch', () => {
    const unverified = transitionPayout('accrued', { ...approve, recipientVerified: false });
    expect(!unverified.ok && unverified.error.code).toBe('RECIPIENT_NOT_VERIFIED');
    const disabled = transitionPayout('failed', { ...approve, transfersEnabled: false });
    expect(!disabled.ok && disabled.error.code).toBe('TRANSFERS_DISABLED');
  });

  it('paid → adjusted records a later adjustment without rewriting the paid history', () => {
    expect(transitionPayout('paid', { type: 'adjust' })).toEqual({
      ok: true,
      value: { status: 'adjusted' },
    });
    expect(transitionPayout('adjusted', { type: 'adjust' })).toEqual({
      ok: true,
      value: { status: 'adjusted' },
    });
    expect(transitionPayout('accrued', { type: 'adjust' }).ok).toBe(false);
  });

  it('every transition outside the documented table is rejected', () => {
    const events: readonly PayoutEvent[] = [
      approve,
      { type: 'mark_paid', transferReference: 'tr_sandbox_0002' },
      { type: 'mark_failed' },
      { type: 'adjust' },
    ];
    const allowed = new Set([
      'accrued:approve',
      'failed:approve',
      'approved:mark_paid',
      'approved:mark_failed',
      'paid:adjust',
      'adjusted:adjust',
    ]);
    for (const status of PAYOUT_STATUSES as readonly PayoutStatus[]) {
      for (const event of events) {
        const result = transitionPayout(status, event);
        expect(result.ok).toBe(allowed.has(`${status}:${event.type}`));
        if (!result.ok) expect(result.error.code).toBe('INVALID_TRANSITION');
      }
    }
  });
});
