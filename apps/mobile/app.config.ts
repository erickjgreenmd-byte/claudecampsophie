import type { ExpoConfig } from 'expo/config';

/**
 * Native app configuration (spec P15). `com.pencillift.app` is PROPOSED: the owner must confirm and
 * reserve bundle/package ownership before any store registration (docs/Owner_Actions.md).
 * EXPO_PUBLIC_* values are compiled into the bundle and therefore public.
 */
const rawApiBaseUrl: unknown = process.env.EXPO_PUBLIC_API_BASE_URL;
const apiBaseUrl =
  typeof rawApiBaseUrl === 'string' && rawApiBaseUrl.length > 0
    ? rawApiBaseUrl
    : 'http://localhost:8787';

function publicEnv(name: string): string | null {
  const value: unknown = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
// Supabase URL + publishable key are public by design; every decision is re-made by the API.
const supabaseUrl = publicEnv('EXPO_PUBLIC_SUPABASE_URL');
const supabasePublishableKey = publicEnv('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
const portalUrl = publicEnv('EXPO_PUBLIC_PORTAL_URL');
/**
 * RevenueCat PUBLIC SDK keys only (RV-billing-6). Everything in `extra` ships in the app bundle, so
 * a value that is not the platform's public key shape (`appl_…` for iOS, `goog_…` for Android) — a
 * secret `sk_…` key, another provider's key, the other platform's key — fails the build instead of
 * being embedded. Same allowlist as isUsablePublicSdkKey (src/billing/store.ts). The value itself
 * is never printed. Absent → native purchases stay switched off and the plan screen says so
 * (src/billing/revenuecat.ts).
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
// default is Google Play so an unset variable never produces an Amazon build by accident.
const revenueCatAmazonKey = revenueCatPublicKey('EXPO_PUBLIC_REVENUECAT_AMAZON_KEY', 'amzn_');
const rawAndroidStore = publicEnv('EXPO_PUBLIC_ANDROID_STORE') ?? 'play';
if (rawAndroidStore !== 'play' && rawAndroidStore !== 'amazon') {
  throw new Error('EXPO_PUBLIC_ANDROID_STORE must be "play" or "amazon"');
}
const androidStore: 'play' | 'amazon' = rawAndroidStore;

const config: ExpoConfig = {
  name: 'PencilLift',
  slug: 'pencillift',
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
    infoPlist: {
      NSCameraUsageDescription:
        'PencilLift uses the camera so you can take a photo of completed homework to check it.',
      NSPhotoLibraryUsageDescription:
        'PencilLift lets you choose a photo of completed homework from your library.',
      NSFaceIDUsageDescription: 'Face ID lets a parent unlock the parent area quickly.',
    },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyAccessedAPITypes: [],
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
    blockedPermissions: [
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.RECORD_AUDIO',
      'com.google.android.gms.permission.AD_ID',
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-camera',
      {
        cameraPermission:
          'PencilLift uses the camera so you can take a photo of completed homework to check it.',
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission:
          'PencilLift lets you choose a photo of completed homework from your library.',
      },
    ],
    [
      'expo-local-authentication',
      { faceIDPermission: 'Face ID lets a parent unlock the parent area quickly.' },
    ],
    'expo-notifications',
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
