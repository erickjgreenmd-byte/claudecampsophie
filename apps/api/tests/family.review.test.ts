import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Independent adversarial review of the family vertical (guardians, invitations, consent).
 * Real Postgres; synthetic adults and children only. Tests named [RV-family-n] reproduce defects
 * found in review; the "probe" tests pin the riskiest behaviour that was verified sound.
 */

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

/** Pulls the raw token out of the most recent invitation email sent to `to`. */
function tokenFromOutbox(to: string): string {
  const message = [...api.providers.email.outbox].reverse().find((m) => m.to === to);
  if (!message) throw new Error(`no invitation email to ${to}`);
  const match = /#accept=([A-Za-z0-9_-]+)$/.exec(message.params.acceptUrl ?? '');
  if (!match?.[1]) throw new Error('invitation link has no token');
  return match[1];
}

/** Owner of `fam` invites `email`, and the adult `userId` accepts. Returns the guardian token. */
async function addGuardian(
  fam: SeededFamily,
  ownerSession: string,
  email: string,
  userId: string,
  guardianSession: string,
): Promise<string> {
  const ownerToken = await parentToken(fam.ownerId, { sessionId: ownerSession });
  const invited = await api.request('/v1/guardians/invitations', {
    method: 'POST',
    token: ownerToken,
    body: { email },
  });
  expect(invited.status).toBe(201);
  const guardianToken = await parentToken(userId, { sessionId: guardianSession });
  const accepted = await api.request('/v1/invitations/accept', {
    method: 'POST',
    token: guardianToken,
    body: { token: tokenFromOutbox(email) },
  });
  expect(accepted.status).toBe(200);
  return guardianToken;
}

describe('family vertical review: guardian removal (AC_ACCESS_09)', () => {
  it('[RV-family-1] a pairing code created by a guardian stops working when that guardian is removed', async () => {
    const OWNER_SESSION = '41111111-1111-4111-8111-111111111111';
    const GUARDIAN_SESSION = '42222222-2222-4222-8222-222222222222';
    const email = 'rv1.guardian@example.test';
    const fam = await seedFamily(api.db, { childCount: 1 }); // Riley, active
    await grantAdultUnlock(api.db, fam.ownerId, OWNER_SESSION, 3600);
    const guardianId = await api.db.createUser(email);
    const guardianToken = await addGuardian(
      fam,
      OWNER_SESSION,
      email,
      guardianId,
      GUARDIAN_SESSION,
    );

    // While still a guardian (with a recent step-up) they create a pairing code for Riley.
    await grantAdultUnlock(api.db, guardianId, GUARDIAN_SESSION, 3600);
    const created = await api.request(`/v1/children/${fam.children[0]!.id}/pairing-code`, {
      method: 'POST',
      token: guardianToken,
    });
    expect(created.status).toBe(201);
    const { code } = await json<{ code: string }>(created);

    // The owner removes the guardian: access and pending privileged actions must end now.
    const removed = await api.request(`/v1/guardians/${guardianId}`, {
      method: 'DELETE',
      token: await parentToken(fam.ownerId, { sessionId: OWNER_SESSION }),
    });
    expect(removed.status).toBe(200);
    expect((await api.request('/v1/family', { token: guardianToken })).status).toBe(404);

    // The removed guardian still holds the unexpired one-time code. Redeeming it must not create a
    // child device/session for Riley on a device the removed adult controls.
    const paired = await api.request('/v1/child/pair', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.21' },
      body: { code, deviceLabel: 'Removed adult phone', platform: 'android' },
    });
    expect(paired.status).toBe(404);
    const devices = await api.db.sql`
      select 1 from public.child_devices
       where family_id = ${fam.familyId} and label = 'Removed adult phone'`;
    expect(devices.length).toBe(0);
  });
});

describe('family vertical review: one family per adult (spec P1)', () => {
  /**
   * Accepting checks "already in a family" with an unlocked read, and the adult-limit trigger only
   * locks the *invited* family's row, so two acceptances into different families race past the
   * check. The race is timing-dependent; several fresh attempts make the reproduction reliable.
   */
  it('[RV-family-2] two invitations accepted concurrently cannot put one adult in two families', async () => {
    const SESSION_A = '43333333-3333-4333-8333-333333333333';
    const SESSION_B = '44444444-4444-4444-8444-444444444444';
    const outcomes: { memberships: number; statuses: number[] }[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const email = `rv2.guardian${attempt}@example.test`;
      const famA = await seedFamily(api.db, { childCount: 1 });
      const famB = await seedFamily(api.db, { childCount: 1 });
      await grantAdultUnlock(api.db, famA.ownerId, SESSION_A, 3600);
      await grantAdultUnlock(api.db, famB.ownerId, SESSION_B, 3600);
      const adultId = await api.db.createUser(email);
      for (const [fam, session] of [
        [famA, SESSION_A],
        [famB, SESSION_B],
      ] as const) {
        const res = await api.request('/v1/guardians/invitations', {
          method: 'POST',
          token: await parentToken(fam.ownerId, { sessionId: session }),
          body: { email },
        });
        expect(res.status).toBe(201);
      }
      const tokens = api.providers.email.outbox
        .filter((m) => m.to === email)
        .map((m) => /#accept=([A-Za-z0-9_-]+)$/.exec(m.params.acceptUrl ?? '')![1]!);
      expect(tokens).toHaveLength(2);

      const adultToken = await parentToken(adultId);
      const results = await Promise.all(
        tokens.map((token) =>
          api.request('/v1/invitations/accept', {
            method: 'POST',
            token: adultToken,
            body: { token },
          }),
        ),
      );
      const [row] = await api.db.sql<{ n: number }[]>`
        select count(*)::int as n from public.family_memberships
         where user_id = ${adultId} and status = 'active'`;
      outcomes.push({ memberships: row!.n, statuses: results.map((r) => r.status).sort() });
    }
    // Exactly one acceptance may win each time; the other must be refused as ALREADY_IN_FAMILY.
    expect(outcomes.filter((o) => o.memberships !== 1)).toEqual([]);
    expect(outcomes.every((o) => o.statuses.join() === '200,409')).toBe(true);
  });
});

describe('family vertical review: probes of the riskiest behaviour (expected to pass)', () => {
  let fam: SeededFamily;
  let other: SeededFamily;
  const OWNER_SESSION = '45555555-5555-4555-8555-555555555555';
  const OTHER_SESSION = '46666666-6666-4666-8666-666666666666';

  beforeAll(async () => {
    fam = await seedFamily(api.db, { childCount: 1 });
    other = await seedFamily(api.db, { childCount: 1 });
    await grantAdultUnlock(api.db, fam.ownerId, OWNER_SESSION, 3600);
    await grantAdultUnlock(api.db, other.ownerId, OTHER_SESSION, 3600);
  });

  it('probe: another family cannot cancel this family’s pending invitation', async () => {
    const email = 'rv.probe.cancel@example.test';
    const res = await api.request('/v1/guardians/invitations', {
      method: 'POST',
      token: await parentToken(fam.ownerId, { sessionId: OWNER_SESSION }),
      body: { email },
    });
    const { invitationId } = await json<{ invitationId: string }>(res);
    const cross = await api.request(`/v1/guardians/invitations/${invitationId}/revoke`, {
      method: 'POST',
      token: await parentToken(other.ownerId, { sessionId: OTHER_SESSION }),
    });
    expect(cross.status).toBe(404);
    const [row] = await api.db.sql<{ status: string }[]>`
      select status from public.guardian_invitations where id = ${invitationId}`;
    expect(row!.status).toBe('pending');
  });

  it('probe: another family’s withdrawal never touches this family’s consent or jobs', async () => {
    const token = await parentToken(fam.ownerId, { sessionId: OWNER_SESSION });
    const started = await json<{ consentId: string }>(
      await api.request('/v1/consent/start', { method: 'POST', token, body: {} }),
    );
    await api.request(`/v1/consent/${started.consentId}/refresh`, { method: 'POST', token });
    const [job] = await api.db.sql<{ id: string }[]>`
      insert into public.jobs (kind, idempotency_key, family_id, status)
      values ('scan_process', ${`rv-scan:${fam.familyId}`}, ${fam.familyId}, 'queued') returning id`;
    const otherToken = await parentToken(other.ownerId, { sessionId: OTHER_SESSION });
    const res = await api.request('/v1/consent/withdraw', {
      method: 'POST',
      token: otherToken,
      body: {},
    });
    expect(res.status).toBe(404); // the other family has no consent record
    const [consent] = await api.db.sql<{ status: string }[]>`
      select status from public.consent_records where id = ${started.consentId}`;
    expect(consent!.status).toBe('verified');
    const [jobRow] = await api.db.sql<{ status: string }[]>`
      select status from public.jobs where id = ${job!.id}`;
    expect(jobRow!.status).toBe('queued');
  });

  it('probe: a paired child token cannot use guardian, invitation or consent routes', async () => {
    // Child access tokens are signed with a different secret and role; requireParent rejects them.
    const pairCode = await api.request(`/v1/children/${fam.children[0]!.id}/pairing-code`, {
      method: 'POST',
      token: await parentToken(fam.ownerId, { sessionId: OWNER_SESSION }),
    });
    const { code } = await json<{ code: string }>(pairCode);
    const paired = await json<{ accessToken: string }>(
      await api.request('/v1/child/pair', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.22' },
        body: { code, deviceLabel: 'Riley tablet', platform: 'ios' },
      }),
    );
    for (const [method, path, body] of [
      ['GET', '/v1/guardians', undefined],
      ['GET', '/v1/consent', undefined],
      ['POST', '/v1/consent/start', {}],
      ['POST', '/v1/consent/withdraw', {}],
      ['POST', '/v1/guardians/invitations', { email: 'child.escalation@example.test' }],
      ['POST', '/v1/invitations/accept', { token: 'x'.repeat(43) }],
    ] as const) {
      const res = await api.request(path, { method, token: paired.accessToken, body });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('probe: a consent start body cannot smuggle an outcome, family or provider flag', async () => {
    const token = await parentToken(other.ownerId, { sessionId: OTHER_SESSION });
    for (const body of [
      { familyId: fam.familyId },
      { isTestProvider: false },
      { status: 'verified' },
    ]) {
      const res = await api.request('/v1/consent/start', { method: 'POST', token, body });
      expect(res.status).toBe(400);
    }
  });

  it('probe: GET /v1/guardians never exposes invitation tokens or hashes', async () => {
    const res = await api.request('/v1/guardians', {
      token: await parentToken(fam.ownerId, { sessionId: OWNER_SESSION }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const token = tokenFromOutbox('rv.probe.cancel@example.test');
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/token/i);
  });
});
