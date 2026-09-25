import { useEffect, useState } from 'react';
import { Link, useRouteError } from 'react-router';
import { Loading } from './states.tsx';

/**
 * WEB-R1-02: the route error boundary (spec P14: no blank or dead screens).
 *
 * Rendered by React Router in place of a page that failed to load or render, inside the Shell, so
 * the brand bar, navigation and footer stay. It never shows raw error text. It offers "Reload" and
 * "Go to the family dashboard".
 *
 * A stale lazy chunk after a deploy ("Failed to fetch dynamically imported module", Safari's
 * "Importing a module script failed", Firefox's "error loading dynamically imported module")
 * reloads the page once so the parent gets the new build. A sessionStorage marker allows at most one
 * automatic reload per window of time, so a chunk that still fails after the reload shows this page
 * instead of looping; without usable storage there is no automatic reload at all.
 */

export const CHUNK_RELOAD_MARKER = 'pencillift.chunk-reload-at';
/** At most one automatic reload per tab in this window. */
export const CHUNK_RELOAD_WINDOW_MS = 10 * 60 * 1000;

/** Indirection so tests can observe reloads (jsdom's `location.reload` cannot be replaced). */
export const pageReload = {
  reload(): void {
    window.location.reload();
  },
};

const CHUNK_LOAD_MESSAGES = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
];

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_LOAD_MESSAGES.some((pattern) => pattern.test(error.message));
}

type MarkerStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * True when this tab may reload now for a stale chunk, recording the attempt. False when a reload
 * was already attempted within the window, or when storage is unavailable (fail safe: no loop).
 */
export function claimChunkReload(storage: MarkerStorage | null, nowMs: number): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(CHUNK_RELOAD_MARKER));
    if (Number.isFinite(last) && last > 0 && nowMs - last < CHUNK_RELOAD_WINDOW_MS) return false;
    storage.setItem(CHUNK_RELOAD_MARKER, String(nowMs));
    // Only a marker that was really written allows the reload.
    return storage.getItem(CHUNK_RELOAD_MARKER) === String(nowMs);
  } catch {
    return false;
  }
}

function sessionStorageOrNull(): MarkerStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function RouteError() {
  const error = useRouteError();
  const staleChunk = isChunkLoadError(error);
  const [reloading] = useState(
    () => staleChunk && claimChunkReload(sessionStorageOrNull(), Date.now()),
  );
  useEffect(() => {
    if (reloading) pageReload.reload();
  }, [reloading]);

  if (reloading) return <Loading label="Loading the latest version of PencilLift…" />;
  return (
    <section className="card" role="alert" aria-labelledby="route-error-title">
      <h1 id="route-error-title">This page couldn’t be shown</h1>
      <p>
        {staleChunk
          ? 'PencilLift was updated while this page was open. Reload to get the latest version.'
          : 'Something went wrong while showing this page. Reload to try again, or go back to your family dashboard.'}
      </p>
      <p style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <button type="button" className="btn" onClick={() => pageReload.reload()}>
          Reload
        </button>
        <Link to="/app">Go to the family dashboard</Link>
      </p>
    </section>
  );
}
