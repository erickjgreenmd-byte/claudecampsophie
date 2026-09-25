# P17 / P11 provider capability matrix

Required by spec P17 ("Provider integration is part of the feature") and P11 (exact store prices).
Checked 2026-09-24. **Evidence levels:** `doc-verified` = read in the provider's current public docs
during this session; `secondary` = reputable secondary source; `candidate` = the builder's best
understanding, **not yet verified**; `sandbox-verified` = proven with a real sandbox receipt (none yet).
Only sandbox evidence can close AC_PROMO_07 / AC_CONN_03.

## 1. Approved regular prices vs store catalogs (AC_CAPACITY_02)

| Tier | Approved total | Apple App Store (USD) | Google Play | Stripe (web, optional) |
|---|---|---|---|---|
| 1 child | $39.99 | Representable ($0.50 steps from $10–$50 include x.99) — `secondary` | Representable (arbitrary price) — `candidate` | Representable — `candidate` |
| 2 children | $49.98 | **Not representable.** Nearest points $49.49 / $49.99 (or $50.00) — `secondary` | Representable — `candidate` | Representable |
| 3 children | $59.97 | **Not representable.** $1 steps from $50–$200 → $59.99 / $60.00 — `secondary` | Representable — `candidate` | Representable |
| 4 children | $69.96 | **Not representable.** → $69.99 / $70.00 — `secondary` | Representable — `candidate` | Representable |

Sources: [Apple newsroom, Dec 2022](https://www.apple.com/newsroom/2022/12/apple-announces-biggest-upgrade-to-app-store-pricing-adding-700-new-price-points/) ("every $0.10 up to $10; every $0.50 between $10 and $50; etc."), [TechCrunch summary](https://techcrunch.com/2022/12/06/apple-loosens-grip-on-app-store-pricing-with-700-new-price-points-support-for-prices-that-dont-end-in-99) ("$0.50 increments up to $49.99, $1 increments up to $199.99").

**Consequence (owner decision required, see `docs/Owner_Actions.md`):** the App Store cannot sell three of
the four approved totals. The code never rounds silently: `store_product_mappings` records the store's actual
price and the release-readiness check blocks any tier whose store price ≠ approved price.

## 2. Monthly promotions (P17)

| Capability | Apple | Google Play | Stripe |
|---|---|---|---|
| Discount expressed as a percentage | **No** — offer price is a chosen *price point* ("Pay as you go / Pay up front / Free") — `doc-verified` ([offer codes](https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-subscription-offer-codes), [promotional offers](https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-promotional-offers-for-auto-renewable-subscriptions)) | Yes — offer phases support `relativeDiscount` — `secondary` ([Play API offers](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.subscriptions.basePlans.offers)) | Yes — coupon `percent_off` — `candidate` |
| Exact 5–99% of $49.98 etc. | Only if the discounted amount is itself a price point; most are not (e.g. 5% → $47.48). Must report unsupported, never round | Store computes the discounted price; verify rounding in sandbox | Exact to the cent; Stripe rounding to verify |
| 100% one-month offer | Yes — "Free" offer type — `doc-verified` | New subscribers: free phase offer. Existing: `candidate` — Play's subscription *defer* API extends the billing date (free time) | Yes — 100% `once` coupon on the target invoice |
| New subscribers | Offer codes (eligibility "New") — `doc-verified` | Offers with new-customer or developer-determined eligibility — `secondary` | Yes |
| Existing subscribers, next period | Offer codes (eligibility "Existing") and promotional offers ("existing and previously subscribed") — `doc-verified`. **When the discount starts for an active subscriber is not stated in the docs** — must be sandbox-verified | **Unclear/likely unsupported for a partial discount without a plan replacement** — `candidate`. 100% via defer is the smallest compliant alternative | Yes — attach the discount to the draft renewal invoice (`invoice.created`, `billing_reason = subscription_cycle`) so a proration invoice cannot consume it — `candidate`; Stripe states proration items cannot be discounted further ([coupons](https://docs.stripe.com/billing/subscriptions/coupons)) |
| Lapsed subscribers | Offer codes ("Expired") and promotional offers — `doc-verified` | Developer-determined offer at re-purchase — `candidate` | Yes |
| Repeat monthly redemption by the same family | "Customers are limited to redeeming one code per offer" — `doc-verified`. ⇒ Each month needs a **new App Store offer** per tier/percentage. Limit: "up to 10 active offers per subscription SKU" — `doc-verified`; campaigns must rotate/expire | Per-offer eligibility "if they haven't used this offer" for new-customer offers — `secondary`; developer-determined offers are app-controlled | Our DB enforces one redemption per family per campaign; Stripe allows repeated coupons — `candidate` |
| Code volume | 1M codes/app/quarter; custom code redemption limit ≤ 25,000 at a time — `doc-verified` | Promo code quotas — `candidate` | Unlimited promotion codes — `candidate` |
| Redemption surface | App Store code-redemption sheet or signed promotional offer via StoreKit/RevenueCat | In-app purchase flow with selected offer token | Our web checkout / billing portal |

## 2a. Amazon Appstore (Fire tablets) — channel `amazon_appstore`

Added 2026-09-25 with the Amazon channel (Owner action #29). Amazon's developer documentation was not reachable
from this environment; every row below is `candidate` except where the installed RevenueCat SDK typings are the
source, and none is sandbox-verified (Amazon App Tester needs the owner's developer account).

| Capability | Amazon Appstore | Evidence |
|---|---|---|
| Subscriptions through RevenueCat | Supported by the SDK: `Purchases.configure({ useAmazon: true })` with an `amzn_…` public key; the build's store is fixed at build time (`EXPO_PUBLIC_ANDROID_STORE=amazon`), never guessed from the OS | `doc-verified` against `react-native-purchases` typings in `node_modules` |
| Approved totals $39.99 / $49.98 / $59.97 / $69.96 | Believed representable (Amazon takes a base list price per item); the release-readiness price check applies exactly as for the other stores, so a mismatch blocks the tier rather than rounding | `candidate` |
| Offer codes / redeemable promotion codes | **None.** Amazon has no subscriber-redeemable code surface, so every P17 mapping for this channel is recorded `unsupported` with the reason "The Amazon Appstore has no offer codes" (`apps/api/src/services/p17-jobs.ts`, tested); the parent UI says the code cannot be redeemed through that store. Introductory pricing for new subscribers may exist but is not a per-family code and is not used | `candidate` (the absence is asserted in code and must be confirmed in the owner's Amazon console) |
| Webhook store name | RevenueCat sends `AMAZON` in webhooks and `amazon` in the REST subscriber payload; one normalizing function maps both to `amazon_appstore` (BUG-113) | `doc-verified` against the SDK typings; first sandbox webhook to confirm (Owner action #4) |
| Distribution | APK from the `preview-amazon` / `production-amazon` EAS profiles, uploaded by hand (EAS Submit has no Amazon target) | `candidate` |
| Push notifications on Fire OS | No Google services, so no FCM; Amazon Device Messaging would be needed later — none today | `candidate` |

## 2b. RevenueCat webhook event shapes and currencies (billing hardening round 1)

RevenueCat's docs (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields) were not
reachable from this environment (egress policy), so the rows below are `candidate` and are to be confirmed by
the owner against the live docs before the first production webhook (Owner action: lead adds the row).

| Item | What the code does | Evidence |
|---|---|---|
| `TRANSFER` field list (BILL-R1-4) | The body schema is a union: a `TRANSFER` requires non-empty `transferred_from` and `transferred_to` and accepts `app_user_id` / `original_app_user_id` / `aliases` only when present; every other event type requires `app_user_id`. The documented sample is understood to carry exactly `app_id`, `event_timestamp_ms`, `id`, `store`, `transferred_from`, `transferred_to`, `type` — no `app_user_id`, `product_id` or `transaction_id` — and `apps/api/tests/billing-hardening.review.test.ts` posts that shape verbatim. Every family named in either list is re-verified from its own complete provider fetch | `candidate` — confirm the sample's field list, and whether `environment` is present on `TRANSFER` |
| `environment` on `TRANSFER` | A `TRANSFER` that does not state `environment` is still processed: nothing from its payload is written, and each family's fetch is environment-checked by the ledger. Every other event without `environment` is processed only under the sandbox runtime (RV-lead-billing-p17-4 unchanged) | `candidate` |
| Refused shapes | A JSON body the schema refuses is answered 400 and traced once in `billing_provider_events` (status `ignored`, error `UNEXPECTED_SHAPE`, digest + id + type, never the body), so it shows in the admin attention list; a body without an id and type is only counted in the logs | `doc-verified` against the code (tested) |
| Non-USD `currency` / `price_in_purchased_currency` (BILL-R1-5) | Launch is US-only (Owner action #38). A period in another currency is recorded with its currency, audited as `billing.unexpected_currency` (family, channel, currency; no amounts) and left out of every USD revenue sum; the revenue response names the excluded count per channel in its notes. Restricting store availability to the United States is the owner's setting in each store console; the `$1` donation exclusion for such a period is a lead change in the domain (see the hardening report) | `candidate` — confirm that the webhook's `currency` is the purchase currency (ISO 4217) and that `price` is the USD amount |

## 3. Design consequences implemented in code

1. **Internal code first, provider offer second.** A family enters a PencilLift code; the server validates it
   (caps, one redemption per family per campaign, target period, step-up) and only then provisions/selects the
   provider offer. Automatic offer selection by RevenueCat/StoreKit can never grant a school promotion without
   a validated redemption (spec P17).
2. **Per-channel availability.** Each campaign month has `provider_offer_mappings` per channel × tier with status
   `pending | ready | failed | unsupported`. The parent UI shows "not available on this device's store" instead
   of a code that silently does nothing. Apple percentages that aren't price points are `unsupported`.
3. **Smallest compliant alternatives to put to the owner** (not implemented as silent changes):
   Apple — use promotional offers at the nearest *lower* price point only with explicit owner approval, or offer
   only 100% (Free) campaigns on iOS; Google existing subscribers — 100% via defer; partial via web billing where
   policy allows.

## 3a. AI cost assumptions to verify at activation

- `IMAGE_INPUT_TOKEN_BOUND` = 1,500 input tokens per page image (`apps/api/src/jobs/spend-ceiling.ts`) bounds the
  admitted spend estimate (BUG-094). It is unverified (no provider key): check it against the chosen model's
  high-detail image accounting and raise it if a page can cost more.
- Prompt versions in use: extraction.v2, grading.v3, verification.v2, coaching.v1 (`packages/ai/src/prompts.ts`).

## 4. Sandbox evidence still required (blocked on account access)

- [ ] Apple sandbox: existing subscriber redeems offer for next period; second month new offer; 100% twice.
- [ ] Google internal testing: new-subscriber offer; defer for existing subscriber; tier replacement during an offer.
- [ ] Stripe test mode: discount on renewal invoice only; proration invoice between redemption and renewal untouched.
- [ ] RevenueCat: webhook + `GET /subscribers` reflect offer/period dates for each of the above.
- [ ] Amazon App Tester: a subscription purchase on a Fire tablet build reaches RevenueCat as store `AMAZON` and records a billing period; confirm the four list prices and that no code-redemption surface exists.
