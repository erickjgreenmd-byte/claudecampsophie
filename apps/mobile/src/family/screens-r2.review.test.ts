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
    expect(ui).toMatch(/lockParentAreaOnDevice\(secureStorage, modeEffects\)/);
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
    // The storage argument is what returns a paired family tablet to the child space (MOB-R4-LOCK-01).
    expect(session).toMatch(/await lockParentAreaOnDevice\(secureStorage, modeEffects\)/);
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
    // A PIN with no recorded owner (an older build): never offered, and removed.
    expect(biometricOffer({ enabled: true, ownerUserId: null }, 'user-a')).toBe('other_user');
    // "Nobody signed in" used to be folded into 'other_user' here, which made the unlock screen
    // delete the enrolment of the parent who IS signed in whenever the session could not be read
    // (MOB-R4-LOCK-02). It is its own outcome now; the assertion that pinned 'other_user' was wrong.
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, null)).toBe('unknown');
    expect(biometricOffer({ enabled: false, ownerUserId: 'user-a' }, 'user-a')).toBe('off');
  });

  it('the owner is stored beside the enabled flag', () => {
    expect(BIOMETRIC_OWNER_KEY).toBe('pl.parent.biometricOwner');
    expect(runtime).toMatch(/BIOMETRIC_OWNER_KEY/);
    expect(runtime).toMatch(/biometricOffer\(/);
  });

  it('signing out on the device clears the stored PIN', () => {
    // Both device exits go through the same helper, so neither can drop the PIN removal.
    expect(runtime).toMatch(
      /export async function signOutParentOnDevice[^]*?await clearDeviceAdultSecrets\(\);/,
    );
    expect(runtime).toMatch(
      /async function clearDeviceAdultSecrets[^]*?biometricPinStore\.clear\(\)/,
    );
  });

  it('closing the account goes through the same device sign-out', () => {
    const privacy = screen('(parent)', 'privacy.tsx');
    // The whole device sign-out, so a closed account leaves no PIN, no parent mode and no unlock.
    // The call takes no argument (MOB-R4-LOCK-05): nothing at the call site can switch part of the
    // closure off, which is how the first round-4 attempt ended up inert.
    expect(privacy).toMatch(/signOutClosedAccountOnDevice\(\)/);
    expect(privacy).not.toMatch(/parentAuth\.signOut\(\)/);
    expect(runtime).toMatch(
      /export async function signOutClosedAccountOnDevice[^]*?await signOutClosedAccount\(/,
    );
    expect(runtime).toMatch(
      /export async function signOutClosedAccountOnDevice[^]*?await clearDeviceAdultSecrets\(\);/,
    );
  });
});

/**
 * Round-4 hardening of the parent-area lock (MOB-R4-LOCK-02/03/04/05/06). Each check below names
 * the wiring or the copy that closes one finding, so a refactor cannot quietly drop it; the parts
 * that can be exercised as logic have real tests in src/lib/mode-r2.review.test.ts and
 * src/lib/app-session.test.ts.
 */
describe('the biometric enrolment survives a session that cannot be read (MOB-R4-LOCK-02)', () => {
  it('[repro] “nobody signed in” is its own outcome, not the same as a different parent', () => {
    // An offline device more than the access-token TTL past its last refresh reports no user id
    // (getSession() yields null once the token is expired and the refresh cannot run), so folding
    // that into 'other_user' deleted the keychain PIN of the parent who IS signed in.
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, null)).toBe('unknown');
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, 'user-b')).toBe('other_user');
  });

  it('the runtime store deletes the stored PIN only for a different owner', () => {
    expect(runtime).toMatch(/if \(offer === 'other_user'\) \{\s*await clearBiometricPin\(\);/);
    // 'unknown' falls through to the plain `offer === 'offer'` answer: no offer, no delete.
    expect(runtime).toMatch(/return offer === 'offer';/);
  });
});

describe('no PIN-less visitor can change the parent’s security settings (MOB-R4-LOCK-03)', () => {
  const unlock = screen('(parent)', 'unlock.tsx');

  it('“Turn off biometric unlock” is behind the parental gate, not a bare button', () => {
    // It deletes the keychain PIN and both flags, with no PIN, no OS prompt and no confirmation,
    // and the child's "Grown-ups" button opens this screen with no PIN at all. The gate is the one
    // already used for the portal link here; the live-unlock condition that hides Lock and Sign out
    // would put it out of a parent's reach, since they arrive at this screen precisely without one.
    expect(unlock).toMatch(/<GatedButton\s+label="Turn off biometric unlock"/);
    expect(unlock).not.toMatch(/<Button\s+label="Turn off biometric unlock"/);
  });
});

describe('an auth change closes the client-side unlock (MOB-R4-LOCK-04)', () => {
  it('the session watcher forgets the unlock when the Supabase session disappears', () => {
    const session = readFileSync(join(srcDir, 'lib', 'app-session.ts'), 'utf8');
    expect(session).toMatch(/if \(!signedIn\) \{[^]*?forgetParentUnlock\(\)/);
  });

  it('the parent gate re-checks when a parent screen comes back into view', () => {
    // Without a re-check a screen that was already 'ready' kept the previous parent's data on
    // screen, and its ApiClient followed whoever signed in next: the finding's repro is the header
    // back arrow from the sign-in/unlock screen onto the still-mounted parent screen underneath,
    // which is a focus event. Focus is the trigger for it.
    //
    // The first round-4 attempt re-checked on parentAuth.watch instead. That assertion was wrong:
    // the watch fires during app/(parent)/privacy.tsx's own account closure (it calls
    // parentAuth.signOut()), and privacy.tsx renders its "Account deleted" confirmation inside the
    // `access.status === 'ready'` branch, so re-gating on that event replaced the confirmation the
    // parent had just earned with a sign-in prompt. The unlock is still forgotten on the auth
    // change (src/lib/app-session.ts, the check above), which is what closes the grant.
    expect(ui).toMatch(/useFocusEffect\(check\)/);
    expect(ui).not.toMatch(/parentAuth\.watch\(\(\) => check\(\)\)/);
  });

  it('a screen that is still unlocked keeps the access it already had', () => {
    // A check that is still 'ready' must hand the screen back the SAME state object. parentApi()
    // builds a new ApiClient on every call, and the parent screens key their load on that client
    // (e.g. app/(parent)/home.tsx: useLoad(load) with load = useCallback(…, [api])), so a fresh
    // object on every focus would re-fetch and flash "Loading your family" over data the parent
    // was already reading each time they came back from a pushed screen. The client's token source
    // reads the live session, so reusing it never serves another parent's data.
    expect(ui).toMatch(
      /setAccess\(\(previous\) => \(?\s*previous\.status === 'ready' \? previous : \{ status: 'ready', api \}/,
    );
  });
});

describe('closing the account leaves no child pairing on the device (MOB-R4-LOCK-05)', () => {
  it('the closure is one call with nothing to switch off', () => {
    // The rule and its behavioural tests live in src/lib/mode.ts / src/lib/mode-r2.review.test.ts
    // ("closing an account leaves no child pairing on the device"): the closure signs the parent out
    // and then forgets the child on this device — refresh token, cached nickname, mode 'signed_out'.
    //
    // The first round-4 attempt put that forget behind a `familyDeleted` argument so a guardian's own
    // closure would keep the pairing, and left the single call site passing nothing: the fix never ran
    // on the finding's repro (the owner deletes the family, then closes their sign-in on the paired
    // tablet). Nothing on the device can tell the two closures apart, so the forget is unconditional
    // and purely local — no child session is revoked on the wire — and the signature has no argument
    // for a call site to omit.
    expect(runtime).toMatch(
      /export async function signOutClosedAccountOnDevice\(\): Promise<void>/,
    );
    expect(runtime).not.toMatch(/familyDeleted: false/);
    expect(runtime).not.toMatch(/childSession\.logout\(\)/);
  });

  it('the child home offers a grown-up route while the device is not connected', () => {
    const home = screen('(child)', 'home.tsx');
    const notConnected = /if \(state\.status === 'not_connected'\) \{([^]*?)\n {2}\}/.exec(home);
    expect(notConnected).not.toBeNull();
    expect(notConnected?.[1]).toMatch(/label="Grown-ups"/);
  });
});

describe('the Children screen does not name the wrong deletion scope (MOB-R4-LOCK-06)', () => {
  const children = screen('(parent)', 'children.tsx');

  it('the notice never tells the parent they asked for this one child’s data to be deleted', () => {
    // GET /v1/family sets deletionPending for a FAMILY-scope request too, so the per-child wording
    // told a parent who asked for the whole family that they had asked for one child.
    expect(children).toMatch(/Data\s+deletion\s+under\s+way/);
    expect(children).not.toMatch(/You asked for \{row\.nickname\}/);
    expect(children).toMatch(/whole\s+family/i);
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
