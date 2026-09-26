import { randomUUID } from 'node:crypto';
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

/** Every audit action recorded for this family, newest last. */
async function auditActions(familyId: string): Promise<string[]> {
  const rows = await api.db.sql<{ action: string }[]>`
    select action from public.audit_events where family_id = ${familyId} order by created_at`;
  return rows.map((r) => r.action);
}

const refresh = (refreshToken: string, refreshRequestId?: string) =>
  api.request('/v1/child/refresh', {
    method: 'POST',
    body: refreshRequestId === undefined ? { refreshToken } : { refreshToken, refreshRequestId },
  });

/** The session of the one device this test paired (seedFamily seeds its own 'Test tablet' too). */
async function sessionRow(
  familyId: string,
  label: string,
): Promise<{ revoked_at: Date | null; revoke_reason: string | null }> {
  const [row] = await api.db.sql<{ revoked_at: Date | null; revoke_reason: string | null }[]>`
    select s.revoked_at, s.revoke_reason from public.child_sessions s
      join public.child_devices d on d.id = s.device_id
     where s.family_id = ${familyId} and d.label = ${label}`;
  return row!;
}

/**
 * HUNT4-MOB-1 — OPEN, not fixed here; these cases pin the behaviour the attempted fix removed.
 *
 * The finding is real: POST /v1/child/refresh commits the rotation before the response goes out, so a
 * response lost on the way back (the client's own 20s timeout, a wifi/cellular switch, a Worker
 * evicted after commit) leaves the tablet holding a token the server has marked used. Presenting it
 * again is read as theft, the session is revoked, and the client unpairs — a parent has to mint a new
 * pairing code over one dropped HTTP response. But the only remedy on this side is to serve some
 * re-presentations of a rotated token, and the server cannot tell the tablet from a replayer: a 60s
 * grace (tried and withdrawn in this round) hands whoever replays the older token a live child access
 * token with no audit event, and retires the rightful holder's unclaimed replacement, so the real
 * tablet is the one that gets kicked. It also contradicts tests/auth.test.ts:189 ("refresh tokens
 * rotate and reuse revokes the session"), which requires an immediate replay to revoke, and
 * docs/Threat_Model.md T20. Weakening either is a lead decision, so reuse stays immediate revocation
 * and this case keeps it that way.
 *
 * So this case is a PIN, not a repro: it passes against src/routes/child-auth.ts unchanged, and no
 * failing-test-first for HUNT4-MOB-1 exists, because nothing about the reuse gate was changed. If the
 * lead does accept a bounded "the response never arrived" grace, this case is the one to update (age
 * the rotation first: update private.child_refresh_tokens set used_at = used_at - interval '5 minutes'
 * for this family, then replay, and keep the 401 + audit + revoke_reason assertions), never to delete
 * — an immediate replay would then be served, but a replay outside the window must still be theft.
 */
describe('reuse of a rotated refresh token revokes the session at once (HUNT4-MOB-1 open)', () => {
  it('an immediate replay is revoked and audited, and the rotated replacement dies with it', async () => {
    const device = await pairedDevice('Replay tablet');
    const rotated = await json<{ refreshToken: string }>(await refresh(device.refreshToken));

    expect((await refresh(device.refreshToken)).status).toBe(401);
    expect(await auditActions(device.fam.familyId)).toContain('child_session.revoked_token_reuse');
    expect((await sessionRow(device.fam.familyId, 'Replay tablet')).revoke_reason).toBe(
      'refresh_token_reuse',
    );
    // No grace window: the token the rotation issued stops working too, however new it is.
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
  });
});

/**
 * BUG-244, closed: the tablet's own retry of a refresh whose response was lost is served, and every
 * other re-presentation of a rotated token is still theft.
 *
 * The rejected alternative was a time window, which cannot separate the two cases — inside it a
 * replayer looks exactly like the rightful holder. The request identifies itself instead: one id per
 * refresh, kept by the device across its own retries of that refresh, recorded by the server as the id
 * that consumed the token. A used token presented again WITH that id is the same attempt finishing;
 * with another id, or none, it is theft and the session is revoked as before.
 */
describe('a refresh whose response was lost is recoverable by its own id (BUG-244)', () => {
  it('[repro] the same token and the same request id issues tokens instead of revoking', async () => {
    const device = await pairedDevice('Lost response tablet');
    const rid = randomUUID();
    const first = await json<{ refreshToken: string }>(await refresh(device.refreshToken, rid));

    // The tablet never saw that response. It retries the SAME refresh: same token, same id.
    const retried = await refresh(device.refreshToken, rid);
    expect(retried.status).toBe(200);
    const second = await json<{ refreshToken: string }>(retried);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    // The recovery itself is not a theft signal: the session survived it.
    expect(await auditActions(device.fam.familyId)).not.toContain(
      'child_session.revoked_token_reuse',
    );
    expect((await sessionRow(device.fam.familyId, 'Lost response tablet')).revoked_at).toBeNull();
    // The token the lost response carried is retired. Only someone who intercepted that response
    // holds it, so presenting it is a real theft signal and is treated as one.
    expect((await refresh(first.refreshToken, randomUUID())).status).toBe(401);
    expect(await auditActions(device.fam.familyId)).toContain('child_session.revoked_token_reuse');
  });

  it('a second lost response in a row still recovers, through the same id', async () => {
    const device = await pairedDevice('Twice lost tablet');
    const rid = randomUUID();
    await refresh(device.refreshToken, rid);
    expect((await refresh(device.refreshToken, rid)).status).toBe(200);
    const third = await refresh(device.refreshToken, rid);
    expect(third.status).toBe(200);
    const row = await sessionRow(device.fam.familyId, 'Twice lost tablet');
    expect(row.revoked_at).toBeNull();
  });

  it('a replay with a different id is theft, and so is one with no id at all', async () => {
    const other = await pairedDevice('Different id tablet');
    await refresh(other.refreshToken, randomUUID());
    expect((await refresh(other.refreshToken, randomUUID())).status).toBe(401);
    expect(await auditActions(other.fam.familyId)).toContain('child_session.revoked_token_reuse');

    const none = await pairedDevice('No id tablet');
    await refresh(none.refreshToken, randomUUID());
    expect((await refresh(none.refreshToken)).status).toBe(401);
    expect(await auditActions(none.fam.familyId)).toContain('child_session.revoked_token_reuse');
  });

  it('once the replacement has been used, even the right id is theft', async () => {
    const device = await pairedDevice('Claimed replacement tablet');
    const rid = randomUUID();
    const rotated = await json<{ refreshToken: string }>(await refresh(device.refreshToken, rid));
    // The response did arrive: the tablet used the replacement. A presentation of the old token now
    // means two parties hold it, whatever id it carries.
    expect((await refresh(rotated.refreshToken, randomUUID())).status).toBe(200);
    expect((await refresh(device.refreshToken, rid)).status).toBe(401);
    expect(await auditActions(device.fam.familyId)).toContain('child_session.revoked_token_reuse');
  });

  it('a token rotated by a client that sent no id keeps today’s behaviour exactly', async () => {
    const device = await pairedDevice('Old client tablet');
    await refresh(device.refreshToken);
    expect((await refresh(device.refreshToken, randomUUID())).status).toBe(401);
    expect(await auditActions(device.fam.familyId)).toContain('child_session.revoked_token_reuse');
  });
});

/**
 * HUNT4-MOB-4. The parent's device list derives "Connected" from child_devices.revoked_at alone
 * (GET /v1/devices, apps/mobile/src/family/family-view.ts). Round 3 stamped that column in the
 * logout handler only, so a session that ended any other way left the tablet listed as Connected for
 * good, with a live "Disconnect" button, while the child was being told to ask a grown-up to connect
 * the device again. The two remaining paths are the refresh-token-reuse revocation and plain expiry.
 */
describe('a session that ends any other way stops being listed as connected (HUNT4-MOB-4)', () => {
  it('[repro] the refresh-token-reuse revocation stamps the device', async () => {
    const device = await pairedDevice('Reuse tablet');
    expect((await refresh(device.refreshToken)).status).toBe(200);
    // The same token again: theft, so the session is revoked (see the HUNT4-MOB-1 note above).
    expect((await refresh(device.refreshToken)).status).toBe(401);
    const after = await devices(device.parentToken, 'Reuse tablet');
    expect(after).toHaveLength(1);
    expect(after[0]!.revokedAt).not.toBeNull();
  });

  it('[repro] a session that simply expired stamps the device on the next refresh', async () => {
    const device = await pairedDevice('Expired tablet');
    await api.db.sql`
      update public.child_sessions s set expires_at = now() - interval '1 day'
       where s.family_id = ${device.fam.familyId}
         and exists (select 1 from public.child_devices d
                      where d.id = s.device_id and d.label = 'Expired tablet')`;
    expect((await refresh(device.refreshToken)).status).toBe(401);
    const after = await devices(device.parentToken, 'Expired tablet');
    expect(after[0]!.revokedAt).not.toBeNull();
  });

  it('a device that still has a live session stays connected', async () => {
    const device = await pairedDevice('Shared reuse tablet');
    const [deviceRow] = await devices(device.parentToken, 'Shared reuse tablet');
    await api.db.sql`
      insert into public.child_sessions (family_id, child_id, device_id, created_at, expires_at)
      values (${device.fam.familyId}, ${device.childId}, ${deviceRow!.id}, ${FIXED_NOW},
              ${new Date(FIXED_NOW.getTime() + 7 * 24 * 3600 * 1000)})`;
    expect((await refresh(device.refreshToken)).status).toBe(200);
    expect((await refresh(device.refreshToken)).status).toBe(401);
    expect((await devices(device.parentToken, 'Shared reuse tablet'))[0]!.revokedAt).toBeNull();
  });
});
