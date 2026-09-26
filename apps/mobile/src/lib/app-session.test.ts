// Session layer wiring (spec P3, AC_ACCESS_07). Native modules and the Supabase client are replaced
// by labeled vitest mocks; the token strings are synthetic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parentTokenSource, stepUpTokenSource } from '../family/parent-session.ts';
import { parentPrivacyTokenSource } from '../privacy/session.ts';
import { parentRewardsTokenSource } from '../rewards/session.ts';
import {
  enterParentMode,
  forgetParentUnlock,
  parentIdentityGeneration,
  parentStateStillCurrent,
  parentUnlockActive,
  STORAGE_KEYS,
  whileStorePurchaseOpen,
} from './mode.ts';

const fake = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  onAuthChange: null as null | ((signedIn: boolean) => void),
  /** Who the mocked Supabase session belongs to (MOB-R2-06 uses the same accessor). */
  userId: null as string | null,
  relocks: 0,
  cacheClears: 0,
  unlockScreens: 0,
  storeForgets: 0,
  appStateListener: null as null | ((next: string) => void),
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (next: string) => void) => {
      fake.appStateListener = listener;
      return { remove: () => undefined };
    },
  },
}));
vi.mock('../family/runtime.ts', () => ({
  childSession: { accessToken: () => Promise.resolve('child-token-mock') },
  modeEffects: {
    relockOnServer: () => {
      fake.relocks += 1;
      return Promise.resolve();
    },
    clearAdultCaches: () => {
      fake.cacheClears += 1;
    },
    resetNavigationToUnlock: () => {
      fake.unlockScreens += 1;
    },
    resetNavigationToChildHome: () => undefined,
    resetNavigationToWelcome: () => undefined,
    setScreenPrivacy: () => Promise.resolve(),
  },
}));
vi.mock('../billing/revenuecat.ts', () => ({
  forgetStoreIdentity: () => {
    fake.storeForgets += 1;
    return Promise.resolve();
  },
}));
vi.mock('./parent-auth.ts', () => ({
  parentAuth: {
    watch(listener: (signedIn: boolean) => void) {
      fake.onAuthChange = listener;
      return () => {
        fake.onAuthChange = null;
      };
    },
    tokenSource: () => Promise.resolve('parent-token-mock'),
    userId: () => Promise.resolve(fake.userId),
  },
}));
vi.mock('./secure-storage.ts', () => ({
  secureStorage: {
    getItem: (k: string) => Promise.resolve(fake.keychain.get(k) ?? null),
    setItem: (k: string, v: string) => {
      fake.keychain.set(k, v);
      return Promise.resolve();
    },
    deleteItem: (k: string) => {
      fake.keychain.delete(k);
      return Promise.resolve();
    },
  },
}));

const { initAppSession, parentSourceOutsideChildMode } = await import('./app-session.ts');

afterEach(() => {
  fake.keychain.clear();
  fake.userId = null;
  fake.relocks = 0;
  fake.cacheClears = 0;
  fake.unlockScreens = 0;
  fake.storeForgets = 0;
  forgetParentUnlock();
});

/** The clock is pinned (L-027): the unlock window below is measured from this instant. */
const NOW = new Date('2026-09-24T15:00:00Z');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('parent token sources and child mode (review note b, AC_ACCESS_07)', () => {
  it('the parent data sources give no token while the device is in child mode', async () => {
    const stop = initAppSession();
    try {
      fake.onAuthChange?.(true);
      const privacy = parentPrivacyTokenSource();
      const rewards = parentRewardsTokenSource();
      expect(privacy).not.toBeNull();
      expect(rewards).not.toBeNull();

      fake.keychain.set(STORAGE_KEYS.mode, 'parent');
      expect(await privacy!()).toBe('parent-token-mock');
      expect(await rewards!()).toBe('parent-token-mock');

      // A child now holds the device: the same registered sources fail closed.
      fake.keychain.set(STORAGE_KEYS.mode, 'child');
      expect(await privacy!()).toBeNull();
      expect(await rewards!()).toBeNull();

      // The family data source fails closed too (GET /v1/family, /v1/devices, ...); only the
      // step-up source still serves the PIN unlock that leads out of child mode, and the relock.
      expect(await parentTokenSource()!()).toBeNull();
      expect(await stepUpTokenSource()!()).toBe('parent-token-mock');
      fake.keychain.set(STORAGE_KEYS.mode, 'parent');
      expect(await parentTokenSource()!()).toBe('parent-token-mock');
    } finally {
      stop();
    }
  });

  it('signing out unregisters every parent source and unbinds the store SDK', () => {
    const stop = initAppSession();
    try {
      fake.onAuthChange?.(true);
      expect(fake.storeForgets).toBe(0);
      fake.onAuthChange?.(false);
      expect(parentTokenSource()).toBeNull();
      expect(stepUpTokenSource()).toBeNull();
      expect(parentPrivacyTokenSource()).toBeNull();
      expect(parentRewardsTokenSource()).toBeNull();
      expect(fake.storeForgets).toBe(1);
    } finally {
      stop();
    }
  });

  it('a mode that cannot be read counts as child mode (fails closed)', async () => {
    const gated = parentSourceOutsideChildMode(
      () => Promise.resolve('parent-token-mock'),
      () => Promise.reject(new Error('keychain unavailable')),
    );
    expect(await gated()).toBeNull();
  });

  it('backgrounding relocks only in parent mode', async () => {
    const stop = initAppSession();
    try {
      fake.keychain.set(STORAGE_KEYS.mode, 'child');
      fake.appStateListener?.('background');
      await settle();
      expect(fake.relocks).toBe(0);
      fake.keychain.set(STORAGE_KEYS.mode, 'parent');
      fake.appStateListener?.('background');
      await settle();
      expect(fake.relocks).toBe(1);
    } finally {
      stop();
    }
  });
});

/**
 * MOB-R2-01: leaving the app used to revoke only the server step-up. The open parent screen stayed
 * up with its data, and every other parent screen still opened without a PIN until the server's
 * window ran out, because the read routes behind them need only a signed-in parent.
 */
describe('leaving the app locks the parent area on the device too (MOB-R2-01)', () => {
  async function unlocked(): Promise<void> {
    const storage = {
      getItem: (k: string) => Promise.resolve(fake.keychain.get(k) ?? null),
      setItem: (k: string, v: string) => {
        fake.keychain.set(k, v);
        return Promise.resolve();
      },
      deleteItem: (k: string) => {
        fake.keychain.delete(k);
        return Promise.resolve();
      },
    };
    const noEffects = {
      clearAdultCaches: () => undefined,
      resetNavigationToChildHome: () => undefined,
      resetNavigationToWelcome: () => undefined,
      resetNavigationToUnlock: () => undefined,
      relockOnServer: () => Promise.resolve(),
      setScreenPrivacy: () => Promise.resolve(),
    };
    await enterParentMode(
      storage,
      noEffects,
      {
        unlocked: true,
        unlockedUntil: new Date(NOW.getTime() + 300_000).toISOString(),
        unlockSeconds: 300,
      },
      NOW,
    );
  }

  it('[repro] forgets the client unlock, clears the caches and replaces the screen', async () => {
    const stop = initAppSession();
    try {
      await unlocked();
      expect(parentUnlockActive(NOW)).toBe(true);
      fake.appStateListener?.('background');
      await settle();
      // Well inside the server's 300 s window, the parent area is nonetheless locked here.
      expect(parentUnlockActive(NOW)).toBe(false);
      expect(fake.cacheClears).toBeGreaterThan(0);
      expect(fake.unlockScreens).toBe(1);
      expect(fake.relocks).toBe(1);
    } finally {
      stop();
    }
  });

  /**
   * MOB-R4-LOCK-04. The watcher's signed-out branch cleared the adult caches and unbound the store
   * SDK but left the client-side unlock running, so a session that ended elsewhere (portal "sign out
   * everywhere", a password change) left the grant open for the rest of its window: the next parent
   * to sign in on the device reached the parent screens without the fresh PIN unlock the sign-in
   * screen promises, and a screen still mounted as 'ready' kept the previous parent's data on show.
   */
  it('[repro] a session that disappears also closes the client-side unlock', async () => {
    const stop = initAppSession();
    try {
      fake.onAuthChange?.(true);
      await unlocked();
      expect(parentUnlockActive(NOW)).toBe(true);
      // The session ends elsewhere; nothing about this device changed otherwise.
      fake.onAuthChange?.(false);
      expect(parentUnlockActive(NOW)).toBe(false);
    } finally {
      stop();
    }
  });

  it('an open store purchase sheet is exempt (it backgrounds the Android activity)', async () => {
    const stop = initAppSession();
    try {
      await unlocked();
      await whileStorePurchaseOpen(async () => {
        fake.appStateListener?.('background');
        await settle();
        expect(parentUnlockActive(NOW)).toBe(true);
        expect(fake.relocks).toBe(0);
        expect(fake.unlockScreens).toBe(0);
      });
      // Once the purchase is over, backgrounding locks as usual.
      fake.appStateListener?.('background');
      await settle();
      expect(parentUnlockActive(NOW)).toBe(false);
      expect(fake.unlockScreens).toBe(1);
    } finally {
      stop();
    }
  });
});

/**
 * HUNT5-H-1 / HUNT5-G-5. The signed-out branch's comment claimed it stopped "a screen still mounted
 * as 'ready'" keeping the previous parent's data. Nothing in it did: it closed the client-side grant
 * (which the next parent's own PIN re-arms) and cleared the registered caches, which are not a
 * screen's own state — so the parent gate handed a still-mounted screen its old state straight back.
 * The watcher now records WHOSE the parent state is, which is what lets the gate tell "the same
 * adult came back to this screen" from "a different adult is holding the tablet".
 */
describe('the watcher records which adult the parent state belongs to (HUNT5-H-1)', () => {
  it('[repro] an ended session, and a different parent signing in, both change the identity', async () => {
    const stop = initAppSession();
    try {
      fake.userId = 'user-a';
      fake.onAuthChange?.(true);
      await settle();
      const publishedForA = parentIdentityGeneration();
      expect(parentStateStillCurrent(publishedForA)).toBe(true);

      // The same session firing again (supabase-js reports a token refresh as an auth change) must
      // not invalidate A's screens: that is the "Loading your family" flash the gate avoids.
      fake.onAuthChange?.(true);
      await settle();
      expect(parentStateStillCurrent(publishedForA)).toBe(true);

      // A's session ends elsewhere. Nothing about this device changed otherwise, and A's screen is
      // still mounted: from this moment its state belongs to nobody.
      fake.onAuthChange?.(false);
      expect(parentStateStillCurrent(publishedForA)).toBe(false);

      // Parent B signs in on the handed-on tablet and unlocks with their own PIN.
      fake.userId = 'user-b';
      fake.onAuthChange?.(true);
      await settle();
      expect(parentStateStillCurrent(publishedForA)).toBe(false);
    } finally {
      stop();
    }
  });

  it('[repro] a session whose user id cannot be read moves the identity every time', async () => {
    // parentAuth.userId() reads the session, and an offline device past its token expiry resolves to
    // nothing — so the watcher records null for an adult who is signed in. Recording null twice in a
    // row used to move nothing (mode.ts returned early when the id equalled the stored owner), so a
    // screen published while this device could not read WHOSE session it was stayed "current" for
    // the next adult, on the very path the comment in the branch below says never keeps its rows.
    const stop = initAppSession();
    try {
      fake.userId = null;
      fake.onAuthChange?.(true);
      await settle();
      const publishedWhileNobodyKnown = parentIdentityGeneration();
      expect(parentStateStillCurrent(publishedWhileNobodyKnown)).toBe(true);

      // The session ends and a different adult signs in, with the id still unreadable: two more
      // unknown adults, and the screen published for the first of them keeps nothing.
      fake.onAuthChange?.(false);
      await settle();
      expect(parentStateStillCurrent(publishedWhileNobodyKnown)).toBe(false);
      const publishedWhileSignedOut = parentIdentityGeneration();
      fake.onAuthChange?.(true);
      await settle();
      expect(parentStateStillCurrent(publishedWhileSignedOut)).toBe(false);
    } finally {
      stop();
    }
  });
});
