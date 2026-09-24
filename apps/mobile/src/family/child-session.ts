import { childTokenResponseSchema, familyOkResponseSchema } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient, type TokenSource } from '@pencillift/contracts/client';
import { STORAGE_KEYS, unpairChildDevice, type SecureStorage } from '../lib/mode.ts';
import { pairingErrorMessage, validatePairingCode } from './pairing-code.ts';

/**
 * The paired child's session on this device (spec P3, AC_ACCESS_04/08). Pure: no react-native.
 *
 * - Pairing redeems a parent-issued one-time code for a child-scoped session only.
 * - The rotating refresh token lives in the device keychain (SecureStorage); the short-lived access
 *   token lives only in memory.
 * - Refresh is single-flight: two concurrent requests never present the same refresh token twice,
 *   which the server treats as theft and answers by revoking the session.
 * - When the server says the session is gone (device disconnected, logout, deletion), the device
 *   forgets the child: refresh token and cached profile are removed.
 */

/** The stored profile has exactly the shape the pairing response returned (strict schema). */
const childProfileSchema = childTokenResponseSchema.shape.child;

export interface ChildProfile {
  readonly id: string;
  readonly nickname: string;
}

type ChildTokenResponse = ReturnType<typeof childTokenResponseSchema.parse>;

/** Refresh this long before expiry so a request never starts with an about-to-expire token. */
const EXPIRY_SKEW_MS = 30_000;

export interface ChildSessionDeps {
  readonly storage: SecureStorage;
  /** Unauthenticated client (pairing and refresh carry their own credentials in the body). */
  readonly publicApi: ApiClient;
  /** Builds a client that sends the given bearer token (used for logout). */
  readonly authedApi: (token: TokenSource) => ApiClient;
  readonly now: () => Date;
}

export type PairResult =
  | { readonly ok: true; readonly child: ChildProfile }
  | { readonly ok: false; readonly message: string };

export interface ChildSession {
  pair(input: {
    code: string;
    deviceLabel: string;
    platform: 'ios' | 'android' | 'web';
  }): Promise<PairResult>;
  /** Bearer token source for child API calls; null when this device is not paired. */
  readonly accessToken: TokenSource;
  profile(): Promise<ChildProfile | null>;
  isPaired(): Promise<boolean>;
  /** Ends the session on the server (best effort) and forgets the child on this device. */
  logout(): Promise<void>;
}

export function createChildSession(deps: ChildSessionDeps): ChildSession {
  let access: { token: string; expiresAtMs: number } | null = null;
  let inflight: Promise<string | null> | null = null;

  async function persist(response: ChildTokenResponse): Promise<void> {
    // Store the rotated refresh token before anything else uses the new access token.
    await deps.storage.setItem(STORAGE_KEYS.childRefreshToken, response.refreshToken);
    await deps.storage.setItem(STORAGE_KEYS.childProfile, JSON.stringify(response.child));
    access = {
      token: response.accessToken,
      expiresAtMs: Date.parse(response.accessTokenExpiresAt),
    };
  }

  async function forget(): Promise<void> {
    access = null;
    await unpairChildDevice(deps.storage);
  }

  async function refresh(): Promise<string | null> {
    const refreshToken = await deps.storage.getItem(STORAGE_KEYS.childRefreshToken);
    if (!refreshToken) return null;
    try {
      const response = await deps.publicApi.send(
        'POST',
        '/v1/child/refresh',
        { refreshToken },
        childTokenResponseSchema,
      );
      await persist(response);
      return response.accessToken;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'UNAUTHENTICATED') {
        await forget();
        return null;
      }
      // Offline or server trouble: keep the refresh token so the device reconnects later.
      throw error;
    }
  }

  const accessToken: TokenSource = () => {
    if (access && access.expiresAtMs - EXPIRY_SKEW_MS > deps.now().getTime()) {
      return Promise.resolve(access.token);
    }
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    async pair(input) {
      const check = validatePairingCode(input.code);
      if (!check.ok) return { ok: false, message: check.message };
      try {
        const response = await deps.publicApi.send(
          'POST',
          '/v1/child/pair',
          {
            code: check.code,
            deviceLabel: input.deviceLabel.trim().slice(0, 60) || 'Child device',
            platform: input.platform,
          },
          childTokenResponseSchema,
        );
        await persist(response);
        return { ok: true, child: response.child };
      } catch (error) {
        return { ok: false, message: pairingErrorMessage(error) };
      }
    },

    accessToken,

    async profile() {
      const raw = await deps.storage.getItem(STORAGE_KEYS.childProfile);
      if (!raw) return null;
      try {
        const parsed = childProfileSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    async isPaired() {
      return (await deps.storage.getItem(STORAGE_KEYS.childRefreshToken)) !== null;
    },

    async logout() {
      try {
        const token = await accessToken();
        if (token) {
          await deps
            .authedApi(() => Promise.resolve(token))
            .send('POST', '/v1/child/logout', undefined, familyOkResponseSchema);
        }
      } catch {
        // Best effort: the device forgets the child either way.
      }
      await forget();
    },
  };
}
