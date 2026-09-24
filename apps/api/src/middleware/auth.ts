import type { Context, MiddlewareHandler } from 'hono';
import { verifyChildAccessToken } from '../auth/child.ts';
import { ApiError } from '../errors.ts';
import type { AppEnv } from './context.ts';

function bearer(c: Context<AppEnv>): string | null {
  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 && token.length < 8192 ? token : null;
}

/** Requires a verified parent (Supabase) token. Child tokens are rejected here. */
export const requireParent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue');
  const principal = await c.var.deps.verifyParentToken(token);
  c.set('parent', principal);
  await next();
};

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

/** Returns the caller's active family id or throws NOT_FOUND. */
export async function currentFamilyId(c: Context<AppEnv>): Promise<string> {
  const rows = await c.var.deps.db.asParent(
    c.var.parent,
    (tx) => tx<{ family_id: string }[]>`
      select family_id from public.family_memberships
       where user_id = ${c.var.parent.userId} and status = 'active'
    `,
  );
  const familyId = rows[0]?.family_id;
  if (!familyId) throw new ApiError('NOT_FOUND', 'Create your family first');
  return familyId;
}

/** Middleware form of assertOwnerAdmin for admin routers. */
export const requireOwnerAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  await assertOwnerAdmin(c);
  await next();
};
