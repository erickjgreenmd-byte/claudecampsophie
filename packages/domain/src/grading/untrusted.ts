/**
 * Guards for answer keys and capture metadata that arrive from extraction models (spec P5: "Keep
 * source text and AI output as untrusted data"). Strict structured outputs model every optional
 * field as nullable (packages/ai/src/schemas.ts), so `null` and `undefined` both mean "not given";
 * any other unexpected type is a malformed key, which the checkers report as data, never a crash.
 */

export function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

/** True for a string or an object with Symbol.iterator (arrays, sets). */
export function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === 'string' ||
    (typeof value === 'object' && value !== null && Symbol.iterator in value)
  );
}

/** A list of strings, or null when the value is anything else. */
export function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const list: readonly unknown[] = value;
  return list.every((item): item is string => typeof item === 'string') ? list : null;
}
