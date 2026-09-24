# PencilLift: parent ads and affiliate monetization

Revision 3, September 15, 2026. This is a build specification and planning analysis. No ad campaign, affiliate account, store release or revenue has been activated. The owner has approved adding the capabilities while keeping AI central to the learning experience.

## What stays in the product

AI continues to read/check homework, explain mistakes safely, interpret learning patterns, create personalized daily practice and Thursday reviews, and help parents identify useful study resources. Cost controls focus on model routing after evaluation, extracting a page once, bounded context, concise explanations, complete-set generation and explicit usage allowances. Reviewed content supports grounding, correctness and safe fallbacks; it does not replace the AI-centered product. The owner-approved price is $39.99/month for the first child plus $9.99/month per additional child. Validate actual workloads and sibling-plan margins before launch; see `PencilLift_Child_Pricing.md`.

## The revenue design

| Channel | Proposed placement and behavior | Current status |
|---|---|---|
| Direct sponsor cards | Reauthenticated parent dashboard and Resources browsing. Clearly labeled, reviewed education-related creative hosted by PencilLift. | Build campaign administration and delivery; real campaigns require contracts and platform eligibility. |
| Contextual ad network | Future adapter for approved inventory. No child targeting or SDK in the initial build. | Disabled until the actual SDK, configuration, audience and both stores permit it. |
| Amazon Associates | Optional, disclosed study-resource links through an approved property and linking mechanism. | Material eligibility obstacle for this child-directed app; do not assume activation or earnings. |
| Subscription | Native store subscriptions with measured scan/coaching allowances and an ad-free option. | Approved base: $39.99/month including one child; each added child $9.99/month. Separate optional ad-free upgrade pricing remains unspecified. |

Child sessions and unknown-role sessions receive no commercial cards, affiliate links or ad-network requests. The parent can dismiss/report placements. There is at most one commercial card per screen and no interruption of homework, explanations, practice, reviews or reward redemption. Paid ad-free behavior must match the plan description; affiliate cards remain optional and clearly disclosed.

Sponsor selection must not use a child's grades, mistakes, raw homework, school, learning profile or sensitive inferences. Sponsors receive aggregate campaign reporting only. Keep paid placements separate from educational recommendations, and do not increase a product's learning rank because it pays more.

Apple tightly restricts advertising in child-focused apps and allows only limited contextual-ad exceptions; parent placement alone does not establish eligibility. Google has specific child-audience ad/SDK and presentation rules. First-party sponsorship cards are still commercial content and need review. Sources: [Apple guidelines, 1.3, 2.5.18 and 5.1.4](https://developer.apple.com/app-store/review/guidelines/), [Google Families](https://support.google.com/googleplay/android-developer/answer/9893335?hl=en).

## Amazon must be resolved before counting commissions

Amazon's published suitability rules exclude child-directed properties and properties knowingly handling under-threshold children's personal information. A parent PIN, existing Associates ID or separate parent page does not remove that restriction. For this app, assume no affiliate revenue unless Amazon specifically establishes eligibility for the actual property and use.

Eligible mobile participation also requires an approved mobile app, permitted linking tools, free download, free access to Amazon links and no Amazon WebView. Therefore build the complete adapter and its tests, but keep live activation blocked without real evidence. A separate adult website needs its own genuine eligibility assessment; it is not an automatic workaround. [Amazon program and mobile policies](https://affiliate-program.amazon.com/help/operating/policies)

Where authorized, the resource card has an own/authorized description, educational rationale, merchant name, disclosure and deliberate parent outbound action. AI selects reviewed catalog IDs and must not invent products, prices or availability. Use permitted metadata and omit prices unless the actual refresh/license requirements are met. Do not send private learning data to Amazon or put it in outbound URLs. A commercial recommendation based on child learning history needs review against the advertising/data rules before monetizing it; default commercial browsing uses parent-selected context.

Show the required program identification, **“As an Amazon Associate I earn from qualifying purchases.”** Include a clear nearby commission disclosure. [Amazon agreement](https://affiliate-program.amazon.com/help/operating/agreement), [FTC disclosure guidance](https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking)

Keep learning points entirely independent: no points, cashback, subscription discounts or extra scans for ad views, affiliate clicks or purchases. The Amazon program prohibits incentives for using its affiliate links. [Participation requirements](https://affiliate-program.amazon.com/help/operating/policies)

## How much can this offset?

These examples explain the arithmetic. They are not market-rate estimates, measured behavior, signed sponsorships or an eligibility prediction.

| Illustration | Calculation | Monthly revenue per ALL active families |
|---|---|---:|
| Parent network ads | 40 billable impressions/family × assumed $3 publisher eCPM ÷ 1,000 | $0.12 |
| Eligible Amazon physical-book sales | 20% of families × $25 qualifying attributed spend × 4.5% | $0.225 |
| Combined theoretical case | $0.12 + $0.225 | $0.345, about $0.35 |
| Separate fixed sponsorship | Assumed $500 contract ÷ 1,000 active families | $0.50 before selling/serving costs |

Amazon currently lists 4.5% for physical books; other categories differ. A $25 qualifying book purchase yields $1.125 before later adjustments, approximately $1.13 for that purchasing transaction. It is not $1.13 from every family each month. [Commission table](https://affiliate-program.amazon.com/help/node/topic/GRXPHT8U84RAYDXZ)

At 1,000 families, the combined hypothetical ad/book example yields $345/month before incremental costs. If no Amazon eligibility exists, that example loses its $225 affiliate component. If no commercial inventory or campaign is available, commercial revenue is zero. Use actual served, billable impressions and attributed qualifying sales, with reversals; opportunities and clicks are not income.

The fixed-sponsor example substitutes for network revenue on the same sold inventory. Do not add both for those impressions. Direct sponsors can be pitched for a defined placement, term and aggregate reach, but quoted and collected amounts must be tracked separately. Building sponsor sales, reviewing creatives, accounting and support also take time and money.

## Required owner tools and launch checks

- Campaign admin: sponsor, contract/fee, creative approval, placement, schedule, caps, billing status, pause and expiry.
- Clear disclosures, adult gating, dismissal, inappropriate-ad reporting and an ad-free entitlement.
- Global/per-provider/per-campaign disable controls that preserve learning when monetization is unavailable.
- Property/platform eligibility records; approval evidence cannot be replaced by a flag or generic API key.
- Reviewed resource catalog and approved affiliate-link adapter, free adult link access, safe fallback, and no buyer-level child/family tracking.
- Reports separating forecasts, contracts, recognized earnings, cash received, adjustments and incremental costs.
- Tests M01-M20 in the acceptance checklist, including child-mode network isolation, anti-duplication, no reward incentives and revenue reconciliation.

The master prompt now includes these implementation requirements in section 17. `PencilLift_Revenue_Planner.html` is an offline what-if tool; it never establishes approval or imports real income. The original cost calculator/report retain their historical workload assumptions and do not automatically deduct advertising income.
