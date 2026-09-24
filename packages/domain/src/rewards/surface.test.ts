// Points are a family motivational ledger, not money (P9, P16.4). These tests pin the public
// surface so a cash-out, transfer or purchase path cannot be added without failing review.
import { describe, expect, it } from 'vitest';
import * as rewards from './index.ts';
import { LEARNING_EVENT_KINDS, LEDGER_ENTRY_KINDS, REDEMPTION_ACTIONS } from './index.ts';

const MONEY_WORDS =
  /cash|payout|withdraw|transfer|purchase|buy|sell|wallet|pay(?!load)|refund|convert|exchange|gift ?card|affiliate|sponsor|\bad(?:s|vert)/i;

describe('points are not money (AC_REWARDS_04, AC_MON_13)', () => {
  it('exports no cash-out, transfer, purchase or monetization function', () => {
    const functionNames = Object.entries(rewards)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(functionNames.length).toBeGreaterThan(0);
    expect(functionNames.filter((name) => MONEY_WORDS.test(name))).toEqual([]);
  });

  it('ledger entry kinds, learning event kinds and redemption actions contain no money movement', () => {
    expect([...LEDGER_ENTRY_KINDS]).toEqual([
      'award',
      'adjustment',
      'redemption_reserve',
      'redemption_release',
    ]);
    expect([...LEARNING_EVENT_KINDS]).toEqual(['practice_attempt', 'set_completed']);
    expect([...REDEMPTION_ACTIONS].sort()).toEqual(['approve', 'cancel', 'decline', 'fulfill']);
  });
});
