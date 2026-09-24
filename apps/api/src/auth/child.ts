import { jwtVerify, SignJWT } from 'jose';
import type { ApiConfig } from '../config.ts';
import type { ChildPrincipal } from '../db.ts';
import { ApiError } from '../errors.ts';

/**
 * API-issued child access tokens (docs/Architecture.md §3). Signed with a key Supabase never sees,
 * so a child token cannot be replayed against PostgREST. Short-lived; the session row is re-checked
 * on every request and by RLS (`app.current_child_id()`).
 */

const ISSUER = 'pencillift-api';
const AUDIENCE = 'pencillift-child';

export async function issueChildAccessToken(
  config: ApiConfig,
  principal: ChildPrincipal,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = new Date((issuedAt + config.childAccessTtlSeconds) * 1000);
  const token = await new SignJWT({
    typ: 'child',
    fam: principal.familyId,
    sid: principal.sessionId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(principal.childId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(config.childTokenSecret);
  return { token, expiresAt };
}

export async function verifyChildAccessToken(
  config: ApiConfig,
  token: string,
  now: Date,
): Promise<ChildPrincipal> {
  try {
    const { payload } = await jwtVerify(token, config.childTokenSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      currentDate: now,
    });
    if (payload.typ !== 'child' || typeof payload.sub !== 'string') throw new Error('bad claims');
    if (typeof payload.fam !== 'string' || typeof payload.sid !== 'string')
      throw new Error('bad claims');
    return { kind: 'child', childId: payload.sub, familyId: payload.fam, sessionId: payload.sid };
  } catch {
    throw new ApiError('UNAUTHENTICATED', 'Ask a grown-up to connect this device again');
  }
}
