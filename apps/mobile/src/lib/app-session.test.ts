// Session layer wiring (spec P3, AC_ACCESS_07). Native modules and the Supabase client are replaced
// by labeled vitest mocks; the token strings are synthetic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parentTokenSource } from '../family/parent-session.ts';
import { parentPrivacyTokenSource } from '../privacy/session.ts';
import { parentRewardsTokenSource } from '../rewards/session.ts';
import { STORAGE_KEYS } from './mode.ts';

const fake = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  onAuthChange: null as null | ((signedIn: boolean) => void),
  relocks: 0,
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
  fake.relocks = 0;
  fake.storeForgets = 0;
});

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

      // The family source still serves the PIN unlock that leads out of child mode.
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
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.relocks).toBe(0);
      fake.keychain.set(STORAGE_KEYS.mode, 'parent');
      fake.appStateListener?.('background');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.relocks).toBe(1);
    } finally {
      stop();
    }
  });
});
