# PencilLift: models, family costs and launch budget

**Revision 3, September 15, 2026:** Approved pricing is $39.99/month for the first child plus $9.99/month per additional child. AI and eligible parent commercial features remain in scope. The new table below applies that price to a 30-fresh-daily-set planning scenario; the later original tables retain historical eight-custom-set assumptions and historical example prices for comparison. All costs remain unmeasured. No commercial revenue is deducted.

| Active paid children | Monthly total (USD) |
|---|---:|
| 1 | $39.99 |
| 2 | $49.98 |
| 3 | $59.97 |
| 4 | $69.96 |

### Current AI-centered planning sensitivity

40 pages and 30 freshly generated daily sets per child/month; otherwise the original token/fee assumptions, 1,000 active families and zero ad/affiliate income.

| Children | Approved monthly price | System runtime | Including fees/support/consent | Contribution before overhead |
|---|---:|---:|---:|---:|
| 1 | $39.99 | $11.43 | $20.25 | $19.74 |
| 2 | $49.98 | $22.48 | $32.90 | $17.08 |
| 3 | $59.97 | $33.53 | $45.54 | $14.43 |
| 4 | $69.96 | $44.58 | $58.19 | $11.77 |

Read `PencilLift_Child_Pricing.md` for billing behavior and full limitations. At the assumed 16% percentage fees, a $9.99 sibling adds about $8.39 net revenue against $11.05 modeled incremental runtime in this scenario. The base subscription absorbs that difference; validate actual sibling usage before claiming profitability.

Prepared September 14, 2026. USD. Public prices were checked against vendor documentation. Usage, labor, consent-provider fees and infrastructure allowances are estimates, not quotes or observed production invoices. The app has not yet been built or benchmarked.

## Recommended AI setup

Use **GPT-5.6 Terra for reading scans and structured checking, GPT-6 Astra for original child-facing teaching and difficult cases, and GPT-5.6 Luna for adult summaries**. Reuse validated questions and method templates rather than making a new AI call for every ordinary step. This is the recommended starting design; benchmark handwriting accuracy, subject correctness, safety and actual token usage before launch. Terra is documented as balancing capability and cost, while Astra is the flagship. Both accept images. [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)

| API model | Input / 1 million tokens | Output / 1 million tokens | Role |
|---|---:|---:|---|
| GPT-5.6 Luna | $0.20 | $1.20 | Low-risk adult summaries, catalog tagging |
| GPT-5.6 Terra | $2.00 | $12.00 | Vision extraction, private checking and verification |
| GPT-6 Astra | $10.00 | $50.00 | Original child coaching, new practice/reviews and complex cases |

These are standard short-context rates. The model IDs are `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-6-astra`. Cached-token, cache-write, long-context, priority/fast, regional-processing and tool charges can differ. Do not assume a generic `gpt-6` API name. [Official pricing](https://developers.openai.com/api/docs/pricing), [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

The families use PencilLift accounts, not their own ChatGPT subscriptions. PencilLift pays for its OpenAI API usage. Development-agent subscriptions and development API experiments are separate operator costs.

For children, OpenAI recommends current flagship models and requires ZDR before processing personal data from under-13 users or the applicable digital-consent age. This is why the recommended design reserves Astra for original child teaching. ZDR needs actual account approval/configuration; turning off response storage is insufficient. Confirm model/endpoint/cache eligibility and any commercial terms with OpenAI. No ZDR minimum contract price was verified, so no such fee is fabricated or included below. [Under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance), [Data controls](https://developers.openai.com/api/docs/guides/your-data)

## What a typical family uses in this estimate

Two active children; each child uploads 40 pages/month (two pages on 20 school days). A page averages about eight gradable items; dense pages may cost more. Each child receives five daily questions for 30 days and four subjects of eight Thursday questions across 4.33 weeks. Most daily practice comes from a validated reusable bank; eight custom daily sets per child/month require fresh generation. Each child uses 10 original explanations and 20 follow-up coaching turns. Twenty percent of practice responses require semantic checking; the rest use deterministic answer checks. Five percent of homework pages get an additional Astra escalation. A verifier checks each private grading packet and each original child-facing teaching/practice packet.

These assumptions must be measured in a pilot. They are not unlimited-use entitlements. A cold-start month with no reusable content bank, dense diagrams, many long essays, more subjects or repeated difficult handwriting can cost substantially more. Default family limits should align with the measured cost, not just the profile count.

| Processing stage | Model | Monthly calls / family | Input tokens / call | Billable output tokens / call | Monthly cost |
|---|---|---:|---:|---:|---:|
| Vision extraction | Terra | 80 | 4,000 | 1,200 | $1.79 |
| Private grading | Terra | 80 | 2,500 | 2,000 | $2.32 |
| Original child explanations | Astra | 20 | 1,000 | 1,500 | $1.70 |
| Child follow-up coaching | Astra | 40 | 1,200 | 500 | $1.48 |
| Custom daily practice sets | Astra | 16 | 1,000 | 1,500 | $1.36 |
| Thursday bundles (four subjects each) | Astra | 8.67 | 2,500 | 4,000 | $1.95 |
| Independent verification | Terra | 164.67 | 2,000 | 500 | $1.65 |
| Semantic practice checking | Terra | 115.47 | 1,200 | 300 | $0.69 |
| Additional difficult-case checks | Astra | 4 | 4,000 | 2,000 | $0.56 |
| Adult weekly summaries/catalog match | Luna | 4.33 | 4,000 | 1,000 | $0.01 |
| **Estimated AI subtotal** | | | | | **$13.51** |
| **25% retry/usage uncertainty reserve** | | | | | **$3.38** |
| **AI budget per typical family** | | | | | **$16.89** |

Costs use unrounded values internally. The verifier checks packets, not one independent AI call per question. The counts include both normal and difficult-case requests; an escalation adds cost to the original work. The 25% reserve is a budget margin for retries, token variation and unseen usage, not a guarantee or a second hidden-reasoning multiplier.

Formula: `calls × (input tokens × input price + billable output tokens × output price) / 1,000,000`. Input includes image tokens where relevant. Output includes any billed reasoning, not just the words shown on screen. This model assumes no caching/Batch discount and no paid web search, image generation, hosted code interpreter, audio or SMS. Ordinary arithmetic runs in application code without a separate model-tool fee. Images are billed as input tokens; dimensions/detail affect usage. [Vision cost rules](https://developers.openai.com/api/docs/guides/images-vision)

## Shared operating costs

| Item | Monthly budget | Basis |
|---|---:|---|
| Database/auth/private storage | $25.00 | Supabase Pro starting price; usage/compute can increase |
| API/web/job hosting base | $5.00 | Cloudflare Workers paid minimum; queue/CPU/other services can add cost |
| Mobile build service | $19.00 | Expo EAS Starter plus overages if used |
| Transactional email | $20.00 | Resend Pro, 50,000 emails/month |
| Monitoring | $20.00 | Planning allowance, not a vendor quote |
| Extra backup/staging services | $20.00 | Planning allowance; assess actual restore needs |
| Apple membership allocation | $8.25 | $99/year divided by 12 |
| Domain renewal allocation | $1.67 | Assumed $20/year; actual registrar renewal unknown |
| **Shared monthly baseline** | **$118.92** | Not an infrastructure capacity guarantee |

Sources: [Supabase](https://supabase.com/pricing), [Cloudflare](https://developers.cloudflare.com/workers/platform/pricing/), [Expo](https://expo.dev/pricing), [Resend](https://resend.com/pricing), [Apple enrollment](https://developer.apple.com/programs/enroll/).

Add a planning allowance of **$0.25 per active family/month** for marginal storage/egress/queue/notification usage beyond the shared allocation. This is a reserve estimate, not a published per-family vendor fee. Do not double-count actual overages against both this reserve and an itemized invoice. At roughly 1 MB per normalized page, 80 pages and 30-day raw retention imply about 80 MB of raw images per typical family before derivatives/backups. A thousand similar families would hold about 80 GB; derived images and database growth can push beyond included capacity. Supabase Pro currently includes 100 GB file storage and 100,000 MAU, but families are not MAU: parent and child/device identity design affects that count. [Supabase allowances](https://supabase.com/pricing)

## Monthly cost per family

These historical rows assume **1,000 active families sharing the $118.92 baseline**. Runtime includes the AI reserve, shared allocation and $0.25 marginal allowance. Payment costs depend on the example subscription price in each row; the prices are hypotheses, not market-tested recommendations.

| Usage scenario | Homework pages/month | Runtime before payment fees | Example price | Runtime + store/RevenueCat fees | Including support/consent allowances |
|---|---:|---:|---:|---:|---:|
| Light: one child | 20 | **$5.45** | $24.99 | $9.45 | $11.87 |
| Typical: two children | 80 | **$17.26** | $39.99 | $23.65 | $26.07 |
| Heavy: four children | 240 | **$52.32** | $79.99 | $65.12 | $67.54 |

Light use also halves custom explanations/follow-ups and uses four custom daily sets. Heavy use increases those to 20 explanations, 40 follow-ups and 12 custom daily sets per child. All scenarios keep daily/Thursday practice. The last column adds **$2/month support labor reserve** and a **$5 one-time verified-consent onboarding allowance spread over 12 months ($0.42/month)**. Neither is a vendor quote. Actual consent costs may include setup fees, recurring minimums and additional verification attempts; do not treat $0.42 as an actual monthly invoice.

For the typical two-child workload, sending every modeled AI stage to Astra would increase runtime to approximately **$45.33/family/month**, before payment, consent and support. This comparison keeps the same request counts, including rechecks, rather than assuming flagship usage removes verification. The hybrid estimate is about 62% lower under these assumptions. It is an engineering cost comparison, not measured quality equivalence.

| Number of active families | Typical-family runtime | Shared baseline allocation per family |
|---|---:|---:|
| 10 | $29.03 | $11.89 |
| 100 | $18.33 | $1.19 |
| 1,000 | $17.26 | $0.12 |

At 1,000 typical families, the modeled runtime bill is about **$17,257/month** including the AI reserve. Actual AI subtotal before the reserve is about $13,510/month across those families. Larger server tiers, additional environments, support staff or data-retention contracts can increase the total. Trial users incur runtime even before paying; allocate trial/conversion costs separately. Refresh the calculator as soon as a pilot supplies token counts.

## Store and subscription fees

- Apple Developer Program: **$99/year**. Google Play Console registration: **$25 one time**. Domain purchase is already paid by the owner; renewal remains a separate future expense. [Apple](https://developer.apple.com/programs/enroll/), [Google registration](https://support.google.com/googleplay/android-developer/answer/6112435)
- The example uses **15% store commission**. Apple Small Business Program requires enrollment/eligibility; without the reduced rate, applicable transactions can cost more. Google's current US auto-renewing subscription table shows 10% service plus 5% billing for Play Billing; other regions/programs have their own rules. Verify the actual storefront/account. [Apple small business](https://developer.apple.com/app-store/small-business-program/), [Google service fees](https://support.google.com/googleplay/android-developer/answer/112622)
- RevenueCat is free up to its stated $2,500 monthly tracked-revenue threshold, then lists **1% of tracked revenue**. Model 1% on the tracked total once the threshold applies, not merely the excess. At $39.99, the estimate adds $0.40/family when applicable. [RevenueCat](https://www.revenuecat.com/pricing)
- Optional US web billing with Stripe currently lists **2.9% + $0.30** card processing and **0.7%** Billing usage. At $39.99 this is about $1.74/transaction before additional services/tax, versus $6.00 for a 15% store fee. This is an alternative channel, not an extra charge on the same store purchase. RevenueCat tracking and region-specific app-store rules may still apply. [Stripe Billing pricing](https://stripe.com/billing/pricing)

In the historical illustration with a $39.99 two-child subscription (superseded by the approved $49.98 two-child price), the cost model leaves about **$13.92/family/month** after modeled runtime, 15% store fee, RevenueCat, consent allocation and support reserve. This is contribution before development, marketing, refunds, sales tax effects, insurance, legal work, owner compensation and general overhead. A 30% store fee would reduce that by about $6.00. A $29.99 price would leave only about $5.52 under the same assumptions. Heavy usage requires a higher allowance tier or tighter custom-generation limits; an inexpensive unlimited plan is not supported by this model.

## Up-front and ongoing expenses to plan for

Public store enrollment totals $124 in the first year before local tax, if both are new accounts. Everything below is a planning range, not a quote or required purchase:

| Expense | Planning allowance | Notes |
|---|---:|---|
| Development AI tools/API experiments | $200-$1,500 | Separate from runtime; depends on existing subscriptions and number of build/eval runs |
| Child-privacy/legal/store-policy review | $2,000-$8,000 | Review actual data flows, consent method, terms and vendor contracts |
| Independent engineering/security/release review | $3,000-$12,000 | Review auth, answer protection, purchase flows, deletion and signing |
| Consent-provider setup | $0-$2,000+ | Quote required; minimum commitments may apply; per-family usage is separate |
| Test devices/accessibility/educator testing | $500-$3,000 | Existing hardware/volunteer time may reduce cash spend |
| Initial content bank QA | $500-$3,000 | Original/licensed templates and educator answer review |
| **Subtotal of these planning allowances** | **$6,200-$29,500+** | Plus store enrollment; excludes owner labor and a full contracted build |

A full external software build is an additional vendor-scoped project; obtain a fixed-scope quote using this package rather than treating a prompt as a development-price guarantee. Ongoing engineering/content maintenance could be budgeted initially at **$500-$3,000+/month** as an owner-selected reserve, with staffing adjusted to incident/support demand. This range is not based on a contracted hourly rate. At 1,000 paying families it adds $0.50-$3.00 each; at 100 it adds $5-$30 each. Marketing/customer acquisition, refunds/chargebacks, taxes, accounting, insurance and extra security/legal work remain separate. Actual parent-funded rewards and Amazon purchases are paid by families and are not PencilLift runtime costs.

No affiliate commission is assumed. Amazon's suitability language restricts sites directed toward children or collecting under-threshold children's personal data; a parent-only section does not by itself establish eligibility. Start with ordinary parent-only product links and obtain a policy determination before adding affiliate features. [Amazon Associates policies](https://affiliate-program.amazon.com/help/operating/policies)

## Store readiness and first-build limits

The package instructs the builder to make native iOS and Android apps with real subscription restore, secure backend, background scheduling, reviewer access, account deletion and proper disclosures. Store accounts, identity verification, signing, billing contracts and review decisions are external steps. Apple expects complete metadata, accessible backend and reviewer access. Google has additional requirements for child audiences and AI content reporting, and applicable new personal accounts require a 12-person/14-day closed test. [Apple review](https://developer.apple.com/app-store/review/guidelines/), [Google Families](https://support.google.com/googleplay/android-developer/answer/9893335), [AI reporting](https://support.google.com/googleplay/android-developer/answer/13985936?hl=en), [Google testing](https://support.google.com/googleplay/android-developer/answer/14151465)

COPPA requires appropriate notice, verifiable parental consent, data rights and safeguards for covered under-13 processing. Implementation details and third-party disclosures need review against the current rule. A parental gate is distinct from legally sufficient consent. [FTC compliance guidance](https://www.ftc.gov/business-guidance/resources/childrens-online-privacy-protection-rule-six-step-compliance-plan-your-business)

No prompt can guarantee a perfect first output or app-store approval. This handoff reduces missing requirements by defining the complete scope, schemas, security boundaries, test cases and evidence the coding agent must deliver. The agent should make its own internal test/fix iterations within the same task; the owner should receive a complete, candid release-readiness report rather than discover omitted features afterward.


## Commercial revenue supplement

The revised design includes sponsor cards, conditional affiliate support, an owner campaign console, disclosures and revenue reconciliation. No advertisers, accounts or payouts have been established by this package. The baseline remains zero commercial revenue until real eligibility and campaigns exist. `PencilLift_Revenue_Planner.html` lets the owner test assumptions independently from system costs.

Example only: 40 actually billable parent impressions per active family/month at an assumed $3 publisher eCPM yields $0.12 per family. If 20% of active families each generate $25 of qualifying attributed physical-book revenue at 4.5%, affiliate income averages $0.225 per active family. Combined theoretical revenue is $0.345 per family, or $345 per 1,000 families, before additional selling/administration costs and only if each channel is eligible. Neither traffic nor purchase conversion is measured. Amazon's physical-book commission category is documented in its [rate table](https://affiliate-program.amazon.com/help/node/topic/GRXPHT8U84RAYDXZ); eligibility remains constrained by its [program policies](https://affiliate-program.amazon.com/help/operating/policies).

A separately contracted $500/month sponsor could provide $0.50 per family at 1,000 families before selling/serving costs; $500 is an arithmetic scenario, not a quoted market rate or signed deal. If it buys the same inventory as network ads, replace that inventory's network income instead of counting both. Do not assume advertising makes unlimited AI profitable.
