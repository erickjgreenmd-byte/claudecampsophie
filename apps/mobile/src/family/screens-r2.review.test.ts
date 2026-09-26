import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { biometricOffer, BIOMETRIC_OWNER_KEY } from './unlock.ts';

/**
 * Mobile round-2 hardening of the screens (MOB-R2-01/04/05/06/07 and the mobile half of WEB-R2-02).
 * The Expo screens import react-native, which this pure-logic suite cannot render (see
 * vitest.config.ts), so these checks read their source: each one names the control, the wiring or
 * the copy a screen must carry, so a refactor cannot quietly drop it.
 */
const appDir = join(import.meta.dirname, '..', '..', 'app');
const srcDir = join(import.meta.dirname, '..');
const screen = (...parts: string[]) => readFileSync(join(appDir, ...parts), 'utf8');
const ui = readFileSync(join(import.meta.dirname, 'ui.tsx'), 'utf8');
const runtime = readFileSync(join(import.meta.dirname, 'runtime.ts'), 'utf8');

describe('one lock action for backgrounding and both Lock buttons (MOB-R2-01)', () => {
  it('the shared Lock button runs the whole device lock, not only the server relock', () => {
    expect(ui).toMatch(/export function LockParentAreaButton/);
    expect(ui).toMatch(/lockParentAreaOnDevice\(modeEffects\)/);
  });

  it('the parent home and the unlock screen both use it instead of lockParentArea(api)', () => {
    expect(screen('(parent)', 'home.tsx')).toMatch(/<LockParentAreaButton \/>/);
    expect(screen('(parent)', 'home.tsx')).not.toMatch(/lockParentArea\(api\)/);
    expect(screen('(parent)', 'unlock.tsx')).toMatch(/<LockParentAreaButton \/>/);
    expect(screen('(parent)', 'unlock.tsx')).not.toMatch(/lockParentArea\(api\)\.then/);
  });

  it('the session layer locks the device on backgrounding, exempting an open purchase sheet', () => {
    const session = readFileSync(join(srcDir, 'lib', 'app-session.ts'), 'utf8');
    expect(session).toMatch(/if \(storePurchaseInFlight\(\)\) return;/);
    expect(session).toMatch(/await lockParentAreaOnDevice\(modeEffects\)/);
  });

  it('the plan screen marks its purchase so backgrounding does not lock mid-purchase', () => {
    expect(screen('(parent)', 'plan.tsx')).toMatch(
      /whileStorePurchaseOpen\(\s*\(\)\s*=>\s*runPlanChange\(/,
    );
  });

  it('the parent gate re-checks the unlock whenever the app comes back to the foreground', () => {
    expect(ui).toMatch(/next === 'active'/);
    // And the gate's check is a named, reusable function rather than a one-shot mount effect.
    expect(ui).toMatch(/const check = useCallback\(/);
  });

  /**
   * Source check (the vitest project cannot import react-native, so this hook has no rendered test):
   * each check must cancel the one before it. The foreground listener calls check() on every 'active',
   * so two checks could otherwise be in flight at once and the slower one would win the race to
   * setAccess — putting a screen back to 'ready' after a lock. Found as a residual by the round-3
   * acceptance checker; there is no failing reproduction because the hook cannot be rendered here.
   */
  it('each parent-gate check supersedes the one still in flight', () => {
    expect(ui).toMatch(/const cancelPrevious = useRef<\(\(\) => void\) \| null>\(null\)/);
    expect(ui).toMatch(/cancelPrevious\.current\?\.\(\);/);
    expect(ui).toMatch(/cancelPrevious\.current = cancel;/);
  });

  it('the runtime can reset navigation to the unlock screen', () => {
    expect(runtime).toMatch(/resetNavigationToUnlock\(\) \{/);
    expect(runtime).toMatch(/router\.replace\('\/\(parent\)\/unlock'\)/);
  });
});

describe('the unlock screen offers Sign out and Lock only past the PIN (MOB-R2-04)', () => {
  const unlock = screen('(parent)', 'unlock.tsx');

  it('both controls sit behind a live unlock, not beside the PIN field', () => {
    // The child's "Grown-ups" button opens this screen with no PIN, so an unconditional Sign out
    // let a child end the parent's session.
    expect(unlock).toMatch(/parentUnlockActive\(new Date\(\)\)/);
    expect(unlock).toMatch(/unlockActive \? \(/);
    expect(unlock).toMatch(/<SignOutButton \/>/);
  });

  it('a lapsed unlock window is reported, not a silent bounce back to the PIN', () => {
    expect(unlock).toMatch(/window_lapsed/);
    expect(unlock).toMatch(/unlockSeconds: outcome\.unlockSeconds/);
  });
});

describe('returning to a child screen re-enters child mode (MOB-R2-05)', () => {
  it('the child layout enters child mode when it regains focus in parent mode', () => {
    expect(ui).toMatch(/export function useChildModeOnFocus/);
    expect(ui).toMatch(/enterChildMode\(secureStorage, modeEffects\)/);
    expect(screen('(child)', '_layout.tsx')).toMatch(/useChildModeOnFocus\(\)/);
  });
});

describe('the biometric PIN never outlives its owner (MOB-R2-06)', () => {
  it('the stored PIN is offered only to the parent who stored it', () => {
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, 'user-a')).toBe('offer');
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, 'user-b')).toBe('other_user');
    // Nobody signed in, or a PIN with no recorded owner (an older build): never offered.
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, null)).toBe('other_user');
    expect(biometricOffer({ enabled: true, ownerUserId: null }, 'user-a')).toBe('other_user');
    expect(biometricOffer({ enabled: false, ownerUserId: 'user-a' }, 'user-a')).toBe('off');
  });

  it('the owner is stored beside the enabled flag', () => {
    expect(BIOMETRIC_OWNER_KEY).toBe('pl.parent.biometricOwner');
    expect(runtime).toMatch(/BIOMETRIC_OWNER_KEY/);
    expect(runtime).toMatch(/biometricOffer\(/);
  });

  it('signing out on the device clears the stored PIN', () => {
    expect(runtime).toMatch(
      /export async function signOutParentOnDevice[^]*?biometricPinStore\.clear\(\)/,
    );
  });

  it('closing the account goes through the same device sign-out', () => {
    const privacy = screen('(parent)', 'privacy.tsx');
    // The whole device sign-out, so a closed account leaves no PIN, no parent mode and no unlock.
    expect(privacy).toMatch(/signOutClosedAccountOnDevice\(\)/);
    expect(privacy).not.toMatch(/parentAuth\.signOut\(\)/);
    expect(runtime).toMatch(
      /export function signOutClosedAccountOnDevice[^]*?signOutParentOnDevice\(\{/,
    );
  });
});

describe('a render error shows a retry screen instead of closing the app (MOB-R2-07)', () => {
  for (const layout of [['_layout.tsx'], ['(child)', '_layout.tsx'], ['(parent)', '_layout.tsx']]) {
    it(`app/${layout.join('/')} exports an ErrorBoundary`, () => {
      expect(screen(...layout)).toMatch(/export function ErrorBoundary\(/);
    });
  }

  it('the child copy is calm and leads home; the parent copy offers a retry', () => {
    expect(screen('(child)', '_layout.tsx')).toMatch(/Something went wrong\./);
    expect(screen('(child)', '_layout.tsx')).toMatch(/Let’s go back home\./);
    expect(ui).toMatch(/export function ErrorScreen/);
    expect(ui).toMatch(/label="Try again"/);
  });
});

describe('signing out of the phone leaves other sessions alone (WEB-R2-02, mobile half)', () => {
  it('the mobile parent sign-out is local to this device', () => {
    const auth = readFileSync(join(srcDir, 'lib', 'parent-auth.ts'), 'utf8');
    expect(auth).toMatch(/signOut\(\{ scope: 'local' \}\)/);
  });
});
