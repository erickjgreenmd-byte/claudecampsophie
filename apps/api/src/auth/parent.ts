import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { ApiConfig } from '../config.ts';
import type { ParentPrincipal } from '../db.ts';
import { ApiError } from '../errors.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParentTokenVerifier = (token: string) => Promise<ParentPrincipal>;

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
 * principal comes only from a verified signature, issuer, audience and expiry.
 */
export function createParentVerifier(config: ApiConfig): ParentTokenVerifier {
  const { jwksUrl, jwtSecret, jwtIssuer } = config.supabase;
  const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;

  return async (token) => {
    let payload: JWTPayload;
    try {
      const options = { issuer: jwtIssuer, audience: 'authenticated', clockTolerance: 5 } as const;
      if (jwks) {
        ({ payload } = await jwtVerify(token, jwks, options));
      } else if (jwtSecret) {
        ({ payload } = await jwtVerify(token, jwtSecret, { ...options, algorithms: ['HS256'] }));
      } else {
        throw new ApiError('NOT_CONFIGURED', 'Parent authentication is not configured');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('UNAUTHENTICATED', 'Sign in again to continue');
    }
    const sub = payload.sub;
    const sessionId = payload.session_id;
    if (payload.role !== 'authenticated' || typeof sub !== 'string' || !UUID_RE.test(sub)) {
      throw new ApiError('UNAUTHENTICATED', 'Sign in again to continue');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
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
