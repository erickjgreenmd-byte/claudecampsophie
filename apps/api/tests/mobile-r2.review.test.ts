import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { RATE_RULES } from '../src/middleware/rate-limit.ts';
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

let pairCount = 0;
/**
 * A client network of its own for each POST /v1/child/pair in this file. Pairing is limited per
 * client network (RATE_RULES.pairingRedeemPerNetwork, 20 per 15 minutes, keyed on cf-connecting-ip
 * by clientNetworkKey), and this file pins the clock, so the 15-minute window never advances and
 * every pairing that states no address spends the same 'unknown' bucket — with a case per device
 * the file ran two pairings short of a 429 that has nothing to do with what it tests. An address in
 * the IPv6 documentation prefix per pairing keeps the limit from binding here however many cases
 * the file grows: the limiter keys IPv6 on the /64 (and the pairing failure budget on the /48), so
 * varying the third group gives each pairing a network and a site of its own, with room for 65,535
 * of them. The limit itself is untouched and still bites per network (the case at the end of this
 * file, and child-auth-hardening.test.ts).
 */
function pairingAddress(): string {
  pairCount += 1;
  return `2001:db8:${pairCount.toString(16)}::1`;
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
    headers: { 'cf-connecting-ip': pairingAddress() },
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
      headers: { 'cf-connecting-ip': pairingAddress() },
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
      headers: { 'cf-connecting-ip': pairingAddress() },
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
    // A unit case for the `not exists` clause of stampDeviceWhenNoLiveSession, not a re-pair: no
    // API path puts two sessions on one device row (/v1/child/pair always inserts a fresh
    // child_devices row), so the second session is made with raw SQL. Its timestamps are
    // database-relative because the clause compares expires_at with the database clock, not with
    // the pinned request instant — a fixture built from FIXED_NOW goes stale on a fixed date
    // (L-027, HUNT5-A-3).
    await api.db.sql`
      insert into public.child_sessions (family_id, child_id, device_id, created_at, expires_at)
      values (${device.fam.familyId}, ${device.childId}, ${deviceRow!.id}, now(),
              now() + interval '7 days')`;

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

const refresh = (refreshToken: string) =>
  api.request('/v1/child/refresh', { method: 'POST', body: { refreshToken } });

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
 * HUNT4-MOB-1 / BUG-244: reuse of a rotated refresh token is immediate revocation, with no exception
 * of any kind. BUG-244's recovery — which served the tablet's own retry of a lost refresh when the
 * request carried the id that consumed the token — was removed in round 6 (HUNT6-A-1), so this rule
 * has no "except" clause again.
 *
 * What it requires is stated by name, never by line number, because a line number rots the next time
 * a helper is inserted above it and sends the next reviewer into an unrelated test (HUNT6-A-4):
 * tests/auth.test.ts > 'refresh tokens rotate and reuse revokes the session', and
 * docs/Threat_Model.md T20. Weakening either is a lead decision, not a fixer's.
 *
 * It is a PIN, not a repro: it passed before the recovery existed, while it existed, and after its
 * removal. The cases that DO go red on the removal are in the describe below.
 */
describe('reuse of a rotated refresh token revokes the session at once', () => {
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
 * [repro] HUNT6-A-1. The BUG-244 recovery is REMOVED, not repaired: a captured refresh request body
 * must buy an attacker nothing ONCE THE TOKEN IN IT HAS BEEN ROTATED, which means the request must
 * carry no recovery id — nothing a capture can present to be taken for the rightful retry. That is
 * the whole of what the removal restores, and the premise is stated that narrowly on purpose, this
 * being the reversal of a feature whose recorded residual over-claimed: a body captured BEFORE the
 * device's own request reaches the server carries a LIVE refresh token, and whoever presents it
 * first wins. That race predates BUG-244, survives its removal, and is not what is pinned here.
 *
 * The recovery never marked the row its id consumed, so the SAME captured body was served for the
 * whole window, and each serving returned a full-lifetime rotating refresh token that then rotated
 * down the ordinary path with no id, no window and no audit row: one captured body was a
 * self-renewing child session until the tablet's own next refresh, which for a tablet put away is
 * overnight. Against that the feature only avoided an occasional unpairing a parent can undo with a
 * new pairing code, so BUG-244 goes back to an accepted, documented open defect.
 */
describe('the refresh request carries no recovery id at all (BUG-244 reopened, HUNT6-A-1)', () => {
  it('[repro] a captured refresh body is refused outright, however right the id it carries', async () => {
    const device = await pairedDevice('Replay chain tablet');
    // One request body, posted twice: the tablet's own refresh, then a replay of the same body out of
    // a log, which is the realistic capture vector because logs are read later. Before the reversal
    // the first posting rotated normally AND recorded this id against the token it consumed, which
    // is what made the second posting a recovery — served, and served again for the rest of the
    // window, each serving handing back a rotating refresh token of full lifetime (HUNT6-A-1). The
    // id is not a field of this request any more, so neither posting reaches the token at all.
    const captured = { refreshToken: device.refreshToken, refreshRequestId: randomUUID() };
    const first = await api.request('/v1/child/refresh', { method: 'POST', body: captured });
    expect(first.status).toBe(400);
    const again = await api.request('/v1/child/refresh', { method: 'POST', body: captured });
    expect(again.status).toBe(400);
    // The refusal is the request contract's, before any token work: nothing rotated and nothing was
    // served, so the tablet's own token is still the live one.
    expect((await sessionRow(device.fam.familyId, 'Replay chain tablet')).revoked_at).toBeNull();
    expect((await refresh(device.refreshToken)).status).toBe(200);
    // This case USED to also assert that no recovery audit row and no `child_refresh_recovered` log
    // line were written. Both postings above are refused by readJson's strict contract, so neither
    // reached the refresh route's token logic and no path that could emit those events ran: the
    // assertions could not have failed for the reason they existed, whatever the route did (L-054).
    // They now sit on the case below, whose replay the contract accepts and which therefore executes
    // the used_at branch the recovery used to live in. The two assertions this case keeps are the
    // ones a 400 can still get wrong — that the refusal cost the tablet's own token nothing.
  });

  /**
   * The rule the reversal restores, stated over the exact state the recovery used to look for: a
   * rotation seconds old, whose replacement is still unclaimed. Inside the old two-minute window
   * that state served tokens; it is theft again, as it was before BUG-244. A PIN, not a repro — with
   * no id in the body the recovery branch could not be reached even while it existed, so this passed
   * before the removal too. What goes red on a restored id-keyed recovery is the case above.
   *
   * This is also where the two "no recovery was served" assertions live, because this request is one
   * that REACHES the token logic: the body is contract-valid, the row is found, and the used_at
   * branch — the only place any recovery has ever been served from — runs. So the negatives can fail
   * for the reason they exist, and a recovery keyed on the WINDOW ALONE (the shape child-auth.ts
   * names as still rejected, which needs no id in the body) turns them red here.
   */
  it('a rotated token presented seconds later is theft, and its replacement dies with it', async () => {
    const device = await pairedDevice('Inside window tablet');
    const rotated = await json<{ refreshToken: string }>(await refresh(device.refreshToken));
    const pinned = api.now.value;
    // Thirty seconds: well inside the retired RECOVERY_WINDOW_MS, and the replacement is unclaimed.
    api.now.value = new Date(pinned.getTime() + 30_000);
    try {
      expect((await refresh(device.refreshToken)).status).toBe(401);
    } finally {
      api.now.value = pinned;
    }
    expect((await sessionRow(device.fam.familyId, 'Inside window tablet')).revoke_reason).toBe(
      'refresh_token_reuse',
    );
    expect(await auditActions(device.fam.familyId)).toContain('child_session.revoked_token_reuse');
    expect(await auditActions(device.fam.familyId)).not.toContain(
      'child_session.refresh_recovered',
    );
    // Nor the log line: the audit row and the info log were the whole compensating control the
    // threat model credited for BUG-244's residual, and neither reached a reader (HUNT6-A-2). With
    // no recovery there is nothing to report, so both went rather than gaining an ops surface.
    expect(api.logs.map((l) => l.event)).not.toContain('child_refresh_recovered');
    // No chain survives the revocation: the token the rotation handed out is dead too.
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
  });

  /**
   * There is no window of any length. The recovery had a two-minute one and a replay outside it was
   * theft (the round-5 case this replaces); with the recovery gone, the delay is not a variable of
   * the answer at all, so the same replay is refused at three minutes exactly as at thirty seconds.
   */
  it('a replay long after the rotation is theft on the same terms', async () => {
    const device = await pairedDevice('Outside window tablet');
    await json<{ refreshToken: string }>(await refresh(device.refreshToken));
    const pinned = api.now.value;
    api.now.value = new Date(pinned.getTime() + 3 * 60_000);
    try {
      expect((await refresh(device.refreshToken)).status).toBe(401);
    } finally {
      api.now.value = pinned;
    }
    expect((await sessionRow(device.fam.familyId, 'Outside window tablet')).revoke_reason).toBe(
      'refresh_token_reuse',
    );
  });

  /**
   * A token two rotations old, whose replacement the tablet really did use. The recovery refused this
   * case on the ground that the replacement was claimed (its round-5 case, 'once the replacement has
   * been used, even the right id is theft'); it is refused now because a rotated token is refused,
   * and the session the tablet is actually using ends with it.
   */
  it('a token the tablet has already rotated past ends the session it is using', async () => {
    const device = await pairedDevice('Claimed replacement tablet');
    const second = await json<{ refreshToken: string }>(await refresh(device.refreshToken));
    const third = await json<{ refreshToken: string }>(await refresh(second.refreshToken));

    expect((await refresh(device.refreshToken)).status).toBe(401);
    expect(await auditActions(device.fam.familyId)).toContain('child_session.revoked_token_reuse');
    // The live token the tablet is holding is dead too: the whole session went, not one token.
    expect((await refresh(third.refreshToken)).status).toBe(401);
    expect(
      (await sessionRow(device.fam.familyId, 'Claimed replacement tablet')).revoke_reason,
    ).toBe('refresh_token_reuse');
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
    // Raw SQL and database-relative timestamps for the same two reasons as the logout case above
    // (HUNT5-A-5: no API path makes this state; HUNT5-A-3: the guard reads the database clock).
    await api.db.sql`
      insert into public.child_sessions (family_id, child_id, device_id, created_at, expires_at)
      values (${device.fam.familyId}, ${device.childId}, ${deviceRow!.id}, now(),
              now() + interval '7 days')`;
    expect((await refresh(device.refreshToken)).status).toBe(200);
    expect((await refresh(device.refreshToken)).status).toBe(401);
    expect((await devices(device.parentToken, 'Shared reuse tablet'))[0]!.revokedAt).toBeNull();
  });
});

/**
 * HYGIENE. Every case above pairs a device, and a pairing is one POST /v1/child/pair counted against
 * RATE_RULES.pairingRedeemPerNetwork (20 per 15 minutes per client network) under a clock pinned to
 * FIXED_NOW, so the window never advances: before pairingAddress() the whole file spent one bucket
 * and stood two pairings from a 429 that would have reddened the next case anyone added. These two
 * cases hold both halves of the fix, so neither can rot silently: the first pairs more devices than
 * any one network may, the second shows that budget still runs out on one network. The limit is a
 * real defence against pairing-code guessing (docs/Threat_Model.md T24) and nothing here relaxes it.
 */
describe('pairing a device per case does not spend one network’s pairing budget', () => {
  it('more devices than one network may pair all pair, because each pairs from its own', async () => {
    const limit = RATE_RULES.pairingRedeemPerNetwork.limit;
    // pairedDevice asserts its own 201, so a 429 from a shared bucket fails right here.
    for (let i = 0; i < limit + 2; i += 1) await pairedDevice(`Fleet tablet ${i + 1}`);
  });

  it('the limit still bites: one network’s pairing attempts stop at the limit', async () => {
    const limit = RATE_RULES.pairingRedeemPerNetwork.limit;
    const address = pairingAddress();
    // Wrong codes: an attempt counts against the network before the code is looked at, so this
    // spends the budget without seeding anything. The service-wide failure budget is 200 an hour,
    // far above these, so the refusal below is the per-network rule and not that one.
    const statuses: number[] = [];
    for (let i = 0; i <= limit; i += 1) {
      const attempt = await api.request('/v1/child/pair', {
        method: 'POST',
        headers: { 'cf-connecting-ip': address },
        body: { code: 'ZZZZ-ZZZZ', deviceLabel: 'Guessing tablet', platform: 'android' },
      });
      statuses.push(attempt.status);
    }
    expect(statuses.slice(0, limit)).toEqual(new Array<number>(limit).fill(404));
    expect(statuses[limit]).toBe(429);
    // And it bites that network only: a real pairing from the next one is unaffected.
    await pairedDevice('Own network tablet');
  });
});
