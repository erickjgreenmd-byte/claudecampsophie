import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { chooseSchool, promoProblem, quotePromo, redeemPromo, searchSchools } from './actions.ts';

const MAPLE = {
  id: '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c',
  name: 'Maple Grove Elementary',
  city: null,
  region: null,
};
const CODE = 'ABCDE-FGHJK-X';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Labeled test double: responses pass through the real contract schemas, like the real client. */
function fakeApi(handler: (call: Call) => unknown): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = (call: Call, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    calls.push(call);
    const value = handler(call);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(schema.parse(value) as never);
  };
  return {
    calls,
    api: {
      get: (path, schema) => respond({ method: 'GET', path, body: undefined }, schema),
      send: (method, path, body, schema) => respond({ method, path, body }, schema),
    },
  };
}

const quoteBody = {
  campaignMonth: '2026-10',
  percentOff: 25,
  channel: 'app_store',
  targetPeriod: { kind: 'first_full_period' },
  regularCents: 3999,
  discountCents: 1000,
  chargedCents: 2999,
  nextRegularRenewalCents: 3999,
  isPreview: true,
};

describe('promoProblem maps stable codes to calm, specific parent messages', () => {
  it.each([
    ['FAMILY_ALREADY_REDEEMED_CAMPAIGN', /already used this month’s code/],
    ['TARGET_PERIOD_ALREADY_DISCOUNTED', /already has a discount/],
    ['PENDING_PROMOTION_EXISTS', /already have a discount waiting/],
    ['CHANNEL_UNAVAILABLE', /isn’t available in this store yet/],
    ['CODE_CHECKSUM_MISMATCH', /has a typo/],
    ['CODE_INVALID_FORMAT', /doesn’t look like a PencilLift code/],
  ])('%s', (rule, message) => {
    const problem = promoProblem(new ApiRequestError('BUSINESS_RULE', 'server text', 422, rule));
    expect(problem.message).toMatch(message);
    expect(problem.needsPin).toBe(false);
  });

  it('asks for the parent PIN on STEP_UP_REQUIRED', () => {
    const problem = promoProblem(new ApiRequestError('STEP_UP_REQUIRED', 'x', 403));
    expect(problem.needsPin).toBe(true);
    expect(problem.message).toMatch(/Unlock with your parent PIN/);
  });

  it('treats an unknown code as invalid and passes through safe server wording otherwise', () => {
    expect(promoProblem(new ApiRequestError('NOT_FOUND', 'x', 404)).message).toBe(
      'That code isn’t valid. Check it and try again.',
    );
    expect(
      promoProblem(
        new ApiRequestError('BUSINESS_RULE', 'This code needs attention.', 422, 'NEW_RULE'),
      ).message,
    ).toBe('This code needs attention.');
    expect(promoProblem(new Error('boom')).message).toBe('Something went wrong. Please try again.');
  });
});

describe('school actions', () => {
  it('encodes the search query and requires two letters', async () => {
    const { api, calls } = fakeApi(() => ({ schools: [MAPLE] }));
    expect(await searchSchools(api, ' m ')).toEqual({
      ok: false,
      message: 'Type at least 2 letters of the school’s name.',
    });
    expect(calls).toHaveLength(0);
    const found = await searchSchools(api, 'maple grove');
    expect(calls[0]!.path).toBe('/v1/schools?query=maple%20grove');
    expect(found).toEqual({ ok: true, query: 'maple grove', schools: [MAPLE] });
  });

  it('sends only the school id and reports what the server saved', async () => {
    const { api, calls } = fakeApi(() => ({
      current: MAPLE,
      pending: null,
      programTimezone: 'UTC',
      contributionIsPencilLiftFunded: true,
    }));
    const result = await chooseSchool(api, MAPLE);
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/v1/family/school',
      body: { schoolId: MAPLE.id },
    });
    expect(result.ok && result.message).toMatch(/Maple Grove Elementary stays your school/);
  });
});

describe('promo actions', () => {
  it('quotes with the device channel and optional plan size only', async () => {
    const { api, calls } = fakeApi(() => quoteBody);
    const result = await quotePromo(api, { code: `  ${CODE} `, channel: 'app_store' });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/family/promotions/quote',
      body: { code: CODE, channel: 'app_store' },
    });
    expect(result.ok).toBe(true);
    await quotePromo(api, { code: CODE, channel: 'play_store', paidSlots: 2 });
    expect(calls[1]!.body).toEqual({ code: CODE, channel: 'play_store', paidSlots: 2 });
  });

  it('never calls the API for a malformed code', async () => {
    const { api, calls } = fakeApi(() => quoteBody);
    const result = await quotePromo(api, { code: 'ABC', channel: 'app_store' });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('redeems with the caller’s idempotency key and maps business rules', async () => {
    const { api, calls } = fakeApi(
      () => new ApiRequestError('BUSINESS_RULE', 'x', 422, 'PENDING_PROMOTION_EXISTS'),
    );
    const key = 'key_0123456789abcdef';
    const result = await redeemPromo(api, { code: CODE, channel: 'stripe' }, key);
    expect(calls[0]!.body).toEqual({ code: CODE, channel: 'stripe', idempotencyKey: key });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.message).toMatch(/already have a discount waiting/);
  });
});
