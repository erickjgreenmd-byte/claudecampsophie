import { describe, expect, it } from 'vitest';
import { createMockResponsesClient } from '@pencillift/ai';
import { createOpenAiIdentityProvider } from '../src/providers/identity-openai.ts';

/**
 * THE REAL ADULT-ID ADAPTER, which until now no test called at all.
 *
 * That gap is the whole reason this file exists, and it hid a defect worse than any refusal. When the
 * selfie became optional (migration 0990's method is the document plus the holder's legal
 * declaration), `faceMatch` became 'not_attempted' for every submission — and the result still read
 * `failureCode: faceMatch === 'matched' ? null : faceCode(faceMatch)`. So a genuine government photo
 * ID of a genuine adult came back carrying a face failure code. The route then wrote a row with
 * `adult_declared` true (the document and the declaration both held) AND a non-null `failure_code`,
 * which violates migration 0990's `identity_declarations_established_names_no_failure`: the insert
 * RAISES. Every adult submission in production would have 500'd.
 *
 * Nothing caught it because every suite runs `createDevelopmentIdentityMock`, whose own `check`
 * returns `failureCode: null` for an adult. The mock was right and the real thing was wrong, and no
 * test could tell the difference because no test constructed the real thing. That is L-074 — "built"
 * and "reachable" are different claims — inside the adapter the lesson was written about.
 *
 * So these cases drive `createOpenAiIdentityProvider` with a mock RESPONSES CLIENT (the provider
 * boundary) rather than a mock provider, which is the only way the adapter's own arithmetic is
 * exercised at all.
 */
const ZDR = { reference: 'zdr-synthetic-1', verifiedAt: '2026-01-01' };
const NOW = new Date('2026-09-30T12:00:00.000Z');

const DOCUMENT = {
  mimeType: 'image/png' as const,
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+7AAAAABJRU5ErkJggg==',
};

/** What the vision model answers about the document. Only these fields are ever read. */
function documentAnswer(over: Record<string, unknown> = {}) {
  return {
    readable: true,
    isGovernmentPhotoId: true,
    documentKind: 'drivers_licence',
    dateOfBirth: '1990-04-12',
    expiryDate: null,
    ...over,
  };
}

function providerAnswering(answer: Record<string, unknown>) {
  const client = createMockResponsesClient(() => ({
    kind: 'ok' as const,
    text: JSON.stringify(answer),
    usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 80 },
    modelId: 'gpt-6-terra',
    latencyMs: 5,
  }));
  return {
    client,
    provider: createOpenAiIdentityProvider({
      ai: client,
      zdrEvidence: ZDR,
      environment: 'test',
    }),
  };
}

describe('[BUG-415] a comparison nobody asked for is not a failure', () => {
  it('[repro] establishes a genuine adult with NO selfie, naming no failure at all', async () => {
    const { provider } = providerAnswering(documentAnswer());
    const result = await provider.check({
      document: DOCUMENT,
      statedDateOfBirth: '1990-04-12',
      now: NOW,
    });
    expect(result.documentIsGovernmentId).toBe(true);
    expect(result.documentHolderIsAdult).toBe(true);
    // The honest answer to a question nobody asked.
    expect(result.faceMatch).toBe('not_attempted');
    // THE ASSERTION THE WHOLE FILE EXISTS FOR. Before the fix this was 'FACE_CHECK_UNAVAILABLE',
    // and a row carrying it alongside adult_declared = true violates 0990's own constraint.
    expect(result.failureCode).toBeNull();
  });

  it('makes exactly ONE provider call, so the face-compare stage is never spent', async () => {
    const { client, provider } = providerAnswering(documentAnswer());
    await provider.check({ document: DOCUMENT, statedDateOfBirth: '1990-04-12', now: NOW });
    // docs/Cost_Analysis.md's figure depends on this: one round trip, not two. The 15,000-micro
    // `identity_face_compare` budget is never entered because the stage is never run.
    expect(client.requests).toHaveLength(1);
  });

  it('still refuses what the DOCUMENT itself refuses, so the fix widened nothing', async () => {
    // The fix must not turn every submission into a pass. Each of these is a document-side refusal
    // and each must survive, because "a comparison nobody asked for cannot fail" says nothing about
    // the document checks.
    for (const [why, answer, expected] of [
      ['unreadable', documentAnswer({ readable: false }), 'DOCUMENT_UNREADABLE'],
      ['not an ID', documentAnswer({ isGovernmentPhotoId: false }), 'NOT_A_GOVERNMENT_ID'],
      ['expired', documentAnswer({ expiryDate: '2020-01-01' }), 'DOCUMENT_EXPIRED'],
      ['no date of birth', documentAnswer({ dateOfBirth: null }), 'DOCUMENT_UNREADABLE'],
    ] as const) {
      const { provider } = providerAnswering(answer);
      const result = await provider.check({
        document: DOCUMENT,
        statedDateOfBirth: '1990-04-12',
        now: NOW,
      });
      expect(result.failureCode, why).toBe(expected);
    }
  });

  it('refuses a stated date of birth the document disagrees with', async () => {
    // The one cheap signal that the document belongs to someone else, and the only thing besides the
    // declaration that narrows "anyone holding an adult's licence passes".
    const { provider } = providerAnswering(documentAnswer({ dateOfBirth: '1990-04-12' }));
    const result = await provider.check({
      document: DOCUMENT,
      statedDateOfBirth: '1991-04-12',
      now: NOW,
    });
    expect(result.failureCode).toBe('DOB_MISMATCH');
  });

  it('refuses a document whose holder is a minor', async () => {
    const { provider } = providerAnswering(documentAnswer({ dateOfBirth: '2015-04-12' }));
    const result = await provider.check({
      document: DOCUMENT,
      statedDateOfBirth: '2015-04-12',
      now: NOW,
    });
    expect(result.documentHolderIsAdult).toBe(false);
    expect(result.failureCode).toBe('NOT_AN_ADULT');
  });

  it('declares it cannot compare faces, and refuses without ZDR evidence', async () => {
    const { provider } = providerAnswering(documentAnswer());
    // Not a capability this adapter claims: the comparison is biometric identification, which the
    // provider's policies forbid. `faceCheckAvailable` in the status response is built from this.
    expect(provider.canCompareFaces).toBe(false);

    // The ZDR precondition is this adapter's own and is enforced before any image is sent: an
    // identity document inside a provider's retention window is an identity document in someone
    // else's logs. A missing credential is a blocker, never a pass.
    const client = createMockResponsesClient(() => {
      throw new Error('no image may be sent without ZDR evidence');
    });
    const bare = createOpenAiIdentityProvider({
      ai: client,
      zdrEvidence: null,
      environment: 'test',
    });
    const refusedResult = await bare.check({
      document: DOCUMENT,
      statedDateOfBirth: '1990-04-12',
      now: NOW,
    });
    expect(refusedResult.failureCode).toBe('PROVIDER_ERROR');
    expect(refusedResult.documentIsGovernmentId).toBe(false);
    // Nothing reached the provider at all.
    expect(client.requests).toHaveLength(0);
  });
});
