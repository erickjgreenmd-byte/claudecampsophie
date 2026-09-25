import { describe, expect, it } from 'vitest';
import { heldFromFamily, mergeScreens, screenText } from '@pencillift/domain/safety';
import {
  buildModerationRequestBody,
  createMockModerationClient,
  createOpenAiModerationClient,
  createRefusingModerationClient,
  MODERATION_BATCH_CAP,
  MODERATION_ENDPOINT,
  MODERATION_MODEL,
  mockModerationResult,
  moderationFlagged,
  OPENAI_MODERATION_CATEGORIES,
  PROVIDER_CATEGORY_MAP,
  providerModerationCodes,
  providerSafetyCategories,
  providerSafetyScreen,
  type ModerationResult,
} from './moderation.ts';

/**
 * Provider moderation (spec P4; AC_SECURITY_02). The OpenAI transport is exercised against a
 * scripted fetch only (no key exists and the build environment never calls the network); the mock
 * is the LABELED mock the API uses in development and test. Synthetic text only.
 */

const OPTIONS = { timeoutMs: 1_000, metadata: { stage: 'unit_test' } } as const;

describe('mapping OpenAI categories to PencilLift categories', () => {
  const TABLE: Record<string, { child: string[]; model_output: string[] }> = {
    'self-harm': { child: ['self_harm'], model_output: ['self_harm'] },
    'self-harm/intent': { child: ['self_harm'], model_output: ['self_harm'] },
    'self-harm/instructions': { child: ['self_harm'], model_output: ['self_harm'] },
    sexual: { child: ['sexual'], model_output: ['sexual'] },
    'sexual/minors': { child: ['sexual'], model_output: ['sexual'] },
    // The child's own words: a violence-type flag is held as possible abuse (a victim's report and
    // a threat look the same to a model).
    violence: { child: ['abuse', 'violence'], model_output: ['violence'] },
    'violence/graphic': { child: ['abuse', 'violence'], model_output: ['violence'] },
    'harassment/threatening': { child: ['abuse', 'violence'], model_output: ['violence'] },
    'hate/threatening': { child: ['abuse', 'violence'], model_output: ['violence'] },
    'illicit/violent': { child: ['abuse', 'violence'], model_output: ['violence'] },
    harassment: { child: [], model_output: [] },
    hate: { child: [], model_output: [] },
    illicit: { child: [], model_output: [] },
  };

  it('covers every OpenAI category exactly once', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...OPENAI_MODERATION_CATEGORIES].sort());
    expect(Object.keys(PROVIDER_CATEGORY_MAP).sort()).toEqual(
      [...OPENAI_MODERATION_CATEGORIES].sort(),
    );
  });

  for (const [category, expected] of Object.entries(TABLE)) {
    it(`${category} -> child ${JSON.stringify(expected.child)}, output ${JSON.stringify(expected.model_output)}`, () => {
      expect(providerSafetyCategories([category], 'child')).toEqual(expected.child);
      expect(providerSafetyCategories([category], 'model_output')).toEqual(expected.model_output);
    });
  }

  it('a violence flag on the child’s words is an abuse+violence report that the parent sees at once', () => {
    // Owner decision (2026-09-25): the parent is the sole recipient of every flag, so no provider
    // category holds a report from the family (FAMILY_HOLD_CATEGORIES is empty); the mapping that
    // used to decide the hold still decides the report's categories.
    expect(providerSafetyCategories(['violence'], 'child')).toEqual(['abuse', 'violence']);
    expect(heldFromFamily(providerSafetyCategories(['violence'], 'child'))).toBe(false);
    expect(heldFromFamily(providerSafetyCategories(['self-harm'], 'child'))).toBe(false);
    expect(heldFromFamily(providerSafetyCategories(['sexual/minors'], 'child'))).toBe(false);
  });

  it('joins several flags, sorted like the word-list screen, and ignores unknown names', () => {
    expect(
      providerSafetyCategories(['violence', 'self-harm/intent', 'sexual', 'made-up'], 'child'),
    ).toEqual(['self_harm', 'abuse', 'violence', 'sexual']);
  });

  it('a provider screen merges with the word-list screen: the most serious wins, codes join', () => {
    const words = screenText('The leaves are red in fall.', { ageBand: '8-10' });
    expect(words.level).toBe('none');
    const provider = providerSafetyScreen(
      { flagged: true, categories: ['violence'], maxScore: 0.9 },
      'child',
    );
    expect(provider).toEqual({
      level: 'severe',
      categories: ['abuse', 'violence'],
      topics: [],
      codes: ['PROVIDER_VIOLENCE'],
      truncated: false,
    });
    const merged = mergeScreens([words, provider]);
    expect(merged.level).toBe('severe');
    expect(merged.categories).toEqual(['abuse', 'violence']);
    expect(merged.codes).toContain('PROVIDER_VIOLENCE');
  });

  it('an unmapped flag on child input is a code only, never severe', () => {
    expect(
      providerSafetyScreen({ flagged: true, categories: ['harassment'], maxScore: 0.8 }, 'child'),
    ).toEqual({
      level: 'none',
      categories: [],
      topics: [],
      codes: ['PROVIDER_HARASSMENT'],
      truncated: false,
    });
  });

  it('fails closed: reported categories count as flagged even without the flag', () => {
    const item = { flagged: false, categories: ['self-harm'], maxScore: 0.4 };
    expect(moderationFlagged(item)).toBe(true);
    expect(providerSafetyScreen(item, 'child').categories).toEqual(['self_harm']);
    expect(moderationFlagged({ flagged: true, categories: [], maxScore: 0.4 })).toBe(true);
    expect(providerModerationCodes({ flagged: true, categories: [], maxScore: 0.4 })).toEqual([
      'PROVIDER_FLAGGED',
    ]);
    expect(moderationFlagged({ flagged: false, categories: [], maxScore: 0.4 })).toBe(false);
  });

  it('log codes are bounded capitals, digits and underscores whatever the provider returns', () => {
    const codes = providerModerationCodes({
      flagged: true,
      categories: ['self-harm/intent', 'weird category <script>', '////', 'x'.repeat(200)],
      maxScore: 1,
    });
    expect(codes).toContain('PROVIDER_SELF_HARM_INTENT');
    expect(codes).toContain('PROVIDER_WEIRD_CATEGORY_SCRIPT');
    expect(codes).toContain('PROVIDER_FLAGGED');
    for (const code of codes) expect(code).toMatch(/^PROVIDER_[A-Z0-9_]{1,40}$/);
  });
});

describe('the labeled mock', () => {
  it('flags an input only when it carries a marker with a known OpenAI category', async () => {
    const mock = createMockModerationClient();
    expect(mock.isMock).toBe(true);
    const inputs = [
      'I like fall.',
      'I like fall. [mock-moderation:self-harm/intent]',
      'Two flags [mock-moderation:violence] [mock-moderation:sexual]',
      'Unknown [mock-moderation:not-a-category]',
      'A real-sounding sentence without a marker, about hurting',
    ];
    const out = await mock.moderate(inputs, OPTIONS);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.results.map((r) => [r.flagged, r.categories])).toEqual([
      [false, []],
      [true, ['self-harm/intent']],
      [true, ['sexual', 'violence']],
      [false, []],
      [false, []],
    ]);
    expect(mock.requests).toEqual([{ inputs, options: OPTIONS }]);
  });

  it('answers scripted results first (an error, a timeout or a flag without a marker)', async () => {
    const mock = createMockModerationClient();
    const failure: ModerationResult = {
      kind: 'error',
      status: 503,
      retryable: true,
      timedOut: false,
      latencyMs: 3,
    };
    mock.scripted.push(failure, (inputs) => ({
      kind: 'ok',
      results: inputs.map(() => ({ flagged: true, categories: ['hate'], maxScore: 0.7 })),
      modelId: 'mock-moderation',
      latencyMs: 1,
    }));
    expect(await mock.moderate(['a'], OPTIONS)).toEqual(failure);
    const second = await mock.moderate(['b', 'c'], OPTIONS);
    expect(second.kind === 'ok' && second.results.map((r) => r.categories)).toEqual([
      ['hate'],
      ['hate'],
    ]);
    expect(await mock.moderate(['d'], OPTIONS)).toEqual(mockModerationResult(['d']));
  });

  it('the refusing client fails every call and cannot be retried', async () => {
    const refusing = createRefusingModerationClient();
    expect(refusing.isMock).toBe(false);
    expect(await refusing.moderate(['anything'], OPTIONS)).toEqual({
      kind: 'error',
      status: null,
      retryable: false,
      timedOut: false,
      latencyMs: 0,
    });
  });
});

describe('the OpenAI moderation transport (scripted fetch; never the network)', () => {
  type Call = { url: string; init: RequestInit; body: { model: string; input: string[] } };

  function apiResult(text: string) {
    const flagged = text.includes('FLAG');
    return {
      flagged,
      categories: Object.fromEntries(
        OPENAI_MODERATION_CATEGORIES.map((c) => [c, flagged && c === 'self-harm']),
      ),
      category_scores: Object.fromEntries(
        OPENAI_MODERATION_CATEGORIES.map((c) => [c, flagged && c === 'self-harm' ? 0.93 : 0.01]),
      ),
    };
  }

  function scriptedFetch(respond?: (call: Call) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const call = { url, init, body: JSON.parse(init.body as string) as Call['body'] };
      calls.push(call);
      if (respond) return respond(call);
      return Response.json({
        id: 'modr-synthetic',
        model: 'omni-moderation-2024-09-26',
        results: call.body.input.map(apiResult),
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('posts the documented body with the key, the project and no metadata', async () => {
    const { calls, fetchImpl } = scriptedFetch();
    const client = createOpenAiModerationClient({
      apiKey: 'sk-synthetic-test-value',
      project: 'proj_synthetic',
      fetchImpl,
    });
    expect(client.isMock).toBe(false);
    const out = await client.moderate(['Plants need light.', 'FLAG this'], OPTIONS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MODERATION_ENDPOINT);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: 'Bearer sk-synthetic-test-value',
      'content-type': 'application/json',
      'openai-project': 'proj_synthetic',
    });
    expect(calls[0]!.body).toEqual({
      model: MODERATION_MODEL,
      input: ['Plants need light.', 'FLAG this'],
    });
    expect(buildModerationRequestBody(['x'])).toEqual({
      model: 'omni-moderation-latest',
      input: ['x'],
    });
    expect(out).toMatchObject({
      kind: 'ok',
      modelId: 'omni-moderation-2024-09-26',
      results: [
        { flagged: false, categories: [], maxScore: 0.01 },
        { flagged: true, categories: ['self-harm'], maxScore: 0.93 },
      ],
    });
  });

  it('splits a large call into batches of the fixed cap and keeps the input order', async () => {
    const { calls, fetchImpl } = scriptedFetch();
    const client = createOpenAiModerationClient({ apiKey: 'sk-synthetic-test-value', fetchImpl });
    const inputs = Array.from({ length: MODERATION_BATCH_CAP * 2 + 6 }, (_, i) =>
      i % 9 === 0 ? `FLAG ${i}` : `answer ${i}`,
    );
    const out = await client.moderate(inputs, OPTIONS);
    expect(calls.map((c) => c.body.input.length)).toEqual([
      MODERATION_BATCH_CAP,
      MODERATION_BATCH_CAP,
      6,
    ]);
    expect(calls.flatMap((c) => c.body.input)).toEqual(inputs);
    expect(out.kind === 'ok' && out.results.map((r) => r.flagged)).toEqual(
      inputs.map((t) => t.startsWith('FLAG')),
    );
  });

  it('does not send blank inputs and makes no request when nothing is left', async () => {
    const { calls, fetchImpl } = scriptedFetch();
    const client = createOpenAiModerationClient({ apiKey: 'sk-synthetic-test-value', fetchImpl });
    const out = await client.moderate(['  ', 'FLAG', ''], OPTIONS);
    expect(calls.map((c) => c.body.input)).toEqual([['FLAG']]);
    expect(out.kind === 'ok' && out.results.map((r) => r.flagged)).toEqual([false, true, false]);
    expect(await client.moderate([], OPTIONS)).toMatchObject({ kind: 'ok', results: [] });
    expect(calls).toHaveLength(1);
  });

  it('maps HTTP failures to retryable or not, with no text in the error', async () => {
    const secret = 'Synthetic child sentence 7731';
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [401, false],
    ] as const) {
      const { fetchImpl } = scriptedFetch(() =>
        Response.json({ error: { message: `bad input: ${secret}` } }, { status }),
      );
      const client = createOpenAiModerationClient({ apiKey: 'sk-synthetic-test-value', fetchImpl });
      const out = await client.moderate([secret], OPTIONS);
      expect(out).toMatchObject({ kind: 'error', status, retryable, timedOut: false });
      expect(JSON.stringify(out)).not.toContain(secret);
    }
  });

  it('any failed batch fails the whole call (nothing partial is returned)', async () => {
    let n = 0;
    const { fetchImpl } = scriptedFetch((call) => {
      n += 1;
      if (n === 2) return new Response('unavailable', { status: 502 });
      return Response.json({ model: 'm', results: call.body.input.map(apiResult) });
    });
    const client = createOpenAiModerationClient({ apiKey: 'sk-synthetic-test-value', fetchImpl });
    const out = await client.moderate(
      Array.from({ length: MODERATION_BATCH_CAP + 1 }, (_, i) => `a${i}`),
      OPTIONS,
    );
    expect(out).toMatchObject({ kind: 'error', status: 502, retryable: true });
  });

  it('a response that does not match the inputs one to one is an error, never "not flagged"', async () => {
    for (const body of [
      { model: 'm', results: [] },
      { model: 'm' },
      { model: 'm', results: [{ flagged: 'no', categories: {} }] },
      { model: 'm', results: [{ flagged: false }] },
      { model: 'm', results: [null] },
    ]) {
      const { fetchImpl } = scriptedFetch(() => Response.json(body));
      const client = createOpenAiModerationClient({ apiKey: 'sk-synthetic-test-value', fetchImpl });
      expect(await client.moderate(['one input'], OPTIONS)).toMatchObject({
        kind: 'error',
        retryable: true,
      });
    }
  });

  it('times out with an AbortController (Workers-compatible) and reports it as retryable', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const client = createOpenAiModerationClient({ apiKey: 'sk-synthetic-test-value', fetchImpl });
    const out = await client.moderate(['slow'], { timeoutMs: 5, metadata: {} });
    expect(out).toMatchObject({ kind: 'error', status: null, retryable: true, timedOut: true });
  });

  it('a network error is retryable, not a timeout, and carries no message', async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError('fetch failed for Synthetic words'))) as unknown as typeof fetch;
    const client = createOpenAiModerationClient({ apiKey: 'sk-synthetic-test-value', fetchImpl });
    const out = await client.moderate(['Synthetic words'], OPTIONS);
    expect(out).toMatchObject({ kind: 'error', status: null, retryable: true, timedOut: false });
    expect(JSON.stringify(out)).not.toContain('Synthetic words');
  });
});
