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
