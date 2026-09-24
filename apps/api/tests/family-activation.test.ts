import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  grantAdultUnlock,
  seedChild,
  seedFamily,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

let api: TestApi;
const SESSION = '77777777-7777-4777-8777-777777777777';

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

async function family(options: { paidSlots?: number; consent?: boolean } = {}) {
  const fam = await seedFamily(api.db, { childCount: 0 });
  if (options.paidSlots !== undefined) {
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, ${options.paidSlots}, 'app_store')`;
  }
  if (options.consent !== false) {
    await api.db.sql`
      insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
  }
  const riley = await seedChild(api.db, fam.familyId, 'Riley', 'draft');
  const sam = await seedChild(api.db, fam.familyId, 'Sam', 'draft');
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  const token = await parentToken(fam.ownerId, { sessionId: SESSION });
  return { fam, riley, sam, token };
}

const activate = (token: string, childId: string) =>
  api.request(`/v1/children/${childId}/activate`, { method: 'POST', token });
const archive = (token: string, childId: string) =>
  api.request(`/v1/children/${childId}/archive`, { method: 'POST', token });

async function status(childId: string) {
  const [row] = await api.db.sql<{ status: string }[]>`
    select status from public.child_profiles where id = ${childId}`;
  return row!.status;
}

describe('child activation assigns verified paid slots (AC_CAPACITY_01/03/08, spec P11)', () => {
  it('requires a recent adult unlock', async () => {
    const { fam, riley } = await family({ paidSlots: 1 });
    const stale = await parentToken(fam.ownerId, {
      sessionId: '88888888-8888-4888-8888-888888888888',
    });
    const res = await activate(stale, riley.id);
    expect(res.status).toBe(403);
    expect(await status(riley.id)).toBe('draft');
  });

  it('refuses without verified consent and without a free paid slot', async () => {
    const noConsent = await family({ paidSlots: 1, consent: false });
    const r1 = await activate(noConsent.token, noConsent.riley.id);
    expect(r1.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(r1)).error.rule).toBe('CONSENT_REQUIRED');

    const unpaid = await family({ paidSlots: 0 });
    const r2 = await activate(unpaid.token, unpaid.riley.id);
    expect(r2.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(r2)).error.rule).toBe('NEEDS_PAID_SLOT');
    expect(await status(unpaid.riley.id)).toBe('draft');
  });

  it('one slot serves one child; archiving frees it, ends sessions and keeps the profile', async () => {
    const { riley, sam, token } = await family({ paidSlots: 1 });
    const first = await activate(token, riley.id);
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({ status: 'active', paidSlots: 1, assignedSlots: 1 });
    // Idempotent: activating an active child neither fails nor takes a second slot.
    expect(await json(await activate(token, riley.id))).toMatchObject({ assignedSlots: 1 });

    const blocked = await activate(token, sam.id);
    expect(blocked.status).toBe(422);

    const archived = await archive(token, riley.id);
    expect(archived.status).toBe(200);
    expect(await json(archived)).toMatchObject({ status: 'archived', assignedSlots: 0 });
    const [session] = await api.db.sql<{ revoked_at: Date | null }[]>`
      select revoked_at from public.child_sessions where id = ${riley.sessionId}`;
    expect(session!.revoked_at).not.toBeNull();
    expect(await status(riley.id)).toBe('archived');

    expect((await activate(token, sam.id)).status).toBe(200);
    expect(await status(sam.id)).toBe('active');
  });

  it('two guardians activating different children at once never exceed paid capacity', async () => {
    const { fam, riley, sam, token } = await family({ paidSlots: 1 });
    const results = await Promise.all([activate(token, riley.id), activate(token, sam.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const [open] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.child_slot_assignments
       where family_id = ${fam.familyId} and released_at is null`;
    expect(open!.n).toBe(1);
  });

  it("a parent cannot activate or archive another family's child", async () => {
    const mine = await family({ paidSlots: 2 });
    const theirs = await family({ paidSlots: 2 });
    expect((await activate(mine.token, theirs.riley.id)).status).toBe(404);
    expect((await archive(mine.token, theirs.riley.id)).status).toBe(404);
    expect(await status(theirs.riley.id)).toBe('draft');
  });
});

describe('PIN reset through verified account recovery (spec P3)', () => {
  async function parentWithPin(): Promise<SeededFamily> {
    const fam = await seedFamily(api.db, { childCount: 0 });
    const token = await parentToken(fam.ownerId, { sessionId: SESSION });
    const set = await api.request('/v1/adult/pin', {
      method: 'PUT',
      token,
      body: { pin: '482915' },
    });
    expect(set.status).toBe(200);
    return fam;
  }

  const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

  it('refuses a reset without a fresh account re-authentication', async () => {
    const fam = await parentWithPin();
    const plain = await parentToken(fam.ownerId, { sessionId: SESSION });
    const r1 = await api.request('/v1/adult/pin/reset', {
      method: 'POST',
      token: plain,
      body: { pin: '731846' },
    });
    expect(r1.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(r1)).error.rule).toBe(
      'REAUTHENTICATION_REQUIRED',
    );

    const old = await parentToken(fam.ownerId, {
      sessionId: SESSION,
      amr: [{ method: 'password', timestamp: seconds(api.now.value) - 20 * 60 }],
    });
    const r2 = await api.request('/v1/adult/pin/reset', {
      method: 'POST',
      token: old,
      body: { pin: '731846' },
    });
    expect(r2.status).toBe(422);
  });

  it('a just-re-authenticated adult replaces the PIN and every earlier unlock ends', async () => {
    const fam = await parentWithPin();
    await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
    const fresh = await parentToken(fam.ownerId, {
      sessionId: SESSION,
      amr: [
        { method: 'password', timestamp: seconds(api.now.value) - 3 * 3600 },
        { method: 'otp', timestamp: seconds(api.now.value) - 60 },
      ],
    });
    const reset = await api.request('/v1/adult/pin/reset', {
      method: 'POST',
      token: fresh,
      body: { pin: '731846' },
    });
    expect(reset.status).toBe(200);
    const [live] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from private.adult_unlocks where user_id = ${fam.ownerId} and revoked_at is null`;
    expect(live!.n).toBe(0);

    const token = await parentToken(fam.ownerId, { sessionId: SESSION });
    const wrong = await api.request('/v1/adult/unlock', {
      method: 'POST',
      token,
      body: { method: 'pin', pin: '482915' },
    });
    expect(wrong.status).not.toBe(200);
    const right = await api.request('/v1/adult/unlock', {
      method: 'POST',
      token,
      body: { method: 'pin', pin: '731846' },
    });
    expect(right.status).toBe(200);
    const [audit] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events where actor_user_id = ${fam.ownerId} and action = 'pin.reset'`;
    expect(audit!.n).toBe(1);
  });
});
