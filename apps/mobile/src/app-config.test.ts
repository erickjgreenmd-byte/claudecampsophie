import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpoConfig } from 'expo/config';

/**
 * app.config.ts under environment fixtures (store audits APL-10/12/15/28, MOB-03/04/05/07/08/10/11,
 * PLAY-08, AMZ-01/02). The module computes its config at load time from process.env, so every case
 * resets the module registry, stubs the variables it needs and imports the file again.
 *
 * Synthetic values only: `.invalid` hosts, a fake project id and RevenueCat keys assembled here.
 */

const FAKE_PROJECT_ID = '00000000-0000-4000-8000-000000000000';
const RELEASE_ENV: Record<string, string> = {
  EXPO_PUBLIC_API_BASE_URL: 'https://api.pencillift.invalid',
  EXPO_PUBLIC_SUPABASE_URL: 'https://fakeprojectref00000a.supabase.invalid',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_FAKEfakeFAKEfake0000',
  EXPO_PUBLIC_PORTAL_URL: 'https://app.pencillift.invalid',
  EXPO_PUBLIC_REVENUECAT_IOS_KEY: ['appl', 'FAKEfakeFAKEfake00'].join('_'),
  EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: ['goog', 'FAKEfakeFAKEfake00'].join('_'),
  EXPO_PUBLIC_REVENUECAT_AMAZON_KEY: ['amzn', 'FAKEfakeFAKEfake00'].join('_'),
  EAS_PROJECT_ID: FAKE_PROJECT_ID,
  EXPO_OWNER: 'fake-owner',
};
const ALL_VARIABLES = [
  ...Object.keys(RELEASE_ENV),
  'EAS_BUILD_PROFILE',
  'EAS_BUILD_PLATFORM',
  'EXPO_PUBLIC_ANDROID_STORE',
];

async function load(env: Record<string, string | undefined>): Promise<ExpoConfig> {
  vi.resetModules();
  for (const name of ALL_VARIABLES) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const module = await import('../app.config.ts');
  return module.default;
}

function release(
  profile: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...RELEASE_ENV,
    EAS_BUILD_PROFILE: profile,
    ...(profile.endsWith('-amazon') ? { EXPO_PUBLIC_ANDROID_STORE: 'amazon' } : {}),
    ...overrides,
  };
}

type PluginEntry = string | [string, Record<string, unknown>];
function pluginProps(config: ExpoConfig, name: string): Record<string, unknown> | undefined {
  const entry = (config.plugins as PluginEntry[] | undefined)?.find(
    (plugin): plugin is [string, Record<string, unknown>] =>
      Array.isArray(plugin) && plugin[0] === name,
  );
  return entry?.[1];
}
function pluginNames(config: ExpoConfig): string[] {
  return ((config.plugins as PluginEntry[] | undefined) ?? []).map((plugin) =>
    Array.isArray(plugin) ? plugin[0] : plugin,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('app.config.ts permissions and privacy (APL-10/12/15/28, MOB-08/10/11, PLAY-08, AMZ-01/02)', () => {
  it('switches the microphone off in both photo plugins and keeps the custom camera string', async () => {
    const config = await load({});
    expect(pluginProps(config, 'expo-camera')).toMatchObject({
      microphonePermission: false,
      recordAudioAndroid: false,
    });
    expect(pluginProps(config, 'expo-image-picker')).toMatchObject({
      microphonePermission: false,
      cameraPermission: config.ios?.infoPlist?.NSCameraUsageDescription,
    });
    expect(config.ios?.infoPlist).not.toHaveProperty('NSMicrophoneUsageDescription');
  });

  it('ships no push stack: expo-notifications is neither a plugin nor a dependency', async () => {
    const config = await load({});
    expect(pluginNames(config)).not.toContain('expo-notifications');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).not.toHaveProperty('expo-notifications');
    // The development profile needs the dev client it declares (MOB-04).
    expect(pkg.dependencies).toHaveProperty('expo-dev-client');
  });

  it('asks Android only for CAMERA and USE_BIOMETRIC and blocks audio, location, ad id and notifications', async () => {
    const config = await load({});
    expect(config.android?.permissions).toEqual(['CAMERA', 'USE_BIOMETRIC']);
    expect(config.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.RECORD_AUDIO',
        'android.permission.POST_NOTIFICATIONS',
        'com.google.android.gms.permission.AD_ID',
      ]),
    );
  });

  it('declares the collected data types (linked, never tracking) and the required-reason APIs', async () => {
    const config = await load({});
    const manifest = config.ios?.privacyManifests;
    expect(manifest?.NSPrivacyTracking).toBe(false);
    expect(manifest?.NSPrivacyTrackingDomains).toEqual([]);
    const collected = manifest?.NSPrivacyCollectedDataTypes ?? [];
    expect(collected.map((entry) => entry.NSPrivacyCollectedDataType).sort()).toEqual(
      [
        'NSPrivacyCollectedDataTypeEmailAddress',
        'NSPrivacyCollectedDataTypeOtherUserContent',
        'NSPrivacyCollectedDataTypePhotosorVideos',
        'NSPrivacyCollectedDataTypePurchaseHistory',
        'NSPrivacyCollectedDataTypeUserID',
      ].sort(),
    );
    for (const entry of collected) {
      expect(entry.NSPrivacyCollectedDataTypeLinked).toBe(true);
      expect(entry.NSPrivacyCollectedDataTypeTracking).toBe(false);
      expect(entry.NSPrivacyCollectedDataTypePurposes).toEqual([
        'NSPrivacyCollectedDataTypePurposeAppFunctionality',
      ]);
    }
    const accessed = Object.fromEntries(
      (manifest?.NSPrivacyAccessedAPITypes ?? []).map((entry) => [
        entry.NSPrivacyAccessedAPIType,
        entry.NSPrivacyAccessedAPITypeReasons,
      ]),
    );
    expect(accessed).toEqual({
      NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
      NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1'],
      NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1'],
      NSPrivacyAccessedAPICategoryDiskSpace: ['E174.1'],
    });
  });

  it('declares export compliance: no non-exempt encryption', async () => {
    const config = await load({});
    expect(config.ios?.config?.usesNonExemptEncryption).toBe(false);
  });
});

describe('app.config.ts EAS linkage (MOB-03)', () => {
  it('carries the project id and owner from the environment', async () => {
    const config = await load(release('production'));
    expect(config.extra?.eas).toEqual({ projectId: FAKE_PROJECT_ID });
    expect(config.owner).toBe('fake-owner');
  });

  it('may run without them in development (local expo start, tests, the web export)', async () => {
    const config = await load({});
    expect(config.extra?.eas).toBeUndefined();
    expect(config.owner).toBeUndefined();
    const dev = await load({ EAS_BUILD_PROFILE: 'development' });
    expect(dev.extra?.eas).toBeUndefined();
  });

  it.each(['preview', 'production', 'preview-amazon', 'production-amazon'])(
    'fails loudly for the %s profile when EAS_PROJECT_ID is absent',
    async (profile) => {
      await expect(load(release(profile, { EAS_PROJECT_ID: undefined }))).rejects.toThrow(
        /EAS_PROJECT_ID.*npx eas init/s,
      );
    },
  );

  it('fails loudly for a release profile when EXPO_OWNER is absent, and on a malformed project id', async () => {
    await expect(load(release('preview', { EXPO_OWNER: undefined }))).rejects.toThrow(/EXPO_OWNER/);
    await expect(load(release('preview', { EAS_PROJECT_ID: 'not-a-uuid' }))).rejects.toThrow(
      /EAS_PROJECT_ID/,
    );
  });
});

describe('app.config.ts required public variables per profile (MOB-07)', () => {
  it.each([
    'EXPO_PUBLIC_API_BASE_URL',
    'EXPO_PUBLIC_SUPABASE_URL',
    'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'EXPO_PUBLIC_PORTAL_URL',
  ])('names %s when it is missing for a preview build', async (name) => {
    await expect(load(release('preview', { [name]: undefined }))).rejects.toThrow(
      new RegExp(`${name}.*preview`, 's'),
    );
    await expect(load(release('preview', { [name]: '' }))).rejects.toThrow(name);
  });

  it('refuses a release URL that is not https (the development localhost default never ships)', async () => {
    await expect(
      load(release('production', { EXPO_PUBLIC_API_BASE_URL: 'http://localhost:8787' })),
    ).rejects.toThrow(/EXPO_PUBLIC_API_BASE_URL.*https/s);
    // A deployed host over plain http is refused by the https rule itself, not the loopback rule.
    await expect(
      load(release('production', { EXPO_PUBLIC_PORTAL_URL: 'http://app.pencillift.invalid' })),
    ).rejects.toThrow(/EXPO_PUBLIC_PORTAL_URL.*https/s);
  });

  it('requires the RevenueCat public key of the store a production build sells through', async () => {
    await expect(
      load(
        release('production', {
          EAS_BUILD_PLATFORM: 'ios',
          EXPO_PUBLIC_REVENUECAT_IOS_KEY: undefined,
        }),
      ),
    ).rejects.toThrow(/EXPO_PUBLIC_REVENUECAT_IOS_KEY.*production/s);
    await expect(
      load(
        release('production', {
          EAS_BUILD_PLATFORM: 'android',
          EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: undefined,
        }),
      ),
    ).rejects.toThrow(/EXPO_PUBLIC_REVENUECAT_ANDROID_KEY/);
    await expect(
      load(
        release('production-amazon', {
          EAS_BUILD_PLATFORM: 'android',
          EXPO_PUBLIC_REVENUECAT_AMAZON_KEY: undefined,
        }),
      ),
    ).rejects.toThrow(/EXPO_PUBLIC_REVENUECAT_AMAZON_KEY/);
    // The other platform's key is not demanded of this build.
    const ios = await load(
      release('production', {
        EAS_BUILD_PLATFORM: 'ios',
        EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: undefined,
        EXPO_PUBLIC_REVENUECAT_AMAZON_KEY: undefined,
      }),
    );
    expect(ios.extra?.revenueCatIosKey).toBe(RELEASE_ENV.EXPO_PUBLIC_REVENUECAT_IOS_KEY);
    // Without a platform (a local `expo config` check) a production profile demands both store keys.
    await expect(
      load(release('production', { EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: undefined })),
    ).rejects.toThrow(/EXPO_PUBLIC_REVENUECAT_ANDROID_KEY/);
  });

  it('lets a preview build run without a store key (purchases stay off and the plan screen says so)', async () => {
    const config = await load(
      release('preview', {
        EXPO_PUBLIC_REVENUECAT_IOS_KEY: undefined,
        EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: undefined,
      }),
    );
    expect(config.extra?.revenueCatIosKey).toBeNull();
    expect(config.extra?.revenueCatAndroidKey).toBeNull();
  });

  it('refuses a profile name it does not know, so a typo cannot skip the release rules', async () => {
    await expect(load(release('prod'))).rejects.toThrow(/EAS_BUILD_PROFILE.*prod/s);
  });

  it('still refuses a non-public RevenueCat key in every profile', async () => {
    await expect(
      load({ EXPO_PUBLIC_REVENUECAT_IOS_KEY: ['sk', 'FAKEfakeFAKEfake00'].join('_') }),
    ).rejects.toThrow(/EXPO_PUBLIC_REVENUECAT_IOS_KEY/);
  });
});

describe('app.config.ts Amazon Appstore rules (AMZ-01/02, MOB-16)', () => {
  it('an Amazon profile requires EXPO_PUBLIC_ANDROID_STORE=amazon and reports it in extra', async () => {
    const config = await load(release('production-amazon', { EAS_BUILD_PLATFORM: 'android' }));
    expect(config.extra?.androidStore).toBe('amazon');
    expect(config.extra?.revenueCatAmazonKey).toBe(RELEASE_ENV.EXPO_PUBLIC_REVENUECAT_AMAZON_KEY);
    await expect(
      load(release('preview-amazon', { EXPO_PUBLIC_ANDROID_STORE: undefined })),
    ).rejects.toThrow(/preview-amazon.*EXPO_PUBLIC_ANDROID_STORE=amazon/s);
    await expect(
      load(release('preview-amazon', { EXPO_PUBLIC_ANDROID_STORE: 'play' })),
    ).rejects.toThrow(/EXPO_PUBLIC_ANDROID_STORE/);
  });

  it('a Play or App Store profile never builds for Amazon by accident', async () => {
    await expect(
      load(release('production', { EXPO_PUBLIC_ANDROID_STORE: 'amazon' })),
    ).rejects.toThrow(/production.*EXPO_PUBLIC_ANDROID_STORE/s);
    const config = await load(release('production'));
    expect(config.extra?.androidStore).toBe('play');
    await expect(load({ EXPO_PUBLIC_ANDROID_STORE: 'fire' })).rejects.toThrow(
      /EXPO_PUBLIC_ANDROID_STORE/,
    );
  });

  it('an Amazon build carries no Google-only plugin and the same permission set', async () => {
    const config = await load(release('production-amazon', { EAS_BUILD_PLATFORM: 'android' }));
    expect(pluginNames(config)).not.toContain('expo-notifications');
    expect(config.android?.permissions).toEqual(['CAMERA', 'USE_BIOMETRIC']);
    expect(config.android?.package).toBe('com.pencillift.app');
  });
});
