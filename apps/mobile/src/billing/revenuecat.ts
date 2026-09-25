import { AppState, Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import Purchases, { type PurchasesPackage } from 'react-native-purchases';
import { parentTokenSource, registerAdultCacheClearer } from '../family/parent-session.ts';
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
 * Feature gate: the SDK is configured ONLY when this build carries a real public SDK key for its
 * store (EXPO_PUBLIC_REVENUECAT_IOS_KEY / EXPO_PUBLIC_REVENUECAT_ANDROID_KEY, or
 * EXPO_PUBLIC_REVENUECAT_AMAZON_KEY for a Fire tablet build made with
 * EXPO_PUBLIC_ANDROID_STORE=amazon, via app.config.ts `extra`). Without one, `available` is false
 * and the plan screen says purchases are not available in this build; nothing is simulated. Every
 * purchase or restore is followed by POST /v1/billing/sync by the caller (purchase-flow.ts); the
 * device result never grants a slot.
 *
 * Fire OS is Android without Google services: an Amazon build configures RevenueCat with
 * `useAmazon: true` so purchases go through the Amazon Appstore, never Google Play Billing.
 */

interface Extra {
  revenueCatIosKey?: unknown;
  revenueCatAndroidKey?: unknown;
  revenueCatAmazonKey?: unknown;
  /** 'play' (default) or 'amazon': which Android store this build is for (app.config.ts). */
  androidStore?: unknown;
}

const PACKAGE_NAME = 'com.pencillift.app';

function extra(): Extra {
  return Constants.expoConfig?.extra ?? {};
}

/**
 * This build's store: the App Store on iOS; on Android, Google Play, or the Amazon Appstore when
 * the build was made for Fire tablets. A build is for exactly one store; the default is Google
 * Play, so a build that never set the store cannot sell through Amazon by accident.
 */
export function storeChannelForBuild(): StoreChannel | null {
  if (Platform.OS === 'ios') return 'app_store';
  if (Platform.OS === 'android') {
    return extra().androidStore === 'amazon' ? 'amazon_appstore' : 'play_store';
  }
  return null;
}

/** Which `extra` value carries each store's public SDK key. */
const KEY_FOR_STORE: Record<StoreChannel, (e: Extra) => unknown> = {
  app_store: (e) => e.revenueCatIosKey,
  play_store: (e) => e.revenueCatAndroidKey,
  amazon_appstore: (e) => e.revenueCatAmazonKey,
};

/** This build's store's public SDK key, or null (only that store's own public key shape counts). */
export function revenueCatPublicKey(): string | null {
  const store = storeChannelForBuild();
  if (store === null) return null;
  const raw = KEY_FOR_STORE[store](extra());
  return isUsablePublicSdkKey(raw, store) ? raw.trim() : null;
}

/** Purchases.configure may run once per app process; identity changes use logIn/logOut after that. */
let sdkConfigured = false;
/** The family billing ref the SDK currently acts for, or null (signed out / child mode). */
let identifiedAs: string | null = null;
const packages = new Map<string, PurchasesPackage>();
/** Identity changes run one at a time, so a logOut can never interleave with a later logIn. */
let identityQueue: Promise<void> = Promise.resolve();

function serialized(step: () => Promise<void>): Promise<void> {
  const next = identityQueue.then(step);
  identityQueue = next.catch(() => undefined);
  return next;
}

/**
 * Binds the store SDK to the family's opaque billing ref (GET /v1/billing/status `billingRef`), so
 * purchases and offer redemptions belong to this family and both guardians share one subscription.
 */
export function identifyStoreAccount(billingRef: string): Promise<void> {
  return serialized(async () => {
    const apiKey = revenueCatPublicKey();
    if (!apiKey) throw new Error('Store purchases are not configured in this build');
    if (!sdkConfigured) {
      // Configure directly as the family's opaque billing ref: no anonymous store identity is created.
      // A Fire tablet build talks to the Amazon Appstore instead of Google Play Billing.
      Purchases.configure({
        apiKey,
        appUserID: billingRef,
        ...(storeChannelForBuild() === 'amazon_appstore' ? { useAmazon: true } : {}),
      });
      sdkConfigured = true;
      identifiedAs = billingRef;
      return;
    }
    if (identifiedAs !== billingRef) {
      packages.clear();
      await Purchases.logIn(billingRef);
      identifiedAs = billingRef;
    }
  });
}

/**
 * The store SDK stops acting for the family (RV-billing-7): later store transactions on this device
 * (renewals, Ask to Buy approvals, codes redeemed in the App Store app) are no longer attributed to
 * its billing ref. Runs when the parent signs out or the device switches to child mode (see the
 * adult-cache clearer below). The next identify() binds the SDK again.
 */
export function forgetStoreIdentity(): Promise<void> {
  packages.clear();
  return serialized(async () => {
    packages.clear();
    if (identifiedAs === null) return;
    identifiedAs = null;
    await Purchases.logOut().catch(() => undefined);
  });
}

/**
 * Wired through the adult-cache clearers that src/lib/app-session.ts (sign-out) and
 * src/lib/mode.ts (entering child mode) already run, so no second session watcher exists. The same
 * clearers also run when the app merely goes to the background in parent mode; that alone keeps the
 * identity, because leaving the app for the store's own purchase sheet (Google Play) must not unbind
 * a purchase in flight. A signed-out parent always unbinds.
 */
registerAdultCacheClearer(() => {
  const signedIn = parentTokenSource() !== null;
  if (signedIn && AppState.currentState === 'background') return;
  void forgetStoreIdentity();
});

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
  const storeChannel = storeChannelForBuild();
  const available = storeChannel !== null && revenueCatPublicKey() !== null;
  return {
    channel: storeChannel,
    available,
    identify: identifyStoreAccount,
    async loadProducts() {
      if (!available || identifiedAs === null) return [];
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
        } else if (storeChannel === 'amazon_appstore') {
          // The Amazon Appstore has no replacement or proration flow: buying another tier while a
          // plan is live would start a second, parallel subscription, which never happens
          // (AC_CAPACITY_05). The parent ends the current plan in the Amazon Appstore first; a
          // first purchase is a plain package purchase.
          if (request.replacing) {
            return {
              kind: 'failed',
              message:
                'On a Fire tablet the Amazon Appstore can’t switch a subscription to another plan. Cancel your current plan in the Amazon Appstore first, then choose the new plan once it has ended. You haven’t been charged.',
            };
          }
          await Purchases.purchasePackage(pkg);
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
      if (available && identifiedAs !== null) {
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
