// Identifier validation and idempotency-key construction for the points ledger.

/**
 * Decision: identifiers embedded in idempotency keys (child, question instance, set, request,
 * adjustment, reward) must be 1–128 characters of `[A-Za-z0-9._-]`, starting alphanumeric. UUIDs
 * fit. Excluding `:` keeps every key unambiguous (`attempt:<id>` can never collide with another
 * key family or with another id), and untrusted ids cannot smuggle whitespace or control text into
 * keys and logs.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

/** Awarded at most once per question instance: the effort award for the first meaningful attempt. */
export function attemptKey(questionInstanceId: string): string {
  return `attempt:${questionInstanceId}`;
}

/** Awarded at most once per question instance: the independent-correctness bonus. */
export function independentKey(questionInstanceId: string): string {
  return `independent:${questionInstanceId}`;
}

/** Awarded at most once per set. */
export function setKey(setId: string): string {
  return `set:${setId}`;
}

/** The single reserve (debit) of a redemption request. */
export function reserveKey(requestId: string): string {
  return `redeem:${requestId}:reserve`;
}

/** The single release (refund) of a declined or cancelled redemption request. */
export function releaseKey(requestId: string): string {
  return `redeem:${requestId}:release`;
}

/** A parent adjustment, keyed by its client-generated id so a retried submit cannot apply twice. */
export function adjustmentKey(adjustmentId: string): string {
  return `adjust:${adjustmentId}`;
}
