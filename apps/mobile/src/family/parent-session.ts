import type { TokenSource } from '@pencillift/contracts/client';

/**
 * Parent session wiring for the family screens. Pure: no react-native imports.
 *
 * Decision: the mobile app has no parent sign-in yet (Supabase Auth is not connected on mobile),
 * so parent screens take their bearer token from a registered source. Until the auth layer
 * registers one, every parent screen shows an honest "not connected" state and calls nothing.
 *
 * Adult caches: anything a parent screen keeps outside component state registers a clearer here,
 * so switching to child mode (src/lib/mode.ts `clearAdultCaches`) wipes all of it (AC_ACCESS_07).
 */

let parentSource: TokenSource | null = null;
let stepUpSource: TokenSource | null = null;
const clearers = new Set<() => void>();

/**
 * `source` serves every parent DATA call and is registered empty in child mode by the session layer
 * (src/lib/app-session.ts). `stepUp` serves only the PIN unlock that leads out of child mode and
 * the server relock (POST /v1/adult/unlock, /v1/adult/lock); it defaults to `source`.
 */
export function registerParentTokenSource(
  source: TokenSource | null,
  options: { readonly stepUp?: TokenSource | null } = {},
): void {
  parentSource = source;
  stepUpSource = options.stepUp === undefined ? source : options.stepUp;
}

export function parentTokenSource(): TokenSource | null {
  return parentSource;
}

/** The bearer for the PIN unlock and relock only; never for parent data. */
export function stepUpTokenSource(): TokenSource | null {
  return stepUpSource;
}

/** Registers a cache clearer; returns an unregister function. */
export function registerAdultCacheClearer(clear: () => void): () => void {
  clearers.add(clear);
  return () => {
    clearers.delete(clear);
  };
}

/** Clears every registered adult cache. A failing clearer never stops the others. */
export function clearAdultCaches(): void {
  for (const clear of [...clearers]) {
    try {
      clear();
    } catch {
      // Keep clearing: leaving any adult data behind is the worse outcome.
    }
  }
}
