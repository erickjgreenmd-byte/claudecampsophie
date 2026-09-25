import { z } from 'zod';

export const uuidSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const calendarMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');
export const calendarDateSchema = z.iso.date();
/** Client-generated idempotency key (UUID or similar high-entropy token). */
export const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
/**
 * Billing channel: the two phone stores, optional Stripe web billing and the Amazon Appstore
 * (Fire tablets; RevenueCat names that store `AMAZON`).
 */
export const channelSchema = z.enum(['app_store', 'play_store', 'stripe', 'amazon_appstore']);
export const centsSchema = z.number().int().min(0).max(10_000_000);
export const ianaZoneSchema = z.string().min(1).max(64);

/**
 * True when `text` holds a control character other than tab, line feed or carriage return
 * (U+0000 included). Postgres cannot store U+0000 in a text column at all (SQLSTATE 22021), and
 * the other controls have no place in anything a family or staff member reads.
 */
export function textHasControlCharacter(text: string): boolean {
  return /\p{Cc}/u.test(text.replace(/[\t\n\r]/g, ''));
}

export const CONTROL_CHARACTER_MESSAGE = 'Remove the hidden control characters';

/**
 * Free text a person typed (a name, a note, a message, a label): length-bounded, trimmed unless
 * `trim: false`, and free of control characters (API-AUTH-R1-01: every free-text request field
 * refuses them here so unstorable text never reaches the database and answers a 400).
 */
export function freeTextSchema(options: {
  readonly max: number;
  readonly min?: number;
  readonly trim?: boolean;
}): z.ZodString {
  const base = options.trim === false ? z.string() : z.string().trim();
  return base
    .min(options.min ?? 1)
    .max(options.max)
    .refine((text) => !textHasControlCharacter(text), CONTROL_CHARACTER_MESSAGE);
}
