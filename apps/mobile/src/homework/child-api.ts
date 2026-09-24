/**
 * Device wiring for child homework requests: the API client carries the paired child's short-lived
 * access token (never a parent credential). Not unit-tested (imports native modules); the logic it
 * wires lives in child-session.ts, which is.
 *
 * Decision: owned here until a shared child-session module exists in src/lib; it uses the same
 * keychain key (STORAGE_KEYS.childRefreshToken) as the mode switcher so unpairing clears it.
 */
import { childTokenResponseSchema } from '@pencillift/contracts';
import { createApiClient } from '@pencillift/contracts/client';
import { apiBaseUrl, createMobileApi } from '../lib/api.ts';
import { secureStorage } from '../lib/secure-storage.ts';
import { createChildTokenSource } from './child-session.ts';

const anonymous = createApiClient(apiBaseUrl(), () => Promise.resolve(null));

export const childTokens = createChildTokenSource({
  storage: secureStorage,
  refresh: (refreshToken) =>
    anonymous.send('POST', '/v1/child/refresh', { refreshToken }, childTokenResponseSchema),
  now: () => new Date(),
});

export const childApi = createMobileApi(() => childTokens.token());
