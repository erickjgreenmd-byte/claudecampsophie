import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { ApiConfig } from '../config.ts';
import type { Db, ParentPrincipal } from '../db.ts';
import { ApiError } from '../errors.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParentTokenVerifier = (token: string) => Promise<ParentPrincipal>;

/**
 * Supabase signing keys, cached per Worker isolate and keyed by JWKS URL. The Worker builds its
 * dependencies per request, so a verifier-local cache would refetch the keys on every request
 * (RV-lead-identity-access-11). jose refreshes the keys itself (10-minute max age, and at most
 * every 30 s when a token names an unknown key id).
 */
const JWKS_BY_URL = new Map<string, JWTVerifyGetKey>();
const MAX_CACHED_JWKS_URLS = 8;

function signingKeys(jwksUrl: string): JWTVerifyGetKey {
  let keys = JWKS_BY_URL.get(jwksUrl);
  if (!keys) {
    // One URL in production; the bound only keeps tests or misconfiguration from growing the map.
    if (JWKS_BY_URL.size >= MAX_CACHED_JWKS_URLS) JWKS_BY_URL.clear();
    keys = createRemoteJWKSet(new URL(jwksUrl));
    JWKS_BY_URL.set(jwksUrl, keys);
  }
  return keys;
}

/**
 * For an error thrown while resolving the signing key: true when the key service could not be
 * reached or answered badly (timeout, network error, non-200, unparseable or malformed key set).
 * A token naming an unknown key id or a disallowed algorithm is the token's problem, not this.
 */
function isKeyServiceFailure(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
    return true;
  }
  if (error instanceof joseErrors.JOSEError) return error.code === 'ERR_JOSE_GENERIC';
  // fetch() network failures surface as TypeError.
  return error instanceof TypeError;
}

/**
 * Supabase access tokens carry `amr: [{ method, timestamp }]` (seconds) for each authentication in
 * the session. The newest entry is when the adult last proved account ownership (password, OTP,
 * magic link, recovery link or OAuth); malformed entries are ignored.
 */
function latestAuthentication(amr: unknown): Date | undefined {
  if (!Array.isArray(amr)) return undefined;
  let latest = 0;
  for (const entry of amr) {
    const ts = (entry as { timestamp?: unknown } | null)?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > latest) latest = ts;
  }
  return latest > 0 ? new Date(latest * 1000) : undefined;
}

/**
 * Verifies a Supabase Auth access token. The API never trusts a role/family claim from the body; the
 * principal comes only from a verified signature, issuer, audience and expiry. Whether the session
 * is still signed in is checked against the database by `withLiveSessionCheck`, which createApp
 * applies to every parent token check.
 */
export function createParentVerifier(config: ApiConfig): ParentTokenVerifier {
  const { jwksUrl, jwtSecret, jwtIssuer } = config.supabase;

  return async (token) => {
    let payload: JWTPayload;
    // Set only by a failure of the key lookup itself, so token defects never read as an outage.
    let keyServiceDown = false;
    try {
      const options = { issuer: jwtIssuer, audience: 'authenticated', clockTolerance: 5 } as const;
      if (jwksUrl) {
        const keys = signingKeys(jwksUrl);
        const getKey: JWTVerifyGetKey = async (header, input) => {
          try {
            return await keys(header, input);
          } catch (error) {
            keyServiceDown = isKeyServiceFailure(error);
            throw error;
          }
        };
        ({ payload } = await jwtVerify(token, getKey, options));
      } else if (jwtSecret) {
        ({ payload } = await jwtVerify(token, jwtSecret, { ...options, algorithms: ['HS256'] }));
      } else {
        throw new ApiError('NOT_CONFIGURED', 'Parent authentication is not configured');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (keyServiceDown) {
        // A key-service outage is not the parent's fault: retryable, never "sign in again".
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          'We could not check your sign-in just now. Please try again in a moment.',
          { retryAfterSeconds: 5 },
        );
      }
      throw new ApiError('UNAUTHENTICATED', 'Sign in again to continue');
    }
    const sub = payload.sub;
    const sessionId = payload.session_id;
    if (payload.role !== 'authenticated' || typeof sub !== 'string' || !UUID_RE.test(sub)) {
      throw new ApiError('UNAUTHENTICATED', 'Sign in again to continue');
    }
    // Supabase session ids are UUIDs (auth.sessions.id); anything else cannot be checked for sign-out.
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
      throw new ApiError('UNAUTHENTICATED', 'Sign in again to continue');
    }
    const authenticatedAt = latestAuthentication(payload.amr);
    return {
      kind: 'parent',
      userId: sub,
      sessionId,
      aal: payload.aal === 'aal2' ? 'aal2' : 'aal1',
      ...(authenticatedAt ? { authenticatedAt } : {}),
    };
  };
}

/** Verifiers that already confirm the session is still signed in (so wrapping is idempotent). */
const LIVE_SESSION_CHECKED = new WeakSet<ParentTokenVerifier>();

/**
 * Wraps a token verifier so that a valid token is accepted only while its Supabase session is still
 * signed in (app.auth_session_active, migration 0720): signed out, past its not_after time-box or
 * another adult's session all answer 401 at once instead of when the access token expires (spec P3:
 * logout invalidates access). createApp installs this as deps.verifyParentToken, so requireParent
 * and routes that verify parent tokens themselves (the homework capture routes) share it.
 */
export function withLiveSessionCheck(verify: ParentTokenVerifier, db: Db): ParentTokenVerifier {
  if (LIVE_SESSION_CHECKED.has(verify)) return verify;
  const checked: ParentTokenVerifier = async (token) => {
    const principal = await verify(token);
    const [row] = await db.asService(
      (tx) => tx<{ active: boolean }[]>`
        select app.auth_session_active(${principal.userId}::uuid, ${principal.sessionId}) as active
      `,
    );
    if (row?.active !== true) throw new ApiError('UNAUTHENTICATED', 'Sign in again to continue');
    return principal;
  };
  LIVE_SESSION_CHECKED.add(checked);
  return checked;
}
