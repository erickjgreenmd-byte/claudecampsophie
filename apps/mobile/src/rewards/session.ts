import type { TokenSource } from '@pencillift/contracts/client';

/**
 * Where the rewards screens get their bearer tokens.
 *
 * Decision: this vertical does not own device pairing, child refresh-token rotation or parent
 * sign-in. Rotating a child refresh token from two places would trip the server's reuse detection
 * and revoke the session, so the rewards screens never refresh tokens themselves. The app's session
 * layer registers token sources here; until it does, the screens show an honest "not connected"
 * state and make no network calls.
 */
let childSource: TokenSource | null = null;
let parentSource: TokenSource | null = null;

export function registerRewardsTokenSources(sources: {
  child?: TokenSource | null;
  parent?: TokenSource | null;
}): void {
  if (sources.child !== undefined) childSource = sources.child;
  if (sources.parent !== undefined) parentSource = sources.parent;
}

/** The paired child's access-token source, or null when this device is not connected. */
export function childRewardsTokenSource(): TokenSource | null {
  return childSource;
}

/**
 * The signed-in parent's token source, or null when no parent session is available.
 *
 * Not a parent-area gate: the parent stays signed in while the device is in child mode (spec P3,
 * AC_ACCESS_07), so parent screens must get their client from `useParentAccess()` in
 * src/family/ui.tsx, which refuses in child mode (RV-rewards-3). The approvals screen does.
 */
export function parentRewardsTokenSource(): TokenSource | null {
  return parentSource;
}
