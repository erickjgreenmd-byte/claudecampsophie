import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AI_STAGES,
  canAttempt,
  defineStageLimits,
  type AiStage,
  type StageLimits,
} from './index.ts';

const LIMITS: StageLimits = {
  maxAttempts: 3,
  timeoutMs: 30_000,
  maxOutputTokens: 2_000,
  maxCostMicros: 60_000,
};

describe('P12/F4 per-stage attempt and cost limits (AC_FIN_09)', () => {
  it('covers every metered stage from F3', () => {
    expect([...AI_STAGES].sort()).toEqual(
      [
        'extraction',
        'grading',
        'verification',
        'coaching',
        'followup',
        'daily_set',
        'thursday_bundle',
        'semantic_check',
        'escalation',
        'adult_summary',
      ].sort(),
    );
  });

  it('allows the original request within limits', () => {
    expect(
      canAttempt(LIMITS, { attemptsSoFar: 0, spentMicrosSoFar: 0, nextEstimateMicros: 22_400 }),
    ).toEqual({ allow: true });
  });

  it('denies once the original request plus retries reach the attempt limit', () => {
    expect(
      canAttempt(LIMITS, { attemptsSoFar: 3, spentMicrosSoFar: 0, nextEstimateMicros: 1 }),
    ).toEqual({ allow: false, deny: 'MAX_ATTEMPTS' });
  });

  it('counts failed but billed attempts toward the stage cost cap', () => {
    // Two failed Terra extractions were billed 22,400 micros each; a third would exceed 60,000.
    expect(
      canAttempt(LIMITS, {
        attemptsSoFar: 2,
        spentMicrosSoFar: 44_800,
        nextEstimateMicros: 22_400,
      }),
    ).toEqual({ allow: false, deny: 'STAGE_COST_CAP' });
  });

  it('allows spending exactly up to the stage cap', () => {
    expect(
      canAttempt(LIMITS, {
        attemptsSoFar: 2,
        spentMicrosSoFar: 40_000,
        nextEstimateMicros: 20_000,
      }),
    ).toEqual({ allow: true });
  });

  it('property: an allowed attempt never takes attempts or spend past the stage limits', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10 }),
        fc.nat({ max: 200_000 }),
        fc.nat({ max: 200_000 }),
        (attemptsSoFar, spentMicrosSoFar, nextEstimateMicros) => {
          const decision = canAttempt(LIMITS, {
            attemptsSoFar,
            spentMicrosSoFar,
            nextEstimateMicros,
          });
          if (!decision.allow) return true;
          return (
            attemptsSoFar + 1 <= LIMITS.maxAttempts &&
            spentMicrosSoFar + nextEstimateMicros <= LIMITS.maxCostMicros
          );
        },
      ),
    );
  });

  it.each([
    { attemptsSoFar: -1, spentMicrosSoFar: 0, nextEstimateMicros: 0 },
    { attemptsSoFar: 0, spentMicrosSoFar: Number.NaN, nextEstimateMicros: 0 },
    { attemptsSoFar: 0, spentMicrosSoFar: 0, nextEstimateMicros: 1.5 },
  ])('fails closed (throws) on corrupt counters %j instead of allowing', (usage) => {
    expect(() => canAttempt(LIMITS, usage)).toThrow(RangeError);
  });
});

describe('stage limit tables', () => {
  function table(overrides: Partial<Record<AiStage, StageLimits>> = {}) {
    const all = Object.fromEntries(AI_STAGES.map((s) => [s, LIMITS])) as Record<
      AiStage,
      StageLimits
    >;
    return { ...all, ...overrides };
  }

  it('accepts a complete table with positive integer limits', () => {
    const defined = defineStageLimits(table());
    expect(defined.extraction).toEqual(LIMITS);
    expect(Object.isFrozen(defined)).toBe(true);
  });

  it('rejects a table that leaves a stage without limits', () => {
    const partial: Record<string, StageLimits> = table();
    delete partial['escalation'];
    expect(() => defineStageLimits(partial as Record<AiStage, StageLimits>)).toThrow(RangeError);
  });

  it.each([
    { maxAttempts: 0 },
    { timeoutMs: 0 },
    { maxOutputTokens: -5 },
    { maxCostMicros: Number.NaN },
    { maxCostMicros: 1.5 },
  ])('rejects non-positive or fractional limits %j', (bad) => {
    expect(() => defineStageLimits(table({ grading: { ...LIMITS, ...bad } }))).toThrow(RangeError);
  });
});
