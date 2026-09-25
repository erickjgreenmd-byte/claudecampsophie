import type { AuthAdminProvider } from './index.ts';
import { MIN_STORAGE_SERVICE_KEY_LENGTH, storageUrlProblem } from './supabase-storage.ts';

/**
 * Supabase Auth Admin adapter: closes a parent's sign-in (Apple 5.1.1(v), Google Play account
 * deletion). Server-only: it holds the service-role key, which comes from a Worker secret and is
 * never sent to a browser or device.
 *
 * Status: UNTESTED AGAINST A LIVE SERVICE (like the storage adapter). The request shape is the one
 * supabase-js `auth.admin.deleteUser(id, shouldSoftDelete = true)` sends; the API test suite uses
 * the labeled local double instead. Before production, run this against a staging project and
 * record the evidence in docs/Connections.md.
 *
 * Endpoint (base `${supabaseUrl}/auth/v1`):
 * - DELETE /admin/users/{id}  headers `Authorization: Bearer <service role>` and `apikey`, JSON
 *   body `{ "should_soft_delete": true }` (GoTrue reads the flag from the body). 200 with the
 *   closed user, 404 when the auth service does not know the id.
 *
 * SOFT delete on purpose: GoTrue keeps the auth.users row (deleted_at set, email and phone
 * replaced by hashes, metadata emptied, sessions ended). A hard delete would be refused anyway,
 * since about forty columns reference auth.users without ON DELETE actions (migration 0830).
 */

export interface SupabaseAuthAdminOptions {
  /** Project URL, e.g. https://<project>.supabase.co (http only for localhost development). */
  readonly supabaseUrl: string;
  /** Service-role (secret) key from Worker secrets. */
  readonly serviceRoleKey: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout (spec P12: every external request has a timeout). */
  readonly timeoutMs?: number;
}

export class AuthAdminRequestError extends Error {
  readonly status: number;
  constructor(operation: string, status: number) {
    // Status only: the response body can echo the user's identifiers and is not needed.
    super(`Supabase Auth Admin ${operation} failed with HTTP ${status}`);
    this.name = 'AuthAdminRequestError';
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSupabaseAuthAdmin(options: SupabaseAuthAdminOptions): AuthAdminProvider {
  const problem = storageUrlProblem(options.supabaseUrl);
  if (problem) throw new Error(`Supabase URL ${problem}`);
  if (options.serviceRoleKey.length < MIN_STORAGE_SERVICE_KEY_LENGTH) {
    throw new Error('Supabase service key is missing');
  }
  const base = `${new URL(options.supabaseUrl).origin}/auth/v1`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const headers = {
    authorization: `Bearer ${options.serviceRoleKey}`,
    apikey: options.serviceRoleKey,
    'content-type': 'application/json',
    accept: 'application/json',
  };

  return {
    name: 'supabase_auth_admin',
    isMock: false,
    async closeUser(userId) {
      // The id goes into the path: only a UUID may be sent (never a value that could reshape it).
      if (!UUID_RE.test(userId)) throw new Error('Auth user id must be a UUID');
      const response = await fetchImpl(`${base}/admin/users/${userId.toLowerCase()}`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ should_soft_delete: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return { outcome: 'already_closed' };
      if (!response.ok) throw new AuthAdminRequestError('close', response.status);
      return { outcome: 'closed' };
    },
  };
}

/**
 * Staging/production without the service key: every close is refused, never a labeled double
 * (L-016). Readiness reports `auth_admin` blocked; queued account_close jobs retry and dead-letter.
 */
export function createRefusingAuthAdmin(): AuthAdminProvider {
  return {
    name: 'not_configured',
    isMock: false,
    closeUser: () => Promise.reject(new Error('auth admin provider not configured')),
  };
}
