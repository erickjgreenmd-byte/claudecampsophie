/**
 * Child access tokens for homework requests (spec P3: short-lived access token + rotating refresh
 * token kept in the device keychain). The paired device holds only the refresh token; access tokens
 * live in memory and are refreshed shortly before they expire.
 *
 * Decision: concurrent callers share one in-flight refresh. The server treats reuse of a rotated
 * refresh token as theft and revokes the session, so two parallel refreshes must never happen.
 *
 * Pure logic with injected storage/refresh so it is unit-testable without a device.
 */
import { ApiRequestError } from '@pencillift/contracts/client';
import { STORAGE_KEYS, type SecureStorage } from '../lib/mode.ts';

export interface ChildTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
}

export interface ChildTokenSource {
  /** A valid access token, null when the device is not (or no longer) paired. */
  token(): Promise<string | null>;
  /** Forgets the in-memory access token (e.g. on unpair or mode switch). */
  clear(): void;
}

const EXPIRY_SKEW_MS = 30_000;

export function createChildTokenSource(deps: {
  storage: SecureStorage;
  refresh: (refreshToken: string) => Promise<ChildTokens>;
  now: () => Date;
}): ChildTokenSource {
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string | null> | null = null;

  async function refreshNow(): Promise<string | null> {
    const refreshToken = await deps.storage.getItem(STORAGE_KEYS.childRefreshToken);
    if (!refreshToken) return null;
    try {
      const next = await deps.refresh(refreshToken);
      await deps.storage.setItem(STORAGE_KEYS.childRefreshToken, next.refreshToken);
      cached = { token: next.accessToken, expiresAt: Date.parse(next.accessTokenExpiresAt) };
      return next.accessToken;
    } catch (error) {
      // A revoked/expired pairing is not an error for the screen: it has no token to send.
      if (error instanceof ApiRequestError && error.code === 'UNAUTHENTICATED') return null;
      throw error;
    }
  }

  return {
    token() {
      if (cached && deps.now().getTime() < cached.expiresAt - EXPIRY_SKEW_MS) {
        return Promise.resolve(cached.token);
      }
      if (!inflight) {
        inflight = refreshNow().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    clear() {
      cached = null;
    },
  };
}
