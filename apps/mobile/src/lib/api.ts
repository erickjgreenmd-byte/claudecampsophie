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
