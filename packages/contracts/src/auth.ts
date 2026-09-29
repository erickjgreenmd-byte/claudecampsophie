import { z } from 'zod';
import { freeTextSchema, isoDateTimeSchema, uuidSchema } from './common.ts';

/** Six-digit parent PIN. The raw PIN is only ever sent over TLS to the API and never stored. */
export const parentPinSchema = z.string().regex(/^\d{6}$/, 'PIN must be 6 digits');

export const setParentPinRequestSchema = z.strictObject({ pin: parentPinSchema });

export const adultUnlockRequestSchema = z.strictObject({
  method: z.enum(['pin']),
  pin: parentPinSchema,
});

export const adultUnlockResponseSchema = z.strictObject({
  unlockedUntil: isoDateTimeSchema,
  /**
   * How long the window lasts, in seconds (MOB-R2-03). `unlockedUntil` is a database instant, so a
   * client whose own clock is ahead of the server's sees the window as already over and bounces the
   * parent straight back to the PIN screen. A client measures the window from its own clock with
   * this value instead. Required: an API that silently stopped sending it would put the mobile client
   * back on the server instant with no contract failure to catch it (the round-3 checker's residual).
   */
  unlockSeconds: z.number().int().positive(),
});

export const createPairingCodeResponseSchema = z.strictObject({
  /** Shown once to the parent (and as a QR). Stored only as a hash. */
  code: z.string(),
  expiresAt: isoDateTimeSchema,
});

export const childPairRequestSchema = z.strictObject({
  code: z.string().min(6).max(20),
  deviceLabel: freeTextSchema({ max: 60, trim: false }),
  platform: z.enum(['ios', 'android', 'web']),
});

export const childTokenResponseSchema = z.strictObject({
  accessToken: z.string(),
  accessTokenExpiresAt: isoDateTimeSchema,
  /**
   * The access token's lifetime in seconds (MOB-R2-02). `accessTokenExpiresAt` is a server instant;
   * a tablet with a wrong clock that compares it with its own clock either presents a token the
   * server has already rejected or refreshes on every call. The device measures expiry as its own
   * clock at receipt plus this lifetime.
   */
  accessTokenExpiresInSeconds: z.number().int().positive(),
  refreshToken: z.string(),
  child: z.strictObject({ id: uuidSchema, nickname: z.string() }),
});

/**
 * The device presents its stored refresh token and nothing else. Strict, so an extra field is a 400
 * rather than an ignored one, which is the point: BUG-244's recovery id — one id per refresh, kept by
 * the device across its own retries, matched against the id that consumed the token — was REMOVED in
 * round 6 (HUNT6-A-1) and must not come back by accident. Nothing marked the row a recovery had
 * served, so a captured request body was served again and again for the whole window, and every
 * serving handed back a full-lifetime rotating refresh token: the window bounded when a replay could
 * start, not how long it lasted, and a body read out of a log bought a child's session until the
 * tablet's own next refresh.
 *
 * So BUG-244 is an accepted, documented open defect again: a refresh response lost on the way back
 * unpairs the tablet, and the parent mints a new pairing code. Reuse of a rotated token is theft with
 * no exception (apps/api/src/routes/child-auth.ts, tests/auth.test.ts > 'refresh tokens rotate and
 * reuse revokes the session').
 */
export const childRefreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(20).max(200),
});

/** POST /v1/adult/pin/reset — only right after an account re-authentication (spec P3 recovery). */
export const pinResetRequestSchema = setParentPinRequestSchema;
export const okResponseSchema = z.strictObject({ ok: z.literal(true) });
