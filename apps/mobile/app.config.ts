import type { ExpoConfig } from 'expo/config';

/**
 * Native app configuration (spec P15). `com.pencillift.app` is PROPOSED: the owner must confirm and
 * reserve bundle/package ownership before any store registration (docs/Owner_Actions.md).
 * EXPO_PUBLIC_* values are compiled into the bundle and therefore public.
 *
 * Every rule below runs at config time, so a wrong or missing value stops `eas build`, `expo
 * prebuild` and `expo config` with a message that names the variable, instead of shipping a build
 * that points at localhost or sells through the wrong store. docs/Deployment_Runbook.md §3.4.
 */

function publicEnv(name: string): string | null {
  const value: unknown = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Which EAS build profile (apps/mobile/eas.json) this config is rendered for. EAS Build sets
 * EAS_BUILD_PROFILE (and EAS_BUILD_PLATFORM); local `expo start`, the tests and the web export set
 * neither and get the development rules. Any other profile name is refused so a typo can never
 * skip the release rules (MOB-07).
 */
type ProfileKind = 'development' | 'preview' | 'production';
const profileName = publicEnv('EAS_BUILD_PROFILE') ?? 'development';
const profileMatch = /^(development|preview|production)(-amazon)?$/.exec(profileName);
if (profileMatch === null) {
  throw new Error(
    `EAS_BUILD_PROFILE="${profileName}" is not a profile this app knows (development, preview, production, preview-amazon, production-amazon; apps/mobile/eas.json). Refusing to build.`,
  );
}
const profileKind = profileMatch[1] as ProfileKind;
const profileIsAmazon = profileMatch[2] === '-amazon';
if (profileKind === 'development' && profileIsAmazon) {
  throw new Error('EAS_BUILD_PROFILE="development-amazon" does not exist; use preview-amazon.');
}
const releaseShaped = profileKind !== 'development';
const rawPlatform = publicEnv('EAS_BUILD_PLATFORM');
const buildPlatform: 'ios' | 'android' | null =
  rawPlatform === 'ios' || rawPlatform === 'android' ? rawPlatform : null;

function missing(name: string, why: string): Error {
  return new Error(
    `${name} is not set but the "${profileName}" EAS build profile requires it (${why}). Set it as an EAS environment variable for this profile or in eas.json "env"; only the development profile may leave it unset. Refusing to build.`,
  );
}
/** A public variable that every release-shaped profile needs; the value is embedded in the app. */
function requiredPublicEnv(name: string, why: string): string | null {
  const value = publicEnv(name);
  if (value === null && releaseShaped) throw missing(name, why);
  return value;
}
/** A release URL must be https and never a loopback host: the development default cannot ship. */
function releaseUrl(name: string, value: string | null): string | null {
  if (value === null || !releaseShaped) return value;
  const parsed = URL.canParse(value) ? new URL(value) : null;
  if (
    parsed === null ||
    parsed.protocol !== 'https:' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1'
  ) {
    throw new Error(
      `${name} must be an https URL of a deployed host for the "${profileName}" EAS build profile (a development localhost default never ships). Refusing to build.`,
    );
  }
  return value;
}

const apiBaseUrl =
  releaseUrl(
    'EXPO_PUBLIC_API_BASE_URL',
    requiredPublicEnv('EXPO_PUBLIC_API_BASE_URL', 'the API the app talks to'),
  ) ?? 'http://localhost:8787';
// Supabase URL + publishable key are public by design; every decision is re-made by the API.
const supabaseUrl = releaseUrl(
  'EXPO_PUBLIC_SUPABASE_URL',
  requiredPublicEnv('EXPO_PUBLIC_SUPABASE_URL', 'parent sign-in'),
);
const supabasePublishableKey = requiredPublicEnv(
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'parent sign-in; the publishable key, never a secret',
);
const portalUrl = releaseUrl(
  'EXPO_PUBLIC_PORTAL_URL',
  requiredPublicEnv('EXPO_PUBLIC_PORTAL_URL', 'links to the parent portal and legal pages'),
);

/**
 * RevenueCat PUBLIC SDK keys only (RV-billing-6). Everything in `extra` ships in the app bundle, so
 * a value that is not the platform's public key shape (`appl_…` for iOS, `goog_…` for Android) — a
 * secret `sk_…` key, another provider's key, the other platform's key — fails the build instead of
 * being embedded. Same allowlist as isUsablePublicSdkKey (src/billing/store.ts). The value itself
 * is never printed. Absent → native purchases stay switched off and the plan screen says so
 * (src/billing/revenuecat.ts); a production profile refuses to build without the key of the store
 * it sells through (below).
 */
function revenueCatPublicKey(name: string, prefix: 'appl_' | 'goog_' | 'amzn_'): string | null {
  const key = publicEnv(name)?.trim() ?? '';
  if (key === '') return null;
  if (key.startsWith(prefix) && /^[A-Za-z0-9]{10,100}$/.test(key.slice(prefix.length))) return key;
  throw new Error(
    `${name} is not a RevenueCat public ${prefix}… SDK key. Refusing to build: anything in this variable ships inside the app, so a secret or other key must never be set here.`,
  );
}
const revenueCatIosKey = revenueCatPublicKey('EXPO_PUBLIC_REVENUECAT_IOS_KEY', 'appl_');
const revenueCatAndroidKey = revenueCatPublicKey('EXPO_PUBLIC_REVENUECAT_ANDROID_KEY', 'goog_');
// Amazon Appstore builds (Fire tablets have no Google Play services): RevenueCat's Amazon public key
// (`amzn_…`) and which Android store this build is for. A build is for exactly one store; the
// default is Google Play so an unset variable never produces an Amazon build by accident, and an
// Amazon profile must say so explicitly (eas.json sets it) so the two can never be crossed.
const revenueCatAmazonKey = revenueCatPublicKey('EXPO_PUBLIC_REVENUECAT_AMAZON_KEY', 'amzn_');
const rawAndroidStore = publicEnv('EXPO_PUBLIC_ANDROID_STORE') ?? 'play';
if (rawAndroidStore !== 'play' && rawAndroidStore !== 'amazon') {
  throw new Error('EXPO_PUBLIC_ANDROID_STORE must be "play" or "amazon"');
}
const androidStore: 'play' | 'amazon' = rawAndroidStore;
if (releaseShaped && profileIsAmazon && androidStore !== 'amazon') {
  throw new Error(
    `The "${profileName}" EAS build profile is an Amazon Appstore build and requires EXPO_PUBLIC_ANDROID_STORE=amazon (apps/mobile/eas.json sets it). Refusing to build.`,
  );
}
if (releaseShaped && !profileIsAmazon && androidStore !== 'play') {
  throw new Error(
    `The "${profileName}" EAS build profile is a Google Play / App Store build but EXPO_PUBLIC_ANDROID_STORE=${androidStore}; use the preview-amazon or production-amazon profile for Fire tablets. Refusing to build.`,
  );
}
if (profileKind === 'production') {
  // The store this build sells through must have its public key, or the app ships with purchases
  // switched off. With the platform unknown (a local `expo config` check) both stores are checked.
  const storeKeys: Array<[string, string | null, 'ios' | 'android']> =
    androidStore === 'amazon'
      ? [['EXPO_PUBLIC_REVENUECAT_AMAZON_KEY', revenueCatAmazonKey, 'android']]
      : [
          ['EXPO_PUBLIC_REVENUECAT_IOS_KEY', revenueCatIosKey, 'ios'],
          ['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY', revenueCatAndroidKey, 'android'],
        ];
  for (const [name, value, platform] of storeKeys) {
    if (value === null && (buildPlatform === null || buildPlatform === platform)) {
      throw missing(
        name,
        `native purchases on ${platform}; a production build cannot sell without it`,
      );
    }
  }
}

/**
 * EAS project linkage (MOB-03). The owner runs `npx eas init` once, which creates the project on
 * their Expo account and prints its id; because this config is dynamic the id is not written into
 * the file but read from EAS_PROJECT_ID, and the account slug from EXPO_OWNER (both public, both
 * owner-specific). Every non-development profile needs them; local runs may leave them unset.
 */
const easProjectId = requiredPublicEnv(
  'EAS_PROJECT_ID',
  'the Expo project this build belongs to; run `npx eas init` once and copy the id',
);
if (
  easProjectId !== null &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(easProjectId)
) {
  throw new Error(
    'EAS_PROJECT_ID is not a project id (a UUID as printed by `npx eas init`). Refusing to build.',
  );
}
const expoOwner = requiredPublicEnv(
  'EXPO_OWNER',
  'the Expo account (owner slug) that holds the project; run `npx eas init` once',
);
if (expoOwner !== null && !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(expoOwner)) {
  throw new Error('EXPO_OWNER is not an Expo account slug. Refusing to build.');
}

const CAMERA_USAGE =
  'PencilLift uses the camera so you can take a photo of completed homework to check it.';
const PHOTOS_USAGE = 'PencilLift lets you choose a photo of completed homework from your library.';
const FACE_ID_USAGE = 'Face ID lets a parent unlock the parent area quickly.';

/**
 * iOS privacy manifest (APL-12 / MOB-08). What the app collects, all linked to the account and none
 * of it used for tracking: the parent's email (sign-in), homework photos and the child's written
 * answers (user content), purchase history (RevenueCat) and the account id. Purpose: app
 * functionality only. NSPrivacyAccessedAPITypes lists the required-reason APIs React Native and
 * the Expo modules use, with Apple's standard reason codes (UserDefaults CA92.1, file timestamps
 * C617.1, system boot time 35F9.1, disk space E174.1).
 */
const COLLECTED_DATA_TYPES = [
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypePhotosorVideos',
  'NSPrivacyCollectedDataTypeOtherUserContent',
  'NSPrivacyCollectedDataTypePurchaseHistory',
  'NSPrivacyCollectedDataTypeUserID',
].map((type) => ({
  NSPrivacyCollectedDataType: type,
  NSPrivacyCollectedDataTypeLinked: true,
  NSPrivacyCollectedDataTypeTracking: false,
  NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
}));
const ACCESSED_API_TYPES = [
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', reasons: ['CA92.1'] },
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', reasons: ['C617.1'] },
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', reasons: ['35F9.1'] },
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', reasons: ['E174.1'] },
].map(({ NSPrivacyAccessedAPIType, reasons }) => ({
  NSPrivacyAccessedAPIType,
  NSPrivacyAccessedAPITypeReasons: reasons,
}));

const config: ExpoConfig = {
  name: 'PencilLift',
  slug: 'pencillift',
  ...(expoOwner === null ? {} : { owner: expoOwner }),
  scheme: 'pencillift',
  version: '0.1.0',
  orientation: 'default',
  // The product UI has no dark theme, so the app stays light. Keep the splash config below without
  // a `dark` block while this is 'light': expo-splash-screen's iOS plugin writes
  // UIUserInterfaceStyle=Automatic whenever a dark splash exists, overriding this key (it warns).
  // brand/assets splash-dark-1200.png is exported for the day this becomes 'automatic'.
  userInterfaceStyle: 'light',
  // Brand assets (brand/ASSETS.md): opaque teal tile for iOS and the store masks; traced from the
  // approved reference, never the whole presentation board, never the tagline in an icon.
  icon: './assets/brand/icon-ios-1024.png',
  platforms: ['ios', 'android', 'web'],
  ios: {
    bundleIdentifier: 'com.pencillift.app',
    supportsTablet: true,
    buildNumber: '1',
    // Export compliance (APL-15 / MOB-11): the app uses only the platform's TLS and no encryption
    // of its own, so App Store Connect does not ask on every upload.
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSCameraUsageDescription: CAMERA_USAGE,
      NSPhotoLibraryUsageDescription: PHOTOS_USAGE,
      NSFaceIDUsageDescription: FACE_ID_USAGE,
    },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: COLLECTED_DATA_TYPES,
      NSPrivacyAccessedAPITypes: ACCESSED_API_TYPES,
    },
  },
  android: {
    package: 'com.pencillift.app',
    versionCode: 1,
    // Adaptive icon for Google Play and Fire tablets: symbol inside the 66 dp safe circle over a
    // teal ground, plus the Android 13+ monochrome (themed-icon) layer.
    adaptiveIcon: {
      foregroundImage: './assets/brand/adaptive-foreground-1024.png',
      monochromeImage: './assets/brand/adaptive-monochrome-1024.png',
      backgroundColor: '#008D87',
    },
    permissions: ['CAMERA', 'USE_BIOMETRIC'],
    // Removed from the merged manifest even if a library declares them (AMZ-02, PLAY-08): the app
    // never records audio, never locates the device, has no ads and no push notifications.
    blockedPermissions: [
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.RECORD_AUDIO',
      'android.permission.POST_NOTIFICATIONS',
      'com.google.android.gms.permission.AD_ID',
    ],
  },
  // No push stack (APL-28 / MOB-10 / PLAY-08 / AMZ-01): nothing imports expo-notifications, so no
  // aps-environment entitlement, FCM receiver or POST_NOTIFICATIONS permission ships. Fire tablets
  // would need Amazon Device Messaging anyway. expo-dev-client (the development profile's client)
  // applies its own plugin automatically. Amazon purchases need no plugin: react-native-purchases
  // carries purchases-store-amazon, whose manifest declares com.amazon.device.iap.ResponseReceiver
  // (docs/Deployment_Runbook.md §3.4).
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      // microphonePermission: false drops the NSMicrophoneUsageDescription the plugin would otherwise
      // inject (APL-10); the app never records audio.
      'expo-camera',
      { cameraPermission: CAMERA_USAGE, microphonePermission: false, recordAudioAndroid: false },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: PHOTOS_USAGE,
        cameraPermission: CAMERA_USAGE,
        microphonePermission: false,
      },
    ],
    ['expo-local-authentication', { faceIDPermission: FACE_ID_USAGE }],
    [
      // Keys per node_modules/expo-splash-screen/plugin/build/types.d.ts (Props): image, imageWidth,
      // resizeMode, backgroundColor; `dark { image, backgroundColor }` only with 'automatic' above.
      'expo-splash-screen',
      {
        image: './assets/brand/splash-1200.png',
        imageWidth: 220,
        resizeMode: 'contain',
        backgroundColor: '#F7F9FB',
      },
    ],
  ],
  web: { favicon: './assets/brand/symbol-256.png' },
  experiments: { typedRoutes: true },
  extra: {
    ...(easProjectId === null ? {} : { eas: { projectId: easProjectId } }),
    apiBaseUrl,
    supabaseUrl,
    supabasePublishableKey,
    portalUrl,
    revenueCatIosKey,
    revenueCatAndroidKey,
    revenueCatAmazonKey,
    androidStore,
  },
};

export default config;
