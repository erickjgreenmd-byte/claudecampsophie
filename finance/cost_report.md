# PencilLift initial cost analysis

Checked September 18, 2026. USD. **Illustrative and unmeasured; not a quote, app benchmark, total launch budget or net-profit forecast.** The approved customer prices are fixed; usage, labor and allowances remain assumptions. No account-specific contract or balance was inspected.

## Published prices to verify against the owner’s accounts

| Service | Published starting rate / relevant charge | Limitation and source |
|---|---|---|
| Claude Code | Pro $20/month monthly; Max starts at $100/month | Usage limits apply; API/extra usage can be separate. Development tool, not per-family runtime. [Claude](https://claude.com/pricing) |
| Expo EAS | Starter $19/month with $45 build credit; Production $199/month with $225 build credit | Additional usage billed; choose from measured build/update needs, not the plan name. [Expo](https://expo.dev/pricing) |
| Supabase | Pro $25/month; $10 organization compute credit | One Micro fits the credit; two Micro projects model $35/month before overages. Storage, egress, bigger compute and backup options add cost. [Supabase](https://supabase.com/pricing) |
| Cloudflare Workers | Paid minimum $5/month | Requests/CPU, Queues and other services require their own usage calculation. [Workers](https://developers.cloudflare.com/workers/platform/pricing/) |
| RevenueCat | Free up to stated $2,500 MTR threshold, then 1% of tracked revenue | Illustration charges the whole tracked total at $2,500 or above conservatively; confirm boundary/legacy terms. [RevenueCat](https://www.revenuecat.com/pricing) |
| Apple membership | $99/year | Actual annual cash payment; $8.25/month allocation only in accrual view. [Apple](https://developer.apple.com/programs/enroll/) |
| Google registration | $25 once | Do not repeat if already paid. [Google](https://support.google.com/googleplay/android-developer/answer/6112435) |
| Native subscription fees | 15% baseline; 30% stress assumption | Apple reduced rate requires applicable eligibility/enrollment. Current US Google auto-renewing table is 10% service plus 5% Play Billing. Verify account, storefront and agreements. [Apple](https://developer.apple.com/app-store/small-business-program/), [Google](https://support.google.com/googleplay/android-developer/answer/112622) |
| Optional US Stripe web billing | Domestic cards 2.9% + $0.30; Billing pay-as-you-go 0.7% | Model both when applicable; international, tax, disputes, external-link programs and other products may add fees. [Payments](https://stripe.com/en-us/pricing), [Billing](https://stripe.com/billing/pricing) |
| Consent, child-data contract terms, security/privacy review and labor | Unknown | Obtain real scope/quotes. The allowances below do not establish actual provider fees or eligibility. |

OpenAI standard short-context input/output prices per million tokens: Astra **$10/$50**, Terra **$2/$12**, Luna **$0.20/$1.20**. Other billing modes can differ. The illustration uses no cache, Batch, fast-mode or regional discount/uplift; confirm the selected project configuration. [Official model pricing](https://developers.openai.com/api/docs/pricing)

## Development and launch cash

One selected month of Pro ($20), EAS Starter ($19), Supabase with two Micro projects ($35) and Workers ($5) is **$79 in listed base charges**. With Max starting at $100, the same subtotal starts at **$159**. If both store registrations are still unpaid, add $124: **$203 or $283** for those selected first-month items only. Existing paid items reduce incremental cash due; they do not remove future renewals.

**These are not the cost of building or launching PencilLift.** Add development API usage, implementation/owner hours, consent setup, independent security and privacy review, educator testing, devices, email, monitoring, backups and any provider contract. Their actual cost is unresolved. Quote each line before presenting a total. A three-month development period would multiply recurring development charges by three but not repeat one-time Google registration. Domain purchase is already paid; verify renewal timing.

A provisional shared monthly operating allowance is **$128.92**: Supabase $35 + Workers $5 + EAS $19 + assumed email $20 + assumed monitoring $20 + assumed backup services $20 + Apple $8.25 allocation + assumed domain $20/12. The last four service/domain allowances are not verified invoices; backup scope and extra compute must be checked. Development Claude/API spend, AI serving, support, consent, marketing and unknown contracts are additional. This baseline is not a capacity guarantee and is deliberately not subtracted from the scale tables as if it could serve every scale.

## Workload assumptions per child per average month

| Scenario | Pages | Original explanations | Follow-ups | Fresh daily sets | Thursday subjects |
|---|---:|---:|---:|---:|---:|
| Light | 20 | 5 | 10 | 30 | 4 |
| Typical | 40 | 10 | 20 | 30 | 4 |
| Heavy | 80 | 20 | 40 | 30 | 4 |

All scenarios retain five daily questions and eight Thursday questions per enabled subject, with 52/12 weeks/month. Semantic checking: 20% of practice responses. Extra difficult-page checks: 5% of pages. Verification is separately budgeted for homework, explanations, follow-ups, daily sets, longer Thursday bundles, semantic practice results and escalated results. A verifier must receive the full relevant context; an undersized token allowance cannot justify truncating its evidence. The adult summary is one family packet/week. A child count does not multiply that family packet.

## Typical two-child AI detail

| Stage | Model | Calls/month | Input/call | Billed output/call | Expected cost |
|---|---|---:|---:|---:|---:|
| Vision extraction | terra | 80.00 | 4,000 | 1,200 | $1.79 |
| Private grading | terra | 80.00 | 2,500 | 2,000 | $2.32 |
| Original explanations | astra | 20.00 | 1,000 | 1,500 | $1.70 |
| Follow-up coaching | astra | 40.00 | 1,200 | 500 | $1.48 |
| Fresh daily sets | astra | 60.00 | 1,000 | 1,500 | $5.10 |
| Thursday bundles | astra | 8.67 | 2,500 | 4,000 | $1.95 |
| Homework verification | terra | 80.00 | 4,000 | 600 | $1.22 |
| Explanation verification | terra | 20.00 | 2,500 | 500 | $0.22 |
| Follow-up verification | terra | 40.00 | 2,000 | 500 | $0.40 |
| Daily-set verification | terra | 60.00 | 3,000 | 600 | $0.79 |
| Thursday verification | terra | 8.67 | 6,500 | 1,000 | $0.22 |
| Semantic practice checks | terra | 115.47 | 1,200 | 300 | $0.69 |
| Semantic result verification | terra | 115.47 | 1,800 | 300 | $0.83 |
| Difficult-page escalation | astra | 4.00 | 4,000 | 2,000 | $0.56 |
| Escalated result verification | terra | 4.00 | 6,000 | 700 | $0.08 |
| Adult weekly summary | luna | 4.33 | 4,000 | 1,000 | $0.01 |

Expected AI: **$19.36**; separate 25% uncertainty budget: **$4.84**; combined AI budget: **$24.20 per two-child family/month**. These are calculations from assumed calls/tokens, not observations. Input includes images and billed output includes reasoning. No additional per-image or reasoning multiplier is added.

## Family economics at the approved prices

Assumes 1,000 identical paying families, 15% native fee, applicable 1% RevenueCat fee, zero commercial revenue, 1% gross refund allowance, $2 support/family, $5 consent allowance allocated over 12 months and $0.25 other variable allowance/family. Refunds conservatively do not reduce modeled fee bases. Actual refund treatment and consent charges must be reconciled. The last column is after AI contingency, before fixed overhead and unpriced costs; it is not net profit.

| Usage | Children | Price | Expected AI | AI reserve | Channel + RC fees | Other variable allowances | Remaining before fixed/unpriced costs |
|---|---:|---:|---:|---:|---:|---:|---:|
| Light | 1 | $39.99 | $7.24 | $1.81 | $6.40 | $3.07 | **$21.47** |
| Light | 2 | $49.98 | $14.48 | $3.62 | $8.00 | $3.17 | **$20.72** |
| Light | 3 | $59.97 | $21.71 | $5.43 | $9.60 | $3.27 | **$19.97** |
| Light | 4 | $69.96 | $28.94 | $7.24 | $11.19 | $3.37 | **$19.22** |
| Typical | 1 | $39.99 | $9.68 | $2.42 | $6.40 | $3.07 | **$18.42** |
| Typical | 2 | $49.98 | $19.36 | $4.84 | $8.00 | $3.17 | **$14.62** |
| Typical | 3 | $59.97 | $29.04 | $7.26 | $9.60 | $3.27 | **$10.81** |
| Typical | 4 | $69.96 | $38.71 | $9.68 | $11.19 | $3.37 | **$7.01** |
| Heavy | 1 | $39.99 | $14.57 | $3.64 | $6.40 | $3.07 | **$12.31** |
| Heavy | 2 | $49.98 | $29.13 | $7.28 | $8.00 | $3.17 | **$2.40** |
| Heavy | 3 | $59.97 | $43.69 | $10.92 | $9.60 | $3.27 | **-$7.51** |
| Heavy | 4 | $69.96 | $58.25 | $14.56 | $11.19 | $3.37 | **-$17.42** |

**Sibling economics:** each extra typical-use child reduces budgeted monthly contribution by approximately **$3.80** in this illustration. The $9.99 add-on leaves $8.39 after 15% + 1% fees, before extra AI/refund costs. This does not prove the price is wrong; it identifies a measurement and operating-budget decision. Keep the approved price until the owner changes it. With the separate uncertainty reserve, heavy families can have negative budgeted contribution before fixed overhead. Distinguish that downside budget from expected spend without the reserve.

## Payment-route sensitivity: typical workload

| Children | Native 15% + RC | Native 30% + RC | Direct web Stripe + Billing + RC |
|---|---:|---:|---:|
| 1 | $18.42 | $12.42 | $22.68 |
| 2 | $14.62 | $7.12 | $20.01 |
| 3 | $10.81 | $1.82 | $17.35 |
| 4 | $7.01 | -$3.49 | $14.68 |

All figures are budgeted contribution per family before fixed/unpriced costs. Web is an eligible direct adult website hypothetical, not a claim that native link-outs are allowed or exempt from store program fees. It assumes RevenueCat tracks those web subscriptions. Native rows contain no Stripe fee. Compare actual route eligibility, conversion, taxes and fees before enabling web checkout.

## Scale and mixed-family view

Illustrative family mix: 40% one child, 30% two, 20% three, 10% four (average two children). Every family has typical usage here. RevenueCat threshold is applied once to the blended account total, not separately per cohort. These totals show the budget available for shared services and unpriced costs; they do not assert an infrastructure plan can support the load. Reassess annual Apple program eligibility at higher scale rather than extrapolating a reduced fee indefinitely; the 30% sensitivity remains separate.

| Paying families | Gross/month | Budgeted contribution before fixed/unpriced costs |
|---|---:|---:|
| 10 | $499.80 | $151.15 |
| 100 | $4,998.00 | $1,461.54 |
| 1,000 | $49,980.00 | $14,615.37 |
| 10,000 | $499,800.00 | $146,153.67 |

The JSON includes all 144 combinations of 4 scales × 4 child counts × 3 usage levels × 3 payment routes, plus 36 mixed-family rows. A full operating forecast must add the measured infrastructure/support step costs and unpaid usage. No 10,000-family net-profit number is supplied because those inputs are not known.

## Partial break-even sensitivity

Two children, typical use, native 15%, no commercial revenue, including the above allowances and AI contingency. Hypothetical fixed monthly expense inputs below are not vendor quotes. Recompute RevenueCat threshold at each candidate count. Other unknown expenses and acquisition costs remain excluded.

| Hypothetical fixed monthly expense | First family count covering it in this partial model |
|---|---:|
| $500.00 | 34 |
| $2,000.00 | 137 |
| $10,000.00 | 685 |

No reliable total launch budget, first-year cash requirement or net profitability conclusion is possible yet. Next inputs: actual development/review quotes, consent/ZDR commercial terms, measured AI usage and quality, the family/usage/payment mix, verified store price availability, paid acquisition and retention, and infrastructure capacity tests. Section F of the master prompt requires Claude to obtain or explicitly model these inputs and update the report.
