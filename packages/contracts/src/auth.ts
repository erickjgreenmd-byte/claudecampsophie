import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from './common.ts';

/** Six-digit parent PIN. The raw PIN is only ever sent over TLS to the API and never stored. */
export const parentPinSchema = z.string().regex(/^\d{6}$/, 'PIN must be 6 digits');

export const setParentPinRequestSchema = z.strictObject({ pin: parentPinSchema });

export const adultUnlockRequestSchema = z.strictObject({
  method: z.enum(['pin']),
  pin: parentPinSchema,
});

export const adultUnlockResponseSchema = z.strictObject({
  unlockedUntil: isoDateTimeSchema,
});

export const createPairingCodeResponseSchema = z.strictObject({
  /** Shown once to the parent (and as a QR). Stored only as a hash. */
  code: z.string(),
  expiresAt: isoDateTimeSchema,
});

export const childPairRequestSchema = z.strictObject({
  code: z.string().min(6).max(20),
  deviceLabel: z.string().min(1).max(60),
  platform: z.enum(['ios', 'android', 'web']),
});

export const childTokenResponseSchema = z.strictObject({
  accessToken: z.string(),
  accessTokenExpiresAt: isoDateTimeSchema,
  refreshToken: z.string(),
  child: z.strictObject({ id: uuidSchema, nickname: z.string() }),
});

export const childRefreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(20).max(200),
});
