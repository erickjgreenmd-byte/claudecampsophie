import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedChild, seedFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Round-2 review regressions for family and child profile editing, deletion-pending children,
 * calendar-date bounds and the parent practice-set list.
 *
 * - WEB-R2-03: no client or API could change a child's grade, nickname or age band, or the family's
 *   name or time zone, so every family stayed on last year's grade after a school-year rollover.
 * - API-AUTH-R2-02: a child whose data deletion was pending could be re-activated and paired, so
 *   new homework was collected after the parent asked for the child's data to be deleted (spec P4).
 * - API-AUTH-R2-03: `0000-01-01` passed the contract and raised SQLSTATE 22008 in Postgres, which
 *   surfaced as an unhandled 500 on the test-date and learning-schedule writes.
 * - API-AUTH-R2-04: the parent practice-set list was hard-capped at 30 with no cursor, so older
 *   daily sets and their answer keys became unreachable after about a month.
 */

let api: TestApi;
const SESSION = '5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f';

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

async function family(options: { paidSlots?: number; consent?: boolean } = {}) {
  const fam = await seedFamily(api.db, { childCount: 0 });
  await api.db.sql`
    insert into public.family_capacity (family_id, paid_slots, managing_channel)
    values (${fam.familyId}, ${options.paidSlots ?? 2}, 'app_store')`;
  if (options.consent !== false) {
    await api.db.sql`
      insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
  }
  const riley = await seedChild(api.db, fam.familyId, 'Riley', 'active');
  const sam = await seedChild(api.db, fam.familyId, 'Sam', 'draft');
  await api.db.sql`
    insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${riley.id})`;
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  const token = await parentToken(fam.ownerId, { sessionId: SESSION });
  return { fam, riley, sam, token };
}

const patchChild = (token: string, childId: string, body: unknown) =>
  api.request(`/v1/children/${childId}`, { method: 'PATCH', token, body });
const patchFamily = (token: string, body: unknown) =>
  api.request('/v1/family', { method: 'PATCH', token, body });

async function childRow(childId: string) {
  const [row] = await api.db.sql<
    { nickname: string; grade_level: number; age_band: string; status: string }[]
  >`select nickname, grade_level, age_band, status from public.child_profiles where id = ${childId}`;
  return row!;
}

// -----------------------------------------------------------------------------------------------
// WEB-R2-03: child and family profile edits
// -----------------------------------------------------------------------------------------------

describe('WEB-R2-03 PATCH /v1/children/:childId edits a child profile', () => {
  it('changes nickname, grade and age band and audits the change', async () => {
    const { fam, riley, token } = await family();
    const res = await patchChild(token, riley.id, {
      nickname: 'Riley R.',
      gradeLevel: 4,
      ageBand: '11-13',
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      child: { id: riley.id, nickname: 'Riley R.', gradeLevel: 4, ageBand: '11-13' },
    });
    expect(await childRow(riley.id)).toMatchObject({
      nickname: 'Riley R.',
      grade_level: 4,
      age_band: '11-13',
    });
    const [audit] = await api.db.sql<{ action: string }[]>`
      select action from public.audit_events
       where family_id = ${fam.familyId} and target_id = ${riley.id} and action = 'child.profile_updated'`;
    expect(audit?.action).toBe('child.profile_updated');
  });

  it('accepts a single field and leaves the rest alone', async () => {
    const { riley, token } = await family();
    expect((await patchChild(token, riley.id, { gradeLevel: 5 })).status).toBe(200);
    expect(await childRow(riley.id)).toMatchObject({
      nickname: 'Riley',
      grade_level: 5,
      age_band: '8-10',
    });
  });

  it('refuses an empty patch, an out-of-scope grade, an unknown age band and control text', async () => {
    const { riley, token } = await family();
    for (const body of [
      {},
      { gradeLevel: 9 },
      { gradeLevel: -1 },
      { ageBand: '14-18' },
      { nickname: 'Ri\u0000ley' },
      { nickname: '   ' },
      { nickname: 'x'.repeat(41) },
      { gradeLevel: 4, unexpected: true },
    ]) {
      const res = await patchChild(token, riley.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await childRow(riley.id)).toMatchObject({ nickname: 'Riley', grade_level: 3 });
  });

  it('needs a recent adult unlock and never crosses families', async () => {
    const mine = await family();
    const theirs = await family();
    const stale = await parentToken(mine.fam.ownerId, { sessionId: randomUUID() });
    expect((await patchChild(stale, mine.riley.id, { gradeLevel: 4 })).status).toBe(403);
    expect((await patchChild(mine.token, theirs.riley.id, { gradeLevel: 4 })).status).toBe(404);
    expect(await childRow(theirs.riley.id)).toMatchObject({ grade_level: 3 });
  });

  it('edits a draft profile but refuses an archived one', async () => {
    const { fam, sam, token } = await family();
    expect((await patchChild(token, sam.id, { gradeLevel: 2 })).status).toBe(200);
    const archived = await seedChild(api.db, fam.familyId, 'Jordan', 'archived');
    const res = await patchChild(token, archived.id, { gradeLevel: 2 });
    expect(res.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(res)).error.rule).toBe('CHILD_ARCHIVED');
  });
});

describe('WEB-R2-03 PATCH /v1/family edits the family name and time zone', () => {
  it('changes the display name and the time zone and audits the change', async () => {
    const { fam, token } = await family();
    const res = await patchFamily(token, {
      displayName: 'The Rivera family',
      timezone: 'Europe/Berlin',
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      family: { id: fam.familyId, displayName: 'The Rivera family', timezone: 'Europe/Berlin' },
    });
    const [row] = await api.db.sql<{ display_name: string; timezone: string }[]>`
      select display_name, timezone from public.families where id = ${fam.familyId}`;
    expect(row).toMatchObject({ display_name: 'The Rivera family', timezone: 'Europe/Berlin' });
    const [audit] = await api.db.sql<{ action: string }[]>`
      select action from public.audit_events
       where family_id = ${fam.familyId} and action = 'family.profile_updated'`;
    expect(audit?.action).toBe('family.profile_updated');
  });

  it('refuses an empty patch, a non-IANA zone and control text', async () => {
    const { fam, token } = await family();
    for (const body of [
      {},
      { timezone: 'Mars/Olympus' },
      { timezone: '' },
      { displayName: 'Ri\u0000vera' },
      { displayName: '  ' },
      { displayName: 'The Riveras', extra: 1 },
    ]) {
      const res = await patchFamily(token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const [row] = await api.db.sql<{ timezone: string }[]>`
      select timezone from public.families where id = ${fam.familyId}`;
    expect(row!.timezone).not.toBe('Mars/Olympus');
  });

  it('needs a recent adult unlock', async () => {
    const { fam } = await family();
    const stale = await parentToken(fam.ownerId, { sessionId: randomUUID() });
    expect((await patchFamily(stale, { displayName: 'Stale' })).status).toBe(403);
  });
});

// -----------------------------------------------------------------------------------------------
// API-AUTH-R2-02: a deletion-pending child never becomes usable again
// -----------------------------------------------------------------------------------------------

describe('API-AUTH-R2-02 a child under a pending data deletion stays unusable', () => {
  /** Requests deletion of one child; `target` picks which of the two the request covers. */
  async function withPendingDeletion(target: 'riley' | 'sam' = 'riley') {
    const ctx = await family({ paidSlots: 2 });
    const childId = target === 'riley' ? ctx.riley.id : ctx.sam.id;
    const res = await api.request('/v1/deletion', {
      method: 'POST',
      token: ctx.token,
      body: { scope: 'child', childId },
    });
    expect(res.status).toBe(202);
    const [row] = await api.db.sql<{ status: string }[]>`
      select status from public.deletion_requests
       where family_id = ${ctx.fam.familyId} and target_child_id = ${childId}`;
    expect(row!.status).toBe('requested');
    return { ...ctx, targetId: childId };
  }

  it('refuses activation of a draft child while the deletion is open', async () => {
    // Sam is a draft with no slot, so activation is genuinely attempted: before the fix it answered
    // 200 and set status = 'active', after which the child could be paired and scanned.
    const { targetId, token } = await withPendingDeletion('sam');
    const res = await api.request(`/v1/children/${targetId}/activate`, { method: 'POST', token });
    expect(res.status).toBe(404);
    expect(await childRow(targetId)).toMatchObject({ status: 'archived' });
    const [slots] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.child_slot_assignments
       where child_id = ${targetId} and released_at is null`;
    expect(slots!.n).toBe(0);
  });

  it('refuses a pairing code for an ACTIVE child whose deletion is open', async () => {
    // The pairing-code route must have its own deletion check rather than leaning on the status,
    // so the child here is `active` with the request already open.
    //
    // How that state is reached matters: POST /v1/deletion archives the child as it files the
    // request, and migration 0860 added a BEFORE UPDATE trigger on child_profiles that refuses a
    // status change back to 'active' while such a request is open, so the status can no longer be
    // forced back afterwards (an earlier version of this test did exactly that and now fails in
    // its setup). Inserting the request row directly reaches the same state without touching
    // child_profiles at all -- which is what a race between the request and an activation already
    // in flight leaves behind -- so the route, not the status, is what is under test.
    const { fam, riley, token } = await family({ paidSlots: 2 });
    await api.db.sql`
      insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
      values (${fam.familyId}, 'child', ${riley.id}, ${riley.id}, ${fam.ownerId})`;
    expect(await childRow(riley.id)).toMatchObject({ status: 'active' });

    const res = await api.request(`/v1/children/${riley.id}/pairing-code`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(404);
    const [codes] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from private.child_pairing_codes
       where family_id = ${fam.familyId} and child_id = ${riley.id}`;
    expect(codes!.n).toBe(0);
    // The same state refuses a profile edit and, once archived, re-activation.
    expect((await patchChild(token, riley.id, { gradeLevel: 7 })).status).toBe(404);
  });

  it('is what migration 0860 backstops: raw re-activation is refused in the database too', async () => {
    // Not the API's own check (that is the case above) but the reason this suite can no longer force
    // the status: the DB area's trigger refuses child_profiles -> 'active' for every writer while a
    // deletion covering the child is open, service role included.
    const { targetId } = await withPendingDeletion();
    await expect(
      api.db.sql`update public.child_profiles set status = 'active' where id = ${targetId}`,
    ).rejects.toThrow(/deletion covering this child/i);
    expect(await childRow(targetId)).toMatchObject({ status: 'archived' });
  });

  it('refuses a profile edit while the deletion is open', async () => {
    const { targetId, token } = await withPendingDeletion();
    expect((await patchChild(token, targetId, { gradeLevel: 7 })).status).toBe(404);
  });

  it('refuses activation, pairing and edits while a whole-family deletion is open', async () => {
    // A family-scope request tombstones the family instead of archiving each child (migration 0600),
    // so the same checks must cover that scope.
    const ctx = await family({ paidSlots: 2 });
    const res = await api.request('/v1/deletion', {
      method: 'POST',
      token: ctx.token,
      body: { scope: 'family' },
    });
    expect(res.status).toBe(202);
    expect(
      (
        await api.request(`/v1/children/${ctx.sam.id}/activate`, {
          method: 'POST',
          token: ctx.token,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.request(`/v1/children/${ctx.riley.id}/pairing-code`, {
          method: 'POST',
          token: ctx.token,
        })
      ).status,
    ).toBe(404);
    expect((await patchChild(ctx.token, ctx.riley.id, { gradeLevel: 6 })).status).toBe(404);
    expect(await childRow(ctx.sam.id)).toMatchObject({ status: 'draft' });
  });

  it('keeps the child in GET /v1/family, flagged, so the privacy screens can still name it', async () => {
    // ACC-FAM-03. An earlier fix dropped a deletion-pending child from this list. That broke the
    // one thing the list does on the privacy screens: PrivacyControlsPage.tsx childName() and
    // apps/mobile/src/privacy/parent-privacy.ts resolve a nickname out of `family.children` for the
    // pending-deletion list, that child's export rows and any safety report about it, so while the
    // request was still only `requested`/`processing` -- and still cancellable -- a two-child family
    // read "A removed child profile" and could not tell which child it covered. The row stays and
    // carries deletionPending instead; the rules are enforced where they act (the cases above).
    const { riley, sam, token } = await withPendingDeletion();
    const res = await api.request('/v1/family', { token });
    expect(res.status).toBe(200);
    const body = await json<{
      children: { id: string; nickname: string; status: string; deletionPending?: boolean }[];
    }>(res);
    expect(body.children.map((c) => c.id)).toEqual([riley.id, sam.id]);
    expect(body.children.find((c) => c.id === riley.id)).toMatchObject({
      nickname: 'Riley',
      status: 'archived',
      deletionPending: true,
    });
    expect(body.children.find((c) => c.id === sam.id)).toMatchObject({ deletionPending: false });
  });
});

// -----------------------------------------------------------------------------------------------
// API-AUTH-R2-03: calendar dates are bounded and datetime range errors are 400s
// -----------------------------------------------------------------------------------------------

describe('API-AUTH-R2-03 implausible calendar dates answer 400, never 500', () => {
  async function childWithSubject() {
    const ctx = await family();
    await api.db.sql`
      insert into public.learning_schedules (child_id, family_id)
      values (${ctx.riley.id}, ${ctx.fam.familyId}) on conflict do nothing`;
    const [subject] = await api.db.sql<{ id: string }[]>`
      insert into public.child_subjects (family_id, child_id, subject_key, display_name)
      values (${ctx.fam.familyId}, ${ctx.riley.id}, 'math', 'Math') returning id`;
    return { ...ctx, subjectId: subject!.id };
  }

  it('refuses year 0000 and other implausible years on a test date', async () => {
    const { riley, token, subjectId } = await childWithSubject();
    api.logs.length = 0;
    for (const testDate of ['0000-01-01', '0001-01-01', '1900-01-01', '9999-12-31', '2101-01-01']) {
      const res = await api.request(`/v1/children/${riley.id}/test-dates`, {
        method: 'POST',
        token,
        body: { subjectId, testDate },
      });
      expect(res.status, testDate).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('VALIDATION_FAILED');
    }
    expect(api.logs.filter((l) => l.event === 'unhandled_error')).toEqual([]);
    const [stored] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.test_dates where child_id = ${riley.id}`;
    expect(stored!.n).toBe(0);
  });

  it('still accepts a plausible test date', async () => {
    const { riley, token, subjectId } = await childWithSubject();
    const res = await api.request(`/v1/children/${riley.id}/test-dates`, {
      method: 'POST',
      token,
      body: { subjectId, testDate: '2026-10-15' },
    });
    expect(res.status).toBe(201);
  });

  it('refuses year 0000 in a learning-schedule pause', async () => {
    const { riley, token } = await childWithSubject();
    api.logs.length = 0;
    const res = await api.request(`/v1/children/${riley.id}/learning-schedule`, {
      method: 'PUT',
      token,
      body: {
        reviewWeekday: 4,
        reviewLocalTime: '17:00',
        reviewQuestionsPerSubject: 10,
        dailyLocalTime: '16:00',
        dailyQuestionCount: 10,
        pause: { from: '0000-01-01', to: '0000-01-02' },
        quietHours: null,
        childRemindersPermitted: false,
      },
    });
    expect(res.status).toBe(400);
    expect(api.logs.filter((l) => l.event === 'unhandled_error')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// API-AUTH-R2-04: the parent practice-set list pages with a keyset cursor
// -----------------------------------------------------------------------------------------------

describe('API-AUTH-R2-04 older parent practice sets stay reachable', () => {
  /** Seeds `count` daily sets one day apart, oldest first, at the pinned clock (L-027). */
  async function seedDailySets(familyId: string, childId: string, count: number) {
    const base = api.now.value.getTime();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = new Date(base - (count - 1 - i) * 24 * 3600 * 1000);
      const [row] = await api.db.sql<{ id: string }[]>`
        insert into public.practice_sets (family_id, child_id, kind, set_key, local_date, version,
                                          status, ready_at, release_at, evidence_cutoff_at, created_at)
        values (${familyId}, ${childId}, 'daily', ${'paging-test:' + randomUUID()},
                ${at.toISOString().slice(0, 10)}, 1, 'ready', ${at}, ${at}, ${at}, ${at})
        returning id`;
      ids.push(row!.id);
    }
    return ids; // oldest first
  }

  it('returns a nextCursor and reaches the oldest set through it', async () => {
    const { fam, riley, token } = await family();
    const ids = await seedDailySets(fam.familyId, riley.id, 35);
    const oldest = ids[0]!;

    const first = await api.request(`/v1/children/${riley.id}/practice-sets`, { token });
    expect(first.status).toBe(200);
    const page1 = await json<{ sets: { id: string }[]; nextCursor: string | null }>(first);
    expect(page1.sets).toHaveLength(30);
    expect(page1.sets.map((s) => s.id)).not.toContain(oldest);
    expect(page1.nextCursor).toBeTypeOf('string');

    const second = await api.request(
      `/v1/children/${riley.id}/practice-sets?after=${encodeURIComponent(page1.nextCursor!)}`,
      { token },
    );
    expect(second.status).toBe(200);
    const page2 = await json<{ sets: { id: string }[]; nextCursor: string | null }>(second);
    expect(page2.sets).toHaveLength(5);
    expect(page2.sets.map((s) => s.id)).toContain(oldest);
    expect(page2.nextCursor).toBeNull();
    // No set is listed twice across the two pages.
    const all = [...page1.sets, ...page2.sets].map((s) => s.id);
    expect(new Set(all).size).toBe(35);
  });

  it('answers 400 for a malformed or out-of-range cursor, never 500', async () => {
    const { fam, riley, token } = await family();
    await seedDailySets(fam.familyId, riley.id, 2);
    api.logs.length = 0;
    for (const after of ['nonsense', '123', '9999999999999999999999_not-a-uuid', '1_1', '']) {
      const res = await api.request(
        `/v1/children/${riley.id}/practice-sets?after=${encodeURIComponent(after)}`,
        { token },
      );
      expect(res.status, after).toBe(400);
    }
    expect(api.logs.filter((l) => l.event === 'unhandled_error')).toEqual([]);
  });
});
