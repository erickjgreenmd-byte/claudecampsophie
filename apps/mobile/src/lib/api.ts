import Constants from 'expo-constants';
import { createApiClient, type ApiClient, type TokenSource } from '@pencillift/contracts/client';

/** API base URL compiled into the bundle (public; see app.config.ts). */
export function apiBaseUrl(): string {
  const extra = Constants.expoConfig?.extra as { apiBaseUrl?: unknown } | undefined;
  return typeof extra?.apiBaseUrl === 'string' ? extra.apiBaseUrl : 'http://localhost:8787';
}

/** Parent requests carry the Supabase session token; child requests carry the child access token. */
export function createMobileApi(token: TokenSource): ApiClient {
  return createApiClient(apiBaseUrl(), token);
}

/**
 * A client for PUBLIC endpoints only, carrying no token at all. The data-practices notice is on
 * every parent screen, including ones reached before a parent has signed in, and
 * `GET /v1/data-practices` needs no identity.
 *
 * This is not a second token source (L-007): it is the absence of one. Nothing here reads, stores
 * or refreshes a token, so there is still exactly one place that does — src/lib/app-session.ts.
 * Anything that needs a parent or a child identity uses `createMobileApi` with that session's
 * source, and a request sent through this client to a guarded route is refused by the server.
 */
export function createPublicMobileApi(): ApiClient {
  return createApiClient(apiBaseUrl(), () => Promise.resolve(null));
}
