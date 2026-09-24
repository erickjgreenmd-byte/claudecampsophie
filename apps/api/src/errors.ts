import { API_ERROR_STATUS, type ApiErrorCode } from '@pencillift/contracts';

/** Expected API failure. The message must be safe for an adult to read; never include secrets. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly rule: string | undefined;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { rule?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.rule = options.rule;
    this.status = API_ERROR_STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Maps a domain Result error into a 422 BUSINESS_RULE with the domain's stable rule code. */
export function businessRule(rule: string, message: string): ApiError {
  return new ApiError('BUSINESS_RULE', message, { rule });
}

interface PgErrorLike {
  code?: string;
  constraint_name?: string;
  message?: string;
}

/** Postgres error helpers for expected constraint outcomes (never forward raw DB messages). */
export function pgErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as PgErrorLike).code : undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as PgErrorLike).constraint_name
    : undefined;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return (
    pgErrorCode(error) === '23505' &&
    (constraint === undefined || pgConstraint(error) === constraint)
  );
}

/**
 * Database invariants whose violation is an expected, explainable outcome on any route (the schema
 * is the guarantee; route code may not have checked first, e.g. under a race). Keyed by the
 * constraint/index name so an unrelated violation never gets a misleading message.
 */
const KNOWN_CONSTRAINTS: Readonly<Record<string, () => ApiError>> = {
  // 0720: one active family per adult (create_family, invitation acceptance, retries).
  family_memberships_one_active_family_per_user: () =>
    new ApiError('CONFLICT', 'You already have a family'),
  // 0720: families.timezone must be an IANA zone on every write path.
  families_timezone_iana: () => new ApiError('VALIDATION_FAILED', 'Invalid time zone'),
  // 0720: a pairing code is only issued for an active child (checked again under the row lock).
  child_pairing_codes_child_active: () =>
    businessRule('CHILD_NOT_ACTIVE', 'Assign a paid slot to this child before pairing a device'),
};

/** Maps a violation of a known schema invariant to its API error; undefined for anything else. */
export function knownConstraintError(error: unknown): ApiError | undefined {
  const code = pgErrorCode(error);
  if (code !== '23505' && code !== '23514') return undefined;
  const constraint = pgConstraint(error);
  const make = constraint === undefined ? undefined : KNOWN_CONSTRAINTS[constraint];
  return make?.();
}

/**
 * Lock contention the database resolved by aborting this transaction (deadlock, serialization
 * failure, lock timeout). Nothing was written; the same request can simply be retried.
 */
export function isTransientDbError(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === '40P01' || code === '40001' || code === '55P03';
}
