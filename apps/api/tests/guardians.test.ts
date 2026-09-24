import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { CONSENT_POLICY_VERSION, maskEmail } from '@pencillift/contracts';
import { hasVerifiedConsent } from '../src/services/consent.ts';
import type { ConsentProvider } from '../src/providers/index.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Guardians, invitations and consent (spec P1 guardians, P3; AC_ACCESS_01, 02, 09).
 * Real Postgres; synthetic adults only.
 */

let api: TestApi;
let fam: SeededFamily; // owner of the family under test
let other: SeededFamily; // an unrelated family
let consentFam: SeededFamily;

const OWNER_SESSION = '31111111-1111-4111-8111-111111111111';
const OWNER_NO_UNLOCK = '32222222-2222-4222-8222-222222222222';
const GUARDIAN_SESSION = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '34444444-4444-4444-8444-444444444444';
const CONSENT_SESSION = '35555555-5555-4555-8555-555555555555';

const GUARDIAN_EMAIL = 'sam.guardian@example.test';
const THIRD_EMAIL = 'third.adult@example.test';
const WRONG_EMAIL = 'someone.else@example.test';
const UNVERIFIED_EMAIL = 'unverified.adult@example.test';

let ownerToken: string;
let ownerNoUnlockToken: string;
let otherToken: string;
let guardianId: string;
let guardianToken: string;
let thirdId: string;
let wrongId: string;
let unverifiedId: string;
let ownerEmail: string;

const START = new Date('2026-09-24T15:00:00Z');

/**
 * Schema request SR-FAMILY-1 (reported, not yet a migration): the Supabase platform does not grant
 * the API service role SELECT on auth.users, so the verified-email check for invitation acceptance
 * goes through this SECURITY DEFINER lookup, executable by service_role only. Applied here exactly
 * as requested until the migration owner adds it.
 */
const AUTH_EMAIL_FUNCTION_SQL = `
create or replace function app.adult_auth_email(p_user uuid)
returns table (email text, email_verified boolean)
language sql stable security definer
set search_path = ''
as $$
  select u.email::text, u.email_confirmed_at is not null from auth.users u where u.id = p_user
$$;
revoke execute on function app.adult_auth_email(uuid) from public, anon, authenticated, pl_child;
grant execute on function app.adult_auth_email(uuid) to service_role;
`;

beforeAll(async () => {
  api = await createTestApi();
  // Pending schema request (see route module): verified-email lookup for the API service role.
  await api.db.sql.unsafe(AUTH_EMAIL_FUNCTION_SQL);
  fam = await seedFamily(api.db, { childCount: 1 });
  other = await seedFamily(api.db, { childCount: 1 });
  consentFam = await seedFamily(api.db, { childCount: 1 });
  guardianId = await api.db.createUser(GUARDIAN_EMAIL);
  thirdId = await api.db.createUser(THIRD_EMAIL);
  wrongId = await api.db.createUser(WRONG_EMAIL);
  const [unverified] = await api.db.sql<{ id: string }[]>`
    insert into auth.users (email) values (${UNVERIFIED_EMAIL}) returning id`;
  unverifiedId = unverified!.id;
  const [owner] = await api.db.sql<
    { email: string }[]
  >`select email from auth.users where id = ${fam.ownerId}`;
  ownerEmail = owner!.email;

  ownerToken = await parentToken(fam.ownerId, { sessionId: OWNER_SESSION });
  ownerNoUnlockToken = await parentToken(fam.ownerId, { sessionId: OWNER_NO_UNLOCK });
  otherToken = await parentToken(other.ownerId, { sessionId: OTHER_SESSION });
  guardianToken = await parentToken(guardianId, { sessionId: GUARDIAN_SESSION });
  await grantAdultUnlock(api.db, fam.ownerId, OWNER_SESSION, 3600);
  await grantAdultUnlock(api.db, other.ownerId, OTHER_SESSION, 3600);
});

afterAll(async () => {
  await api?.close();
});

function invite(email: string, token = ownerToken) {
  return api.request('/v1/guardians/invitations', { method: 'POST', token, body: { email } });
}

function accept(invitationToken: string, token: string) {
  return api.request('/v1/invitations/accept', {
    method: 'POST',
    token,
    body: { token: invitationToken },
  });
}

/** Pulls the raw token out of the most recent invitation email sent to `to`. */
function tokenFromOutbox(to: string): string {
  const message = [...api.providers.email.outbox].reverse().find((m) => m.to === to);
  if (!message) throw new Error(`no invitation email to ${to}`);
  const url = message.params.acceptUrl ?? '';
  const match = /#accept=([A-Za-z0-9_-]+)$/.exec(url);
  if (!match?.[1]) throw new Error('invitation link has no token');
  return match[1];
}

async function errorOf(res: Response) {
  return (await json<{ error: { code: string; rule?: string } }>(res)).error;
}

describe('guardian invitations (AC_ACCESS_09)', () => {
  let guardianInviteToken = '';
  let thirdInviteToken = '';

  it('requires the family owner and a recent step-up', async () => {
    const res = await invite(GUARDIAN_EMAIL, ownerNoUnlockToken);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('STEP_UP_REQUIRED');
    expect((await api.request('/v1/guardians/invitations', { method: 'POST' })).status).toBe(401);
  });

  it('creates a 7-day invitation, emails the link and stores only the token hash', async () => {
    const before = api.providers.email.outbox.length;
    const res = await invite(`  ${GUARDIAN_EMAIL.toUpperCase()} `.trim());
    expect(res.status).toBe(201);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(['email', 'expiresAt', 'invitationId', 'status']);
    expect(body.email).toBe(GUARDIAN_EMAIL);
    expect(body.status).toBe('pending');
    expect(body.expiresAt).toBe(new Date(START.getTime() + 7 * 86_400_000).toISOString());

    expect(api.providers.email.outbox.length).toBe(before + 1);
    const message = api.providers.email.outbox.at(-1)!;
    expect(message.templateKey).toBe('guardian_invitation');
    expect(message.to).toBe(GUARDIAN_EMAIL);
    guardianInviteToken = tokenFromOutbox(GUARDIAN_EMAIL);
    expect(guardianInviteToken.length).toBeGreaterThanOrEqual(43); // 256-bit base64url
    expect(JSON.stringify(body)).not.toContain(guardianInviteToken);

    const [row] = await api.db.sql<{ hash: string }[]>`
      select encode(t.token_hash, 'hex') as hash from private.guardian_invitation_tokens t
       where t.invitation_id = ${body.invitationId as string}`;
    expect(row!.hash).toBe(createHash('sha256').update(guardianInviteToken).digest('hex'));

    const audit = await api.db.sql`
      select 1 from public.audit_events where family_id = ${fam.familyId} and action = 'guardian.invited'`;
    expect(audit.length).toBe(1);
  });

  it('allows at most one pending invitation per email', async () => {
    const res = await invite(GUARDIAN_EMAIL.toUpperCase());
    expect(res.status).toBe(409);
    expect((await errorOf(res)).rule).toBe('INVITATION_ALREADY_PENDING');
  });

  it('rejects acceptance by a different signed-in adult', async () => {
    const res = await accept(guardianInviteToken, await parentToken(wrongId));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).rule).toBe('INVITATION_EMAIL_MISMATCH');
    const [row] = await api.db.sql<{ status: string }[]>`
      select status from public.guardian_invitations where email = ${GUARDIAN_EMAIL}`;
    expect(row!.status).toBe('pending');
  });

  it('rejects an adult whose email is not verified', async () => {
    expect((await invite(UNVERIFIED_EMAIL)).status).toBe(201);
    const res = await accept(tokenFromOutbox(UNVERIFIED_EMAIL), await parentToken(unverifiedId));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).rule).toBe('EMAIL_NOT_VERIFIED');
  });

  it('rejects an adult who already belongs to a family', async () => {
    const [otherOwner] = await api.db.sql<{ email: string }[]>`
      select email from auth.users where id = ${other.ownerId}`;
    expect((await invite(otherOwner!.email)).status).toBe(201);
    const res = await accept(tokenFromOutbox(otherOwner!.email), otherToken);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).rule).toBe('ALREADY_IN_FAMILY');
  });

  it('rejects a garbage or unknown token without revealing anything', async () => {
    const res = await accept('x'.repeat(43), guardianToken);
    expect(res.status).toBe(404);
    expect((await accept('short', guardianToken)).status).toBe(400);
  });

  it('the invited adult accepts with a verified matching email and gets family access', async () => {
    // A second outstanding invitation, to prove the DB trigger stops a third adult later.
    expect((await invite(THIRD_EMAIL)).status).toBe(201);
    thirdInviteToken = tokenFromOutbox(THIRD_EMAIL);

    expect((await api.request('/v1/family', { token: guardianToken })).status).toBe(404);
    const res = await accept(guardianInviteToken, guardianToken);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ familyId: fam.familyId, role: 'guardian' });

    const family = await api.request('/v1/family', { token: guardianToken });
    expect(family.status).toBe(200);
    expect((await json<{ id: string }>(family)).id).toBe(fam.familyId);

    const [inv] = await api.db.sql<{ status: string; accepted_by: string }[]>`
      select status, accepted_by from public.guardian_invitations where email = ${GUARDIAN_EMAIL}`;
    expect(inv).toEqual({ status: 'accepted', accepted_by: guardianId });
    const audit = await api.db.sql`
      select 1 from public.audit_events
       where family_id = ${fam.familyId} and action = 'guardian.accepted' and actor_user_id = ${guardianId}`;
    expect(audit.length).toBe(1);
  });

  it('a used token cannot be reused', async () => {
    const res = await accept(guardianInviteToken, guardianToken);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).rule).toBe('INVITATION_NOT_PENDING');
  });

  it('a third adult is blocked by the database limit even with a valid invitation', async () => {
    const res = await accept(thirdInviteToken, await parentToken(thirdId));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).rule).toBe('ADULT_LIMIT_REACHED');
    const [count] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.family_memberships
       where family_id = ${fam.familyId} and status = 'active'`;
    expect(count!.n).toBe(2);
  });

  it('new invitations are refused once two adults are active', async () => {
    const res = await invite('fourth.adult@example.test');
    expect(res.status).toBe(409);
    expect((await errorOf(res)).rule).toBe('ADULT_LIMIT_REACHED');
  });

  it('lists members with the other adult masked, for both adults', async () => {
    const asOwner = await api.request('/v1/guardians', { token: ownerToken });
    expect(asOwner.status).toBe(200);
    const ownerView = await json<{
      callerRole: string;
      maxAdults: number;
      members: { userId: string; role: string; email: string | null; isYou: boolean }[];
      pendingInvitations: { email: string }[];
    }>(asOwner);
    expect(ownerView.callerRole).toBe('owner');
    expect(ownerView.maxAdults).toBe(2);
    expect(ownerView.members).toHaveLength(2);
    const me = ownerView.members.find((m) => m.isYou)!;
    const them = ownerView.members.find((m) => !m.isYou)!;
    expect(me).toMatchObject({ role: 'owner', email: ownerEmail });
    expect(them).toMatchObject({
      role: 'guardian',
      userId: guardianId,
      email: maskEmail(GUARDIAN_EMAIL),
    });
    expect(ownerView.pendingInvitations.map((p) => p.email)).toContain(THIRD_EMAIL);

    const asGuardian = await json<typeof ownerView>(
      await api.request('/v1/guardians', { token: guardianToken }),
    );
    expect(asGuardian.callerRole).toBe('guardian');
    const owner = asGuardian.members.find((m) => m.role === 'owner')!;
    expect(owner.email).toBe(maskEmail(ownerEmail));
    expect(owner.email).not.toBe(ownerEmail);
    expect(asGuardian.pendingInvitations.map((p) => p.email)).toContain(maskEmail(THIRD_EMAIL));
    expect(JSON.stringify(asGuardian)).not.toContain(THIRD_EMAIL);
  });

  it('a guardian cannot invite, revoke invitations or remove adults', async () => {
    await grantAdultUnlock(api.db, guardianId, GUARDIAN_SESSION, 3600);
    const res = await invite('another.adult@example.test', guardianToken);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).rule).toBe('OWNER_ONLY');
    const remove = await api.request(`/v1/guardians/${fam.ownerId}`, {
      method: 'DELETE',
      token: guardianToken,
    });
    expect(remove.status).toBe(403);
  });

  it('the owner can cancel a pending invitation, which then cannot be accepted', async () => {
    const [pending] = await api.db.sql<{ id: string }[]>`
      select id from public.guardian_invitations where email = ${THIRD_EMAIL} and status = 'pending'`;
    const res = await api.request(`/v1/guardians/invitations/${pending!.id}/revoke`, {
      method: 'POST',
      token: ownerToken,
    });
    expect(res.status).toBe(200);
    const again = await accept(thirdInviteToken, await parentToken(thirdId));
    expect(again.status).toBe(409);
    expect((await errorOf(again)).rule).toBe('INVITATION_NOT_PENDING');
  });

  it('another family cannot remove this family’s guardian', async () => {
    const res = await api.request(`/v1/guardians/${guardianId}`, {
      method: 'DELETE',
      token: otherToken,
    });
    expect(res.status).toBe(404);
  });

  it('the owner cannot be removed', async () => {
    const res = await api.request(`/v1/guardians/${fam.ownerId}`, {
      method: 'DELETE',
      token: ownerToken,
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).rule).toBe('CANNOT_REMOVE_OWNER');
  });

  it('removal needs step-up and immediately blocks the removed guardian', async () => {
    const noUnlock = await api.request(`/v1/guardians/${guardianId}`, {
      method: 'DELETE',
      token: ownerNoUnlockToken,
    });
    expect(noUnlock.status).toBe(403);
    expect((await api.request('/v1/family', { token: guardianToken })).status).toBe(200);

    const res = await api.request(`/v1/guardians/${guardianId}`, {
      method: 'DELETE',
      token: ownerToken,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });

    // Same (still cryptographically valid) token: access is gone at once.
    expect((await api.request('/v1/family', { token: guardianToken })).status).toBe(404);
    expect((await api.request('/v1/guardians', { token: guardianToken })).status).toBe(404);
    const unlocks = await api.db.sql<{ revoked_at: Date | null }[]>`
      select revoked_at from private.adult_unlocks where user_id = ${guardianId}`;
    expect(unlocks.length).toBeGreaterThan(0);
    expect(unlocks.every((u) => u.revoked_at !== null)).toBe(true);
    const audit = await api.db.sql`
      select 1 from public.audit_events where family_id = ${fam.familyId} and action = 'guardian.removed'`;
    expect(audit.length).toBe(1);

    const view = await json<{ members: unknown[] }>(
      await api.request('/v1/guardians', { token: ownerToken }),
    );
    expect(view.members).toHaveLength(1);
    const again = await api.request(`/v1/guardians/${guardianId}`, {
      method: 'DELETE',
      token: ownerToken,
    });
    expect(again.status).toBe(404);
  });

  it('an expired invitation cannot be accepted and can be re-sent', async () => {
    expect((await invite(WRONG_EMAIL)).status).toBe(201);
    const expiredToken = tokenFromOutbox(WRONG_EMAIL);
    api.now.value = new Date(START.getTime() + 8 * 86_400_000);
    try {
      const res = await accept(expiredToken, await parentToken(wrongId));
      expect(res.status).toBe(422);
      expect((await errorOf(res)).rule).toBe('INVITATION_EXPIRED');
      const [row] = await api.db.sql<{ status: string }[]>`
        select status from public.guardian_invitations
         where family_id = ${fam.familyId} and email = ${WRONG_EMAIL}`;
      expect(row!.status).toBe('expired');
      // A stale invitation does not block a fresh one to the same address.
      expect((await invite(WRONG_EMAIL)).status).toBe(201);
    } finally {
      api.now.value = START;
    }
  });

  it('the verified-email lookup is not callable by signed-in adults or children', async () => {
    await expect(
      api.db.asParent(fam.ownerId, (tx) => tx`select * from app.adult_auth_email(${guardianId})`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('guardian removal ends pending pairing codes (AC_ACCESS_09, RV-family-1)', () => {
  it('retires only the removed guardian’s unredeemed codes; the owner’s codes keep working', async () => {
    const ownerSession = '36666666-6666-4666-8666-666666666666';
    const guardianSession = '37777777-7777-4777-8777-777777777777';
    const email = 'riley.guardian.pairing@example.test';
    const family = await seedFamily(api.db, { childCount: 2 }); // two active children
    const [riley, sam] = family.children;
    await grantAdultUnlock(api.db, family.ownerId, ownerSession, 3600);
    const owner = await parentToken(family.ownerId, { sessionId: ownerSession });
    expect((await invite(email, owner)).status).toBe(201);
    const adultId = await api.db.createUser(email);
    const adult = await parentToken(adultId, { sessionId: guardianSession });
    expect((await accept(tokenFromOutbox(email), adult)).status).toBe(200);
    await grantAdultUnlock(api.db, adultId, guardianSession, 3600);

    const codeFor = async (childId: string, token: string) => {
      const res = await api.request(`/v1/children/${childId}/pairing-code`, {
        method: 'POST',
        token,
      });
      expect(res.status).toBe(201);
      return (await json<{ code: string }>(res)).code;
    };
    const guardianCode = await codeFor(riley!.id, adult);
    const ownerCode = await codeFor(sam!.id, owner);

    const removed = await api.request(`/v1/guardians/${adultId}`, {
      method: 'DELETE',
      token: owner,
    });
    expect(removed.status).toBe(200);

    const pair = (code: string, ip: string) =>
      api.request('/v1/child/pair', {
        method: 'POST',
        headers: { 'cf-connecting-ip': ip },
        body: { code, deviceLabel: 'Synthetic tablet', platform: 'ios' },
      });
    expect((await pair(guardianCode, '198.51.100.31')).status).toBe(404);
    expect((await pair(ownerCode, '198.51.100.32')).status).toBe(201);
    const devices = await api.db.sql<{ child_id: string }[]>`
      select child_id from public.child_devices
       where family_id = ${family.familyId} and label = 'Synthetic tablet'`;
    expect(devices.map((d) => d.child_id)).toEqual([sam!.id]);
  });
});

describe('consent (spec P3, AC_ACCESS_01/02)', () => {
  let token: string;
  let consentId = '';

  beforeAll(async () => {
    token = await parentToken(consentFam.ownerId, { sessionId: CONSENT_SESSION });
  });

  it('reports no consent at first and flags the configured test provider', async () => {
    const res = await api.request('/v1/consent', { token });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      state: 'none',
      consentId: null,
      isTestProvider: false,
      configuredProviderIsTest: true,
      verifiedAt: null,
      withdrawnAt: null,
      policyVersion: null,
      currentPolicyVersion: CONSENT_POLICY_VERSION,
    });
  });

  it('a client cannot claim a consent outcome', async () => {
    const res = await api.request('/v1/consent/start', {
      method: 'POST',
      token,
      body: { status: 'verified' },
    });
    expect(res.status).toBe(400);
  });

  it('starting consent records a pending, test-provider record', async () => {
    const res = await api.request('/v1/consent/start', { method: 'POST', token, body: {} });
    expect(res.status).toBe(201);
    const body = await json<{ consentId: string; state: string; isTestProvider: boolean }>(res);
    expect(body).toMatchObject({ state: 'pending', isTestProvider: true, redirectUrl: null });
    consentId = body.consentId;
    const [row] = await api.db.sql<
      {
        status: string;
        is_test_provider: boolean;
        policy_version: string;
        purpose: string;
        provider: string;
        adult_user_id: string;
        family_id: string;
      }[]
    >`select status, is_test_provider, policy_version, purpose, provider, adult_user_id, family_id
        from public.consent_records where id = ${consentId}`;
    expect(row).toEqual({
      status: 'pending',
      is_test_provider: true,
      policy_version: CONSENT_POLICY_VERSION,
      purpose: 'child_learning_data',
      provider: 'development_mock',
      adult_user_id: consentFam.ownerId,
      family_id: consentFam.familyId,
    });
    expect((await json<{ state: string }>(await api.request('/v1/consent', { token }))).state).toBe(
      'pending',
    );
  });

  it('another family cannot refresh this consent record', async () => {
    const res = await api.request(`/v1/consent/${consentId}/refresh`, {
      method: 'POST',
      token: otherToken,
    });
    expect(res.status).toBe(404);
  });

  it('refresh records the provider result; a test-provider consent never counts in production', async () => {
    const res = await api.request(`/v1/consent/${consentId}/refresh`, { method: 'POST', token });
    expect(res.status).toBe(200);
    const body = await json<{ state: string; isTestProvider: boolean; verifiedAt: string | null }>(
      res,
    );
    expect(body.state).toBe('verified');
    expect(body.isTestProvider).toBe(true);
    expect(body.verifiedAt).not.toBeNull();
    const [row] = await api.db.sql<{ status: string; is_test_provider: boolean }[]>`
      select status, is_test_provider from public.consent_records where id = ${consentId}`;
    expect(row).toEqual({ status: 'verified', is_test_provider: true });
    const gate = await api.apiDb.asService(async (tx) => ({
      production: await hasVerifiedConsent(tx, consentFam.familyId, { allowTestProvider: false }),
      development: await hasVerifiedConsent(tx, consentFam.familyId, { allowTestProvider: true }),
    }));
    expect(gate).toEqual({ production: false, development: true });
  });

  it('a verified consent is not started again', async () => {
    const res = await api.request('/v1/consent/start', { method: 'POST', token, body: {} });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).rule).toBe('CONSENT_ALREADY_VERIFIED');
  });

  it('withdrawal needs step-up, stops processing jobs and keeps privacy jobs', async () => {
    const jobs = await api.db.sql<{ id: string; kind: string }[]>`
      insert into public.jobs (kind, idempotency_key, family_id, status) values
        ('scan_process', ${`scan:${consentFam.familyId}:1`}, ${consentFam.familyId}, 'queued'),
        ('daily_set_generate', ${`daily:${consentFam.familyId}:1`}, ${consentFam.familyId}, 'failed_retryable'),
        ('deletion_purge', ${`purge:${consentFam.familyId}:1`}, ${consentFam.familyId}, 'queued'),
        ('scan_process', ${`scan:${consentFam.familyId}:2`}, ${consentFam.familyId}, 'succeeded'),
        ('scan_process', ${`scan:${other.familyId}:1`}, ${other.familyId}, 'queued')
      returning id, kind`;

    const denied = await api.request('/v1/consent/withdraw', { method: 'POST', token, body: {} });
    expect(denied.status).toBe(403);
    expect((await errorOf(denied)).code).toBe('STEP_UP_REQUIRED');

    await grantAdultUnlock(api.db, consentFam.ownerId, CONSENT_SESSION);
    const res = await api.request('/v1/consent/withdraw', { method: 'POST', token, body: {} });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ state: 'withdrawn', cancelledJobs: 2 });

    const statuses = await api.db.sql<{ id: string; status: string }[]>`
      select id, status from public.jobs where id in ${api.db.sql(jobs.map((j) => j.id))}`;
    const byId = new Map(statuses.map((s) => [s.id, s.status]));
    expect(jobs.map((j) => byId.get(j.id))).toEqual([
      'cancelled',
      'cancelled',
      'queued',
      'succeeded',
      'queued',
    ]);

    const status = await json<{ state: string; withdrawnAt: string | null }>(
      await api.request('/v1/consent', { token }),
    );
    expect(status.state).toBe('withdrawn');
    expect(status.withdrawnAt).not.toBeNull();
    const gate = await api.apiDb.asService((tx) =>
      hasVerifiedConsent(tx, consentFam.familyId, { allowTestProvider: true }),
    );
    expect(gate).toBe(false);
    const audit = await api.db.sql`
      select 1 from public.audit_events where family_id = ${consentFam.familyId} and action = 'consent.withdrawn'`;
    expect(audit.length).toBe(1);

    const again = await api.request('/v1/consent/withdraw', { method: 'POST', token, body: {} });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).rule).toBe('CONSENT_ALREADY_WITHDRAWN');
  });

  it('records a provider failure and surfaces provider outages honestly', async () => {
    const original = api.providers.consent;
    const failing: ConsentProvider = {
      name: 'development_mock',
      isMock: true,
      start: original.start.bind(original),
      status: () =>
        Promise.resolve({ status: 'failed', method: 'development_mock', verifiedAt: null }),
    };
    api.providers.consent = failing;
    try {
      const started = await json<{ consentId: string }>(
        await api.request('/v1/consent/start', { method: 'POST', token, body: {} }),
      );
      const res = await api.request(`/v1/consent/${started.consentId}/refresh`, {
        method: 'POST',
        token,
      });
      expect(res.status).toBe(200);
      expect((await json<{ state: string; verifiedAt: string | null }>(res)).state).toBe('failed');

      api.providers.consent = {
        ...failing,
        start: () => Promise.reject(new Error('provider down')),
      };
      const down = await api.request('/v1/consent/start', { method: 'POST', token, body: {} });
      expect(down.status).toBe(503);
      expect((await errorOf(down)).code).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      api.providers.consent = original;
    }
  });

  it('never logs invitation tokens or email addresses', () => {
    const logs = JSON.stringify(api.logs);
    expect(logs).not.toContain('@example.test');
    expect(logs).not.toContain('#accept=');
  });
});

for (const APP_ENV of ['production', 'staging'] as const) {
  // Lead update (final review, LRD-1 defense line): the mock is refused outside development and
  // test, not only in production, like every other consent gate.
  describe(`${APP_ENV} refuses a mock consent provider (spec P3)`, () => {
    let prod: TestApi;

    beforeAll(async () => {
      prod = await createTestApi({ APP_ENV });
    });

    afterAll(async () => {
      await prod?.close();
    });

    it(`does not start consent with the development mock in ${APP_ENV}`, async () => {
      const family = await seedFamily(prod.db, { childCount: 0 });
      const res = await prod.request('/v1/consent/start', {
        method: 'POST',
        token: await parentToken(family.ownerId),
        body: {},
      });
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe('NOT_CONFIGURED');
      const rows = await prod.db.sql`select 1 from public.consent_records`;
      expect(rows.length).toBe(0);
    });
  });
}
