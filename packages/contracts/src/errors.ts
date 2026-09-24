import { z } from 'zod';

/**
 * Stable API error codes (docs/Architecture.md §2). Clients branch on `code`, never on message text.
 * Messages are safe to show to an adult; child-facing screens map codes to calm, generic copy.
 */
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'STEP_UP_REQUIRED',
  'CHILD_MODE_FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'LOCKED_OUT',
  'PAYLOAD_TOO_LARGE',
  'PROVIDER_UNAVAILABLE',
  'NOT_CONFIGURED',
  'BLOCKED_EXTERNAL',
  'BUSINESS_RULE',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    /** Domain rule code (e.g. FAMILY_ALREADY_REDEEMED_CAMPAIGN) when code = BUSINESS_RULE. */
    rule: z.string().max(80).optional(),
    message: z.string().max(500),
    requestId: z.string().max(80),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** HTTP status for each API error code. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  STEP_UP_REQUIRED: 403,
  CHILD_MODE_FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  LOCKED_OUT: 423,
  PAYLOAD_TOO_LARGE: 413,
  PROVIDER_UNAVAILABLE: 503,
  NOT_CONFIGURED: 503,
  BLOCKED_EXTERNAL: 503,
  BUSINESS_RULE: 422,
  INTERNAL: 500,
};
