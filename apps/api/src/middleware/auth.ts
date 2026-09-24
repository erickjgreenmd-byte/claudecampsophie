import type { Context, MiddlewareHandler } from 'hono';
import { verifyChildAccessToken } from '../auth/child.ts';
import { withLiveSessionCheck } from '../auth/parent.ts';
import { ApiError } from '../errors.ts';
import type { AppEnv } from './context.ts';

function bearer(c: Context<AppEnv>): string | null {
  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 && token.length < 8192 ? token : null;
}

/**
 * Requires a verified parent (Supabase) token whose auth session is still signed in. Child tokens
 * are rejected here. A signed-out session (Supabase deletes its auth.sessions row) stops working at
 * once instead of when the access token expires (spec P3: logout invalidates access). createApp
 * already installs the session-checked verifier; wrapping again is a no-op and keeps this
 * middleware safe with deps built elsewhere.
 */
export const requireParent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue');
  const { deps } = c.var;
  const principal = await withLiveSessionCheck(deps.verifyParentToken, deps.db)(token);
  c.set('parent', principal);
  await markParentSeen(deps, principal.userId);
  await next();
};

/**
 * Inactivity retention needs to know when an adult last used the service (spec P4). Stamped at most
 * once a day per adult; a failure here never blocks the request.
 */
async function markParentSeen(deps: AppEnv['Variables']['deps'], userId: string): Promise<void> {
  try {
    const stamped = await deps.db.asService(
      (tx) => tx`
        update public.family_memberships set last_seen_at = ${deps.clock()}
         where user_id = ${userId} and status = 'active'
           and (last_seen_at is null or last_seen_at < ${deps.clock()}::timestamptz - interval '1 day')
        returning family_id
      `,
    );
    // A notice only goes to families idle for months, so a returning adult is always re-stamped here.
    if (stamped.length === 0) return;
    await deps.db.asService(
      (tx) => tx`
        update public.families f set inactivity_notified_at = null
          from public.family_memberships m
         where m.family_id = f.id and m.user_id = ${userId} and m.status = 'active'
           and f.inactivity_notified_at is not null and f.deleted_at is null
      `,
    );
  } catch {
    deps.log({ level: 'warn', event: 'parent_seen_update_failed' });
  }
}

/**
 * Requires a live paired child session. The token proves identity; the DB check proves the session,
 * device, child and family are all still active (revocation takes effect immediately).
 */
export const requireChild: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new ApiError('UNAUTHENTICATED', 'Ask a grown-up to connect this device');
  const { deps } = c.var;
  const principal = await verifyChildAccessToken(deps.config, token, deps.clock());
  const [row] = await deps.db.asChild(
    principal,
    (tx) => tx<{ id: string | null }[]>`select app.current_child_id() as id`,
  );
  if (!row?.id)
    throw new ApiError('UNAUTHENTICATED', 'Ask a grown-up to connect this device again');
  c.set('child', principal);
  await next();
};

/** Server-side step-up check (spec P3): a recent PIN/biometric unlock bound to this auth session. */
export async function assertRecentUnlock(c: Context<AppEnv>): Promise<void> {
  const [row] = await c.var.deps.db.asParent(
    c.var.parent,
    (tx) => tx<{ ok: boolean }[]>`select app.has_recent_adult_unlock() as ok`,
  );
  if (!row?.ok) throw new ApiError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue');
}

/** Owner admin: admin_users row AND an MFA (aal2) session. */
export async function assertOwnerAdmin(c: Context<AppEnv>): Promise<void> {
  const [row] = await c.var.deps.db.asParent(
    c.var.parent,
    (tx) => tx<{ ok: boolean }[]>`select app.is_owner_admin() as ok`,
  );
  if (!row?.ok) throw new ApiError('FORBIDDEN', 'Owner administration requires an MFA session');
}

/**
 * Returns the caller's active family id or throws NOT_FOUND. An adult has at most one active
 * membership (unique index, migration 0720); if that ever fails to hold the request is refused
 * rather than acting on an arbitrary family.
 */
export async function currentFamilyId(c: Context<AppEnv>): Promise<string> {
  const rows = await c.var.deps.db.asParent(
    c.var.parent,
    (tx) => tx<{ family_id: string }[]>`
      select family_id from public.family_memberships
       where user_id = ${c.var.parent.userId} and status = 'active'
       order by accepted_at, id
       limit 2
    `,
  );
  if (rows.length > 1) {
    c.var.deps.log({ level: 'error', event: 'multiple_active_families' });
    throw new ApiError('CONFLICT', 'Your account is linked to more than one family');
  }
  const familyId = rows[0]?.family_id;
  if (!familyId) throw new ApiError('NOT_FOUND', 'Create your family first');
  return familyId;
}

/** Middleware form of assertOwnerAdmin for admin routers. */
export const requireOwnerAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  await assertOwnerAdmin(c);
  await next();
};
