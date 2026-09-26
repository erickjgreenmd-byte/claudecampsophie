# PencilLift cost analysis — working report (spec F, AC_FIN_*)

Revision: 2026-09-24 (builder session 1). Supersedes nothing; the owner's `finance/cost_report.md` and
`finance/promo_school_report.md` (2026-09-18) remain the baseline and are reproduced unchanged.

**Status: illustrative and unmeasured.** No PencilLift AI call, database, build or store transaction has
run yet, so there is no measured usage (`docs/Measured_Usage.md` is empty on purpose). Nothing here is
net profit, a quote, or spending authorization.

## 1. Reproducibility (evidence)

| Command | Exit | Result |
|---|---|---|
| `python3 finance/cost_model.py --check` | 0 | "Passed: price tiers, account threshold, fee separation, arithmetic reconciliation, heavy loss, mix and break-even boundaries." |
| `python3 finance/promo_school_model.py --check` | 0 | "Promo/school planning arithmetic checks passed; app behavior remains unimplemented." |
| `python3 finance/cost_model.py` + `promo_school_model.py` | 0 | Regenerated `cost_report.md`, `scenario_results.json`, `promo_school_*` **byte-identical** to the package (`git status` clean) |

CI runs both `--check` commands (`pnpm finance:check`).

## 2. Price evidence (F2)

| Rate | Value used | Source | Evidence status |
|---|---|---|---|
| OpenAI gpt-6-astra / gpt-5.6-terra / gpt-5.6-luna | $10/$50, $2/$12, $0.20/$1.20 per 1M input/output | developers.openai.com pricing, checked by package author 2026-09-18 | `verified_public` (2026-09-18). **Not re-verified 2026-09-24:** egress to developers.openai.com is blocked here |
| Native store fee | 15% base, 30% stress | Apple SBP / Google table, package 2026-09-18 | `verified_public`; account eligibility unverified |
| RevenueCat | 1% of tracked revenue at ≥ $2,500 MTR | revenuecat.com/pricing, 2026-09-18 | `verified_public`; contract unverified |
| Stripe | 2.9% + $0.30 + 0.7% Billing | stripe.com, 2026-09-18 | `verified_public`; route hypothetical |
| Supabase / Workers / EAS / Apple / Google | per `finance/cost_report.md` | package 2026-09-18 | `verified_public`; account plans unverified |
| **Apple USD price points** | $0.50 steps $10–$50, $1 steps $50–$200 | [Apple newsroom 2022-12](https://www.apple.com/newsroom/2022/12/apple-announces-biggest-upgrade-to-app-store-pricing-adding-700-new-price-points/) | `secondary` (newsroom + press); confirm in App Store Connect |
| Consent (VPC) provider, security/privacy review, educator review, legal, labor | — | — | **`unknown`** — never zero |

## 3. Verdict: what the numbers say (F1.7)

Figures are per family per month, typical workload, 15% native fee + RevenueCat, zero commercial revenue,
before fixed and unpriced costs, from the owner's calculator (`scenario_result`).

| Tier | Price | Non-AI variable costs | Max expected AI to break even (no reserve / with 25% reserve) | Assumed AI: typical / heavy |
|---|---:|---:|---:|---:|
| 1 child | $39.99 | $9.46 | $30.53 / $24.42 | $9.68 / $14.57 |
| 2 children | $49.98 | $11.16 | $38.82 / $31.05 | $19.36 / $29.13 |
| 3 children | $59.97 | $12.86 | $47.11 / $37.69 | $29.04 / **$43.69** |
| 4 children | $69.96 | $14.56 | $55.40 / $44.32 | $38.71 / **$58.25** |

Findings, in order of consequence:

1. **Siblings lose money at typical usage.** Each additional child changes expected contribution by
   **−$1.38/month before contingency** and **−$3.80 with the 25% reserve**. The $9.99 add-on leaves $8.29
   after 16% fees and 1% refunds; a typical child is assumed to cost $9.68 in AI. The whole family is
   still positive, but every sibling added reduces it. Price is owner-approved and unchanged; the lever is
   measured per-child AI cost.
2. **Heavy 3–4 child families are negative.** Heavy 3 children exceed the reserve-adjusted ceiling; heavy
   4 children ($58.25) exceed even the no-reserve ceiling ($55.40). Quotas (P11) and stage cost caps are
   therefore release requirements, not optimizations.
3. **At a 30% native fee, typical 4-child families are negative (−$3.49).** Small Business Program
   eligibility is worth verifying early.
4. **Promotions are the largest controllable loss.** A two-child family on a 100% month costs about
   −$26.87 in budgeted contribution; 50% off is −$5.88. Repeated monthly 100% codes are an open-ended
   subsidy. The code enforces a positive budget cap on every campaign template (no unlimited budgets) and
   stops new redemptions at the cap without revoking confirmed benefits.
5. **iOS cannot charge three of the four approved totals** (see `docs/Provider_Capability_Matrix.md`).
   Revenue impact of the nearest points is cents per family; the real cost is an owner decision and
   possible price inconsistency across channels (AC_CAPACITY_11).
6. **No finite break-even can be stated.** Fixed costs, labor, consent, security review and acquisition
   are unknown. The package's partial break-even (34 / 137 / 685 two-child families for $500 / $2,000 /
   $10,000 fixed monthly) stays partial.

Metering of failed attempts (JOBS-R1-03, round 2b): a provider attempt whose usage is unknown (our timeout, a
network failure or a 5xx answer) is metered at its upper-bound estimate and counts against the stage cap and the
monthly ceiling, because the provider may still bill it. Recorded spend can therefore run above the provider's bill
during an outage; it never runs below it. After one timed-out extraction attempt at most one more fits the stage
cap, so a slow provider fails a scan sooner rather than spending past the cap.

Stage ceilings raised in round 5 (BUG-252): extraction and grading go from 150,000 to **216,816 micro-USD**
(`EXTRACTION_GRADING_COST_MICROS`). The reason is not appetite but reachability — at 150,000 the one raised retry
after a truncated answer did not FIT from 7 pages up, so a scan inside the product's own ten-page limit was cut off
and failed with `SCAN_TOO_MANY_QUESTIONS` although every comment in the code promised a retry. 216,816 is the exact
arithmetic for a full retry at ten pages (4E + 144,000 at E = 18,204 input tokens), not a round number.

What this costs, precisely: **nothing per scan that succeeds.** The ceiling is a cap, and the per-scan spend HOLD it
sizes (`scan-process.ts`'s `spending()`) settles to actual usage (`settleSpend`), so the raise moves a transient
reservation, not money: extraction's hold goes 150,000 → 216,816 and grading+verification's 250,000 → 316,816
micro-USD. The one real effect is at the monthly ceiling — a family within ~67,000 micro-USD (about 6.7 cents) of
their remaining budget can now be told to wait for a scan they could in fact have afforded. Against that, a scan
that used to die after one billed generation now finishes.

Known gap, deliberate and owner-visible (owner action #46): grading is bounded by QUESTIONS, not pages, because it
sends no image. On the same ceiling the full retry is reachable to about 85 questions of average length and to none
past about 149 — and the count moves with question length, since the bound is in bytes. So a ten-page worksheet of
dense questions can still be cut off in grading with no retry. Closing that needs a further ceiling raise, which is
a cost decision, not a code change; `apps/api/tests/jobs-r2.review.test.ts` states the measured numbers and names
the limit in the case that pins it, rather than implying coverage it does not have.

## 4. What measurement would change the conclusion

| Measurement | Why it matters | How it will be captured |
|---|---|---|
| Actual tokens per homework page (vision + grading + verification) | Largest AI line; drives sibling margin | `usage_events` table with model, stage, input/cached/output tokens, micro-USD (P12) |
| Fresh daily-set generation cost | $5.10 of the $19.36 two-child typical AI | Same, stage `daily_set` |
| Unreadable/retry rate | Retries cost money even with no child result | Failed billed attempts are recorded, not dropped |
| Truncated-answer rate (JOBS-R2-02) | An answer cut off at the output budget used to be re-sent unchanged ten times — ten billed calls for one scan. The stage budget is now raised once and a second truncation ends the scan with a parent-facing code, so the worst case is two calls, not ten | `ai_usage_events` per stage plus the `SCAN_TOO_MANY_QUESTIONS` count on assignments |
| Redemption and repeat-redemption rates | Promotion subsidy | `promo_redemptions` confirmed rows × discount cents |
| Store fee tier actually granted | 15% vs 30% | Store agreements |

## 5. Unknown expenses that must be quoted (never zero)

Implementation and owner time; verifiable-parental-consent provider (setup + per-verification);
OpenAI ZDR/child-data terms; independent security and privacy review; educator evaluation of AI
teaching; privacy/terms legal review; accountant/tax; device testing; email/push/monitoring/backup
services beyond the allowances; paid acquisition; school payout transfer fees; fraud loss on promotions.
