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
