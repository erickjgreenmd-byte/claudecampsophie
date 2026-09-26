import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * API side of the mobile round-2 hardening (MOB-R2-02, MOB-R2-03, API-AUTH-R2-05). Real local
 * Postgres; synthetic families only.
 *
 * - MOB-R2-02: the child token responses carry a device-relative lifetime, so a tablet with a wrong
 *   clock can measure expiry against its own clock instead of the server's instant.
 * - MOB-R2-03: the unlock response carries the window length, so the parent area opens for that
 *   long on the device's clock rather than lapsing at once on a fast clock.
 * - API-AUTH-R2-05: a device that signs itself out stops being listed as connected.
 */

let api: TestApi;
const FIXED_NOW = new Date('2026-09-24T15:00:00Z');

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

let seq = 0;
function sessionId(): string {
  seq += 1;
  return `b2d0${seq.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
}

interface PairedDevice {
  fam: SeededFamily;
  childId: string;
  parentToken: string;
  childToken: string;
  refreshToken: string;
}

async function pairedDevice(label = 'Kitchen tablet'): Promise<PairedDevice> {
  const fam = await seedFamily(api.db, { childCount: 1 });
  const childId = fam.children[0]!.id;
  const session = sessionId();
  await grantAdultUnlock(api.db, fam.ownerId, session, 3600);
  const token = await parentToken(fam.ownerId, { sessionId: session });
  const { code } = await json<{ code: string }>(
    await api.request(`/v1/children/${childId}/pairing-code`, { method: 'POST', token }),
  );
  const paired = await api.request('/v1/child/pair', {
    method: 'POST',
    body: { code, deviceLabel: label, platform: 'android' },
  });
  expect(paired.status).toBe(201);
  const body = await json<{ accessToken: string; refreshToken: string }>(paired);
  return {
    fam,
    childId,
    parentToken: token,
    childToken: body.accessToken,
    refreshToken: body.refreshToken,
  };
}

interface DeviceRow {
  id: string;
  label: string;
  revokedAt: string | null;
}

async function devices(token: string, label: string): Promise<DeviceRow[]> {
  const response = await api.request('/v1/devices', { token });
  expect(response.status).toBe(200);
  // seedChild seeds its own 'Test tablet' row; only the device this test paired matters here.
  return (await json<{ devices: DeviceRow[] }>(response)).devices.filter((d) => d.label === label);
}

/**
 * MOB-R2-02. The client cannot turn `accessTokenExpiresAt` (a server instant) into a lifetime it
 * can measure on its own clock, so a skewed device clock either presents a dead token or refreshes
 * on every call. The responses therefore state the lifetime itself.
 */
describe('child token responses state a device-relative lifetime (MOB-R2-02)', () => {
  it('pair and refresh both carry accessTokenExpiresInSeconds matching the configured TTL', async () => {
    const device = await pairedDevice();
    const paired = await api.request('/v1/child/pair', {
      method: 'POST',
      body: { code: 'ZZZZ-ZZZZ', deviceLabel: 'x', platform: 'ios' },
    });
    // The pairing above already succeeded; this one only shows a wrong code still answers 404.
    expect(paired.status).toBe(404);

    const refreshed = await api.request('/v1/child/refresh', {
      method: 'POST',
      body: { refreshToken: device.refreshToken },
    });
    expect(refreshed.status).toBe(200);
    const body = await json<{
      accessTokenExpiresAt: string;
      accessTokenExpiresInSeconds: number;
    }>(refreshed);
    expect(body.accessTokenExpiresInSeconds).toBe(api.config.childAccessTtlSeconds);
    // The two agree: the lifetime is the distance from the request instant to the stated expiry.
    expect(Date.parse(body.accessTokenExpiresAt) - FIXED_NOW.getTime()).toBe(
      body.accessTokenExpiresInSeconds * 1000,
    );
  });

  it('the pairing response carries it too', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const session = sessionId();
    await grantAdultUnlock(api.db, fam.ownerId, session, 3600);
    const token = await parentToken(fam.ownerId, { sessionId: session });
    const { code } = await json<{ code: string }>(
      await api.request(`/v1/children/${fam.children[0]!.id}/pairing-code`, {
        method: 'POST',
        token,
      }),
    );
    const paired = await api.request('/v1/child/pair', {
      method: 'POST',
      body: { code, deviceLabel: 'Bedroom tablet', platform: 'ios' },
    });
    const body = await json<{ accessTokenExpiresInSeconds: number }>(paired);
    expect(body.accessTokenExpiresInSeconds).toBe(api.config.childAccessTtlSeconds);
  });
});

/**
 * MOB-R2-03. `unlockedUntil` is a database instant; a device clock more than the TTL ahead sees it
 * as already past and bounces the parent straight back to the PIN screen. The response states the
 * window length so the client can hold it on its own clock.
 */
describe('the unlock response states the window length (MOB-R2-03)', () => {
  it('POST /v1/adult/unlock answers unlockSeconds alongside unlockedUntil', async () => {
    const fam = await seedFamily(api.db);
    const token = await parentToken(fam.ownerId, { sessionId: sessionId() });
    expect(
      (await api.request('/v1/adult/pin', { method: 'PUT', token, body: { pin: '739164' } }))
        .status,
    ).toBe(200);
    const unlocked = await api.request('/v1/adult/unlock', {
      method: 'POST',
      token,
      body: { method: 'pin', pin: '739164' },
    });
    expect(unlocked.status).toBe(200);
    const body = await json<{ unlockedUntil: string; unlockSeconds: number }>(unlocked);
    expect(body.unlockSeconds).toBe(api.config.adultUnlockTtlSeconds);
    expect(typeof body.unlockedUntil).toBe('string');
  });
});

/**
 * API-AUTH-R2-05. The mobile app posts /v1/child/logout whenever the device forgets the child. The
 * parent's device list read `child_devices.revoked_at` alone, so a signed-out tablet stayed
 * "Connected" for good and every re-pair added another connected row for the same tablet.
 */
describe('a device that signs itself out stops being listed as connected (API-AUTH-R2-05)', () => {
  it('POST /v1/child/logout marks the device revoked when it has no other live session', async () => {
    const device = await pairedDevice('Riley’s tablet');
    expect(await devices(device.parentToken, 'Riley’s tablet')).toEqual([
      expect.objectContaining({ label: 'Riley’s tablet', revokedAt: null }),
    ]);

    const loggedOut = await api.request('/v1/child/logout', {
      method: 'POST',
      token: device.childToken,
    });
    expect(loggedOut.status).toBe(200);

    const after = await devices(device.parentToken, 'Riley’s tablet');
    expect(after).toHaveLength(1);
    expect(after[0]!.revokedAt).not.toBeNull();
  });

  it('a second live session on the same device keeps it connected', async () => {
    const device = await pairedDevice('Shared tablet');
    const [deviceRow] = await devices(device.parentToken, 'Shared tablet');
    // A second session on the same device row, as a re-pair of the same tablet would make.
    await api.db.sql`
      insert into public.child_sessions (family_id, child_id, device_id, created_at, expires_at)
      values (${device.fam.familyId}, ${device.childId}, ${deviceRow!.id}, ${FIXED_NOW},
              ${new Date(FIXED_NOW.getTime() + 7 * 24 * 3600 * 1000)})`;

    expect(
      (await api.request('/v1/child/logout', { method: 'POST', token: device.childToken })).status,
    ).toBe(200);
    const after = await devices(device.parentToken, 'Shared tablet');
    expect(after[0]!.revokedAt).toBeNull();
  });

  it('the logged-out session itself is revoked and its refresh token no longer works', async () => {
    const device = await pairedDevice('Old tablet');
    expect(
      (await api.request('/v1/child/logout', { method: 'POST', token: device.childToken })).status,
    ).toBe(200);
    const refreshed = await api.request('/v1/child/refresh', {
      method: 'POST',
      body: { refreshToken: device.refreshToken },
    });
    expect(refreshed.status).toBe(401);
  });
});
