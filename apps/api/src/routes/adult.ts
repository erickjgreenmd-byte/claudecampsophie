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

type UnlockOutcome =
  | { readonly kind: 'no_pin' }
  | { readonly kind: 'locked'; readonly until: Date }
  | { readonly kind: 'wrong'; readonly lockedNow: boolean }
  | { readonly kind: 'unlocked'; readonly until: Date };

function lockedOut(until: Date, now: Date, message: string): ApiError {
  return new ApiError('LOCKED_OUT', message, {
    retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
  });
}

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
    const changing = existing.length > 0;
    if (changing) await assertRecentUnlock(c);
    await enforceRateLimit(
      deps.rateLimiter,
      `pin-set:${parent.userId}`,
      RATE_RULES.pinSetPerUser,
      deps.clock(),
    );
    const hash = await hashPin(pin, deps.config.hashPepper);
    await deps.db.asService(async (tx) => {
      await tx`
        insert into private.parent_pins (user_id, pin_hash) values (${parent.userId}, ${hash})
        on conflict (user_id) do update set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now()
      `;
      if (changing) {
        // Like a reset: unlocks other sessions obtained with the old PIN end now. This session
        // just proved the current PIN, so its own step-up stays.
        await tx`
          update private.adult_unlocks set revoked_at = now()
           where user_id = ${parent.userId} and auth_session_id <> ${parent.sessionId} and revoked_at is null
        `;
      }
      await tx`
        insert into public.audit_events (actor_user_id, actor_kind, action, target_type, target_id)
        values (${parent.userId}, 'parent', ${changing ? 'pin.changed' : 'pin.set'}, 'user', ${parent.userId})
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
    // Counted only for requests that would replace the PIN, so refused calls (a stale session on
    // a shared device, weak PINs) cannot use up the verified parent's recovery for the day.
    await enforceRateLimit(
      deps.rateLimiter,
      `pin-reset:${parent.userId}`,
      RATE_RULES.pinResetPerUser,
      now,
    );
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
    await enforceRateLimit(
      deps.rateLimiter,
      `pin-user:${parent.userId}`,
      RATE_RULES.pinAttemptPerUser,
      now,
    );
    const { pin } = await readJson(c, adultUnlockRequestSchema);
    // One attempt at a time per adult (RV-lead-identity-access-1): the PIN row stays locked while
    // the PIN is checked, so concurrent guesses each see the previous one's count and lock, and a
    // failure only ever increments the counter or sets the lock (never clears one).
    const outcome = await deps.db.asService(async (tx): Promise<UnlockOutcome> => {
      const [record] = await tx<{ pin_hash: string; locked_until: Date | null }[]>`
        select pin_hash, locked_until from private.parent_pins
         where user_id = ${parent.userId}
         for update
      `;
      if (!record) return { kind: 'no_pin' };
      if (record.locked_until && record.locked_until > now) {
        return { kind: 'locked', until: record.locked_until };
      }
      if (!(await verifyPin(pin, record.pin_hash, deps.config.hashPepper))) {
        // The lockout runs on the request clock, like the check above.
        const [updated] = await tx<{ locked_until: Date | null }[]>`
          update private.parent_pins
             set failed_attempts = case when failed_attempts + 1 >= ${PIN_MAX_FAILURES}
                                        then 0 else failed_attempts + 1 end,
                 locked_until = case when failed_attempts + 1 >= ${PIN_MAX_FAILURES}
                                     then ${now}::timestamptz + make_interval(secs => ${PIN_LOCKOUT_SECONDS})
                                     else locked_until end,
                 updated_at = now()
           where user_id = ${parent.userId}
          returning locked_until
        `;
        const lockedUntil = updated?.locked_until ?? null;
        const lockedNow = lockedUntil !== null && lockedUntil > now;
        return { kind: 'wrong', lockedNow };
      }
      await tx`update private.parent_pins set failed_attempts = 0, locked_until = null, updated_at = now() where user_id = ${parent.userId}`;
      // Written and checked (app.has_recent_adult_unlock) with the database clock
      // (RV-lead-identity-access-8), so the step-up lasts its TTL whatever the request clock says.
      const [unlock] = await tx<{ expires_at: Date }[]>`
        insert into private.adult_unlocks (user_id, auth_session_id, method, created_at, expires_at)
        values (${parent.userId}, ${parent.sessionId}, 'pin', now(),
                now() + make_interval(secs => ${deps.config.adultUnlockTtlSeconds}))
        returning expires_at
      `;
      return { kind: 'unlocked', until: unlock!.expires_at };
    });
    switch (outcome.kind) {
      case 'no_pin':
        throw new ApiError('NOT_FOUND', 'Set a parent PIN first');
      case 'locked':
        throw lockedOut(
          outcome.until,
          now,
          'Too many incorrect PINs. Try again later or reset your PIN.',
        );
      case 'wrong':
        if (outcome.lockedNow) {
          throw lockedOut(
            new Date(now.getTime() + PIN_LOCKOUT_SECONDS * 1000),
            now,
            'Too many incorrect PINs. Try again later.',
          );
        }
        throw new ApiError('FORBIDDEN', 'Incorrect PIN');
      case 'unlocked':
        return c.json({ unlockedUntil: outcome.until.toISOString() });
    }
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
