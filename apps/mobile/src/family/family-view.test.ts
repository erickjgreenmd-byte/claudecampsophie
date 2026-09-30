import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildDevice, FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  activationError,
  activationMessage,
  childArchiveLabel,
  childEditBody,
  childEditDriftNote,
  childPlanEditable,
  childRows,
  childStatusText,
  deviceRows,
  loadStateForRun,
  parentActionError,
  slotSummary,
  unusedPaidSlots,
} from './family-view.ts';

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const family: FamilyOverview = {
  id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
  displayName: 'Test Family',
  timezone: 'America/Chicago',
  paidSlots: 1,
  billingConflict: null,
  managingChannel: null,
  children: [
    { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
    { id: SAM, nickname: 'Sam', gradeLevel: 0, ageBand: '5-7', status: 'draft' },
  ],
};

describe('family view models', () => {
  it('spells out child status and only lets active children pair', () => {
    const [riley, sam] = childRows(family);
    expect(riley).toMatchObject({
      detail: 'Grade 3 · ages 8-10',
      statusText: 'Active: uses a paid slot',
      canPair: true,
      pairingNote: null,
    });
    expect(sam).toMatchObject({
      detail: 'Kindergarten · ages 5-7',
      statusText: 'Draft: not active yet, no charge',
      canPair: false,
    });
    expect(sam?.pairingNote).toMatch(/once Sam has a paid slot/);
  });

  it('lets a draft take an unused paid slot without buying, and says why when none is free (RV-family-3)', () => {
    // One paid slot, held by Riley: Sam cannot be activated here, and the row says why.
    expect(unusedPaidSlots(family)).toBe(0);
    const [riley, sam] = childRows(family);
    expect(riley).toMatchObject({ canActivate: false, activationNote: null });
    expect(sam).toMatchObject({
      canActivate: false,
      activationNote:
        'All 1 paid slot is in use. To activate Sam, add a child slot under Plan and child slots.',
    });
    // A second paid slot is unused: Sam's draft can take it.
    const twoSlots = { ...family, paidSlots: 2 };
    expect(unusedPaidSlots(twoSlots)).toBe(1);
    expect(childRows(twoSlots)[1]).toMatchObject({ canActivate: true, activationNote: null });
    // No paid slot in the family at all. HUNT7-G-8: the sentence is state-neutral — the literal
    // wording, and why "yet" cannot be said here, are pinned in their own case below.
    const none = { ...family, paidSlots: 0, children: [family.children[1]!] };
    expect(childRows(none)[0]?.activationNote).toMatch(/no paid child slots right now/);
    // WEBR4-01 (lead, round 4): an archived child IS offered a free slot here, the way the portal
    // does. POST /children/:childId/activate clears archived_at for any profile that is not already
    // active, and the archive confirmation on both clients promises exactly this ("You can activate
    // them again later while a paid slot is free"); before this the app could not keep that promise
    // and an archived child's devices stayed signed out for good. This assertion used to read
    // `canActivate: false` — that expectation WAS the defect.
    const archived = {
      ...twoSlots,
      children: [{ ...family.children[1]!, status: 'archived' as const }],
    };
    expect(childRows(archived)[0]).toMatchObject({ canActivate: true, activationNote: null });
    // With the one paid slot already taken by Riley there is nothing to assign, and the note says
    // where another slot comes from.
    const archivedNoSlot = {
      ...family,
      paidSlots: 1,
      children: [family.children[0]!, { ...family.children[1]!, status: 'archived' as const }],
    };
    expect(childRows(archivedNoSlot)[1]?.canActivate).toBe(false);
    expect(childRows(archivedNoSlot)[1]?.activationNote).toMatch(/slot/);
  });

  it('confirms activation and maps its refusals by rule code', () => {
    expect(
      activationMessage('Sam', { childId: SAM, status: 'active', paidSlots: 2, assignedSlots: 2 }),
    ).toBe(
      'Sam is active and uses one of your paid slots (2 of 2 in use). You can now pair a device.',
    );
    expect(
      activationError(
        new ApiRequestError('BUSINESS_RULE', 'Parental consent is needed', 422, 'CONSENT_REQUIRED'),
      ).message,
    ).toMatch(/^Parental consent comes first/);
    expect(
      activationError(new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403))
        .needsPin,
    ).toBe(true);
    expect(
      activationError(
        new ApiRequestError(
          'BUSINESS_RULE',
          'All 1 paid child slots are in use. Add a child slot to your plan first.',
          422,
          'NEEDS_PAID_SLOT',
        ),
      ).message,
    ).toBe('All 1 paid child slots are in use. Add a child slot to your plan first.');
  });

  it('summarizes paid slots honestly', () => {
    expect(slotSummary(family)).toMatch(/^1 paid child slot, 1 in use\./);
    expect(slotSummary(family)).toMatch(/with no new purchase\.$/);
    expect(slotSummary(family)).not.toMatch(/isn’t available/);
    expect(slotSummary({ ...family, paidSlots: 0, children: [] })).toMatch(/^0 paid child slots/);
  });

  it('lists devices with child names and revocability', () => {
    const devices: ChildDevice[] = [
      {
        id: 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c',
        childId: RILEY,
        label: 'Kitchen tablet',
        platform: 'ios',
        pairedAt: '2026-09-20T15:00:00.000Z',
        revokedAt: null,
      },
      {
        id: 'be6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d',
        childId: SAM,
        label: 'Old phone',
        platform: 'android',
        pairedAt: '2026-09-01T15:00:00.000Z',
        revokedAt: '2026-09-10T15:00:00.000Z',
      },
    ];
    expect(deviceRows(devices, family)).toEqual([
      {
        id: devices[0]!.id,
        title: 'Kitchen tablet',
        detail: 'Riley’s device · iPhone or iPad',
        statusText: 'Connected',
        canRevoke: true,
      },
      {
        id: devices[1]!.id,
        title: 'Old phone',
        detail: 'Sam’s device · Android',
        statusText: 'Disconnected',
        canRevoke: false,
      },
    ]);
  });

  it('maps step-up, missing family and other errors', () => {
    expect(parentActionError(new ApiRequestError('STEP_UP_REQUIRED', 'Enter PIN', 403))).toEqual(
      expect.objectContaining({ needsPin: true }),
    );
    expect(
      parentActionError(new ApiRequestError('NOT_FOUND', 'Create your family first', 404), 'load'),
    ).toEqual(expect.objectContaining({ noFamily: true }));
    // An action's NOT_FOUND (e.g. a device already gone) is not "no family".
    expect(parentActionError(new ApiRequestError('NOT_FOUND', 'Device not found', 404))).toEqual({
      message: 'Device not found',
      needsPin: false,
      noFamily: false,
    });
    expect(
      parentActionError(new ApiRequestError('NETWORK', 'You appear to be offline.', 0)),
    ).toEqual({ message: 'You appear to be offline.', needsPin: false, noFamily: false });
    expect(parentActionError(new Error('x')).message).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

/**
 * HUNT5-H-5. WEBR4-01 widened canActivate/activationNote to archived children, and left the doc
 * comments that DEFINE those fields saying "a draft". They are the only description a consumer has —
 * app/(parent)/children.tsx renders `row.canActivate` with no status logic of its own — so a reader
 * who trusted the contract would add a `status === 'draft'` guard at a new call site and quietly take
 * the archived offer away again, breaking the promise the archive confirmation on that screen makes
 * ("You can activate them again later while a paid slot is free"), which is what WEBR4-01/BUG-220 was
 * filed for. The behaviour above is right; only its description was wrong.
 */
describe('the ChildRow contract describes the behaviour the code has (HUNT5-H-5)', () => {
  const source = readFileSync(join(import.meta.dirname, 'family-view.ts'), 'utf8');
  /** The doc comment immediately above `declaration` (no other comment can slip in between). */
  const docFor = (declaration: string) =>
    new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*${declaration}`).exec(source)?.[1] ?? '';

  it('[repro] both activation fields say an archived child is covered too', () => {
    expect(docFor('readonly canActivate: boolean;')).toMatch(/archived/i);
    expect(docFor('readonly activationNote: string \\| null;')).toMatch(/archived/i);
  });

  it('the note helper still named for drafts says it serves both cases', () => {
    expect(docFor('function draftActivationNote')).toMatch(/archived/i);
  });
});

/**
 * HUNT6-I-2. `useLoad` (src/family/ui.tsx) preserved a 'ready' state across a load it had never run,
 * so on a handed-on tablet the previous adult's rows stayed on screen for the length of the new
 * adult's request — up to DEFAULT_REQUEST_TIMEOUT_MS. The hook itself cannot be rendered in this
 * suite (ui.tsx imports react-native; see src/family/screens-r2.review.test.ts), so the decision it
 * makes lives here as a value-in, value-out rule and is pinned behaviourally.
 */
describe('a screen does not keep rows it cannot vouch for (HUNT6-I-2)', () => {
  const rileyRow = { status: 'ready', data: 'Riley' } as const;
  const loadA = () => Promise.resolve('Riley');
  const loadB = () => Promise.resolve('Ada');

  it('[repro] rows fetched by another load are dropped before the new one runs', () => {
    expect(loadStateForRun(rileyRow, loadA, loadB)).toEqual({ status: 'loading' });
  });

  it('a reload of the SAME load keeps the rows, so refresh does not flash', () => {
    expect(loadStateForRun(rileyRow, loadA, loadA)).toBe(rileyRow);
  });

  it('a first run has no rows to vouch for', () => {
    expect(loadStateForRun({ status: 'idle' }, null, loadA)).toEqual({ status: 'loading' });
  });

  it('an error or a load still in flight becomes loading either way', () => {
    expect(loadStateForRun({ status: 'error', error: new Error('x') }, loadA, loadA)).toEqual({
      status: 'loading',
    });
    expect(loadStateForRun({ status: 'loading' }, loadA, loadA)).toEqual({ status: 'loading' });
  });
});

/**
 * HUNT6-H-1 (the mobile half named in its suggested fix). The Practice planner mounted its subject
 * toggles and its schedule editor for any child GET /v1/family returned, and both writes go through
 * `ownedChild(c, 'write')`, which answers 422 BUSINESS_RULE CHILD_ARCHIVED for an archived profile
 * (apps/api/src/routes/learning.ts). The reads succeed, so every control was offered and every one of
 * them could only be refused.
 */
describe('a planner write is offered only where the API accepts one (HUNT6-H-1)', () => {
  it('[repro] an archived child is read-only; a draft is not', () => {
    expect(childPlanEditable('active')).toBe(true);
    // A draft profile stays writable on purpose (learning.ts keeps it so), which is why this is not
    // "only active children".
    expect(childPlanEditable('draft')).toBe(true);
    expect(childPlanEditable('archived')).toBe(false);
  });
});

/**
 * HUNT7-G-3 / HUNT7-J-1. `childStatusText` took only the status, so it answered
 * 'Archived: history only' — that the history is KEPT — for a child whose history the purge is
 * deleting. `public.request_deletion` archives a child-scope target in the same transaction
 * (migrations 0600, 0890) and GET /v1/family returns that same row with `deletionPending: true`
 * (apps/api/src/routes/family.ts), so EVERY deletion-pending child reads as archived here. Both
 * mobile printers of `row.statusText` rendered the false sentence: the Children screen two lines
 * above its own notice that the data is being deleted, and the parent home with no counter-notice
 * anywhere on the screen.
 *
 * HUNT6-G-2 put the branch in the portal's `childStatusLabel` (apps/web/src/pages/app/ChildrenPage.tsx)
 * and claimed one helper decides the sentence for every surface (L-037). This is that claim made true
 * on the phone: the branch is in the one helper `childRows` prints from, tested BEFORE the status.
 */
describe('a deletion-pending child is never told their history is kept (HUNT7-G-3, HUNT7-J-1)', () => {
  const archivedPending: FamilyOverview = {
    ...family,
    children: [{ ...family.children[0]!, status: 'archived', deletionPending: true }],
  };

  it('[repro] the row both parent screens print says the deletion is under way', () => {
    const [riley] = childRows(archivedPending);
    expect(riley?.statusText).toBe('Data deletion under way');
    expect(riley?.statusText).not.toMatch(/history only/i);
  });

  it('reads the flag BEFORE the status, and leaves the archived sentence otherwise intact', () => {
    // The reachable case: archived AND deletion-pending, which is every deletion-pending child.
    expect(childStatusText({ status: 'archived', deletionPending: true })).toBe(
      'Data deletion under way',
    );
    // The branch it overrides is untouched for an archive with no deletion request.
    expect(childStatusText({ status: 'archived' })).toBe('Archived: history only');
    expect(childStatusText({ status: 'archived', deletionPending: false })).toBe(
      'Archived: history only',
    );
    // The flag wins over every status, so no future reordering of the two can bring the sentence
    // back for a family-scope request that has not archived the child yet.
    expect(childStatusText({ status: 'active', deletionPending: true })).toBe(
      'Data deletion under way',
    );
    expect(childStatusText({ status: 'draft', deletionPending: true })).toBe(
      'Data deletion under way',
    );
    // And the two statuses no deletion covers still say what they said.
    expect(childStatusText({ status: 'active' })).toBe('Active: uses a paid slot');
    expect(childStatusText({ status: 'draft' })).toBe('Draft: not active yet, no charge');
  });

  it('does not let the deletion branch swallow the activation note the archived row still needs', () => {
    // HUNT7-G-8 touches the archived branch's note; this pins that the G-3 branch runs first for
    // the status text WITHOUT changing which controls the row offers — children.tsx decides those
    // from `child.deletionPending` itself (its `deletionPending ? null : …` rows).
    const withSlot: FamilyOverview = { ...archivedPending, paidSlots: 2 };
    expect(childRows(withSlot)[0]).toMatchObject({
      statusText: 'Data deletion under way',
      canActivate: true,
    });
    // Both branches on ONE row, the other way round: the flag decides the status sentence and the
    // archived-with-no-slot branch HUNT7-G-8 rewords still decides the note, independently.
    expect(childRows({ ...archivedPending, paidSlots: 0 })[0]).toMatchObject({
      statusText: 'Data deletion under way',
      canActivate: false,
      activationNote:
        'Your family has no paid child slots right now. To activate Riley, choose or renew a plan under Plan and child slots.',
    });
  });
});

/**
 * HUNT7-G-8. `draftActivationNote` said a family with `paidSlots === 0` has "no paid child slots
 * YET", which asserts they never had one. `releaseSlotlessProfiles`
 * (apps/api/src/services/billing-sync.ts) sets `status = 'draft'` on a previously ACTIVE child
 * whenever verified provider state releases its slot (release_reason 'expired' or 'downgrade'), and
 * `family_capacity.paid_slots` is then 0 for a family that has been paying — so the sentence was
 * false for exactly the lapsed population, on the screen where they manage the children they were
 * paying for. Same word, same premise, as HUNT6-H-4 removed from the planner
 * (apps/web/src/pages/app/LearningPlannerPage.tsx) and HUNT7-G-8 removes from the portal's
 * `noFreeSlotText` (apps/web/src/pages/app/ChildrenPage.tsx).
 *
 * The remedy is unchanged and still honest: this app is where capacity is bought (WEB-R1-04), so
 * the note points at Plan and child slots to choose or renew a plan. It never says a slot exists.
 */
describe('the no-slot note does not tell a lapsed family they never paid (HUNT7-G-8)', () => {
  const noSlots: FamilyOverview = {
    ...family,
    paidSlots: 0,
    children: [{ ...family.children[1]!, nickname: 'Sam' }],
  };

  it('[repro] states the literal sentence, with no "yet" in it', () => {
    expect(childRows(noSlots)[0]?.activationNote).toBe(
      'Your family has no paid child slots right now. To activate Sam, choose or renew a plan under Plan and child slots.',
    );
  });

  it('never claims a slot is waiting, and never says the family has never had one', () => {
    const note = childRows(noSlots)[0]?.activationNote ?? '';
    expect(note).not.toMatch(/\byet\b/i);
    // WEB-R1-04: the note points at where capacity comes from; it promises no capacity itself.
    expect(note).not.toMatch(/slot is (free|available|waiting)/i);
    expect(note).toMatch(/choose or renew a plan/);
    // The other branch, where the family demonstrably HAS slots, is unchanged: Riley holds the
    // family's one paid slot, so Sam's draft has none to take and the note names where another
    // comes from.
    expect(childRows(family)[1]?.activationNote).toBe(
      'All 1 paid slot is in use. To activate Sam, add a child slot under Plan and child slots.',
    );
  });
});

/**
 * HUNT7-G-4. The phone's EditChild seeded all three fields from the live prop once and then PATCHed
 * all three unconditionally, so a nickname fix on the phone reverted the other guardian's grade
 * change — BUG-222/WEBR4-03 verbatim, three rounds after the portal was fixed (WEBR4-03, HUNT5-F-1,
 * HUNT6-G-8). The card is keyed on `row.id` (app/(parent)/children.tsx), so a reload never remounts
 * it and the seed is as old as the open form.
 *
 * The phone now sends what the parent EDITED, like the portal's `changes()`
 * (apps/web/src/pages/app/ChildrenPage.tsx, EditChildForm). The decision lives here, as a pure
 * value-in/value-out helper, because this suite cannot render react-native (see vitest.config.ts)
 * and a rule that only exists inside a screen cannot be tested at all.
 *
 * Reseeding the fields from the live prop is NOT the fix: that is BUG-330, the value on screen
 * becoming unsavable, whose repair was `touched`. So the note below carries the drift instead.
 */
describe('a phone child edit sends only the fields the parent edited (HUNT7-G-4)', () => {
  const fields = { nickname: 'Riley R.', gradeLevel: 3, ageBand: '8-10' } as const;
  const nothing = { nickname: false, gradeLevel: false, ageBand: false } as const;

  it('[repro] a nickname-only edit carries the nickname alone, so the other guardian’s grade survives', () => {
    expect(childEditBody(fields, { ...nothing, nickname: true })).toEqual({ nickname: 'Riley R.' });
  });

  it('carries each field on its own, and all three together', () => {
    expect(childEditBody(fields, { ...nothing, gradeLevel: true })).toEqual({ gradeLevel: 3 });
    expect(childEditBody(fields, { ...nothing, ageBand: true })).toEqual({ ageBand: '8-10' });
    expect(childEditBody(fields, { nickname: true, gradeLevel: true, ageBand: true })).toEqual({
      nickname: 'Riley R.',
      gradeLevel: 3,
      ageBand: '8-10',
    });
  });

  it('carries nothing at all when nothing was edited, which is what disables Save', () => {
    // An empty body is also what the contract's refine rejects
    // (updateChildProfileRequestSchema, packages/contracts/src/family.ts), so a screen that sent it
    // would earn a 422 instead of reverting anything — but the button must never offer that.
    expect(childEditBody(fields, nothing)).toEqual({});
    expect(Object.keys(childEditBody(fields, nothing))).toHaveLength(0);
  });

  it('sends an edited field even when the parent typed the seeded value back', () => {
    // BUG-330: "edited" is not "differs from the seed". A parent who retypes the value the form
    // opened on is putting it back deliberately — most sharply when the other guardian's value
    // landed under the open form — and that save must reach the server.
    expect(childEditBody({ ...fields, gradeLevel: 3 }, { ...nothing, gradeLevel: true })).toEqual({
      gradeLevel: 3,
    });
  });
});

/**
 * HUNT7-G-4, the other half of the portal's rule: once Save hangs on `touched`, an untouched field
 * keeps showing what the form opened on while the card above it shows the new value, and nothing on
 * screen says the two are about the same child (BUG-330). The portal renders that as a `role="note"`
 * notice; the phone renders this sentence.
 *
 * HUNT7-G-2: it says WHAT changed, never WHO changed it. `familyChildSchema` carries no actor field
 * and GET /v1/family selects no actor column (packages/contracts/src/family.ts,
 * apps/api/src/routes/family.ts), and the reader can be the cause themselves — the same parent
 * editing this child in the portal or after a failed reload.
 */
describe('the phone form says what changed under it while it was open (HUNT7-G-4)', () => {
  const seed = { nickname: 'Riley', gradeLevel: 3, ageBand: '8-10' } as const;

  it('[repro] names the new nickname and no actor', () => {
    const note = childEditDriftNote(seed, { ...seed, nickname: 'Robin' });
    expect(note).toBe(
      'This profile changed somewhere else while this form was open: the nickname is now “Robin”. The fields above still show what you opened. Saving sends only the fields you edit here, so that change stays unless you edit that field too.',
    );
    expect(note).not.toMatch(/guardian|someone else|somebody|you asked/i);
  });

  it('joins two changes and spells the grade the way the screens do', () => {
    expect(childEditDriftNote(seed, { nickname: 'Robin', gradeLevel: 0, ageBand: '8-10' })).toMatch(
      /the nickname is now “Robin” and the grade is now Kindergarten\./,
    );
    expect(childEditDriftNote(seed, { ...seed, gradeLevel: 4 })).toMatch(
      /the grade is now Grade 4\./,
    );
    expect(childEditDriftNote(seed, { ...seed, ageBand: '11-13' })).toMatch(
      /the age band is now ages 11-13\./,
    );
  });

  it('is absent while nothing has moved under the form', () => {
    expect(childEditDriftNote(seed, { ...seed })).toBeNull();
  });
});

/**
 * HUNT7-G-4 (WEBR4-12, the mobile half). The phone's archive button said "Archive (keeps history,
 * frees the slot)" unconditionally, and that row is rendered for a DRAFT child too — a draft holds
 * no slot, so archiving one frees nothing (`slotSummary` returns unchanged counts). The portal
 * branched on the status at ChildrenPage.tsx (ChildCard's archive button) from round 4 and the phone
 * never got it.
 */
describe('the archive button promises a freed slot only where there is one (HUNT7-G-4)', () => {
  it('[repro] a draft is not promised a freed slot; an active child is', () => {
    expect(childArchiveLabel('draft')).toBe('Archive (keeps history)');
    expect(childArchiveLabel('active')).toBe('Archive (keeps history, frees the slot)');
    // The archived row offers no archive control at all, but the label must not lie if it ever does.
    expect(childArchiveLabel('archived')).toBe('Archive (keeps history)');
  });

  it('always keeps the promise archiving actually makes', () => {
    for (const status of ['draft', 'active', 'archived'] as const) {
      expect(childArchiveLabel(status)).toMatch(/keeps history/);
    }
  });
});
