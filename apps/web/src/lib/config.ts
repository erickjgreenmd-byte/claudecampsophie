/** Public build-time configuration. Only publishable values belong here (they ship to browsers). */
export interface WebConfig {
  readonly apiBaseUrl: string;
  readonly supabaseUrl: string | null;
  readonly supabasePublishableKey: string | null;
}

export function readWebConfig(
  env: Record<string, string | undefined> = import.meta.env,
): WebConfig {
  return {
    apiBaseUrl: env.VITE_API_BASE_URL ?? '/api',
    supabaseUrl: env.VITE_SUPABASE_URL ?? null,
    supabasePublishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY ?? null,
  };
}
