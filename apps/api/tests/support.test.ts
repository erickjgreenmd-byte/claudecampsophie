import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SUPPORT_INTAKE_NOTICE,
  supportBillingPeriodsResponseSchema,
  supportCaseResponseSchema,
  supportCasesResponseSchema,
  parentSupportPolicyResponseSchema,
} from '@pencillift/contracts';
import { seedFamily, seedOwnerAdmin, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { issueChildAccessToken } from '../src/auth/child.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Parent support cases (/v1/support/*): a family opens cases about its account, sees its own cases
 * and the staff's public replies only, replies while a case is not closed, and a refund request
 * names one of the family's own billing periods. Real local Postgres, synthetic families (children
 * Riley and Sam exist so the tests can prove no child text reaches a response).
 */

let api: TestApi;
let famA: SeededFamily;
let famB: SeededFamily;
let tokenA: string;
let tokenB: string;
let adminToken: string;
let childToken: string;

type ErrorBody = { error: { code: string; rule?: string; message: string } };

const CHILD_NAMES = ['Riley', 'Sam', 'Jordan', 'Avery'];

function expectNoChildText(body: unknown, fam: SeededFamily): void {
  const text = JSON.stringify(body);
  for (const name of CHILD_NAMES) expect(text).not.toContain(name);
  for (const child of fam.children) expect(text).not.toContain(child.id);
}

async function ok<T>(pending: Response | Promise<Response>, status = 200): Promise<T> {
  const res = await pending;
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const post = (path: string, body: unknown, token = tokenA) =>
  api.request(path, { method: 'POST', token, body });

async function seedPeriod(
  fam: SeededFamily,
  channel: string,
  providerPeriodId: string,
  start: string,
  /**
   * A row that is not an ordinary subscription charge: the derived ':proration' row below.
   *
   * `id` is settable because the ordering assertion needs it: with two random uuids the old
   * `order by period_start desc, id desc` came out in the right order about three runs in five, so the
   * test only failed on the mutation some of the time (the round-7 checker measured it). Giving the
   * derived row an id that sorts ABOVE the subscription row's makes the old order fail every time.
   */
  options: { kind?: string; chargedCents?: number; id?: string } = {},
): Promise<string> {
  const end = new Date(new Date(start).getTime() + 30 * 86_400_000).toISOString();
  const charged = options.chargedCents ?? 4998;
  const [row] = await api.db.sql<{ id: string }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end,
      paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at, id)
    values (${fam.familyId}, ${channel}, ${providerPeriodId}, ${options.kind ?? 'subscription_period'},
            ${start}, ${end}, 2, 4998, ${charged}, 'settled', ${start},
            ${options.id ?? api.db.sql`gen_random_uuid()`})
    returning id`;
  return row!.id;
}

beforeAll(async () => {
  api = await createTestApi();
  famA = await seedFamily(api.db, { childCount: 2 });
  famB = await seedFamily(api.db, { childCount: 1 });
  tokenA = await parentToken(famA.ownerId);
  tokenB = await parentToken(famB.ownerId);
  adminToken = await parentToken(await seedOwnerAdmin(api.db), { aal: 'aal2' });
  const child = famA.children[0]!;
  childToken = (
    await issueChildAccessToken(
      api.config,
      { kind: 'child', childId: child.id, familyId: famA.familyId, sessionId: child.sessionId },
      api.now.value,
    )
  ).token;
});

afterAll(async () => {
  await api?.close();
});

describe('intake', () => {
  it('the intake copy tells parents not to include a child’s name, homework or answers', () => {
    expect(SUPPORT_INTAKE_NOTICE).toMatch(/child’s name/);
    expect(SUPPORT_INTAKE_NOTICE).toMatch(/homework/);
  });

  it('billing periods start empty and list the family’s own periods newest first', async () => {
    const empty = await ok<unknown>(api.request('/v1/support/billing-periods', { token: tokenA }));
    expect(supportBillingPeriodsResponseSchema.parse(empty)).toEqual({ periods: [] });
    await seedPeriod(famA, 'app_store', 'sup-a-aug', '2026-08-05T00:00:00Z');
    await seedPeriod(famA, 'app_store', 'sup-a-sep', '2026-09-05T00:00:00Z');
    await seedPeriod(famB, 'play_store', 'sup-b-sep', '2026-09-02T00:00:00Z');
    const body = supportBillingPeriodsResponseSchema.parse(
      await ok(api.request('/v1/support/billing-periods', { token: tokenA })),
    );
    expect(body.periods.map((p) => p.providerPeriodId)).toEqual(['sup-a-sep', 'sup-a-aug']);
    expect(body.periods[0]).toMatchObject({
      channel: 'app_store',
      chargedCents: 4998,
      refundedCents: 0,
      settlement: 'settled',
    });
  });

  it('[HUNT7-C-3] says what kind each period is, and never lists a derived proration row above its own charge', async () => {
    // A renewal that carried a deferred mid-cycle item is recorded as TWO periods: the subscription
    // charge and a derived '<invoice>:proration' row that `prorationPeriodFor` spreads from it, so it
    // inherits the same period_start, period_end and paid_slots and differs only in its provider id,
    // its kind and its amount (apps/api/src/services/billing-sync.ts). Both belong to the family and
    // both are pickable for a refund request, so the picker has to say which is which: two entries
    // reading 'Web billing · Sep 19 – Oct 19 · $49.98' and '… · $10.00' with nothing to tell them
    // apart is a parent guessing which charge is theirs, and the tie between equal period_starts was
    // broken by a random uuid, so half the time the $10 row came first in a list called newest-first.
    // Ids chosen so the derived row sorts ABOVE the subscription row under `id desc`: the old
    // tie-break then puts it first every run, not three runs in five (the checker's measurement).
    await seedPeriod(famA, 'stripe', 'in_sup_r7', '2026-09-19T00:00:00Z', {
      id: '11111111-1111-4111-8111-111111111111',
    });
    await seedPeriod(famA, 'stripe', 'in_sup_r7:proration', '2026-09-19T00:00:00Z', {
      kind: 'proration',
      chargedCents: 1000,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    const body = supportBillingPeriodsResponseSchema.parse(
      await ok(api.request('/v1/support/billing-periods', { token: tokenA })),
    );
    const web = body.periods.filter((p) => p.channel === 'stripe');
    expect(web.map((p) => [p.providerPeriodId, p.kind, p.chargedCents])).toEqual([
      ['in_sup_r7', 'subscription_period', 4998],
      ['in_sup_r7:proration', 'proration', 1000],
    ]);
  });

  it('rejects an over-long subject, unknown keys, a billing period on a non-refund kind and empty text', async () => {
    const base = { kind: 'complaint', subject: 'Charged twice', message: 'Synthetic message.' };
    for (const body of [
      { ...base, subject: 'x'.repeat(121) },
      { ...base, message: 'x'.repeat(2001) },
      { ...base, message: '   ' },
      { ...base, familyId: famB.familyId },
      { ...base, status: 'resolved' },
      { ...base, kind: 'chat' },
      { ...base, billingPeriodId: '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c' },
    ]) {
      const res = await post('/v1/support/cases', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json<ErrorBody>(res)).error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('requires a signed-in parent; a child session is refused', async () => {
    expect((await api.request('/v1/support/cases')).status).toBe(401);
    expect((await api.request('/v1/support/cases', { token: childToken })).status).toBe(401);
    expect(
      (await post('/v1/support/cases', { kind: 'other', subject: 's', message: 'm' }, childToken))
        .status,
    ).toBe(401);
  });
});

describe('parent flow', () => {
  let complaintId: string;
  let refundId: string;

  it('opens a complaint: 201 with the case, open, replyable, no messages yet', async () => {
    const res = await post('/v1/support/cases', {
      kind: 'complaint',
      subject: '  The app signed me out twice today  ',
      message: 'Synthetic complaint about the account. Nothing about a child.',
    });
    const body = supportCaseResponseSchema.parse(await ok(res, 201));
    complaintId = body.case.id;
    expect(body.case).toMatchObject({
      kind: 'complaint',
      status: 'open',
      subject: 'The app signed me out twice today',
      billingPeriod: null,
      resolution: null,
      resolvedAt: null,
      canReply: true,
      messageCount: 0,
      messages: [],
    });
    expectNoChildText(body, famA);
    const audit = await api.db.sql<{ action: string; metadata: Record<string, unknown> }[]>`
      select action, metadata from public.audit_events
       where target_type = 'support_case' and target_id = ${complaintId}`;
    expect(audit).toEqual([
      { action: 'support.case_opened', metadata: { kind: 'complaint', hasBillingPeriod: false } },
    ]);
  });

  it('a refund request names one of the family’s own billing periods and shows what the provider reports', async () => {
    const [period] = await api.db.sql<
      { id: string }[]
    >`select id from public.billing_periods where provider_period_id = 'sup-a-sep'`;
    const [foreign] = await api.db.sql<
      { id: string }[]
    >`select id from public.billing_periods where provider_period_id = 'sup-b-sep'`;
    const denied = await post('/v1/support/cases', {
      kind: 'refund_request',
      subject: 'Refund please',
      message: 'Synthetic refund request.',
      billingPeriodId: foreign!.id,
    });
    expect(denied.status).toBe(422);
    expect((await json<ErrorBody>(denied)).error.rule).toBe('BILLING_PERIOD_NOT_FOUND');

    const res = await post('/v1/support/cases', {
      kind: 'refund_request',
      subject: 'Refund please',
      message: 'Synthetic refund request for September.',
      billingPeriodId: period!.id,
    });
    const body = supportCaseResponseSchema.parse(await ok(res, 201));
    refundId = body.case.id;
    expect(body.case.billingPeriod).toMatchObject({
      id: period!.id,
      channel: 'app_store',
      providerPeriodId: 'sup-a-sep',
      // HUNT7-C-3: the kind travels with the period on a case too, so the case detail names the same
      // row the picker named — otherwise 'Charge in question' is the sentence a parent cannot check.
      kind: 'subscription_period',
      chargedCents: 4998,
      refundedCents: 0,
      settlement: 'settled',
    });

    // The store reports the refund later (webhook/reconciliation writes the period); the case shows it.
    await api.db
      .sql`update public.billing_periods set settlement = 'refunded', refunded_cents = 4998
                     where id = ${period!.id}`;
    const after = supportCaseResponseSchema.parse(
      await ok(api.request(`/v1/support/cases/${refundId}`, { token: tokenA })),
    );
    expect(after.case.billingPeriod).toMatchObject({ refundedCents: 4998, settlement: 'refunded' });
  });

  it('lists the family’s own cases newest first; another family sees none and cannot open them', async () => {
    const mine = supportCasesResponseSchema.parse(
      await ok(api.request('/v1/support/cases', { token: tokenA })),
    );
    expect(mine.cases.map((c) => c.id)).toEqual([refundId, complaintId]);
    expectNoChildText(mine, famA);
    const theirs = supportCasesResponseSchema.parse(
      await ok(api.request('/v1/support/cases', { token: tokenB })),
    );
    expect(theirs.cases).toEqual([]);
    expect((await api.request(`/v1/support/cases/${complaintId}`, { token: tokenB })).status).toBe(
      404,
    );
    expect(
      (await post(`/v1/support/cases/${complaintId}/messages`, { message: 'hi' }, tokenB)).status,
    ).toBe(404);
    expect((await api.request('/v1/support/cases/not-a-uuid', { token: tokenA })).status).toBe(404);
  });

  it('a parent replies; staff internal notes never reach the family, public replies do', async () => {
    const reply = supportCaseResponseSchema.parse(
      await ok(
        post(`/v1/support/cases/${complaintId}/messages`, {
          message: 'It happened again this morning.',
        }),
      ),
    );
    expect(reply.case.messageCount).toBe(1);
    expect(reply.case.messages).toEqual([
      expect.objectContaining({ authorKind: 'parent', body: 'It happened again this morning.' }),
    ]);

    for (const [message, internal] of [
      ['INTERNAL NOTE: known session bug, see ticket 41', true],
      ['Thanks for letting us know. A fix is on its way.', false],
    ] as const) {
      await ok(
        api.request(`/v1/admin/support/cases/${complaintId}/messages`, {
          method: 'POST',
          token: adminToken,
          body: { message, internal },
        }),
        201,
      );
    }
    const detail = supportCaseResponseSchema.parse(
      await ok(api.request(`/v1/support/cases/${complaintId}`, { token: tokenA })),
    );
    expect(detail.case.messages.map((m) => [m.authorKind, m.body])).toEqual([
      ['parent', 'It happened again this morning.'],
      ['admin', 'Thanks for letting us know. A fix is on its way.'],
    ]);
    expect(JSON.stringify(detail)).not.toContain('INTERNAL NOTE');
    expect(detail.case.messageCount).toBe(2);
    const list = supportCasesResponseSchema.parse(
      await ok(api.request('/v1/support/cases', { token: tokenA })),
    );
    expect(list.cases.find((c) => c.id === complaintId)?.messageCount).toBe(2);
  });

  it('a reply on a resolved case reopens it; a closed case takes no replies', async () => {
    await ok(
      api.request(`/v1/admin/support/cases/${complaintId}`, {
        method: 'PATCH',
        token: adminToken,
        body: { status: 'resolved', resolution: 'fixed' },
      }),
    );
    const resolved = supportCaseResponseSchema.parse(
      await ok(api.request(`/v1/support/cases/${complaintId}`, { token: tokenA })),
    );
    expect(resolved.case).toMatchObject({
      status: 'resolved',
      resolution: 'fixed',
      canReply: true,
    });
    expect(resolved.case.resolvedAt).not.toBeNull();

    const reopened = supportCaseResponseSchema.parse(
      await ok(post(`/v1/support/cases/${complaintId}/messages`, { message: 'Still broken.' })),
    );
    expect(reopened.case).toMatchObject({ status: 'open', resolution: null, resolvedAt: null });

    await ok(
      api.request(`/v1/admin/support/cases/${complaintId}`, {
        method: 'PATCH',
        token: adminToken,
        body: { status: 'closed' },
      }),
    );
    const closed = supportCaseResponseSchema.parse(
      await ok(api.request(`/v1/support/cases/${complaintId}`, { token: tokenA })),
    );
    expect(closed.case.canReply).toBe(false);
    const refused = await post(`/v1/support/cases/${complaintId}/messages`, { message: 'Hello?' });
    expect(refused.status).toBe(422);
    expect((await json<ErrorBody>(refused)).error.rule).toBe('CASE_CLOSED');
    const [count] = await api.db.sql<
      { n: number }[]
    >`select count(*)::int as n from public.support_case_messages where case_id = ${complaintId}`;
    expect(count!.n).toBe(4);
  });

  it('bounds how many cases a family can open in an hour', async () => {
    const other = await seedFamily(api.db, { childCount: 1 });
    const token = await parentToken(other.ownerId);
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await post(
        '/v1/support/cases',
        { kind: 'other', subject: `Case ${i}`, message: 'Synthetic.' },
        token,
      );
      last = res.status;
      if (last !== 201) {
        expect(i).toBe(10);
        break;
      }
    }
    expect(last).toBe(429);
  });
});

describe('policy view', () => {
  it('a parent reads the refund window and response targets; a child cannot', async () => {
    const view = parentSupportPolicyResponseSchema.parse(
      await ok(api.request('/v1/support/policy', { token: tokenA })),
    );
    expect(view.refundWindowDays).toBe(14);
    expect(view.responseTargetHours.safety_question).toBe(24);
    expect(view.refundWindowSentence).toMatch(/last 14 days/);
    expect(view.refundWindowSentence).not.toMatch(/guarantee/i);
    expect((await api.request('/v1/support/policy', { token: childToken })).status).toBe(401);
    expect((await api.request('/v1/support/policy')).status).toBe(401);
  });
});
