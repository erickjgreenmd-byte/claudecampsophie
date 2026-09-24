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
// RevenueCat PUBLIC SDK keys (appl_… / goog_…), never the secret key. Absent → native purchases stay
// switched off and the plan screen says so (src/billing/revenuecat.ts).
const revenueCatIosKey = publicEnv('EXPO_PUBLIC_REVENUECAT_IOS_KEY');
const revenueCatAndroidKey = publicEnv('EXPO_PUBLIC_REVENUECAT_ANDROID_KEY');

const config: ExpoConfig = {
  name: 'PencilLift',
  slug: 'pencillift',
  scheme: 'pencillift',
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'light',
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
  ],
  experiments: { typedRoutes: true },
  extra: {
    apiBaseUrl,
    supabaseUrl,
    supabasePublishableKey,
    portalUrl,
    revenueCatIosKey,
    revenueCatAndroidKey,
  },
};

export default config;
