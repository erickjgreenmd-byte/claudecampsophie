import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildDevice, FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  activationError,
  activationMessage,
  childRows,
  deviceRows,
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
    // No subscription at all.
    const none = { ...family, paidSlots: 0, children: [family.children[1]!] };
    expect(childRows(none)[0]?.activationNote).toMatch(/no paid child slots yet/);
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
