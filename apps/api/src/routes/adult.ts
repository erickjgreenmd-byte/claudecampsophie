import { Hono } from 'hono';
import { adultUnlockRequestSchema, setParentPinRequestSchema } from '@pencillift/contracts';
import { readJson } from '../app.ts';
import { ApiError } from '../errors.ts';
import { assertRecentUnlock, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, RATE_RULES } from '../middleware/rate-limit.ts';
import {
  hashPin,
  isWeakPin,
  PIN_LOCKOUT_SECONDS,
  PIN_MAX_FAILURES,
  verifyPin,
} from '../security/pin.ts';

/** A PIN reset must follow an account re-authentication within this window. */
export const PIN_RESET_REAUTH_SECONDS = 10 * 60;

/** Adult step-up (spec P3): PIN set/change/reset, unlock with lockout, and explicit relock. */
export function adultRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireParent);

  r.put('/pin', async (c) => {
    const { deps, parent } = c.var;
    const { pin } = await readJson(c, setParentPinRequestSchema);
    if (isWeakPin(pin)) throw new ApiError('VALIDATION_FAILED', 'Choose a less predictable PIN');
    const existing = await deps.db.asService(
      (tx) =>
        tx<
          { user_id: string }[]
        >`select user_id from private.parent_pins where user_id = ${parent.userId}`,
    );
    // Changing an existing PIN needs the current step-up; first-time setup only needs the session.
    if (existing.length > 0) await assertRecentUnlock(c);
    const hash = await hashPin(pin, deps.config.hashPepper);
    await deps.db.asService(async (tx) => {
      await tx`
        insert into private.parent_pins (user_id, pin_hash) values (${parent.userId}, ${hash})
        on conflict (user_id) do update set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now()
      `;
      await tx`
        insert into public.audit_events (actor_user_id, actor_kind, action, target_type, target_id)
        values (${parent.userId}, 'parent', ${existing.length > 0 ? 'pin.changed' : 'pin.set'}, 'user', ${parent.userId})
      `;
    });
    return c.json({ ok: true });
  });

  // Verified recovery (spec P3: reset only through verified parent recovery): a forgotten PIN is
  // replaced only right after the adult re-proves account ownership with Supabase Auth (password,
  // email OTP/magic link or recovery link). A PIN, the device or an old session cannot do it.
  r.post('/pin/reset', async (c) => {
    const { deps, parent } = c.var;
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      `pin-reset:${parent.userId}`,
      RATE_RULES.pinResetPerUser,
      now,
    );
    const authAt = parent.authenticatedAt?.getTime();
    if (
      authAt === undefined ||
      authAt > now.getTime() + 60_000 ||
      now.getTime() - authAt > PIN_RESET_REAUTH_SECONDS * 1000
    ) {
      throw new ApiError('BUSINESS_RULE', 'Sign in again with your account to reset your PIN', {
        rule: 'REAUTHENTICATION_REQUIRED',
      });
    }
    const { pin } = await readJson(c, setParentPinRequestSchema);
    if (isWeakPin(pin)) throw new ApiError('VALIDATION_FAILED', 'Choose a less predictable PIN');
    const hash = await hashPin(pin, deps.config.hashPepper);
    await deps.db.asService(async (tx) => {
      await tx`
        insert into private.parent_pins (user_id, pin_hash) values (${parent.userId}, ${hash})
        on conflict (user_id) do update set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now()
      `;
      // Existing unlocks from any session end: the new PIN must be used from here on.
      await tx`update private.adult_unlocks set revoked_at = now() where user_id = ${parent.userId} and revoked_at is null`;
      await tx`
        insert into public.audit_events (actor_user_id, actor_kind, action, target_type, target_id)
        values (${parent.userId}, 'parent', 'pin.reset', 'user', ${parent.userId})
      `;
    });
    return c.json({ ok: true });
  });

  r.post('/unlock', async (c) => {
    const { deps, parent } = c.var;
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      `pin:${parent.sessionId}`,
      RATE_RULES.pinAttemptPerSession,
      now,
    );
    const { pin } = await readJson(c, adultUnlockRequestSchema);
    const [record] = await deps.db.asService(
      (tx) => tx<{ pin_hash: string; failed_attempts: number; locked_until: Date | null }[]>`
        select pin_hash, failed_attempts, locked_until from private.parent_pins where user_id = ${parent.userId}
      `,
    );
    if (!record) throw new ApiError('NOT_FOUND', 'Set a parent PIN first');
    if (record.locked_until && record.locked_until > now) {
      throw new ApiError(
        'LOCKED_OUT',
        'Too many incorrect PINs. Try again later or reset your PIN.',
        {
          retryAfterSeconds: Math.ceil((record.locked_until.getTime() - now.getTime()) / 1000),
        },
      );
    }
    const valid = await verifyPin(pin, record.pin_hash, deps.config.hashPepper);
    if (!valid) {
      const failures = record.failed_attempts + 1;
      const lock =
        failures >= PIN_MAX_FAILURES ? new Date(now.getTime() + PIN_LOCKOUT_SECONDS * 1000) : null;
      await deps.db.asService(
        (tx) => tx`
          update private.parent_pins
             set failed_attempts = ${lock ? 0 : failures}, locked_until = ${lock}, updated_at = now()
           where user_id = ${parent.userId}
        `,
      );
      throw new ApiError(
        lock ? 'LOCKED_OUT' : 'FORBIDDEN',
        lock ? 'Too many incorrect PINs. Try again later.' : 'Incorrect PIN',
      );
    }
    const unlockedUntil = new Date(now.getTime() + deps.config.adultUnlockTtlSeconds * 1000);
    await deps.db.asService(async (tx) => {
      await tx`update private.parent_pins set failed_attempts = 0, locked_until = null, updated_at = now() where user_id = ${parent.userId}`;
      await tx`
        insert into private.adult_unlocks (user_id, auth_session_id, method, created_at, expires_at)
        values (${parent.userId}, ${parent.sessionId}, 'pin', ${now}, ${unlockedUntil})
      `;
    });
    return c.json({ unlockedUntil: unlockedUntil.toISOString() });
  });

  // Switching to child mode: server-side relock so a shared device keeps no usable adult step-up.
  r.post('/lock', async (c) => {
    const { deps, parent } = c.var;
    await deps.db.asService(
      (tx) => tx`
        update private.adult_unlocks set revoked_at = now()
         where user_id = ${parent.userId} and auth_session_id = ${parent.sessionId} and revoked_at is null
      `,
    );
    return c.json({ ok: true });
  });

  return r;
}
