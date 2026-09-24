import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  resolveGrading,
  type ModelVerdict,
  type ResolveGradingInput,
} from './index.ts';

const judged = (verdict: ModelVerdict, confidence = 0.9) => ({ verdict, confidence });

function resolve(input: ResolveGradingInput) {
  const { final, route, disagreement } = resolveGrading(input);
  return { final, route, disagreement };
}

describe('P5 verification: deterministic evidence is authoritative (AC_GRADING_04)', () => {
  it('a model disagreeing with a deterministic "correct" is flagged but cannot override it', () => {
    expect(
      resolve({
        deterministic: 'correct',
        primary: judged('incorrect', 0.99),
        verifier: judged('incorrect', 1),
        escalationBudgetRemaining: 2,
      }),
    ).toEqual({ final: 'correct', route: 'deterministic', disagreement: true });
  });

  it('high model confidence never overrides a deterministic "incorrect"', () => {
    expect(
      resolve({
        deterministic: 'incorrect',
        primary: judged('correct', 1),
        verifier: judged('correct', 1),
        escalation: { verdict: 'correct' },
        escalationBudgetRemaining: 5,
      }),
    ).toEqual({ final: 'incorrect', route: 'deterministic', disagreement: true });
  });

  it('agreeing models with a deterministic result raise no flag', () => {
    expect(
      resolve({
        deterministic: 'correct',
        primary: judged('correct'),
        escalationBudgetRemaining: 0,
      }),
    ).toEqual({ final: 'correct', route: 'deterministic', disagreement: false });
  });

  it('an abstaining model is not a disagreement', () => {
    expect(
      resolve({
        deterministic: 'incorrect',
        primary: judged('unresolved'),
        escalationBudgetRemaining: 0,
      }),
    ).toEqual({ final: 'incorrect', route: 'deterministic', disagreement: false });
  });
});

describe('P5 verification: model agreement and escalation (AC_GRADING_04)', () => {
  it('a deterministic "unresolved" falls through to independent model agreement', () => {
    expect(
      resolve({
        deterministic: 'unresolved',
        primary: judged('correct', 0.9),
        verifier: judged('correct', 0.8),
        escalationBudgetRemaining: 1,
      }),
    ).toEqual({ final: 'correct', route: 'agreement', disagreement: false });
  });

  it('two independent confident "incorrect" judgments are accepted', () => {
    expect(
      resolve({
        primary: judged('incorrect', 0.9),
        verifier: judged('incorrect', 0.7),
        escalationBudgetRemaining: 0,
      }),
    ).toEqual({ final: 'incorrect', route: 'agreement', disagreement: false });
  });

  it('primary/verifier disagreement requests escalation while budget remains', () => {
    const result = resolveGrading({
      primary: judged('correct', 0.99),
      verifier: judged('incorrect', 0.6),
      escalationBudgetRemaining: 1,
    });
    expect(result).toEqual({
      final: 'unresolved',
      route: 'escalated',
      disagreement: true,
      awaitingEscalation: true,
    });
  });

  it('primary/verifier disagreement with no budget goes to parent review, never "incorrect"', () => {
    expect(
      resolve({
        primary: judged('correct', 0.99),
        verifier: judged('incorrect', 0.99),
        escalationBudgetRemaining: 0,
      }),
    ).toEqual({ final: 'needs_parent_review', route: 'parent_review', disagreement: true });
  });

  it('a stronger model that corroborates one side settles the disagreement', () => {
    expect(
      resolve({
        primary: judged('correct', 0.6),
        verifier: judged('incorrect', 0.99),
        escalation: { verdict: 'correct' },
        escalationBudgetRemaining: 0,
      }),
    ).toEqual({ final: 'correct', route: 'escalated', disagreement: true });
  });

  it('an escalation that abstains goes to parent review', () => {
    expect(
      resolve({
        primary: judged('correct'),
        verifier: judged('incorrect'),
        escalation: { verdict: 'unresolved' },
        escalationBudgetRemaining: 3,
      }),
    ).toEqual({ final: 'needs_parent_review', route: 'parent_review', disagreement: true });
  });

  it('an escalation contradicting two agreeing (low-confidence) models goes to parent review', () => {
    expect(
      resolve({
        primary: judged('correct', 0.2),
        verifier: judged('correct', 0.2),
        escalation: { verdict: 'incorrect' },
        escalationBudgetRemaining: 0,
      }),
    ).toEqual({ final: 'needs_parent_review', route: 'parent_review', disagreement: true });
  });

  it('an unverified primary judgment is never accepted on its own', () => {
    expect(resolve({ primary: judged('incorrect', 1), escalationBudgetRemaining: 3 })).toEqual({
      final: 'needs_parent_review',
      route: 'parent_review',
      disagreement: false,
    });
  });

  it('low-confidence agreement on "incorrect" is not silently accepted', () => {
    expect(
      resolve({
        primary: judged('incorrect', 0.3),
        verifier: judged('incorrect', 0.3),
        escalationBudgetRemaining: 0,
      }),
    ).toEqual({ final: 'needs_parent_review', route: 'parent_review', disagreement: false });
  });

  it('one model abstaining leaves the item unsettled (escalate, else parent review)', () => {
    expect(
      resolve({
        primary: judged('incorrect', 0.95),
        verifier: judged('unresolved', 0.9),
        escalationBudgetRemaining: 0,
      }),
    ).toEqual({ final: 'needs_parent_review', route: 'parent_review', disagreement: false });
    expect(
      resolve({
        primary: judged('incorrect', 0.95),
        verifier: judged('unresolved', 0.9),
        escalationBudgetRemaining: 1,
      }).route,
    ).toBe('escalated');
  });

  it('when every judge abstains the item stays unresolved for a grown-up, with no paid escalation', () => {
    expect(
      resolve({
        deterministic: 'unresolved',
        primary: judged('unresolved'),
        verifier: judged('unresolved'),
        escalationBudgetRemaining: 5,
      }),
    ).toEqual({ final: 'unresolved', route: 'parent_review', disagreement: false });
  });

  it('non-finite or out-of-range confidence from a model is treated as low confidence', () => {
    for (const confidence of [Number.NaN, -1, 2, Number.POSITIVE_INFINITY]) {
      expect(
        resolve({
          primary: judged('correct', confidence),
          verifier: judged('correct', 0.9),
          escalationBudgetRemaining: 0,
        }).final,
      ).toBe('needs_parent_review');
    }
  });

  it('uses a documented default low-confidence threshold that callers may raise', () => {
    expect(DEFAULT_LOW_CONFIDENCE_THRESHOLD).toBe(0.5);
    expect(
      resolve({
        primary: judged('correct', 0.8),
        verifier: judged('correct', 0.8),
        escalationBudgetRemaining: 0,
        lowConfidenceThreshold: 0.9,
      }).final,
    ).toBe('needs_parent_review');
  });
});

describe('P5 verification: properties', () => {
  const verdict = fc.constantFrom<ModelVerdict>('correct', 'incorrect', 'unresolved');
  const confidence = fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant(Number.NaN));
  const judgment = fc.record({ verdict, confidence });
  const input = fc.record(
    {
      deterministic: fc.constantFrom<'correct' | 'incorrect' | 'unresolved'>(
        'correct',
        'incorrect',
        'unresolved',
      ),
      primary: judgment,
      verifier: judgment,
      escalation: fc.record({ verdict }),
      escalationBudgetRemaining: fc.integer({ min: -2, max: 3 }),
    },
    { requiredKeys: ['primary', 'escalationBudgetRemaining'] },
  );

  it('confidence never overrides decisive deterministic evidence', () => {
    fc.assert(
      fc.property(input, (i) => {
        const result = resolveGrading(i);
        if (i.deterministic === 'correct' || i.deterministic === 'incorrect') {
          expect(result.final).toBe(i.deterministic);
          expect(result.route).toBe('deterministic');
        }
      }),
    );
  });

  it('uncertainty never silently becomes "incorrect" (needs deterministic or two corroborating judges)', () => {
    fc.assert(
      fc.property(input, (i) => {
        const result = resolveGrading(i);
        if (result.final !== 'incorrect' || i.deterministic === 'incorrect') return;
        const incorrectVotes = [i.primary, i.verifier, i.escalation].filter(
          (j) => j?.verdict === 'incorrect',
        ).length;
        expect(incorrectVotes).toBeGreaterThanOrEqual(2);
      }),
    );
  });

  it('a decisive disagreement is always flagged', () => {
    fc.assert(
      fc.property(input, (i) => {
        const votes = [
          i.deterministic,
          i.primary.verdict,
          i.verifier?.verdict,
          i.escalation?.verdict,
        ];
        const conflict = votes.includes('correct') && votes.includes('incorrect');
        expect(resolveGrading(i).disagreement).toBe(conflict);
      }),
    );
  });

  it('with no budget and no escalation result, nothing is routed to escalation', () => {
    fc.assert(
      fc.property(input, (i) => {
        const { escalation: _omitted, ...rest } = i;
        const result = resolveGrading({ ...rest, escalationBudgetRemaining: 0 });
        expect(result.route).not.toBe('escalated');
        expect(result.awaitingEscalation).toBe(false);
      }),
    );
  });
});
