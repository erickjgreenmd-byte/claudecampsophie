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

## 4. Sandbox evidence still required (blocked on account access)

- [ ] Apple sandbox: existing subscriber redeems offer for next period; second month new offer; 100% twice.
- [ ] Google internal testing: new-subscriber offer; defer for existing subscriber; tier replacement during an offer.
- [ ] Stripe test mode: discount on renewal invoice only; proration invoice between redemption and renewal untouched.
- [ ] RevenueCat: webhook + `GET /subscribers` reflect offer/period dates for each of the above.
