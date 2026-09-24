// Validation and unambiguous encoding of identifiers that go into idempotency keys.

export const MAX_KEY_COMPONENT_LENGTH = 128;

/** C0/C1 control characters or a lone (unpaired) UTF-16 surrogate. */
function hasUnsafeCodeUnit(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Non-blank, bounded, no control characters and well-formed UTF-16 (safe to percent-encode). */
export function isValidKeyComponent(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_KEY_COMPONENT_LENGTH &&
    !hasUnsafeCodeUnit(value)
  );
}

/** Subjects are parent/configuration data: same rules as any key component. */
export const isValidSubject = isValidKeyComponent;

/**
 * Percent-encodes a validated component so `:` can separate components without ambiguity
 * (`encodeURIComponent` escapes `:` and `%`), making composite keys injective.
 */
export function encodeKeyComponent(value: string, what: string): string {
  if (!isValidKeyComponent(value)) throw new RangeError(`Invalid ${what} for an idempotency key`);
  return encodeURIComponent(value);
}
