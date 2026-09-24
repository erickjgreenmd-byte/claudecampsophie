# PencilLift approved child pricing

Revision 3, September 15, 2026. **$39.99 USD/month for the first child, plus $9.99/month for each additional child on the same parent account.** This is a specification update; no subscription products, charges or app-store release have been activated.

| Active paid children | Monthly total (USD) |
|---|---:|
| 1 | $39.99 |
| 2 | $49.98 |
| 3 | $59.97 |
| 4 | $69.96 |

Use `3999 + 999 × (paid children − 1)` in integer cents for one or more paid child slots. The first child is included in the $39.99 base. No additional family-account fee applies. Monthly billing is the agreed cadence; these are the approved USD subscription amounts before any separately applicable tax. Store checkout must show actual localized totals.

## Parent account and child profiles

Each paid child gets their own homework, AI coaching, skill progress, daily questions, Thursday reviews, points and parent-managed rewards. Two guardians may manage the same family subscription. Initially implement 1-4 paid slots, with configurable capacity tiers for future expansion. Draft and archived profiles do not by themselves create recurring charges. Prototype allowance: 40 homework pages per paid child/month plus the specified practice and bounded coaching; validate this proposed allowance before advertising final limits.

The parent selects Add child. An unused paid slot can be assigned immediately after consent/authorization. If more capacity is needed, display the new total and store-provided charge/timing details, require parent confirmation and verify the purchase before activating a slot. A child cannot purchase. Failed or pending purchases must not grant extra access.

Downgrades follow the store-confirmed effective date and let the parent choose active profiles. Retain inactive children's history, exports and earned rewards according to the retention policy; stop paid AI for profiles without an active slot. Archiving/deleting a profile alone does not cancel its store billing or claim a lower price. Restore and webhook reconciliation must update paid capacity as well as subscription status.

## Store implementation

Use capacity products mapped server-side to paid slots, not repeated quantity purchases of one subscription. Apple allows one active subscription per group; put the capacity tiers in one group. Use verified Google replacement flows for changes. See [Apple subscription groups](https://developer.apple.com/help/app-store-connect/manage-subscriptions/offer-auto-renewable-subscriptions/) and [Google subscription replacements](https://codelabs.developers.google.com/codelabs/play-billing-subs-replacement).

The exact totals above remain the owner's approved target. Apple uses predefined price points, so confirm $49.98/$59.97/$69.96 availability in the actual catalogs before product activation. Never silently round or advertise an unavailable checkout price. If unsupported, report the exact mismatch after completing the reviewable implementation. See [Apple subscription pricing](https://developer.apple.com/help/app-store-connect/manage-subscriptions/manage-pricing-for-auto-renewable-subscriptions/).

Proration, due-now charges, upgrade timing and renewal dates come from the provider. Do not promise that adding a child always charges exactly $9.99 immediately; that is the additional monthly recurring amount. Reconcile concurrent guardian requests, restored purchases and cross-platform ownership without duplicate subscriptions.

## Cost sensitivity at the approved price

The current planning example assumes **40 homework pages and 30 freshly generated daily sets per child/month**, 10 original explanations and 20 coaching turns, plus the existing Thursday/verification assumptions. It retains the dated token estimates and rates, 25% AI reserve, 1,000 active paying families, 15% store fee, 1% RevenueCat where applicable, $2 support and $0.42 amortized consent allowance per family. These are unmeasured assumptions, not vendor invoices or proven AI quality. Ads and affiliates contribute **$0** here.

| Children | Monthly revenue | Modeled system cost | Including fees/support/consent | Contribution before overhead |
|---|---:|---:|---:|---:|
| 1 | $39.99 | $11.43 | $20.25 | $19.74 |
| 2 | $49.98 | $22.48 | $32.90 | $17.08 |
| 3 | $59.97 | $33.53 | $45.54 | $14.43 |
| 4 | $69.96 | $44.58 | $58.19 | $11.77 |

Contribution still has to cover development, maintenance, marketing, refunds, tax effects and owner compensation. The shared starting plans are not a capacity guarantee. This table cannot establish actual business profit. Costs may rise for heavy usage, more subjects, longer outputs, onboarding or child-specific support/consent fees.

The earlier **$17.26** runtime estimate was for two children with only eight freshly generated daily sets per child, plus reusable practice. At the newly approved two-child price of $49.98 that original scenario leaves about $22.31 before overhead. With 30 fresh daily sets under otherwise unchanged assumptions, the table above models $22.48 runtime and $17.08 contribution for two children. Neither has been measured.

Each additional child's $9.99 adds about $8.39 after the assumed 16% percentage fees. Modeled additional runtime is about $11.05 in the 30-fresh-set scenario, so the base plan subsidizes added children by roughly $2.66 each before additional support. Validate sibling usage and gross margins in the pilot; do not claim the add-on is independently profitable or count hypothetical ads/affiliate commissions to make it so.

The offline Cost Calculator defaults to the current 30-fresh-set scenario and recalculates the family price when the child count changes. Its Light/Heavy buttons change workload assumptions, not the approved pricing rule. The Revenue Planner separately explores hypothetical commercial offsets.
