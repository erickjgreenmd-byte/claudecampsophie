// The one note both surfaces print beside a child's points balance (packages/contracts/src/family.ts).
// Synthetic names only.
import { describe, expect, it } from 'vitest';
import {
  CHILD_PROFILE_STATUSES,
  REWARD_BALANCE_DELETION_PENDING_NOTE,
  REWARD_BALANCE_STATUS_NOTE,
  REWARD_BALANCE_UNKNOWN_STATUS_NOTE,
  rewardBalanceStatusNote,
} from './family.ts';

describe('rewardBalanceStatusNote', () => {
  it('has exactly one arm per child status, so a fourth status cannot reuse a third one’s sentence', () => {
    // L-057: the shape of the map is the guard. A status added to CHILD_PROFILE_STATUSES without a
    // sentence here fails this, instead of silently landing on the arm next to it.
    expect(Object.keys(REWARD_BALANCE_STATUS_NOTE).sort()).toEqual(
      [...CHILD_PROFILE_STATUSES].sort(),
    );
  });

  it('says nothing about a live balance and names the reason for every closed one', () => {
    expect(rewardBalanceStatusNote({ status: 'active' })).toBeNull();
    for (const status of CHILD_PROFILE_STATUSES.filter((s) => s !== 'active')) {
      const note = rewardBalanceStatusNote({ status });
      expect(note).not.toBeNull();
      // The claim is about the points, not just the profile: the parent is reading a number.
      expect(note).toMatch(/history only/);
    }
    expect(rewardBalanceStatusNote({ status: 'archived' })).toBe('(archived — history only)');
    expect(rewardBalanceStatusNote({ status: 'draft' })).toBe('(no paid slot — history only)');
  });

  it('never tells an unknown status it has no paid slot (BUG-406’s mistake)', () => {
    // The portal's inline version read `status === 'archived' ? 'archived' : 'no paid slot'`, so
    // anything else — a status added later, a typo from a hand-built fixture — was told a cause that
    // is not known to be true. The consequence is certain for every non-active status; the cause is
    // not, so only the known arms name one.
    for (const status of ['suspended', 'pending_activation', '', 'ACTIVE']) {
      const note = rewardBalanceStatusNote({ status });
      expect(note).toBe(REWARD_BALANCE_UNKNOWN_STATUS_NOTE);
      expect(note).not.toMatch(/no paid slot|archived/);
      expect(note).toMatch(/history only/);
    }
  });

  it('does not inherit a sentence from Object.prototype', () => {
    // `Object.hasOwn`, not `in`: 'toString' and 'constructor' are not statuses.
    expect(rewardBalanceStatusNote({ status: 'toString' })).toBe(
      REWARD_BALANCE_UNKNOWN_STATUS_NOTE,
    );
    expect(rewardBalanceStatusNote({ status: 'constructor' })).toBe(
      REWARD_BALANCE_UNKNOWN_STATUS_NOTE,
    );
  });

  it('never claims kept history while a purge is deleting it', () => {
    // `public.request_deletion` archives a child-scope target (migrations 0600, 0890), so a
    // deletion-pending child IS archived: a map keyed on status alone would print "history only"
    // about the one child whose history is being deleted. The flag is therefore read first.
    for (const status of [...CHILD_PROFILE_STATUSES, 'something-new']) {
      const note = rewardBalanceStatusNote({ status, deletionPending: true });
      expect(note).toBe(REWARD_BALANCE_DELETION_PENDING_NOTE);
      expect(note).not.toMatch(/history only/);
      expect(note).toMatch(/deletion/);
    }
    // `deletionPending: false` and an absent flag are the same case, and `undefined` is explicit
    // because `exactOptionalPropertyTypes` is on (see ChildCopySubject).
    expect(rewardBalanceStatusNote({ status: 'archived', deletionPending: false })).toBe(
      '(archived — history only)',
    );
    expect(rewardBalanceStatusNote({ status: 'archived', deletionPending: undefined })).toBe(
      '(archived — history only)',
    );
  });
});
