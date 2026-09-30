import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSENT_ATTESTATION_VERSION } from '@pencillift/contracts';
import { seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { RATE_RULES } from '../src/middleware/rate-limit.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

let api: TestApi;
let fam: SeededFamily;
let token: string;
const SESSION = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 1 });
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
});

afterAll(async () => {
  await api?.close();
});

async function setPin(pin = '482913', t = token) {
  return api.request('/v1/adult/pin', { method: 'PUT', token: t, body: { pin } });
}

async function unlock(pin = '482913', t = token) {
  return api.request('/v1/adult/unlock', {
    method: 'POST',
    token: t,
    body: { method: 'pin', pin },
  });
}

describe('parent authentication', () => {
  it('rejects missing, forged, expired and wrong-role tokens', async () => {
    expect((await api.request('/v1/family')).status).toBe(401);
    const forged = await parentToken(fam.ownerId, {
      secret: 'attacker-secret-attacker-secret-attacker!!',
    });
    expect((await api.request('/v1/family', { token: forged })).status).toBe(401);
    const expired = await parentToken(fam.ownerId, { expiresInSeconds: -120 });
    expect((await api.request('/v1/family', { token: expired })).status).toBe(401);
    const anonRole = await parentToken(fam.ownerId, { role: 'anon' });
    expect((await api.request('/v1/family', { token: anonRole })).status).toBe(401);
  });

  it('returns the caller family only', async () => {
    const res = await api.request('/v1/family', { token });
    expect(res.status).toBe(200);
    const body = await json<{ id: string; children: unknown[] }>(res);
    expect(body.id).toBe(fam.familyId);
    expect(body.children).toHaveLength(1);
  });

  it('error bodies carry a code and request id and never a stack', async () => {
    const res = await api.request('/v1/family');
    const body = await json<{ error: Record<string, unknown> }>(res);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('adult step-up (spec P3, AC_ACCESS_08)', () => {
  it('refuses weak PINs and stores only a hash', async () => {
    expect((await setPin('111111')).status).toBe(400);
    expect((await setPin('123456')).status).toBe(400);
    expect((await setPin()).status).toBe(200);
    const [row] = await api.db.sql<
      { pin_hash: string }[]
    >`select pin_hash from private.parent_pins where user_id = ${fam.ownerId}`;
    expect(row!.pin_hash).toMatch(/^pbkdf2-sha256\$/);
    expect(row!.pin_hash).not.toContain('482913');
  });

  it('adding a child requires an unlock; unlock is bound to the auth session', async () => {
    const add = (t: string) =>
      api.request('/v1/children', {
        method: 'POST',
        token: t,
        body: { nickname: 'Sam', gradeLevel: 2, ageBand: '5-7', parentalAttestation: true },
      });
    expect((await add(token)).status).toBe(403);
    expect((await unlock()).status).toBe(200);
    const otherSession = await parentToken(fam.ownerId, {
      sessionId: '33333333-3333-4333-8333-333333333333',
    });
    const denied = await add(otherSession);
    expect(denied.status).toBe(403);
    expect((await json<{ error: { code: string } }>(denied)).error.code).toBe('STEP_UP_REQUIRED');
    const created = await add(token);
    expect(created.status).toBe(201);
    expect((await json<{ status: string }>(created)).status).toBe('draft');
  });

  it('refuses a child whose parental attestation is missing, false, or client-dated (0970)', async () => {
    await unlock();
    const post = (body: unknown) =>
      api.request('/v1/children', { method: 'POST', token, body: body as never });

    // An unticked box and an absent one are the same thing to a parent, and neither is consent.
    for (const body of [
      { nickname: 'Riley', gradeLevel: 2, ageBand: '5-7' },
      { nickname: 'Riley', gradeLevel: 2, ageBand: '5-7', parentalAttestation: false },
    ]) {
      const res = await post(body);
      // A contract violation is 400 (VALIDATION); 422 is for a business rule that the body satisfies.
      expect(res.status).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('VALIDATION_FAILED');
    }

    // The client cannot choose the wording version or the instant: the request carries only the tick,
    // and a strictObject refuses anything else, so a caller cannot backdate an attestation or claim
    // agreement to a version that was never shown.
    const extra = await post({
      nickname: 'Riley',
      gradeLevel: 2,
      ageBand: '5-7',
      parentalAttestation: true,
      attestationVersion: '1999-01-v1',
      attestedAt: '1999-01-01T00:00:00.000Z',
    });
    expect(extra.status).toBe(400);

    // The ticked box succeeds, and the SERVER's version and clock are what got stored.
    const ok = await post({
      nickname: 'Riley',
      gradeLevel: 2,
      ageBand: '5-7',
      parentalAttestation: true,
    });
    expect(ok.status).toBe(201);
    const { childId } = await json<{ childId: string }>(ok);
    const [row] = await api.db.sql<
      { attestation_version: string; attested_by: string; attested_at: Date }[]
    >`
      select attestation_version, attested_by, attested_at
        from public.child_profiles where id = ${childId}`;
    expect(row!.attestation_version).toBe(CONSENT_ATTESTATION_VERSION);
    expect(row!.attested_by).toBe(fam.ownerId);
    expect(row!.attested_at.getFullYear()).toBeGreaterThan(2000);
  });

  it('relocking on switch to child mode removes the step-up', async () => {
    await unlock();
    expect((await api.request('/v1/adult/lock', { method: 'POST', token })).status).toBe(200);
    const res = await api.request('/v1/children', {
      method: 'POST',
      token,
      body: { nickname: 'Avery', gradeLevel: 1, ageBand: '5-7', parentalAttestation: true },
    });
    expect(res.status).toBe(403);
  });

  it('locks out after repeated wrong PINs and does not accept the right PIN while locked', async () => {
    const f = await seedFamily(api.db);
    const t = await parentToken(f.ownerId, { sessionId: '44444444-4444-4444-8444-444444444444' });
    await setPin('739164', t);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await unlock('000001', t)).status);
    expect(statuses.slice(0, 4)).toEqual([403, 403, 403, 403]);
    expect(statuses[4]).toBe(423);
    const locked = await unlock('739164', t);
    expect(locked.status).toBe(423);
    expect(locked.headers.get('retry-after')).not.toBeNull();
  });

  it('changing an existing PIN requires the current step-up', async () => {
    const f = await seedFamily(api.db);
    const t = await parentToken(f.ownerId, { sessionId: '55555555-5555-4555-8555-555555555555' });
    expect((await setPin('739164', t)).status).toBe(200);
    expect((await setPin('846201', t)).status).toBe(403);
    await unlock('739164', t);
    expect((await setPin('846201', t)).status).toBe(200);
  });
});

describe('child pairing and sessions (AC_ACCESS_04, AC_ACCESS_06, AC_ACCESS_08)', () => {
  async function pairingCode(): Promise<string> {
    await unlock();
    const res = await api.request(`/v1/children/${fam.children[0]!.id}/pairing-code`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(201);
    return (await json<{ code: string }>(res)).code;
  }

  let pairCount = 0;
  /**
   * A client network of its own for each POST /v1/child/pair this file makes (N3-AUTH-RATE, the same
   * structural fix mobile-r2.review.test.ts carries). Pairing is limited per client network
   * (RATE_RULES.pairingRedeemPerNetwork, 20 per 15 minutes, keyed on cf-connecting-ip by
   * clientNetworkKey) and this file pins the clock, so the 15-minute window never advances and every
   * pairing that states no address spends the same 'unknown' bucket. An address in the IPv6
   * documentation prefix per pairing keeps the limit from binding here however many cases the file
   * grows: the limiter keys IPv6 on the /64 (and the pairing failure budget on the /48), so varying
   * the third group gives each pairing a network and a site of its own, with room for 65,535 of them.
   * The limit itself is untouched and still bites per network (the hygiene case at the end of this
   * describe, mobile-r2.review.test.ts and child-auth-hardening.test.ts).
   */
  function pairingAddress(): string {
    pairCount += 1;
    return `2001:db8:${pairCount.toString(16)}::1`;
  }

  async function pair(code: string) {
    return api.request('/v1/child/pair', {
      method: 'POST',
      headers: { 'cf-connecting-ip': pairingAddress() },
      body: { code, deviceLabel: 'Kitchen tablet', platform: 'ios' },
    });
  }

  it('a code pairs exactly one device, once, for the selected child only', async () => {
    const code = await pairingCode();
    const first = await pair(code);
    expect(first.status).toBe(201);
    const tokens = await json<{ accessToken: string; refreshToken: string; child: { id: string } }>(
      first,
    );
    expect(tokens.child.id).toBe(fam.children[0]!.id);
    expect((await pair(code)).status).toBe(404);
    const me = await api.request('/v1/child/me', { token: tokens.accessToken });
    expect(me.status).toBe(200);
    expect(await json(me)).toMatchObject({ id: fam.children[0]!.id, nickname: 'Riley' });
  });

  it('two concurrent redemptions of one code produce one session', async () => {
    const code = await pairingCode();
    const results = await Promise.all([pair(code), pair(code), pair(code)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('expired codes do not pair', async () => {
    const code = await pairingCode();
    api.now.value = new Date(api.now.value.getTime() + 11 * 60 * 1000);
    try {
      expect((await pair(code)).status).toBe(404);
    } finally {
      api.now.value = new Date('2026-09-24T15:00:00Z');
    }
  });

  it('a child token is not a parent token and cannot reach parent routes', async () => {
    const tokens = await json<{ accessToken: string }>(await pair(await pairingCode()));
    expect((await api.request('/v1/family', { token: tokens.accessToken })).status).toBe(401);
    expect(
      (
        await api.request('/v1/adult/unlock', {
          method: 'POST',
          token: tokens.accessToken,
          body: { method: 'pin', pin: '482913' },
        })
      ).status,
    ).toBe(401);
  });

  /**
   * The rule the rest of the tree cites by name for child refresh (HUNT6-A-4 asks for the name, not a
   * line number, because a helper inserted above this moves it). Reuse of a rotated token is theft
   * with NO exception: BUG-244's recovery, which served the tablet's own retry when the request
   * carried the id that consumed the token, was removed in round 6 (HUNT6-A-1), so the exception
   * clause this case once had to tolerate is gone. tests/mobile-r2.review.test.ts carries the cases
   * that go red if it returns.
   */
  it('refresh tokens rotate and reuse revokes the session', async () => {
    const tokens = await json<{ accessToken: string; refreshToken: string }>(
      await pair(await pairingCode()),
    );
    const refreshed = await api.request('/v1/child/refresh', {
      method: 'POST',
      body: { refreshToken: tokens.refreshToken },
    });
    expect(refreshed.status).toBe(200);
    const next = await json<{ accessToken: string; refreshToken: string }>(refreshed);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    // Replaying the old token (theft signal) revokes the session; even the new tokens stop working.
    expect(
      (
        await api.request('/v1/child/refresh', {
          method: 'POST',
          body: { refreshToken: tokens.refreshToken },
        })
      ).status,
    ).toBe(401);
    expect((await api.request('/v1/child/me', { token: next.accessToken })).status).toBe(401);
    expect(
      (
        await api.request('/v1/child/refresh', {
          method: 'POST',
          body: { refreshToken: next.refreshToken },
        })
      ).status,
    ).toBe(401);
    // A 401 alone would also be what a route that merely stopped serving this token returns. What is
    // required is a REVOCATION of the session, recorded as theft, so the family has a record of it.
    const actions = await api.db.sql<{ action: string }[]>`
      select action from public.audit_events
       where family_id = ${fam.familyId} and target_type = 'child_session'`;
    expect(actions.map((a) => a.action)).toContain('child_session.revoked_token_reuse');
    // And nothing heals it: a third presentation is still refused, and no token is issued.
    const third = await api.request('/v1/child/refresh', {
      method: 'POST',
      body: { refreshToken: tokens.refreshToken },
    });
    expect(third.status).toBe(401);
    expect(await json<{ error: { code: string } }>(third)).toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    });
  });

  it('revoking the device stops the still-unexpired access token immediately', async () => {
    const res = await pair(await pairingCode());
    const tokens = await json<{ accessToken: string }>(res);
    const devices = await json<{ devices: { id: string; revokedAt: string | null }[] }>(
      await api.request('/v1/devices', { token }),
    );
    const live = devices.devices.find((d) => d.revokedAt === null)!;
    await unlock();
    expect(
      (await api.request(`/v1/devices/${live.id}/revoke`, { method: 'POST', token })).status,
    ).toBe(200);
    // Revoke all remaining devices to be sure this token's device is included.
    for (const d of devices.devices.filter((x) => x.revokedAt === null)) {
      await api.request(`/v1/devices/${d.id}/revoke`, { method: 'POST', token });
    }
    expect((await api.request('/v1/child/me', { token: tokens.accessToken })).status).toBe(401);
  });

  it('a parent cannot revoke another family device', async () => {
    const otherFam = await seedFamily(api.db);
    await unlock();
    const res = await api.request(`/v1/devices/${otherFam.children[0]!.deviceId}/revoke`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(404);
    const [device] = await api.db.sql<
      { revoked_at: Date | null }[]
    >`select revoked_at from public.child_devices where id = ${otherFam.children[0]!.deviceId}`;
    expect(device!.revoked_at).toBeNull();
  });

  /**
   * HYGIENE (N3-AUTH-RATE). Every pairing above is one POST /v1/child/pair counted against
   * RATE_RULES.pairingRedeemPerNetwork (20 per 15 minutes per client network) under a clock this
   * file pins, so the window never advances: while `pair` stated no address, every pairing in the
   * file spent the ONE 'unknown' bucket and the file sat at about half that limit — headroom, not a
   * failure, until the next case anyone added turned it into a 429 that has nothing to do with what
   * the file tests. This case holds the fix: `pair` states a network of its own each time, so more
   * attempts than any one network may make still all reach the code. The limit itself is untouched
   * and still bites per network (mobile-r2.review.test.ts, child-auth-hardening.test.ts).
   */
  it('more attempts than one network may make all reach the code, because each states its own', async () => {
    const limit = RATE_RULES.pairingRedeemPerNetwork.limit;
    // Wrong codes: an attempt is counted against the network before the code is looked at, so this
    // spends a pairing budget without needing a code. A shared bucket answers 429 from attempt 21.
    const statuses: number[] = [];
    for (let i = 0; i < limit + 2; i += 1) statuses.push((await pair('ZZZZ-ZZZZ')).status);
    expect(statuses).toEqual(new Array<number>(limit + 2).fill(404));
  });

  it('draft children cannot be paired', async () => {
    const [draft] = await api.db.sql<{ id: string }[]>`
      insert into public.child_profiles (family_id, nickname, grade_level, age_band) values (${fam.familyId}, 'Jordan', 4, '8-10') returning id`;
    await unlock();
    const res = await api.request(`/v1/children/${draft!.id}/pairing-code`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(res)).error.rule).toBe('CHILD_NOT_ACTIVE');
  });
});

describe('transport hardening', () => {
  it('rejects oversized bodies and unknown fields', async () => {
    const big = await api.request('/v1/adult/pin', {
      method: 'PUT',
      token,
      body: { pin: '482913' },
      headers: { 'content-length': String(1024 * 1024) },
    });
    expect(big.status).toBe(413);
    const extra = await api.request('/v1/adult/pin', {
      method: 'PUT',
      token,
      body: { pin: '482913', role: 'admin' },
    });
    expect(extra.status).toBe(400);
  });

  it('CORS only answers configured origins', async () => {
    const ok = await api.request('/v1/family', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.pencillift.test' },
    });
    expect(ok.status).toBe(204);
    const bad = await api.request('/v1/family', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(bad.status).toBe(403);
  });

  it('readiness is owner-admin only and reports blocked integrations honestly', async () => {
    expect((await api.request('/v1/admin/readiness', { token })).status).toBe(403);
    const adminId = await api.db.createUser();
    await api.db
      .sql`insert into public.admin_users (user_id, role) values (${adminId}, 'owner_admin')`;
    const adminToken = await parentToken(adminId, { aal: 'aal2' });
    const res = await api.request('/v1/admin/readiness', { token: adminToken });
    expect(res.status).toBe(200);
    const body = await json<{ checks: { check: string; status: string }[] }>(res);
    expect(body.checks.find((c) => c.check === 'consent_provider')!.status).toBe('blocked');
    expect(body.checks.find((c) => c.check === 'zdr_evidence')!.status).toBe('blocked');
  });

  it('logs contain no request bodies, PINs or tokens', () => {
    const text = JSON.stringify(api.logs);
    expect(text).not.toContain('482913');
    expect(text).not.toContain('Bearer');
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});
