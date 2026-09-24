# Monthly promotions and school contribution cost extension

Planning illustration dated September 18, 2026. Base prices and usage assumptions are unchanged. Each newly redeemed monthly code may grant another discounted month; a prior code never renews itself. The baseline cost_report.md excludes promotions and school contributions. Use this extension for those cohorts.

## Two-child family illustration

Typical assumed usage, 100 identical families, native 15% fee, one designated school, owner-approved full-price-only donation policy, no other tracked account revenue. Contribution includes the existing AI reserve and variable allowances, before fixed and unpriced costs.

| Discount this period | Family charge | School contribution/family | Budgeted contribution/family | Next period without a new code |
|---|---:|---:|---:|---:|
| 0% | $49.98 | $1.00 | $13.62 | $49.98 |
| 5% | $47.48 | $0.00 | $12.54 | $49.98 |
| 25% | $37.49 | $0.00 | $4.25 | $49.98 |
| 50% | $24.99 | $0.00 | -$5.88 | $49.98 |
| 75% | $12.50 | $0.00 | -$16.37 | $49.98 |
| 100% | $0.00 | $0.00 | -$26.87 | $49.98 |

## Repeated monthly redemptions

For a two-child family: a 50% code for one monthly period charges $24.99; a newly entered valid 50% code for the next period charges $24.99 again; with no new code the following period charges $49.98. The cost model must not assume every family returns to full price in month two. A new valid 100% code every month can produce continuing zero revenue while service expenses continue.

## Approved donation rule

Each family supports one school. A settled full-price monthly subscription period generates $1; ANY discount generates $0, including 5%, 50% and 100%. A subsequent full-price renewal restores eligibility. Discounted families remain in school signup counts. The dated ledger assigns each eligible billing period to its start month and prevents duplicate family/month accruals. These steady-state financial scenarios do not implement billing events or the ledger.

The JSON contains 864 scenarios across four scales, four child tiers, six discount cases, three channels, three workloads, one school and the full-price-only donation policy. Zero means a regular-price period. All whole discount percentages from 5 to 100 are accepted by the calculator. Provider catalogs may not represent every exact percentage; this arithmetic is not a verified native offer catalog.

RevenueCat uses account-level thresholds. These scenarios assume no other tracked account revenue; outcome() accepts other_tracked_revenue for marginal account-fee calculations. Production forecasts must aggregate the actual mixture of full-price and discounted receipts before applying fees. Web examples charge no transaction fee for a zero-dollar period; actual contracts, fixed provider charges, taxes and native promotional rules must be verified. No native/web fees are stacked.

Usage, support and consent allowances remain illustrative. School transfer fees, administration, fraud loss, campaign implementation labor, provider quotas and taxes remain unpriced; net profit is unknown. Budget campaigns on redeemed discounts plus ongoing service and donation costs, not merely code counts. A budget cap stops future issuance/redemption; it must not revoke an already confirmed benefit. Show 3/6/12-month cohorts, monthly redemption and retention rates, 100% repeat-redemption exposure, monthly school accruals and cash payout timing after actual data is available.
