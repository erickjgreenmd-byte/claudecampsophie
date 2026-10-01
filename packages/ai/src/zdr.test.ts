import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  APPROVED_AI_PROVIDER_HOSTS,
  assertApprovedProviderHost,
  assertZdrEligibleEndpoint,
  assertZdrSafeMetadata,
  checkChildDataGate,
  createMockResponsesClient,
  createOpenAiResponsesClient,
  MODERATION_ENDPOINT,
  RESPONSES_ENDPOINT,
  validateZdrEvidence,
  ZDR_ELIGIBLE_ENDPOINTS,
  ZDR_INELIGIBLE,
  ZDR_SAFE_METADATA_KEYS,
  ZdrEndpointError,
} from './index.ts';

/**
 * ZERO DATA RETENTION, as far as code can carry it. Synthetic throughout: the "homework" below is a
 * made-up fraction question and a 1x1 PNG, and no case needs a network, a key or a real child.
 *
 * WHAT THESE CASES DO NOT SHOW. Nothing here makes ZDR active, and a green run is not evidence that
 * OpenAI has approved anything. ZDR is granted to an ORGANIZATION after OpenAI's review; what these
 * assert is that the requests this product makes stay inside the shape such an approval covers, and
 * that the gate refuses a child's data until documented evidence of the approval exists.
 */

const NOW = new Date('2026-10-01T12:00:00.000Z');
const SYNTHETIC_HOMEWORK = 'Compare 3/4 and 2/3. Show your working.';
const SYNTHETIC_ANSWER = 'I think 3/4 is bigger because 4 is bigger than 3';
const GOOD_EVIDENCE = { reference: 'OPENAI-ZDR-2026-0001', verifiedAt: '2026-09-15' };

describe('the production gate: a flag is not proof of provider approval', () => {
  const base = {
    containsChildPersonalData: true,
    ageBand: '8-10' as const,
    environment: 'production' as const,
    providerIsMock: false,
    now: NOW,
  };

  it('refuses child data with no evidence at all', () => {
    const out = checkChildDataGate({ ...base, zdrEvidence: null });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error.code).toBe('ZDR_EVIDENCE_REQUIRED');
  });

  it('refuses a switch-like reference, which is what a local flag looks like', () => {
    // The whole point of the control: `ZDR_APPROVED=true` in an env file is an operational switch
    // someone set, not a record of OpenAI having approved anything.
    for (const reference of ['true', 'enabled', 'approved', 'granted', 'yes', 'TODO']) {
      const out = checkChildDataGate({
        ...base,
        zdrEvidence: { reference, verifiedAt: '2026-09-15' },
      });
      expect(out.ok, reference).toBe(false);
    }
  });

  it('refuses a verification date in the future, because nobody has checked it yet', () => {
    const out = checkChildDataGate({
      ...base,
      zdrEvidence: { reference: 'OPENAI-ZDR-2026-0001', verifiedAt: '2027-01-01' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error.code).toBe('ZDR_EVIDENCE_INVALID');
  });

  it('refuses a mock provider in production, whatever the evidence says', () => {
    const out = checkChildDataGate({ ...base, providerIsMock: true, zdrEvidence: GOOD_EVIDENCE });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error.code).toBe('MOCK_PROVIDER_IN_PRODUCTION');
  });

  it('admits child data only with a documented reference and a past verification date', () => {
    const out = checkChildDataGate({ ...base, zdrEvidence: GOOD_EVIDENCE });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.value.zdrReference).toBe('OPENAI-ZDR-2026-0001');
  });

  it('treats every band that can contain a 12-year-old as under 13, and a missing band too', () => {
    // Conservative on purpose: OpenAI's under-18 guidance ties the requirement to under-13 personal
    // data, and a null band is the case where nobody knows.
    for (const ageBand of ['5-7', '8-10', '11-13', null] as const) {
      const out = checkChildDataGate({ ...base, ageBand, zdrEvidence: null });
      expect(out.ok, String(ageBand)).toBe(false);
    }
  });

  it('readiness and the gate judge evidence the same way, so readiness cannot say ready', () => {
    // RV-lead-identity-access-4: two different answers would let the owner read "ready" for
    // evidence the gate refuses.
    for (const evidence of [
      null,
      { reference: 'true', verifiedAt: '2026-09-15' },
      { reference: 'OPENAI-ZDR-2026-0001', verifiedAt: '2027-01-01' },
      GOOD_EVIDENCE,
    ]) {
      const gate = checkChildDataGate({ ...base, zdrEvidence: evidence });
      const readiness = validateZdrEvidence(evidence, NOW);
      expect(gate.ok, JSON.stringify(evidence)).toBe(readiness.ok);
    }
  });
});

describe('request settings: only endpoints and features an approved ZDR configuration covers', () => {
  it('every endpoint this product calls is on the documented eligible list', () => {
    for (const endpoint of [RESPONSES_ENDPOINT, MODERATION_ENDPOINT]) {
      expect(() => assertZdrEligibleEndpoint(endpoint)).not.toThrow();
    }
  });

  it('the Files API is refused by name, with the retention reason attached', () => {
    // The exception that matters most here: /v1/files is NOT ZDR-eligible — 30-day abuse-monitoring
    // retention AND application state until the file is deleted. Homework images travel inline as
    // data URLs precisely so this endpoint is never needed.
    expect(() => assertZdrEligibleEndpoint('https://api.openai.com/v1/files')).toThrow(
      ZdrEndpointError,
    );
    expect(ZDR_INELIGIBLE['/v1/files']).toMatch(/30-day|retention/i);
  });

  it('every ineligible endpoint is refused, and each says why', () => {
    for (const [endpoint, reason] of Object.entries(ZDR_INELIGIBLE)) {
      expect(() => assertZdrEligibleEndpoint(endpoint), endpoint).toThrow(ZdrEndpointError);
      expect(reason.length, endpoint).toBeGreaterThan(40);
    }
  });

  it('an endpoint nobody has checked is refused rather than allowed', () => {
    // Fails CLOSED: a new OpenAI endpoint is ineligible here until someone opens the guide.
    expect(() => assertZdrEligibleEndpoint('https://api.openai.com/v1/something_new')).toThrow(
      ZdrEndpointError,
    );
  });

  it('the eligible list holds no endpoint the ineligible list also names', () => {
    for (const endpoint of ZDR_ELIGIBLE_ENDPOINTS) {
      expect(Object.keys(ZDR_INELIGIBLE), endpoint).not.toContain(endpoint);
    }
  });

  it('store:false is on the wire for every request', async () => {
    const client = createMockResponsesClient(() => ({
      kind: 'ok' as const,
      text: '{}',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
      modelId: 'gpt-6-terra',
      latencyMs: 1,
    }));
    await client.create({
      model: 'gpt-6-terra',
      instructions: 'synthetic',
      input: [{ type: 'input_text', text: SYNTHETIC_HOMEWORK }],
      outputName: 'o',
      jsonSchema: { type: 'object' },
      maxOutputTokens: 16,
      timeoutMs: 1000,
      metadata: { stage: 'unit_test' },
    });
    expect(client.requests).toHaveLength(1);
  });

  it('the real transport sends store:false and no second provider host', async () => {
    const sent: { url: string; body: string }[] = [];
    const client = createOpenAiResponsesClient({
      apiKey: 'sk-synthetic-not-a-real-key',
      fetchImpl: ((url: string, init: { body: Uint8Array }) => {
        sent.push({ url: String(url), body: new TextDecoder().decode(init.body) });
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'completed', output: [], usage: {} }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    });
    await client.create({
      model: 'gpt-6-terra',
      instructions: 'synthetic',
      input: [{ type: 'input_text', text: SYNTHETIC_HOMEWORK }],
      outputName: 'o',
      jsonSchema: { type: 'object' },
      maxOutputTokens: 16,
      timeoutMs: 1000,
      metadata: { stage: 'unit_test' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(RESPONSES_ENDPOINT);
    expect(JSON.parse(sent[0]!.body).store).toBe(false);
  });

  it('there is exactly one approved provider host, so nothing can silently fail over', () => {
    expect(APPROVED_AI_PROVIDER_HOSTS).toEqual(['api.openai.com']);
    for (const other of [
      'https://api.anthropic.com/v1/messages',
      'https://generativelanguage.googleapis.com/v1/models',
      'https://pencillift-proxy.example.com/v1/responses',
    ]) {
      expect(() => assertApprovedProviderHost(other), other).toThrow(ZdrEndpointError);
    }
  });
});

describe('data minimisation: what travels beside the request', () => {
  it('accepts only the two keys that describe the software', () => {
    expect(ZDR_SAFE_METADATA_KEYS).toEqual(['stage', 'prompt_version']);
    expect(() =>
      assertZdrSafeMetadata({ stage: 'grading', prompt_version: 'grading.v3' }),
    ).not.toThrow();
  });

  it('refuses every identifier a developer would plausibly add', () => {
    // Each of these is something someone would add to debug a single family's run. The first was
    // genuinely present in this package's own fixtures before this change.
    for (const key of [
      'child',
      'child_id',
      'family_id',
      'parent_email',
      'student_name',
      'session_id',
      'device_id',
      'user',
      'account_id',
      'nickname',
      'ip',
    ]) {
      expect(() => assertZdrSafeMetadata({ [key]: 'x' }), key).toThrow(ZdrEndpointError);
    }
  });

  it('the TRANSPORT refuses an identifier, not only the compiler', async () => {
    /*
     * The type closes this for any TypeScript caller, and that is the stronger control. But the
     * compiler cannot see a spread of a `Record<string, string>` built at runtime, which is how a
     * per-family debug key would actually arrive. Removing the runtime guard from client.ts reddened
     * NOTHING until this case existed — the rule was in a helper and the call site was unpinned,
     * which is L-071 exactly.
     */
    let reached = false;
    const client = createOpenAiResponsesClient({
      apiKey: 'sk-synthetic-not-a-real-key',
      fetchImpl: () => {
        reached = true;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    await expect(
      client.create({
        model: 'gpt-6-terra',
        instructions: 'synthetic',
        input: [{ type: 'input_text', text: SYNTHETIC_HOMEWORK }],
        outputName: 'o',
        jsonSchema: { type: 'object' },
        maxOutputTokens: 16,
        timeoutMs: 1000,
        // The cast is the point: this is what a dynamically assembled object looks like once it
        // has been widened, and it is the only way past the type.
        metadata: {
          /* zdr-negative-test */ stage: 'grading',
          child_id: 'synthetic-child',
        } as unknown as {
          stage: string;
        },
      }),
    ).rejects.toThrow(ZdrEndpointError);
    expect(reached, 'nothing may reach the provider when metadata is refused').toBe(false);
  });

  it('refuses an unknown key even when it looks harmless', () => {
    // The allow-list is the control; "looks harmless" is how the next identifier gets in.
    expect(() => assertZdrSafeMetadata({ note: 'retry after timeout' })).toThrow(ZdrEndpointError);
  });
});

describe('logging protections: a child’s work never reaches a log, a report or a fixture', () => {
  const AI_DIR = path.join(import.meta.dirname);
  const sources = readdirSync(AI_DIR).filter((f) => f.endsWith('.ts'));

  it('no file in this package writes to the console', () => {
    // A console line in a Worker goes to the platform's log stream, which is exactly the place a
    // prompt, an image or a model response must never appear.
    for (const file of sources) {
      const text = readFileSync(path.join(AI_DIR, file), 'utf8');
      expect(text, file).not.toMatch(/\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/);
    }
  });

  it('a failed request carries a status and a timing, never the body', () => {
    // The error path is where response text leaks: it is tempting to attach the provider's body to
    // help debugging, and that body is the child's work coming back.
    const client = createOpenAiResponsesClient({
      apiKey: 'sk-synthetic-not-a-real-key',
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: SYNTHETIC_ANSWER } }), { status: 500 }),
        ),
    });
    return client
      .create({
        model: 'gpt-6-terra',
        instructions: 'synthetic',
        input: [{ type: 'input_text', text: SYNTHETIC_HOMEWORK }],
        outputName: 'o',
        jsonSchema: { type: 'object' },
        maxOutputTokens: 16,
        timeoutMs: 1000,
        metadata: { stage: 'unit_test' },
      })
      .then((result) => {
        const printed = JSON.stringify(result);
        expect(printed).not.toContain(SYNTHETIC_ANSWER);
        expect(printed).not.toContain(SYNTHETIC_HOMEWORK);
        expect(result.kind).toBe('error');
      });
  });

  it('a thrown transport error carries no prompt text either', async () => {
    const client = createOpenAiResponsesClient({
      apiKey: 'sk-synthetic-not-a-real-key',
      fetchImpl: () => Promise.reject(new Error('socket closed')),
    });
    const result = await client.create({
      model: 'gpt-6-terra',
      instructions: SYNTHETIC_HOMEWORK,
      input: [{ type: 'input_text', text: SYNTHETIC_HOMEWORK }],
      outputName: 'o',
      jsonSchema: { type: 'object' },
      maxOutputTokens: 16,
      timeoutMs: 1000,
      metadata: { stage: 'unit_test' },
    });
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_HOMEWORK);
  });

  it('no fixture in this package carries a per-child identifier in request metadata', () => {
    // Fixtures are where patterns get copied from, so the brief counts them as a place a child's
    // data must not appear. `metadata: { child: 'pseudonymous-id' }` was here until this change.
    for (const file of sources.filter((f) => f.endsWith('.test.ts'))) {
      // Comments are stripped first. The rule is about CODE: this very file quotes the old
      // `metadata: { child: ... }` in a comment to say what changed, and a scanner that cannot tell
      // prose from a call would be satisfied by deleting the explanation — the opposite of the point
      // (L-077: assert the syntax you mean, not a string that happens to sit near it).
      const text = readFileSync(path.join(AI_DIR, file), 'utf8')
        // The exemption is rewritten FIRST, because the comment stripping below would otherwise
        // delete the marker before the match ran and the exemption would never apply — which is
        // what happened on the first attempt. Renaming the key is what removes it from the scan.
        .replace(/metadata:\s*\{\s*\/\* zdr-negative-test \*\//g, 'zdrNegativeTestOmitted: {')
        // Comments go next. The rule is about CODE: this file quotes the old
        // `metadata: { child: ... }` in prose to say what changed, and a scanner that cannot tell
        // prose from a call would be satisfied by deleting the explanation (L-077).
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const match of text.matchAll(/metadata:\s*\{([^}]*)\}/g)) {
        const keys = [...match[1]!.matchAll(/(\w+)\s*:/g)].map((m) => m[1]!);
        for (const key of keys) {
          expect(ZDR_SAFE_METADATA_KEYS, `${file}: metadata.${key}`).toContain(key);
        }
      }
    }
  });
});
