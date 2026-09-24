import type { TokenSource } from '@pencillift/contracts/client';

/**
 * Where the privacy screens (child help/report, parent privacy) get their bearer tokens.
 *
 * Decision: this vertical does not own device pairing, child refresh-token rotation or parent
 * sign-in. Refreshing a child token from a second place would trip the server's reuse detection and
 * revoke the session, so these screens never refresh tokens themselves. The app's session layer
 * registers token sources here; until it does, the child can still use "Tell a grown-up" (no
 * network needed) and the screens show an honest "not connected" state for everything else.
 */
let childSource: TokenSource | null = null;
let parentSource: TokenSource | null = null;

export function registerPrivacyTokenSources(sources: {
  child?: TokenSource | null;
  parent?: TokenSource | null;
}): void {
  if (sources.child !== undefined) childSource = sources.child;
  if (sources.parent !== undefined) parentSource = sources.parent;
}

/** The paired child's access-token source, or null when this device is not connected. */
export function childPrivacyTokenSource(): TokenSource | null {
  return childSource;
}

/** The signed-in parent's token source, or null when no parent session is available. */
export function parentPrivacyTokenSource(): TokenSource | null {
  return parentSource;
}
