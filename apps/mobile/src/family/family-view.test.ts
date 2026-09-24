import { describe, expect, it } from 'vitest';
import type { ChildDevice, FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { childRows, deviceRows, parentActionError, slotSummary } from './family-view.ts';

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

  it('summarizes paid slots honestly', () => {
    expect(slotSummary(family)).toMatch(/^1 paid child slot, 1 in use\./);
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
