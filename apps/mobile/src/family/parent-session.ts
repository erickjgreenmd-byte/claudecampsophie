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
const clearers = new Set<() => void>();

export function registerParentTokenSource(source: TokenSource | null): void {
  parentSource = source;
}

export function parentTokenSource(): TokenSource | null {
  return parentSource;
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
