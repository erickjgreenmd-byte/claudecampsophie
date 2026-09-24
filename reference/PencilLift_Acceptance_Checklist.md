# PencilLift acceptance and release checklist

Each item starts **not tested**. The builder must add code/test references and real evidence; this file is not a claim that the app has been built or tested. A blocked test stays blocked. Use synthetic family data by default.

| ID | Required observable outcome |
|---|---|
| A01 | A verified parent can create a family; an unverified or nonconsenting adult cannot start child-data processing. |
| A02 | Consent integration returns a verifiable provider result, version, time and scope. A checkbox/PIN alone cannot grant the production consent state. |
| A03 | Under-13 personal-data API calls are blocked when ZDR approval/configuration is absent. `store:false` or a forged client flag cannot bypass the block. |
| A04 | A parent creates two synthetic children; each device pairing binds only to the selected child. Codes expire, are single-use and resist guessing. |
| A05 | A child cannot enumerate or read a sibling's or another family's assignments by replacing any ID in requests or storage paths. |
| A06 | A child cannot create an adult session by changing a local role, calling the solution API, replaying a stale code, or claiming to be a parent. |
| A07 | Switching to child mode erases parent data from navigation history, offline caches, query stores and shared web state; returning requires fresh proof. |
| A08 | Parent PIN rate limits, reset/recovery and biometric fallback work; device revocation stops refresh and privileged access. |
| A09 | Guardian invitations require verified acceptance. Removal immediately invalidates access and pending privileged actions. |
| A10 | Consent withdrawal stops uploads/jobs; parent deletion removes active data and schedules documented backup expiry. Jobs cannot resurrect deleted records. |
| C01 | Camera, photo picker and PDF import work with permission denied, offline upload, interrupted upload and resume. |
| C02 | File signature, byte/page limits and image dimensions are validated; malformed PDFs, decompression bombs and unexpected files fail safely. |
| C03 | Rotation, handwriting, fractions, exponent placement, units and multi-page numbering are represented correctly in test fixtures. |
| C04 | Blur, missing passage, glare and cropped-off questions produce rescan/review states instead of invented grades. |
| C05 | Parent transcription corrections retain provenance and trigger only necessary rechecking. |
| C06 | Duplicate upload/finalize events create one job and one quota charge; permanently failed unreadable scans release reservations. |
| C07 | Model outage/timeout retries are bounded, visible and idempotent; failed processing is never shown as a successful check. |
| G01 | Mixed-correctness homework maps each student answer to the right question and distinguishes unanswered, correct, incorrect and unresolved. |
| G02 | Equivalent fractions, units, rounding and alternative valid methods pass appropriate deterministic checks. |
| G03 | Subjective writing receives rubric feedback, not a false binary grade or generated essay for the child to copy. |
| G04 | Verifier disagreement triggers a documented escalation/review route; confidence alone cannot override conflicting evidence. |
| G05 | Parent sees complete solutions only after server-verified recent reauthentication. |
| G06 | Child API responses, HTML/mobile bundles, cache, push payloads, logs and realtime events contain no withheld key/solution fields. |
| G07 | Child hints teach a method without final values/letters/spelling targets. Analogous worked examples do not reveal the target result. |
| G08 | Image-text prompt injections, fake-parent requests, encodings, translation requests, malicious URLs and tool instructions do not leak solutions. |
| G09 | Repeated target-answer guesses hit the defined limit and redirect to practice/parent help; resubmission does not reset the limit trivially. |
| G10 | Parent grading override is audited and changes learning evidence without silently corrupting or unfairly clawing back rewards. |
| G11 | Benchmark reports false-right, false-wrong and abstention/coverage by subject. Proposed >=98% objective precision is demonstrated or release is blocked. |
| G12 | Educator review checks explanation correctness and developmental fit; model-judge scores alone are insufficient. |
| L01 | Initial accuracy and eventual post-hint success remain distinct. Repeated attempts on one item do not inflate mastery sample size. |
| L02 | Fewer than five distinct independent examples displays insufficient evidence; skill mastery requires independent success across sessions. |
| L03 | Daily practice is available every local day including weekends; vacation/quiet-hour controls work without point loss. |
| L04 | Daily selection follows weak-skill/spaced-review/confidence mix; grade-level fallback works with no upload history. |
| L05 | All six subject areas have meaningful usable content or clearly identified unsupported coverage; no fake content completion. |
| L06 | Generated questions have private validated keys; invalid/unsolvable/ambiguous generated items never reach the child. |
| L07 | Thursday review covers enabled subjects and prioritizes weekly errors. Teacher test scope and subject-specific dates affect selection. |
| L08 | Thursday jobs run with the app closed, honor IANA time zones and DST, and do not duplicate on worker retries. |
| L09 | Late uploads produce optional versioned top-ups without overwriting completed work or awarding twice. |
| L10 | Parent PDF contains a protected key; child PDF has questions only and cannot be switched to include a key by modifying a parameter. |
| R01 | Earned points, bonus rules and caps match the published family rules; empty/rapid retries do not farm points. |
| R02 | Two simultaneous devices cannot redeem the same points; ledger entries have unique constraints and atomic balance checks. |
| R03 | Approve/decline/cancel/fulfill transitions are idempotent and refund reserved points exactly once where applicable. |
| R04 | Cash-style rewards are parent-fulfilled records; no actual payment or unauthorized Amazon purchase occurs. |
| R05 | Parent adjustments carry a reason and append-only record; totals reconcile after reversals. |
| P01 | Catalog suggestions are tied to learning skills with rationale, and include free practice alternatives. |
| P02 | AI returns only valid reviewed catalog IDs; invented ASINs, prices, links and expired products are rejected. |
| P03 | Amazon links are parent-only, contain no child identifiers/skill-history payloads, and work without an affiliate account. |
| P04 | Requested affiliate implementation works with approved-tool test fixtures; live use stays blocked without specific property/mobile eligibility. No child tracking SDK is present. |
| B01 | Sandbox Apple/Google purchases create server-verified entitlements on the correct parent account. |
| B02 | Restore on another device works; pending/Ask to Buy does not unlock paid usage prematurely. |
| B03 | Renewal, cancellation, grace, billing retry, expiry, refund and revocation produce correct access states. |
| B04 | Duplicate/out-of-order webhooks reconcile to current provider state and do not double-grant access or reset quotas. |
| B05 | Child cannot purchase, modify subscriptions, forge paid state or bypass quotas; no surprise overage billing. |
| B06 | Web/store entitlements synchronize if optional web billing is enabled; the same transaction does not incur both store and Stripe fee assumptions. |
| S01 | AI report/help control works in the app, creates a reviewable ticket and follows the documented moderation workflow. |
| S02 | Safety templates cover severe-risk inputs and age-appropriate educational content; notification claims match actual deliveries. |
| S03 | Logs, analytics and crash reports omit raw homework, solutions, secrets and child identifying content. |
| S04 | Static/dynamic secret scans pass; private buckets/RLS resist anonymous and cross-tenant access. |
| S05 | Retention jobs, data export, deletion, access revocation and backup restore are exercised with evidence. |
| S06 | Rate/cost limits include in-flight requests; budget exhaustion preserves existing learning data and approved basic practice. |
| U01 | Screen readers, focus, large text, contrast, reduced motion, keyboard avoidance and tablet layouts are inspected. |
| U02 | All primary actions have real connected behavior and meaningful empty/loading/error/offline states. |
| D01 | Typecheck/lint/unit/integration/E2E tests pass; the build report identifies every blocked live-service test. |
| D02 | iOS and Android release builds exist or have an explicit credential/signing blocker with reproducible commands. |
| D03 | Real app screenshots, native icons, permission descriptions, privacy disclosures and target-audience settings match the binary. |
| D04 | Account/support/privacy/deletion URLs are live before review; reviewer access works without using real child records. |
| D05 | Store subscription products, agreements, certificates, tax/bank/account verification and applicable closed testing are complete before submission. |
| D06 | Staging/production isolation, migrations, rollback, restore, alerts, queue failure handling and DNS/TLS have documented checks. |
| D07 | Production readiness rejects mock consent/billing/AI, fake resource catalogs and unverified child-data provider configuration. |
| D08 | Final coverage matrix has no unexplained missing requirement and accurately distinguishes built, tested, signed, submitted and approved. |

Critical failure rule: any unauthorized parent-key access, cross-family data leak, child-data consent bypass, unbounded billing, ledger double-spend, or missing deletion control blocks production. These failures cannot be waived by changing marketing wording.


## Monetization and AI-centered revision acceptance

| ID | Pass condition |
|---|---|
| M01 | AI continues to personalize explanations, daily practice, Thursday reviews and learning summaries. Original cost/template assumptions do not silently remove those features. |
| M02 | Child and unknown-role sessions receive no commercial placement DTO, affiliate tag, advertiser asset or third-party ad request, including at cold start and after parent-to-child switching. |
| M03 | Sponsor cards appear only in permitted adult surfaces after server-verified unlock; direct URL/role spoofing, expired unlock and back-stack/cache access fail. |
| M04 | Paid ad-free restore suppresses sponsor/network ads across devices. Affiliate cards are optional, disclosed and hideable; plan wording matches actual behavior. |
| M05 | One card/screen, no background refresh and default three newly served cards/session are enforced. Dismiss/report controls work and do not navigate to the advertiser. |
| M06 | Creative uploads reject scripts/pixels/unapproved destinations; human review, change re-review, scheduling, caps and expiry all work. |
| M07 | Child grades, mistakes, profiles, learning history and sensitive inferences cannot enter paid-ad selection, requests, advertiser reports or URLs. |
| M08 | Sponsor and affiliate disclosures remain visible at large text sizes, on screen readers and beside links. Commercial ranking cannot alter educational relevance scores. |
| M09 | Approval booleans/API keys alone cannot activate an ineligible property. Missing, expired or revoked platform/vendor eligibility suppresses monetization and preserves learning. |
| M10 | Amazon mobile affiliate mode requires the actual approved property and permitted linking mechanism; an arbitrary tag or generic Associates account does not pass readiness. |
| M11 | Eligible Amazon links are accessible to an authenticated free adult account without subscription payment; cancellation preserves that access. Destinations open outside a WebView after an adult tap. |
| M12 | Outbound URLs/referrers and logs contain no child/family identifiers, homework, scores or tokens. Invalid/expired products fail safely and no fake prices appear. |
| M13 | No points, cashback, scan allowance, reward fulfillment or subscription discount can be triggered by an ad impression, commercial click or affiliate purchase. |
| M14 | Campaign/affiliate/provider kill switches, pauses and outages remove placements without affecting grading, practice or rewards. |
| M15 | Owner admin isolation/MFA and audit trails resist family/sponsor access to other campaigns or child data. No self-service advertiser purchase flow exists inside the consumer app. |
| M16 | Hidden/preloaded/replayed cards do not generate billable impressions. Aggregate reports contain no child/family/buyer-level attribution. |
| M17 | Revenue imports deduplicate, support refunds/reversals and separate projected, contracted, recognized and received amounts. Clicks never become invented sales. |
| M18 | Same-inventory sponsor and network revenue cannot be double-counted. Revenue per all families includes non-buyers and ad-free families. |
| M19 | iOS/Android commercial-content and SDK declarations match the binary; pending/rejected eligibility is reported candidly and cannot be bypassed by remote flags after review. |
| M20 | Runtime and commercial-revenue budgets use measured or explicitly hypothetical assumptions; zero-revenue viability and 40/80-page AI workload reports are delivered. |


## Approved pricing and paid child slots (revision 3)

| ID | Required evidence |
|---|---|
| C01 | Integer-cent pricing returns $39.99/$49.98/$59.97/$69.96 for 1/2/3/4 paid slots. No extra family fee or $9.99-first-child fallback exists. |
| C02 | Actual store products map to the correct paid slot counts. Unsupported exact US price points block activation with a concrete report; prices are never silently rounded. |
| C03 | Parent creates a draft child without a charge; an unused paid slot can be assigned without buying again. |
| C04 | Adding capacity requires recent parent reauthentication and store confirmation. Child mode, pending, cancelled and failed purchases cannot grant a slot. |
| C05 | A verified upgrade adds precisely the purchased capacity; duplicate/out-of-order webhooks, two guardians and two platforms cannot duplicate billing or slots. |
| C06 | The parent sees actual store due-now details, renewal total/date and effective timing. The UI does not promise a full $9.99 charge immediately when proration applies. |
| C07 | Each active child has isolated homework, skill evidence, practice/reviews, points/rewards and usage. Base access never grants all four profiles paid AI. |
| C08 | Downgrade takes effect on the verified date and keeps the selected children active. Archived/inactive profiles retain parent-readable history, exports and reward records under retention rules. |
| C09 | Removing a profile alone does not claim subscription cancellation or a reduced renewal charge. Reassignment and upgrade do not reset existing usage or permit quota farming. |
| C10 | Restore, refunds, revocation and expiration reconcile both family entitlement and paid capacity; no local boolean grants extra children. |
| C11 | Public approved prices, native catalog, parent web portal and billing receipts agree within actual storefront currency/tax rules. Optional affiliate access stays available to eligible free adult users. |
| C12 | Pilot reports 1-4-child economics with zero commercial revenue and measured AI practice usage; a positive contribution is not described as net profit. |
