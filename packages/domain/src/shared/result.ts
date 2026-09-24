/** Expected business failures are values, not exceptions (docs/Architecture.md §2). */
export interface DomainError<C extends string = string> {
  readonly code: C;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type Result<T, C extends string = string> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError<C> };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<C extends string>(
  code: C,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): { readonly ok: false; readonly error: DomainError<C> } {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

/** Exhaustiveness helper for discriminated unions. */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
