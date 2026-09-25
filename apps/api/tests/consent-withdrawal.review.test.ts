import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedChild, seedFamily } from '@pencillift/db/testing/fixtures';
import { cryptoRandom } from '@pencillift/domain';
import type { JobDeps } from '../src/jobs/dispatcher.ts';
import { enqueueDueLearningJobs } from '../src/jobs/learning-jobs.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Consent withdrawal stops the child's traffic (CS-R1-01) and keeps the safety-flag email
 * (CS-R1-02). Regression from the hardening probe: after POST /v1/consent/withdraw the paired
 * device is signed out, no new pairing code is minted, an unredeemed code no longer pairs, the
 * refresh token is refused and the learning tick enqueues nothing for the child. Real local
 * Postgres; synthetic family (owner + child "Riley") only.
 */

let api: TestApi;
let deps: JobDeps;
let seq = 0;

beforeAll(async () => {
  api = await createTestApi();
  deps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
});

afterAll(async () => {
  await api?.close();
});

async function errorOf(res: Response) {
  return (await json<{ error: { code: string; rule?: string; message: string } }>(res)).error;
}

async function verifiedMockConsent(familyId: string, ownerId: string) {
  await api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${familyId}, ${ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
}

/** A family with verified (mock) consent, one paid slot and a draft child activated through the API. */
async function consentedFamilyWithActiveChild() {
  const fam = await seedFamily(api.db, { childCount: 0 });
  seq += 1;
  const sessionId = `c5a2${seq.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
  await api.db.sql`
    insert into public.family_capacity (family_id, paid_slots, managing_channel)
    values (${fam.familyId}, ${2}, 'app_store')`;
  await verifiedMockConsent(fam.familyId, fam.ownerId);
  const riley = await seedChild(api.db, fam.familyId, 'Riley', 'draft');
  await grantAdultUnlock(api.db, fam.ownerId, sessionId, 3600);
  const token = await parentToken(fam.ownerId, { sessionId });
  const activated = await api.request(`/v1/children/${riley.id}/activate`, {
    method: 'POST',
    token,
  });
  expect(activated.status).toBe(200);
  return { fam, childId: riley.id, token };
}

const newCode = (token: string, childId: string) =>
  api.request(`/v1/children/${childId}/pairing-code`, { method: 'POST', token });

const pair = (code: string, ip: string, label = 'Kitchen tablet') =>
  api.request('/v1/child/pair', {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip },
    body: { code, deviceLabel: label, platform: 'ios' },
  });

const withdraw = (token: string) =>
  api.request('/v1/consent/withdraw', { method: 'POST', token, body: {} });

describe('consent withdrawal stops the child’s traffic (CS-R1-01)', () => {
  it('signs paired devices out, refuses new codes, pairing and refresh, and stops practice generation', async () => {
    const { fam, childId, token } = await consentedFamilyWithActiveChild();

    // Paired device works before withdrawal.
    const first = await newCode(token, childId);
    expect(first.status).toBe(201);
    const { code } = await json<{ code: string }>(first);
    const paired = await pair(code, '198.51.100.7');
    expect(paired.status).toBe(201);
    const { accessToken, refreshToken } = await json<{
      accessToken: string;
      refreshToken: string;
    }>(paired);
    expect((await api.request('/v1/child/me', { token: accessToken })).status).toBe(200);

    // A second code is minted before withdrawal but never redeemed.
    const second = await newCode(token, childId);
    expect(second.status).toBe(201);
    const { code: unredeemed } = await json<{ code: string }>(second);

    const withdrawn = await withdraw(token);
    expect(withdrawn.status).toBe(200);

    // 1. Every paired device is signed out (the fixture's seeded device and the one paired above):
    //    sessions and devices revoked, the access token refused.
    const sessions = await api.db.sql<{ revoked_at: Date | null; revoke_reason: string | null }[]>`
      select revoked_at, revoke_reason from public.child_sessions where child_id = ${childId}`;
    expect(sessions.length).toBe(2);
    expect(sessions.map((s) => [s.revoked_at !== null, s.revoke_reason])).toEqual([
      [true, 'consent_withdrawn'],
      [true, 'consent_withdrawn'],
    ]);
    const devices = await api.db.sql<{ revoked_at: Date | null }[]>`
      select revoked_at from public.child_devices where child_id = ${childId}`;
    expect(devices.length).toBe(2);
    expect(devices.every((d) => d.revoked_at !== null)).toBe(true);
    expect((await api.request('/v1/child/me', { token: accessToken })).status).toBe(401);

    // 2. The refresh token is refused with the child-safe message.
    const refreshed = await api.request('/v1/child/refresh', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.7' },
      body: { refreshToken },
    });
    expect(refreshed.status).toBe(401);

    // 3. No new pairing code: a clear, parent-safe business rule.
    const denied = await newCode(token, childId);
    expect(denied.status).toBe(422);
    const error = await errorOf(denied);
    expect(error.code).toBe('BUSINESS_RULE');
    expect(error.rule).toBe('CONSENT_REQUIRED');
    expect(error.message).not.toMatch(/riley/i);

    // 4. The code minted before withdrawal was retired by it and no longer pairs a device.
    const late = await pair(unredeemed, '198.51.100.8', 'Second tablet');
    expect(late.status).toBe(404);
    const [after] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.child_devices where child_id = ${childId}`;
    expect(after!.n).toBe(2);

    // 5. The child stays 'active' (paid slots are a billing decision) but the learning tick
    //    generates nothing for it while consent is withdrawn.
    const [child] = await api.db.sql<{ status: string }[]>`
      select status from public.child_profiles where id = ${childId}`;
    expect(child!.status).toBe('active');
    await api.db.sql`
      insert into public.learning_schedules (child_id, family_id) values (${childId}, ${fam.familyId})
      on conflict do nothing`;
    await api.db.sql`
      insert into public.child_subjects (family_id, child_id, subject_key, display_name)
      values (${fam.familyId}, ${childId}, 'math', 'math')`;
    api.now.value = new Date('2026-03-02T12:00:00Z'); // Monday: daily set and Thursday reviews are due
    await enqueueDueLearningJobs(deps, api.now.value);
    const learningJobs = await api.db.sql<{ kind: string; status: string }[]>`
      select kind, status from public.jobs where child_id = ${childId}
         and kind in ('daily_set_generate', 'thursday_review_generate', 'review_top_up')
         and status in ('queued', 'failed_retryable')`;
    expect(learningJobs).toEqual([]);

    // The withdrawal is audited with what it stopped.
    const [audit] = await api.db.sql<{ metadata: Record<string, unknown> }[]>`
      select metadata from public.audit_events
       where family_id = ${fam.familyId} and action = 'consent.withdrawn'`;
    expect(audit!.metadata).toMatchObject({ revokedSessions: 2, revokedDevices: 2 });
  });

  it('a live code does not pair while consent is not verified, and stays unredeemed', async () => {
    const { fam, childId, token } = await consentedFamilyWithActiveChild();
    const minted = await newCode(token, childId);
    expect(minted.status).toBe(201);
    const { code } = await json<{ code: string }>(minted);
    // Consent flips without the withdrawal route (e.g. a provider-side change), so the code is
    // still live: /child/pair itself must refuse and leave the code for after re-verification.
    await api.db.sql`
      update public.consent_records set status = 'withdrawn', withdrawn_at = now()
       where family_id = ${fam.familyId}`;
    const refused = await pair(code, '198.51.100.10');
    expect(refused.status).toBe(422);
    const error = await errorOf(refused);
    expect(error.rule).toBe('CONSENT_REQUIRED');
    expect(error.message).not.toMatch(/consent|riley/i); // child-safe wording
    const [codeRow] = await api.db.sql<{ consumed_at: Date | null }[]>`
      select consumed_at from private.child_pairing_codes where child_id = ${childId}`;
    expect(codeRow!.consumed_at).toBeNull();
    const [devices] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.child_devices where child_id = ${childId}`;
    expect(devices!.n).toBe(1); // the fixture's seeded device only
    // Once consent is verified again the same, still-live code pairs.
    await verifiedMockConsent(fam.familyId, fam.ownerId);
    expect((await pair(code, '198.51.100.10')).status).toBe(201);
  });

  it('refresh is refused for a session that outlived a consent change', async () => {
    const { fam, childId, token } = await consentedFamilyWithActiveChild();
    const minted = await newCode(token, childId);
    const { code } = await json<{ code: string }>(minted);
    const paired = await pair(code, '198.51.100.11');
    expect(paired.status).toBe(201);
    const { refreshToken } = await json<{ refreshToken: string }>(paired);
    await api.db.sql`
      update public.consent_records set status = 'withdrawn', withdrawn_at = now()
       where family_id = ${fam.familyId}`;
    const refreshed = await api.request('/v1/child/refresh', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.11' },
      body: { refreshToken },
    });
    expect(refreshed.status).toBe(401);
    const [tokenRow] = await api.db.sql<{ used_at: Date | null }[]>`
      select t.used_at from private.child_refresh_tokens t
        join public.child_sessions s on s.id = t.session_id
       where s.child_id = ${childId} and s.device_id <> (
         select id from public.child_devices where child_id = ${childId} and label = 'Test tablet')`;
    expect(tokenRow!.used_at).toBeNull();
  });

  it('a family whose consent is verified again pairs a new device as usual', async () => {
    const { fam, childId, token } = await consentedFamilyWithActiveChild();
    expect((await withdraw(token)).status).toBe(200);
    expect((await newCode(token, childId)).status).toBe(422);
    // A fresh verified record (the parent gave consent again) restores pairing.
    await verifiedMockConsent(fam.familyId, fam.ownerId);
    const res = await newCode(token, childId);
    expect(res.status).toBe(201);
    const { code } = await json<{ code: string }>(res);
    expect((await pair(code, '198.51.100.9')).status).toBe(201);
  });

  it('a pending restart after withdrawal does not let the child back in before it is verified', async () => {
    const { fam, childId, token } = await consentedFamilyWithActiveChild();
    expect((await withdraw(token)).status).toBe(200);
    // Starting consent again creates a pending record; the child stays blocked until it verifies.
    await api.db.sql`
      insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider)
      values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'pending', true)`;
    const res = await newCode(token, childId);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).rule).toBe('CONSENT_REQUIRED');
  });
});

describe('consent withdrawal keeps a pending safety-flag email (CS-R1-02)', () => {
  it('a queued safety_flag_email job survives withdrawal; child-data jobs are cancelled', async () => {
    const { fam, childId, token } = await consentedFamilyWithActiveChild();
    const reportId = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
    const inserted = await api.db.sql<{ id: string; kind: string }[]>`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, status) values
        ('safety_flag_email', ${`safety-flag-email:${reportId}`}, ${fam.familyId}, ${childId},
         ${JSON.stringify({ reportId })}::text::jsonb, 'queued'),
        ('scan_process', ${`scan:${fam.familyId}:withdraw`}, ${fam.familyId}, ${childId},
         ${JSON.stringify({ assignmentId: reportId })}::text::jsonb, 'queued')
      returning id, kind`;
    const res = await withdraw(token);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ state: 'withdrawn', cancelledJobs: 1 });
    const rows = await api.db.sql<
      { kind: string; status: string; last_error_code: string | null }[]
    >`
      select kind, status, last_error_code from public.jobs
       where id in ${api.db.sql(inserted.map((j) => j.id))} order by kind`;
    expect(rows).toEqual([
      { kind: 'safety_flag_email', status: 'queued', last_error_code: null },
      { kind: 'scan_process', status: 'cancelled', last_error_code: 'consent_withdrawn' },
    ]);
  });
});
