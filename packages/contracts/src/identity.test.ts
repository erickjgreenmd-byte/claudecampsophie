import { describe, expect, it } from 'vitest';
import {
  ADULT_MIN_AGE_YEARS,
  IDENTITY_ATTESTATION_STATEMENT,
  IDENTITY_ATTESTATION_VERSION,
  IDENTITY_BASIS_COPY,
  IDENTITY_FAILURE_CODES,
  IDENTITY_FAILURE_FALLBACK,
  IDENTITY_REQUIREMENT_COPY,
  identityFailureCopy,
  identityFailureIsOurs,
  clearIdentityProblem,
  identityOutcome,
  identityRetryWorthwhile,
  type IdentityVerificationStatus,
} from './identity.ts';

/**
 * THE HONESTY PROPERTIES, asserted here rather than on either screen.
 *
 * Both surfaces already show that a declared basis is not called verified — and BOTH did so by
 * reading `IDENTITY_BASIS_COPY.declared.detail` and asserting the rendered text equals it. That
 * assertion passes no matter what the sentence says: rewrite the constant to "your ID is verified"
 * and the screens print the new words while their suites stay green, because the expected value
 * moved with the actual (L-067). The web suite lost the whole claim that way; the phone kept it only
 * because one unrelated case happened to grep the printed output for "selfie".
 *
 * So the substance lives here, in one place, stated against the WORDS rather than against the
 * identifier holding them. A surface test's job is then only to prove it prints the right key.
 */
const DECLARED = IDENTITY_BASIS_COPY.declared;
const VERIFIED = IDENTITY_BASIS_COPY.verified;
const UNSTATED = IDENTITY_BASIS_COPY.unstated;

describe('a declaration is never worded as a check', () => {
  it('the declared basis claims no verification and no comparison', () => {
    const printed = `${DECLARED.headline} ${DECLARED.detail}`;
    // The single word the whole two-standard design exists to keep off this branch.
    expect(printed).not.toMatch(/\bverif(y|ied|ication)\b/i);
    // Nor any of the ways a comparison could be implied without that word.
    expect(printed).not.toMatch(/face check|matched|compared your photo|confirmed it is yours/i);
  });

  it('the declared basis says out loud what DID tie the ID to the person, and what did not', () => {
    // Not enough to omit the false claim: a parent reading this has to be able to tell that the
    // binding is their own statement. Omission alone would read as verification by default.
    expect(DECLARED.detail).toMatch(/declar/i);
    expect(DECLARED.detail).toMatch(/nothing compared/i);
  });

  it('only the verified basis may mention a face check at all', () => {
    expect(VERIFIED.detail).toMatch(/face check/i);
    for (const [key, copy] of Object.entries(IDENTITY_BASIS_COPY)) {
      if (key === 'verified') continue;
      expect(`${copy.headline} ${copy.detail}`, key).not.toMatch(/face check/i);
    }
  });

  it('the unstated basis guesses at neither standard', () => {
    const printed = `${UNSTATED.headline} ${UNSTATED.detail}`;
    expect(printed).not.toMatch(/\bverif(y|ied|ication)\b/i);
    expect(printed).not.toMatch(/declar/i);
  });

  it('no two bases read the same, so the basis is always legible from the words', () => {
    const headlines = Object.values(IDENTITY_BASIS_COPY).map((c) => c.headline);
    const details = Object.values(IDENTITY_BASIS_COPY).map((c) => c.detail);
    expect(new Set(headlines).size).toBe(headlines.length);
    expect(new Set(details).size).toBe(details.length);
  });

  it('every basis says the adult may now add children, since that is what it gates', () => {
    for (const [key, copy] of Object.entries(IDENTITY_BASIS_COPY)) {
      expect(copy.detail, key).toMatch(/add your children/i);
    }
  });
});

/** A refusal as the route really returns it, so the outcome is read through the real row shape. */
function refusedStatus(code: (typeof IDENTITY_FAILURE_CODES)[number]): IdentityVerificationStatus {
  return status({
    confirmed: false,
    basis: null,
    latest: {
      id: '00000000-0000-4000-8000-000000000001',
      checkedAt: '2026-09-30T12:00:00.000Z',
      provider: 'development_mock',
      documentIsGovernmentId: false,
      documentHolderIsAdult: false,
      faceMatch: 'not_attempted',
      holderAttestationVersion: null,
      failureCode: code,
      isTestProvider: true,
    },
  });
}

function status(over: Partial<IdentityVerificationStatus> = {}): IdentityVerificationStatus {
  return {
    confirmed: false,
    basis: null,
    latest: null,
    attestationVersionRequired: IDENTITY_ATTESTATION_VERSION,
    faceCheckAvailable: false,
    ...over,
  };
}

/**
 * The two bases the SERVER can state, which is not the same set as the copy table's keys: 'unstated'
 * exists only as `identityOutcome`'s fall-through for `basis: null`, and the status schema cannot
 * carry it. That asymmetry is the reason the fall-through has its own case below rather than riding
 * this loop — writing the loop over `Object.keys(IDENTITY_BASIS_COPY)` does not compile, and the
 * compiler saying so is the evidence that 'unstated' is reachable one way only.
 */
const STATED_BASES = ['verified', 'declared'] as const;

describe('identityOutcome answers "on what evidence" from the BASIS, never from `confirmed`', () => {
  it('maps every basis the server can state to its own copy', () => {
    for (const key of STATED_BASES) {
      const outcome = identityOutcome(status({ confirmed: true, basis: key }));
      expect(outcome.state, key).toBe('established');
      if (outcome.state !== 'established') throw new Error('unreachable');
      expect(outcome.basis, key).toBe(key);
      expect(outcome.headline, key).toBe(IDENTITY_BASIS_COPY[key].headline);
      expect(outcome.detail, key).toBe(IDENTITY_BASIS_COPY[key].detail);
    }
  });

  it('the copy table holds a key for every stated basis and for the fall-through, and no more', () => {
    // If a third basis is added to the schema without copy, the loop above fails; if copy is added
    // without a basis, nothing would print it. This pins the set itself.
    expect(Object.keys(IDENTITY_BASIS_COPY).sort()).toEqual([...STATED_BASES, 'unstated'].sort());
  });

  /**
   * THE FALL-THROUGH, which is a real reachable state and not a defensive default: a family whose
   * adult was established before either table recorded a basis, and any row `adult_identity_basis`
   * cannot attribute. `confirmed` alone must never pick a standard — picking the stronger one would
   * print "a face check confirmed it is yours" about a check that never ran (L-057).
   */
  it('a confirmed adult with no stated basis is "unstated", not the stronger of the two', () => {
    const outcome = identityOutcome(status({ confirmed: true, basis: null }));
    expect(outcome.state).toBe('established');
    if (outcome.state !== 'established') throw new Error('unreachable');
    expect(outcome.basis).toBe('unstated');
    expect(outcome.headline).toBe(IDENTITY_BASIS_COPY.unstated.headline);
  });

  it('a stated basis establishes the adult even if `confirmed` has not caught up', () => {
    // The two fields come from different reads; a basis present is itself the stronger evidence.
    const outcome = identityOutcome(status({ confirmed: false, basis: 'declared' }));
    expect(outcome.state).toBe('established');
    if (outcome.state !== 'established') throw new Error('unreachable');
    expect(outcome.basis).toBe('declared');
  });

  it('nothing established and nothing attempted is not_started, so no refusal is invented', () => {
    expect(identityOutcome(status()).state).toBe('not_started');
  });
});

describe('a refusal never promises an action the screen withholds', () => {
  /**
   * The property that closes the `PROVIDER_ERROR` divergence for good. Its copy ends "Please try
   * again" while `retryOffered` was `!identityFailureIsOurs(code)` — false for it — so the screen
   * printed the instruction and removed the control in the same breath. This asserts the invariant
   * over the WHOLE table, including codes not written yet.
   */
  it('a code whose words say "try again" offers a retry, and vice versa', () => {
    for (const code of IDENTITY_FAILURE_CODES) {
      const copy = identityFailureCopy(code);
      const saysRetry =
        /try again|use one that is still in date|use the ID that belongs to you/i.test(copy);
      if (saysRetry) {
        expect(identityRetryWorthwhile(code), `${code} tells the parent to try again`).toBe(true);
      }
      if (!identityRetryWorthwhile(code)) {
        expect(copy, `${code} offers no retry, so it has to offer support`).toMatch(/support/i);
      }
    }
  });

  it('a refusal that is ours says so, and never blames the parent', () => {
    for (const code of IDENTITY_FAILURE_CODES) {
      if (!identityFailureIsOurs(code)) continue;
      expect(identityFailureCopy(code), code).toMatch(/on us|on our side|support/i);
    }
  });

  it('PROVIDER_ERROR is ours AND retryable, which is the whole point of two questions', () => {
    expect(identityFailureIsOurs('PROVIDER_ERROR')).toBe(true);
    expect(identityRetryWorthwhile('PROVIDER_ERROR')).toBe(true);
    expect(identityFailureIsOurs('PROVIDER_UNAVAILABLE')).toBe(true);
    expect(identityRetryWorthwhile('PROVIDER_UNAVAILABLE')).toBe(false);
  });

  /**
   * THE CALL SITE, not the helper. The cases above pass with `identityOutcome` still computing
   * `retryOffered` the old way — putting the rule in a named function is half the work and the call
   * site can still pass the wrong thing (L-071). Proved by mutation: reverting line 637 to
   * `!identityFailureIsOurs(failureCode)` reddened NOTHING until this case existed.
   *
   * So this asserts what a screen actually receives, for every code in the table, and states the
   * invariant in the form the parent experiences it: the words and the controls agree.
   */
  it('the OUTCOME a screen receives offers a retry exactly where the words promise one', () => {
    for (const code of IDENTITY_FAILURE_CODES) {
      const outcome = identityOutcome(refusedStatus(code));
      expect(outcome.state, code).toBe('refused');
      if (outcome.state !== 'refused') throw new Error('unreachable');
      expect(outcome.retryOffered, code).toBe(identityRetryWorthwhile(code));
      if (/try again/i.test(outcome.message)) {
        expect(outcome.retryOffered, `${code} says "try again"`).toBe(true);
      }
    }
  });

  it('PROVIDER_ERROR reaches a screen with both the instruction and the control', () => {
    // The defect this closes, stated as one parent's experience rather than as a table property.
    const outcome = identityOutcome(refusedStatus('PROVIDER_ERROR'));
    expect(outcome.state).toBe('refused');
    if (outcome.state !== 'refused') throw new Error('unreachable');
    expect(outcome.message).toMatch(/try again/i);
    expect(outcome.retryOffered).toBe(true);
  });

  it('a code no build knows gets the fallback and no retry, never the nearest guess', () => {
    expect(identityFailureCopy('A_CODE_THAT_DOES_NOT_EXIST')).toBe(IDENTITY_FAILURE_FALLBACK);
    expect(identityFailureCopy(null)).toBe(IDENTITY_FAILURE_FALLBACK);
    expect(identityRetryWorthwhile('A_CODE_THAT_DOES_NOT_EXIST')).toBe(false);
    expect(identityRetryWorthwhile(null)).toBe(false);
  });

  it('ATTESTATION_REQUIRED keeps the form, because reading the statement is the fix', () => {
    expect(identityFailureIsOurs('ATTESTATION_REQUIRED')).toBe(false);
    expect(identityRetryWorthwhile('ATTESTATION_REQUIRED')).toBe(true);
    const outcome = identityOutcome(refusedStatus('ATTESTATION_REQUIRED'));
    expect(outcome.state).toBe('refused');
    if (outcome.state !== 'refused') throw new Error('unreachable');
    expect(outcome.retryOffered).toBe(true);
  });
});

describe('the declaration the adult signs', () => {
  it('says all three things it has to, so the version stamped beside it means something', () => {
    // Who they are relative to the document, relative to the child, and that this carries legal
    // consequence. Drop any one and the statement stops doing the work the face check used to.
    expect(IDENTITY_ATTESTATION_STATEMENT).toMatch(/person shown on this document/i);
    expect(IDENTITY_ATTESTATION_STATEMENT).toMatch(/parent or legal guardian/i);
    expect(IDENTITY_ATTESTATION_STATEMENT).toMatch(/legal declaration/i);
    expect(IDENTITY_ATTESTATION_STATEMENT).toMatch(
      new RegExp(`at least ${ADULT_MIN_AGE_YEARS} years old`, 'i'),
    );
  });
});

/**
 * [BUG-417] THE STALE REASON. Both surfaces hand-rolled this filter and had already diverged: the
 * phone cleared the declaration's reason when the box was ticked, the portal did not, and NEITHER
 * cleared the date of birth's when it was retyped. A parent on the portal ticked the box and went
 * on reading "Please confirm the statement that you are the person on the ID" in red beside a ticked
 * box — a screen contradicting its own control one keystroke away (L-068).
 */
describe('[BUG-417] a corrected field stops being scolded, and only that field', () => {
  const ALL = [
    { field: 'document', message: IDENTITY_REQUIREMENT_COPY.document },
    { field: 'dateOfBirth', message: IDENTITY_REQUIREMENT_COPY.dateOfBirth },
    { field: 'declaration', message: IDENTITY_REQUIREMENT_COPY.declaration },
  ] as const;

  it('clears exactly the field that changed, for every field', () => {
    for (const { field } of ALL) {
      const left = clearIdentityProblem(ALL, field);
      expect(
        left.map((p) => p.field),
        field,
      ).toEqual(ALL.filter((p) => p.field !== field).map((p) => p.field));
    }
  });

  it('leaves the other two standing, so fixing one does not say everything is fine (L-059)', () => {
    // The opposite failure to the one above and just as bad: a parent who fixes one of three
    // requirements meets the same submit again with nothing on screen to explain it.
    expect(clearIdentityProblem(ALL, 'declaration')).toHaveLength(2);
    expect(clearIdentityProblem([], 'declaration')).toHaveLength(0);
  });

  it('is a no-op for a field that was never unmet', () => {
    const one = [{ field: 'document', message: IDENTITY_REQUIREMENT_COPY.document }] as const;
    expect(clearIdentityProblem(one, 'dateOfBirth')).toEqual(one);
  });
});
