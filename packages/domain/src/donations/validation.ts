// Input guards for the donations module. Violations are programmer errors (malformed normalized
// facts or bypassed database constraints), so these throw instead of returning a Result.
import { assertCents, type Cents } from '../shared/money.ts';

/** 1..128 characters, no whitespace or control characters (UUIDs, provider ids, `fam_…`). */
const ID_RE = /^[^\s\p{Cc}]{1,128}$/u;

export function isWellFormedId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export function assertId(value: string, label: string): string {
  if (!isWellFormedId(value)) {
    throw new RangeError(
      `${label} must be 1-128 characters without whitespace or control characters`,
    );
  }
  return value;
}

export function assertInstant(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date`);
  }
  return value;
}

export function assertNonNegativeCents(value: number, label: string): Cents {
  assertCents(value, label);
  if (value < 0) throw new RangeError(`${label} must not be negative, received ${value}`);
  return value;
}
