import { describe, expect, it } from 'vitest';
import type { ChildPracticeToday } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { ITEM_IDS, practiceSet, reviews } from './fixtures.ts';
import {
  createAnswerKeys,
  findForbiddenLearningKeys,
  loadCurrentReview,
  loadPracticeToday,
  submitPracticeAnswer,
} from './practice-api.ts';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Labeled test double: responses pass through the real contract schemas; no network. */
function fakeApi(handlers: { get?: (path: string) => unknown; send?: (call: Call) => unknown }) {
  const calls: Call[] = [];
  const handle = (call: Call, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    calls.push(call);
    const value = call.method === 'GET' ? handlers.get?.(call.path) : handlers.send?.(call);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(schema.parse(value) as never);
  };
  const api: ApiClient = {
    get: (path, schema) => handle({ method: 'GET', path, body: undefined }, schema),
    send: (method, path, body, schema) => handle({ method, path, body }, schema),
  };
  return { api, calls };
}

const today: ChildPracticeToday = {
  state: 'available',
  localDate: '2026-09-24',
  releaseAt: '2026-09-24T19:30:00.000Z',
  set: practiceSet(),
};

const correct = {
  result: 'correct',
  attemptNumber: 1,
  offerHelp: false,
  itemStatus: 'correct',
  pointsAwarded: 5,
  setCompleted: false,
};

describe('child practice API helpers (AC_GRADING_06, AC_REWARDS_01/02)', () => {
  it('loads today’s practice and the current review from the child routes', async () => {
    const { api, calls } = fakeApi({
      get: (path) => (path === '/v1/child/practice/today' ? today : reviews()),
    });
    expect((await loadPracticeToday(api)).set?.items).toHaveLength(3);
    expect((await loadCurrentReview(api)).sections).toHaveLength(3);
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/child/practice/today',
      '/v1/child/reviews/current',
    ]);
  });

  it('rejects a payload carrying an answer key field (strict contract), and the scan fails closed', async () => {
    const leaky = {
      ...today,
      set: { ...today.set!, items: [{ ...today.set!.items[0]!, answer: '85' }] },
    };
    const { api } = fakeApi({ get: () => leaky });
    await expect(loadPracticeToday(api)).rejects.toThrow();
    expect(findForbiddenLearningKeys(leaky)).toEqual(['answer']);
    expect(
      findForbiddenLearningKeys({ deep: [{ prompt: { correctAnswer: 'x', spec: {} } }] }),
    ).toEqual(['correctAnswer', 'spec']);
    expect(findForbiddenLearningKeys(today)).toEqual([]);
    expect(findForbiddenLearningKeys(reviews())).toEqual([]);
  });

  it('a retry of the same answer after a lost response reuses its idempotency key', async () => {
    let n = 0;
    const keys = createAnswerKeys(() => `key-${String(++n).padStart(16, '0')}`);
    let attempt = 0;
    const { api, calls } = fakeApi({
      send: () => {
        attempt += 1;
        return attempt === 1 ? new ApiRequestError('NETWORK', 'offline', 0) : correct;
      },
    });
    const first = await submitPracticeAnswer(api, keys, ITEM_IDS[0], '85');
    expect(first).toMatchObject({ ok: false, reload: false });
    expect(first.ok || first.message).toMatch(/offline/);
    const second = await submitPracticeAnswer(api, keys, ITEM_IDS[0], '85');
    expect(second).toEqual({ ok: true, response: correct });
    const sentKeys = calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(sentKeys[0]).toBe(sentKeys[1]);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: `/v1/child/practice/items/${ITEM_IDS[0]}/answer`,
      body: { answer: '85' },
    });
  });

  it('a new try after a definite result, or a changed answer, gets a fresh key', () => {
    let n = 0;
    const keys = createAnswerKeys(() => `key-${++n}`);
    const a = keys.keyFor(ITEM_IDS[0], '84');
    expect(keys.keyFor(ITEM_IDS[0], '84')).toBe(a);
    const b = keys.keyFor(ITEM_IDS[0], '85');
    expect(b).not.toBe(a);
    keys.settle(ITEM_IDS[0]);
    expect(keys.keyFor(ITEM_IDS[0], '85')).not.toBe(b);
    expect(keys.keyFor(ITEM_IDS[1], '85')).not.toBe(keys.keyFor(ITEM_IDS[0], '85'));
  });

  it('a definite refusal settles the key; a removed question asks the screen to reload', async () => {
    let n = 0;
    const keys = createAnswerKeys(() => `key-${String(++n).padStart(16, '0')}`);
    const { api, calls } = fakeApi({
      send: () => new ApiRequestError('NOT_FOUND', 'Question not found', 404),
    });
    const outcome = await submitPracticeAnswer(api, keys, ITEM_IDS[1], '12');
    expect(outcome).toMatchObject({ ok: false, reload: true });
    await submitPracticeAnswer(api, keys, ITEM_IDS[1], '12');
    const sent = calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(sent[0]).not.toBe(sent[1]);
  });

  it('rate limiting is explained calmly', async () => {
    const keys = createAnswerKeys(() => 'k'.repeat(20));
    const { api } = fakeApi({ send: () => new ApiRequestError('RATE_LIMITED', 'Too many', 429) });
    const outcome = await submitPracticeAnswer(api, keys, ITEM_IDS[0], '5');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/little break/);
  });
});
