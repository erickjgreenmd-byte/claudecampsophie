import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CLOSE_COPY,
  DATA_PRACTICES_COPY,
  DATA_PRACTICE_ADULT_ID_STATES,
  DATA_PRACTICE_CHILD_WORK_STATES,
  DATA_PRACTICE_UNKNOWN,
  dataPracticeAdultIdText,
  dataPracticeChildWorkText,
  dataPracticesResponseSchema,
  DELETION_INTRO,
  deletionConfirmationCopy,
  deletionConfirmationMatches,
  deletionConfirmationMismatch,
  deletionConfirmationPhrase,
  deletionRequestedMessage,
  deletionRequestLabel,
  deletionStatusText,
  FAMILY_DELETION_CONFIRMATION,
  PRIVACY_RETENTION,
  privacyRetentionLines,
  STORE_NOTICE_CHANNELS,
  STORE_NOTICE_SUBJECTS,
  storeSubscriptionNotice,
  type DeletionRequest,
  type DeletionTarget,
  type StoreNoticeChannel,
  type StoreNoticeSubject,
} from './index.ts';

/**
 * The deletion and retention COPY both surfaces print (BUG-411 / L-070). These tests assert the
 * sentences and their BRANCHES here, where the definitions are, so neither surface needs to pin the
 * other's source text — the mistake that let a portal sentence be reverted with the whole mobile
 * suite green (BUG-410).
 *
 * Synthetic names only (Sam).
 */
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const samTarget: DeletionTarget = { scope: 'child', childId: SAM, nickname: 'Sam' };
const familyTarget: DeletionTarget = { scope: 'family' };

function request(overrides: Partial<DeletionRequest> = {}): DeletionRequest {
  return {
    id: 'be6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d',
    scope: 'child',
    childId: SAM,
    status: 'requested',
    requestedAt: '2026-09-24T15:00:00.000Z',
    completeBy: '2026-10-24T15:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

const iso = (value: string) => `<${value}>`;

describe('the store-subscription notice', () => {
  it('names every store where the surface cannot know which one bills the family', () => {
    for (const subject of STORE_NOTICE_SUBJECTS) {
      const line = storeSubscriptionNotice(subject, null);
      expect(line, subject).toContain('an App Store, Google Play or Amazon Appstore subscription');
      expect(line, subject).toContain(
        'the store that bills you (App Store, Google Play or Amazon Appstore)',
      );
      // Nothing is guessed as the reader's own store.
      expect(line, subject).not.toMatch(
        /your (App Store|Google Play|Amazon Appstore) subscription/,
      );
    }
  });

  it('names this build’s store where there is one, and only that one', () => {
    const named: Record<StoreNoticeChannel, RegExp> = {
      app_store: /your App Store subscription\b/,
      play_store: /your Google Play subscription\b/,
      amazon_appstore: /your Amazon Appstore subscription\b/,
    };
    for (const channel of STORE_NOTICE_CHANNELS) {
      const line = storeSubscriptionNotice('family', channel);
      expect(line, channel).toMatch(named[channel]);
      for (const other of STORE_NOTICE_CHANNELS) {
        if (other !== channel) expect(line, `${channel} vs ${other}`).not.toMatch(named[other]);
      }
    }
  });

  /**
   * The severity in BUG-411: the account-wide sentence stood over a single child's deletion. Every
   * subject must name what it is actually about, and no two subjects may share a sentence — two
   * subjects with one sentence is the defect, whichever two they are.
   */
  it('says what is being deleted, and no two subjects share a sentence', () => {
    expect(storeSubscriptionNotice('child', null)).toMatch(/^Deleting one child’s data /);
    expect(storeSubscriptionNotice('family', null)).toMatch(
      /^Deleting your PencilLift family account /,
    );
    expect(storeSubscriptionNotice('sign_in', null)).toMatch(/^Deleting your PencilLift account /);
    expect(storeSubscriptionNotice('any', null)).toMatch(/^Deleting a child’s data, /);
    const lines = STORE_NOTICE_SUBJECTS.map((s) => storeSubscriptionNotice(s, null));
    expect(new Set(lines).size).toBe(STORE_NOTICE_SUBJECTS.length);
  });

  /**
   * L-057, the fall-through: deleting ONE child neither cancels the subscription nor lowers its
   * price, so every subject whose reader could be deleting a child must say both. `any` is the
   * branch a subject nobody has added yet lands on, so it carries the complete claim.
   */
  it('does not promise a lower price to a parent deleting one child', () => {
    for (const subject of ['child', 'any'] as StoreNoticeSubject[]) {
      expect(storeSubscriptionNotice(subject, null), subject).toMatch(/or lower its price/);
    }
  });

  it('is the one the account-closure card says, for the sign-in it closes', () => {
    expect(ACCOUNT_CLOSE_COPY.storeNotice).toBe(storeSubscriptionNotice('sign_in', null));
    // "Delete my account" deletes no family data, so it must not say the family's sentence.
    expect(ACCOUNT_CLOSE_COPY.storeNotice).not.toBe(storeSubscriptionNotice('family', null));
  });
});

describe('the retention list', () => {
  it('states the six retention facts with the contract’s own day counts', () => {
    const lines = privacyRetentionLines(null);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain(`${PRIVACY_RETENTION.rawScanDays} days`);
    expect(lines[2]).toContain(`within ${PRIVACY_RETENTION.deletionTargetDays} days`);
    expect(lines[2]).toMatch(/devices are signed out and queued work is cancelled/);
    expect(lines[3]).toMatch(/backups expire on a documented schedule/i);
    expect(lines[4]).toMatch(/pseudonymous ids only — never homework or answers/);
    expect(lines[5]).toBe(storeSubscriptionNotice('any', null));
  });

  it('changes only its store line with the build’s store', () => {
    for (const channel of STORE_NOTICE_CHANNELS) {
      expect(privacyRetentionLines(channel).slice(0, 5)).toEqual(
        privacyRetentionLines(null).slice(0, 5),
      );
      expect(privacyRetentionLines(channel).at(-1)).toBe(storeSubscriptionNotice('any', channel));
    }
  });

  it('keeps the deletion intro on the same 30-day target', () => {
    expect(DELETION_INTRO).toContain(`within ${PRIVACY_RETENTION.deletionTargetDays} days`);
    expect(DELETION_INTRO).toMatch(/can’t be undone/);
  });
});

describe('the deletion confirmation', () => {
  it('asks for DELETE in capitals for the family and the nickname for a child', () => {
    expect(deletionConfirmationPhrase(familyTarget)).toBe(FAMILY_DELETION_CONFIRMATION);
    expect(deletionConfirmationPhrase(samTarget)).toBe('Sam');
    expect(deletionConfirmationMatches(familyTarget, ' DELETE ')).toBe(true);
    expect(deletionConfirmationMatches(familyTarget, 'delete')).toBe(false);
    expect(deletionConfirmationMatches(samTarget, ' sam ')).toBe(true);
    expect(deletionConfirmationMatches(samTarget, 'Riley')).toBe(false);
    expect(deletionConfirmationMismatch(familyTarget)).toBe(
      'Type DELETE in capital letters to confirm.',
    );
    expect(deletionConfirmationMismatch(samTarget)).toBe('Type Sam exactly to confirm.');
  });

  /**
   * BUG-411's highest-severity half. A parent confirming ONE child's deletion must not read the
   * family-wide sentence, which is a false statement about what is about to be deleted.
   */
  it('[repro] says what this scope deletes and what survives it, differently for each scope', () => {
    const child = deletionConfirmationCopy(samTarget, null);
    const family = deletionConfirmationCopy(familyTarget, null);

    expect(child.effect).toMatch(/^Removes Sam’s homework photos/);
    expect(child.effect).toMatch(
      /Your other children, your family account and your own sign-in stay\./,
    );
    expect(child.effect).not.toMatch(/every guardian/);

    expect(family.effect).toMatch(/^Deletes every child’s data and your family account/);
    expect(family.effect).toMatch(/removes access for every guardian/);
    expect(family.effect).not.toMatch(/stay/);

    // No field of the confirmation may read the same for both scopes except the store's own name.
    expect(child.effect).not.toBe(family.effect);
    expect(child.mismatch).not.toBe(family.mismatch);
    expect(child.typePrompt).not.toBe(family.typePrompt);
    expect(child.storeNotice).not.toBe(family.storeNotice);
  });

  it('takes its store sentence from the target, not from its caller', () => {
    expect(deletionConfirmationCopy(samTarget, 'amazon_appstore').storeNotice).toBe(
      storeSubscriptionNotice('child', 'amazon_appstore'),
    );
    expect(deletionConfirmationCopy(familyTarget, 'amazon_appstore').storeNotice).toBe(
      storeSubscriptionNotice('family', 'amazon_appstore'),
    );
  });

  it('[repro] answers the request with the scope’s own sentence', () => {
    const child = deletionRequestedMessage(samTarget, 'Oct 24, 2026');
    const family = deletionRequestedMessage(familyTarget, 'Oct 24, 2026');
    expect(child).toContain('Sam');
    expect(child).toMatch(/your other children and your account stay/);
    expect(child).toContain('Oct 24, 2026');
    expect(family).toMatch(/Your family account and every child’s data are deleted/);
    expect(family).not.toMatch(/stay/);
    expect(child).not.toBe(family);
  });
});

describe('the deletion requests list', () => {
  it('names the whole family or the child whose data it is', () => {
    expect(deletionRequestLabel({ scope: 'family' }, 'Sam')).toBe('Whole family account');
    expect(deletionRequestLabel({ scope: 'child' }, 'Sam')).toBe('Sam’s data');
  });

  it('reports every status through the surface’s own date format', () => {
    expect(deletionStatusText(request(), iso)).toBe(
      'Requested: processing has stopped. Deletion completes by <2026-10-24T15:00:00.000Z>.',
    );
    expect(deletionStatusText(request({ status: 'processing' }), iso)).toBe(
      'Deleting now. Completes by <2026-10-24T15:00:00.000Z>.',
    );
    expect(
      deletionStatusText(
        request({ status: 'completed', completedAt: '2026-10-01T00:00:00.000Z' }),
        iso,
      ),
    ).toBe('Deleted on <2026-10-01T00:00:00.000Z>.');
    // A completed purge whose instant was not recorded claims no date rather than inventing one.
    expect(deletionStatusText(request({ status: 'completed' }), iso)).toBe('Deleted.');
    expect(deletionStatusText(request({ status: 'cancelled' }), iso)).toBe('Cancelled.');
  });
});

describe('data-practices copy: the one place both surfaces read it from', () => {
  it('every state has a sentence, and the view helpers are total', () => {
    for (const state of DATA_PRACTICE_CHILD_WORK_STATES) {
      expect(dataPracticeChildWorkText(state).length, state).toBeGreaterThan(40);
    }
    for (const state of DATA_PRACTICE_ADULT_ID_STATES) {
      expect(dataPracticeAdultIdText(state)?.length, state).toBeGreaterThan(40);
    }
    expect(dataPracticeChildWorkText(DATA_PRACTICE_UNKNOWN)).toBe(DATA_PRACTICES_COPY.unconfirmed);
    expect(dataPracticeAdultIdText(DATA_PRACTICE_UNKNOWN)).toBeNull();
  });

  it('a “not sent” state carries no retention claim and names no AI company', () => {
    // BUG-430 as a rule rather than a story: zero data retention is a claim about a grant that may
    // not exist, so the only sentences allowed to make it are the ones a verified state publishes.
    for (const text of [
      DATA_PRACTICES_COPY.childWork.not_sent,
      DATA_PRACTICES_COPY.adultId.not_sent,
    ]) {
      expect(text.toLowerCase()).not.toContain('zero data retention');
      expect(text).not.toContain('OpenAI');
    }
  });

  it('the states that DO send name who receives it, and the retention position', () => {
    expect(DATA_PRACTICES_COPY.childWork.openai_under_zdr).toContain('OpenAI');
    expect(DATA_PRACTICES_COPY.childWork.openai_under_zdr.toLowerCase()).toContain('does not keep');
    expect(DATA_PRACTICES_COPY.adultId.openai_under_zdr).toContain('OpenAI');
    expect(DATA_PRACTICES_COPY.adultId.identity_vendor.toLowerCase()).toContain('identity vendor');
  });

  it('the unknown sentence discloses: it takes the wider case, not the comfortable one', () => {
    /*
     * The direction of the whole mechanism, and the one assertion that would survive someone
     * "tidying" the fallback into something friendlier. The gate fails closed by refusing to SEND;
     * a notice fails closed by assuming it was sent (L-082). Same words, opposite directions.
     */
    expect(DATA_PRACTICES_COPY.unconfirmed).toContain('OpenAI');
    expect(DATA_PRACTICES_COPY.unconfirmed.toLowerCase()).not.toContain('nothing your child');
    expect(DATA_PRACTICES_COPY.unconfirmed).not.toBe(DATA_PRACTICES_COPY.childWork.not_sent);
  });

  it('no shared sentence names a control, because the two surfaces have different ones', () => {
    // L-078: a sentence both surfaces print may name the VALUE and not the widget. "Tap" is wrong
    // on a portal, "click" is wrong on a phone, and "the link below" is wrong wherever the layout
    // changes. The way out to the policy is each surface's own, which is why only a LABEL is shared.
    const CONTROL_WORDS =
      /\b(tap|click|press|swipe|button|the link below|below|above|on the right|on the left)\b/i;
    for (const text of [
      ...Object.values(DATA_PRACTICES_COPY.childWork),
      ...Object.values(DATA_PRACTICES_COPY.adultId),
      DATA_PRACTICES_COPY.unconfirmed,
    ]) {
      expect(CONTROL_WORDS.test(text), text).toBe(false);
    }
  });

  it('the response shape is strict: no reference, no extra field, no “unknown”', () => {
    expect(
      dataPracticesResponseSchema.safeParse({ childWork: 'not_sent', adultId: 'not_sent' }).success,
    ).toBe(true);
    for (const body of [
      { childWork: 'unknown', adultId: 'not_sent' },
      { childWork: 'not_sent', adultId: 'unknown' },
      { childWork: 'not_sent' },
      { childWork: 'not_sent', adultId: 'not_sent', zdrReference: 'OAI-SYNTHETIC-0001' },
      { childWork: 'not_sent', adultId: 'not_sent', verifiedAt: '2026-10-01' },
    ]) {
      expect(dataPracticesResponseSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
