import { Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import Purchases, { type PurchasesPackage } from 'react-native-purchases';
import { playRedeemUrl } from './offer-step.ts';
import {
  baseSubscriptionId,
  classifyPurchaseError,
  isUsablePublicSdkKey,
  managementUrl,
  usdCentsFromStorePrice,
  type BillingStore,
  type OfferRedemptionStore,
  type StoreChannel,
  type StoreProductInfo,
} from './store.ts';

/**
 * Native store wiring through RevenueCat (react-native-purchases), spec P11/P17. Covered by
 * typechecking only: purchases need a real device, a store sandbox account and the owner's
 * RevenueCat project (docs/Owner_Actions.md #4), none of which exist in this environment.
 *
 * Feature gate: the SDK is configured ONLY when this build carries a real public SDK key for the
 * platform (EXPO_PUBLIC_REVENUECAT_IOS_KEY / EXPO_PUBLIC_REVENUECAT_ANDROID_KEY via app.config.ts
 * `extra`). Without one, `available` is false and the plan screen says purchases are not available
 * in this build; nothing is simulated. Every purchase or restore is followed by POST
 * /v1/billing/sync by the caller (purchase-flow.ts); the device result never grants a slot.
 */

interface Extra {
  revenueCatIosKey?: unknown;
  revenueCatAndroidKey?: unknown;
}

const PACKAGE_NAME = 'com.pencillift.app';

function channel(): StoreChannel | null {
  if (Platform.OS === 'ios') return 'app_store';
  if (Platform.OS === 'android') return 'play_store';
  return null;
}

/** The platform's public SDK key from the build, or null (never a secret key). */
export function revenueCatPublicKey(): string | null {
  const extra = (Constants.expoConfig?.extra ?? {}) as Extra;
  const raw =
    Platform.OS === 'ios'
      ? extra.revenueCatIosKey
      : Platform.OS === 'android'
        ? extra.revenueCatAndroidKey
        : null;
  return isUsablePublicSdkKey(raw) ? raw.trim() : null;
}

let configuredFor: string | null = null;
const packages = new Map<string, PurchasesPackage>();

/**
 * Binds the store SDK to the family's opaque billing ref (GET /v1/billing/status `billingRef`), so
 * purchases and offer redemptions belong to this family and both guardians share one subscription.
 */
export async function identifyStoreAccount(billingRef: string): Promise<void> {
  const apiKey = revenueCatPublicKey();
  if (!apiKey) throw new Error('Store purchases are not configured in this build');
  if (configuredFor === null) {
    // Configure directly as the family's opaque billing ref: no anonymous store identity is created.
    Purchases.configure({ apiKey, appUserID: billingRef });
    configuredFor = billingRef;
    return;
  }
  if (configuredFor !== billingRef) {
    packages.clear();
    await Purchases.logIn(billingRef);
    configuredFor = billingRef;
  }
}

/**
 * Called when the parent signs out: the store SDK stops acting for that family. Wired by the app's
 * session layer (src/lib/app-session.ts), which is the only place that reacts to sign-in state.
 */
export async function forgetStoreIdentity(): Promise<void> {
  packages.clear();
  if (configuredFor === null) return;
  configuredFor = null;
  await Purchases.logOut().catch(() => undefined);
}

function toProductInfo(pkg: PurchasesPackage): StoreProductInfo {
  return {
    productId: pkg.product.identifier,
    priceText: pkg.product.priceString,
    usdCents: usdCentsFromStorePrice(pkg.product.price, pkg.product.currencyCode),
    currencyCode: pkg.product.currencyCode,
  };
}

/** Read lazily so importing this module never touches the native SDK. */
function errorCodes() {
  return {
    cancelled: Purchases.PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR,
    pending: Purchases.PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR,
  };
}

export function createNativeBillingStore(): BillingStore {
  const storeChannel = channel();
  const available = storeChannel !== null && revenueCatPublicKey() !== null;
  return {
    channel: storeChannel,
    available,
    identify: identifyStoreAccount,
    async loadProducts() {
      if (!available || configuredFor === null) return [];
      const offerings = await Purchases.getOfferings();
      packages.clear();
      const all = [offerings.current, ...Object.values(offerings.all)];
      for (const offering of all) {
        for (const pkg of offering?.availablePackages ?? []) {
          if (!packages.has(pkg.product.identifier)) packages.set(pkg.product.identifier, pkg);
        }
      }
      return [...packages.values()].map(toProductInfo);
    },
    async purchase(request) {
      const pkg = packages.get(request.productId);
      if (!available || !pkg) {
        return { kind: 'failed', message: 'This plan isn’t available from the store right now.' };
      }
      try {
        if (storeChannel === 'play_store') {
          // Buy the base plan explicitly so no store offer is applied automatically (spec P17:
          // a school promotion is never granted without a validated PencilLift redemption), and
          // change tiers through Google's replacement flow, never a second parallel subscription.
          const basePlan = pkg.product.subscriptionOptions?.find((o) => o.isBasePlan) ?? null;
          const change = request.replacing
            ? {
                oldProductIdentifier: baseSubscriptionId(request.replacing.productId),
                replacementMode:
                  request.replacing.direction === 'upgrade'
                    ? Purchases.STORE_REPLACEMENT_MODE.CHARGE_PRORATED_PRICE
                    : Purchases.STORE_REPLACEMENT_MODE.DEFERRED,
              }
            : null;
          if (basePlan) await Purchases.purchaseSubscriptionOption(basePlan, change);
          else await Purchases.purchasePackage(pkg, null, change);
        } else {
          // Apple: all tiers are one subscription group, so the App Store applies an upgrade now
          // and a downgrade at renewal within the same subscription (no duplicate purchase).
          await Purchases.purchasePackage(pkg);
        }
        return { kind: 'success' };
      } catch (error) {
        return classifyPurchaseError(error, errorCodes());
      }
    },
    async restore() {
      if (!available) return { kind: 'failed', message: 'Not available in this build.' };
      try {
        await Purchases.restorePurchases();
        return { kind: 'restored' };
      } catch {
        return {
          kind: 'failed',
          message: 'The store couldn’t restore purchases. Please try again.',
        };
      }
    },
    async openManageSubscriptions() {
      if (storeChannel === null) return;
      let providerUrl: string | null = null;
      if (available && configuredFor !== null) {
        providerUrl = await Purchases.getCustomerInfo()
          .then((info) => info.managementURL)
          .catch(() => null);
      }
      await Linking.openURL(managementUrl(storeChannel, providerUrl, PACKAGE_NAME));
    },
  };
}

/**
 * The platform redemption step for P17 offer codes (used by offer-step.ts). The App Store sheet is
 * presented only after the SDK is bound to this family's billing ref, so the redeemed offer lands on
 * the family's own subscriber record.
 */
export function createNativeOfferRedemptionStore(billingRef: string): OfferRedemptionStore {
  return {
    async presentAppStoreCodeSheet() {
      if (Platform.OS !== 'ios') throw new Error('The App Store code sheet is iOS only');
      await identifyStoreAccount(billingRef);
      await Purchases.presentCodeRedemptionSheet();
    },
    async openUrl(url) {
      await Linking.openURL(url);
    },
  };
}

export { playRedeemUrl };
