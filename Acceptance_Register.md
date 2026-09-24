# PencilLift acceptance register

Generated from Revision 5; the master prompt remains authoritative. All app checks are not tested.

Each item starts **not tested**. The builder must add code/test references and real evidence; this file is not a claim that the app has been built or tested. A blocked test stays blocked. Use synthetic family data by default.

| ID | Required observable outcome |
|---|---|
| AC_ACCESS_01 | A verified parent can create a family; an unverified or nonconsenting adult cannot start child-data processing. |
| AC_ACCESS_02 | Consent integration returns a verifiable provider result, version, time and scope. A checkbox/PIN alone cannot grant the production consent state. |
| AC_ACCESS_03 | Under-13 personal-data API calls are blocked when ZDR approval/configuration is absent. `store:false` or a forged client flag cannot bypass the block. |
| AC_ACCESS_04 | A parent creates two synthetic children; each device pairing binds only to the selected child. Codes expire, are single-use and resist guessing. |
| AC_ACCESS_05 | A child cannot enumerate or read a sibling's or another family's assignments by replacing any ID in requests or storage paths. |
| AC_ACCESS_06 | A child cannot create an adult session by changing a local role, calling the solution API, replaying a stale code, or claiming to be a parent. |
| AC_ACCESS_07 | Switching to child mode erases parent data from navigation history, offline caches, query stores and shared web state; returning requires fresh proof. |
| AC_ACCESS_08 | Parent PIN rate limits, reset/recovery and biometric fallback work; device revocation stops refresh and privileged access. |
| AC_ACCESS_09 | Guardian invitations require verified acceptance. Removal immediately invalidates access and pending privileged actions. |
| AC_ACCESS_10 | Consent withdrawal stops uploads/jobs; parent deletion removes active data and schedules documented backup expiry. Jobs cannot resurrect deleted records. |
| AC_CAPTURE_01 | Camera, photo picker and PDF import work with permission denied, offline upload, interrupted upload and resume. |
| AC_CAPTURE_02 | File signature, byte/page limits and image dimensions are validated; malformed PDFs, decompression bombs and unexpected files fail safely. |
| AC_CAPTURE_03 | Rotation, handwriting, fractions, exponent placement, units and multi-page numbering are represented correctly in test fixtures. |
| AC_CAPTURE_04 | Blur, missing passage, glare and cropped-off questions produce rescan/review states instead of invented grades. |
| AC_CAPTURE_05 | Parent transcription corrections retain provenance and trigger only necessary rechecking. |
| AC_CAPTURE_06 | Duplicate upload/finalize events create one job and one quota charge; permanently failed unreadable scans release reservations. |
| AC_CAPTURE_07 | Model outage/timeout retries are bounded, visible and idempotent; failed processing is never shown as a successful check. |
| AC_GRADING_01 | Mixed-correctness homework maps each student answer to the right question and distinguishes unanswered, correct, incorrect and unresolved. |
| AC_GRADING_02 | Equivalent fractions, units, rounding and alternative valid methods pass appropriate deterministic checks. |
| AC_GRADING_03 | Subjective writing receives rubric feedback, not a false binary grade or generated essay for the child to copy. |
| AC_GRADING_04 | Verifier disagreement triggers a documented escalation/review route; confidence alone cannot override conflicting evidence. |
| AC_GRADING_05 | Parent sees complete solutions only after server-verified recent reauthentication. |
| AC_GRADING_06 | Child API responses, HTML/mobile bundles, cache, push payloads, logs and realtime events contain no withheld key/solution fields. |
| AC_GRADING_07 | Child hints teach a method without final values/letters/spelling targets. Analogous worked examples do not reveal the target result. |
| AC_GRADING_08 | Image-text prompt injections, fake-parent requests, encodings, translation requests, malicious URLs and tool instructions do not leak solutions. |
| AC_GRADING_09 | Repeated target-answer guesses hit the defined limit and redirect to practice/parent help; resubmission does not reset the limit trivially. |
| AC_GRADING_10 | Parent grading override is audited and changes learning evidence without silently corrupting or unfairly clawing back rewards. |
| AC_GRADING_11 | Benchmark reports false-right, false-wrong and abstention/coverage by subject. The frozen objective agreement and correct-judgment precision gates in P12 are demonstrated with adequate coverage, or the affected production grading route is blocked. |
| AC_GRADING_12 | Educator review checks explanation correctness and developmental fit; model-judge scores alone are insufficient. |
| AC_LEARNING_01 | Initial accuracy and eventual post-hint success remain distinct. Repeated attempts on one item do not inflate mastery sample size. |
| AC_LEARNING_02 | Fewer than five distinct independent examples displays insufficient evidence; skill mastery requires independent success across sessions. |
| AC_LEARNING_03 | Daily practice is available every local day including weekends; vacation/quiet-hour controls work without point loss. |
| AC_LEARNING_04 | Daily selection follows weak-skill/spaced-review/confidence mix; grade-level fallback works with no upload history. |
| AC_LEARNING_05 | All six subject areas have meaningful usable content or clearly identified unsupported coverage; no fake content completion. |
| AC_LEARNING_06 | Generated questions have private validated keys; invalid/unsolvable/ambiguous generated items never reach the child. |
| AC_LEARNING_07 | Thursday review covers enabled subjects and prioritizes weekly errors. Teacher test scope and subject-specific dates affect selection. |
| AC_LEARNING_08 | Thursday jobs run with the app closed, honor IANA time zones and DST, and do not duplicate on worker retries. |
| AC_LEARNING_09 | Late uploads produce optional versioned top-ups without overwriting completed work or awarding twice. |
| AC_LEARNING_10 | Parent PDF contains a protected key; child PDF has questions only and cannot be switched to include a key by modifying a parameter. |
| AC_REWARDS_01 | Earned points, bonus rules and caps match the published family rules; empty/rapid retries do not farm points. |
| AC_REWARDS_02 | Two simultaneous devices cannot redeem the same points; ledger entries have unique constraints and atomic balance checks. |
| AC_REWARDS_03 | Approve/decline/cancel/fulfill transitions are idempotent and refund reserved points exactly once where applicable. |
| AC_REWARDS_04 | Cash-style rewards are parent-fulfilled records; no actual payment or unauthorized Amazon purchase occurs. |
| AC_REWARDS_05 | Parent adjustments carry a reason and append-only record; totals reconcile after reversals. |
| AC_RESOURCES_01 | Catalog suggestions are tied to learning skills with rationale, and include free practice alternatives. |
| AC_RESOURCES_02 | AI returns only valid reviewed catalog IDs; invented ASINs, prices, links and expired products are rejected. |
| AC_RESOURCES_03 | Permitted plain Amazon links are parent-only, contain no child identifiers/skill-history payloads, and do not require an affiliate account; when the property/channel is ineligible, safe educational resources remain available. |
| AC_RESOURCES_04 | Requested affiliate implementation works with approved-tool test fixtures; live use stays blocked without specific property/mobile eligibility. No child tracking SDK is present. |
| AC_BILLING_01 | Sandbox Apple/Google purchases create server-verified entitlements on the correct parent account. |
| AC_BILLING_02 | Restore on another device works; pending/Ask to Buy does not unlock paid usage prematurely. |
| AC_BILLING_03 | Renewal, cancellation, grace, billing retry, expiry, refund and revocation produce correct access states. |
| AC_BILLING_04 | Duplicate/out-of-order webhooks reconcile to current provider state and do not double-grant access or reset quotas. |
| AC_BILLING_05 | Child cannot purchase, modify subscriptions, forge paid state or bypass quotas; no surprise overage billing. |
| AC_BILLING_06 | Web/store entitlements synchronize if optional web billing is enabled; standard native sales do not include Stripe fees; any eligible web/link-out route includes its actually applicable store-program fees separately. |
| AC_SECURITY_01 | AI report/help control works in the app, creates a reviewable ticket and follows the documented moderation workflow. |
| AC_SECURITY_02 | Safety templates cover severe-risk inputs and age-appropriate educational content; notification claims match actual deliveries. |
| AC_SECURITY_03 | Logs, analytics and crash reports omit raw homework, solutions, secrets and child identifying content. |
| AC_SECURITY_04 | Static/dynamic secret scans pass; private buckets/RLS resist anonymous and cross-tenant access. |
| AC_SECURITY_05 | Retention jobs, data export, deletion, access revocation and backup restore are exercised with evidence. |
| AC_SECURITY_06 | Rate/cost limits include in-flight requests; budget exhaustion preserves existing learning data and approved basic practice. |
| AC_UX_01 | Screen readers, focus, large text, contrast, reduced motion, keyboard avoidance and tablet layouts are inspected. |
| AC_UX_02 | All primary actions have real connected behavior and meaningful empty/loading/error/offline states. |
| AC_DEPLOY_01 | Typecheck/lint/unit/integration/E2E tests pass; the build report identifies every blocked live-service test. |
| AC_DEPLOY_02 | iOS and Android release builds exist or have an explicit credential/signing blocker with reproducible commands. |
| AC_DEPLOY_03 | Real app screenshots, native icons, permission descriptions, privacy disclosures and target-audience settings match the binary. |
| AC_DEPLOY_04 | Account/support/privacy/deletion URLs are live before review; reviewer access works without using real child records. |
| AC_DEPLOY_05 | Store subscription products, agreements, certificates, tax/bank/account verification and applicable closed testing are complete before submission. |
| AC_DEPLOY_06 | Staging/production isolation, migrations, rollback, restore, alerts, queue failure handling and DNS/TLS have documented checks. |
| AC_DEPLOY_07 | Production readiness rejects mock consent/billing/AI, fake resource catalogs and unverified child-data provider configuration. |
| AC_DEPLOY_08 | Final coverage matrix has no unexplained missing requirement and accurately distinguishes built, tested, signed, submitted and approved. |

Critical failure rule: any unauthorized parent-key access, cross-family data leak, child-data consent bypass, unbounded billing, ledger double-spend, or missing deletion control blocks production. These failures cannot be waived by changing marketing wording.


### Commercial and AI acceptance

| ID | Pass condition |
|---|---|
| AC_MON_01 | AI continues to personalize explanations, daily practice, Thursday reviews and learning summaries. Original cost/template assumptions do not silently remove those features. |
| AC_MON_02 | Child and unknown-role sessions receive no commercial placement DTO, affiliate tag, advertiser asset or third-party ad request, including at cold start and after parent-to-child switching. |
| AC_MON_03 | Sponsor cards appear only in permitted adult surfaces after server-verified unlock; direct URL/role spoofing, expired unlock and back-stack/cache access fail. |
| AC_MON_04 | If an ad-free offer is approved, its restored entitlement suppresses sponsor/network ads across devices; until then prove the behavior with fixtures and keep the sellable offer inactive. Affiliate cards are optional, disclosed and hideable; plan wording matches actual behavior. |
| AC_MON_05 | One card/screen, no background refresh and default three newly served cards/session are enforced. Dismiss/report controls work and do not navigate to the advertiser. |
| AC_MON_06 | Creative uploads reject scripts/pixels/unapproved destinations; human review, change re-review, scheduling, caps and expiry all work. |
| AC_MON_07 | Child grades, mistakes, profiles, learning history and sensitive inferences cannot enter paid-ad selection, requests, advertiser reports or URLs. |
| AC_MON_08 | Sponsor and affiliate disclosures remain visible at large text sizes, on screen readers and beside links. Commercial ranking cannot alter educational relevance scores. |
| AC_MON_09 | Approval booleans/API keys alone cannot activate an ineligible property. Missing, expired or revoked platform/vendor eligibility suppresses monetization and preserves learning. |
| AC_MON_10 | Amazon mobile affiliate mode requires the actual approved property and permitted linking mechanism; an arbitrary tag or generic Associates account does not pass readiness. |
| AC_MON_11 | Eligible Amazon links are accessible to an authenticated free adult account without subscription payment; cancellation preserves that access. Destinations open outside a WebView after an adult tap. |
| AC_MON_12 | Outbound URLs/referrers and logs contain no child/family identifiers, homework, scores or tokens. Invalid/expired products fail safely and no fake prices appear. |
| AC_MON_13 | No points, cashback, scan allowance, reward fulfillment or subscription discount can be triggered by an ad impression, commercial click or affiliate purchase. |
| AC_MON_14 | Campaign/affiliate/provider kill switches, pauses and outages remove placements without affecting grading, practice or rewards. |
| AC_MON_15 | Owner admin isolation/MFA and audit trails resist family/sponsor access to other campaigns or child data. No self-service advertiser purchase flow exists inside the consumer app. |
| AC_MON_16 | Hidden/preloaded/replayed cards do not generate billable impressions. Aggregate reports contain no child/family/buyer-level attribution. |
| AC_MON_17 | Revenue imports deduplicate, support refunds/reversals and separate projected, contracted, recognized and received amounts. Clicks never become invented sales. |
| AC_MON_18 | Same-inventory sponsor and network revenue cannot be double-counted. Revenue per all families includes non-buyers and ad-free families. |
| AC_MON_19 | iOS/Android commercial-content and SDK declarations match the binary; pending/rejected eligibility is reported candidly and cannot be bypassed by remote flags after review. |
| AC_MON_20 | Runtime and commercial-revenue budgets use measured or explicitly hypothetical assumptions; zero-revenue viability and 40/80-page AI workload reports are delivered. |


### Approved pricing and paid child slots

| ID | Required evidence |
|---|---|
| AC_CAPACITY_01 | Integer-cent pricing returns $39.99/$49.98/$59.97/$69.96 for 1/2/3/4 paid slots. No extra family fee or $9.99-first-child fallback exists. |
| AC_CAPACITY_02 | Actual store products map to the correct paid slot counts. Unsupported exact US price points block activation with a concrete report; prices are never silently rounded. |
| AC_CAPACITY_03 | Parent creates a draft child without a charge; an unused paid slot can be assigned without buying again. |
| AC_CAPACITY_04 | Adding capacity requires recent parent reauthentication and store confirmation. Child mode, pending, cancelled and failed purchases cannot grant a slot. |
| AC_CAPACITY_05 | A verified upgrade adds precisely the purchased capacity; duplicate/out-of-order webhooks, two guardians and two platforms cannot duplicate billing or slots. |
| AC_CAPACITY_06 | The parent sees actual store due-now details, renewal total/date and effective timing. The UI does not promise a full $9.99 charge immediately when proration applies. |
| AC_CAPACITY_07 | Each active child has isolated homework, skill evidence, practice/reviews, points/rewards and usage. Base access never grants all four profiles paid AI. |
| AC_CAPACITY_08 | Downgrade takes effect on the verified date and keeps the selected children active. Archived/inactive profiles retain parent-readable history, exports and reward records under retention rules. |
| AC_CAPACITY_09 | Removing a profile alone does not claim subscription cancellation or a reduced renewal charge. Reassignment and upgrade do not reset existing usage or permit quota farming. |
| AC_CAPACITY_10 | Restore, refunds, revocation and expiration reconcile both family entitlement and paid capacity; no local boolean grants extra children. |
| AC_CAPACITY_11 | Public approved prices, native catalog, parent web portal and billing receipts agree within actual storefront currency/tax rules. Optional affiliate access stays available to eligible free adult users. |
| AC_CAPACITY_12 | Pilot reports 1-4-child economics with zero commercial revenue and measured AI practice usage; a positive contribution is not described as net profit. |

### Connections, costs and release evidence

| ID | Required observable outcome |
|---|---|
| AC_CONN_01 | Existing account/project/environment mappings are recorded, scoped and verified without secret disclosure or duplicate resources. |
| AC_CONN_02 | Native scan → deployed API → private storage → durable processing → correct adult/child result works with synthetic data; client/Claude closure does not stop it. |
| AC_CONN_03 | Both native stores have actual sandbox purchase/restore evidence; Expo Go or mocked purchase success is not recorded as store verification. |
| AC_CONN_04 | Two guardians and cross-platform restores reconcile one family billing identity; account switching cannot transfer another family's capacity. |
| AC_CONN_05 | Webhook authenticity follows each provider's real mechanism; replay, out-of-order delivery and deletion races preserve access/financial invariants. |
| AC_CONN_06 | Service-role API paths independently enforce membership; direct database/storage and forged-role tests prove the intended boundary. |
| AC_FIN_01 | Rates include source/date/unit/region/evidence; unknown contracts and labor are explicit, never silently zero. |
| AC_FIN_02 | All 1–4-child tiers and 10/100/1,000/10,000-family scales have light/typical/heavy and payment-route sensitivity; mix sums to 100%. |
| AC_FIN_03 | RevenueCat account-level threshold and whole tracked-revenue fee are tested below/at/above the selected contractual boundary, including blended cohorts. |
| AC_FIN_04 | Native/Stripe routes, credits, image/reasoning tokens, retries and contingency do not double-count costs; actual provider fee exceptions remain represented. |
| AC_FIN_05 | Measured per-stage usage, latency, quality and failed-request spend replace assumptions; heavy/cold-start and six-subject workloads are covered. |
| AC_FIN_06 | Fresh daily AI practice stays included, zero commercial revenue is the baseline, and negative incremental sibling/whole-family margins are surfaced. |
| AC_FIN_07 | Startup cash, development burn, monthly operations, first-year forecast, break-even and runway distinguish unknown costs, cash timing and fixed/variable expenses. |
| AC_FIN_08 | No partial contribution table is labeled net profit; refunds, actual consent cost, maintenance, owner time and acquisition assumptions are visible. |
| AC_FIN_09 | Runtime caps reserve/reconcile concurrent spend, count unsuccessful billed requests, and preserve correctness/privacy and existing learning on exhaustion. |
| AC_FIN_10 | Price/cap/model changes need their actual owner decision; an illustrative forecast does not authorize service purchases or production spending. |
| AC_RELEASE_01 | Store upload, review submission, approval and public availability have separate dated evidence; no stage is inferred from an EAS build. |
| AC_RELEASE_02 | Signed binary targets correct production services and audience; mock adapters, secret leakage and unresolved child-data gates block live enrollment. |
| AC_RELEASE_03 | Recovery/rollback is rehearsed including object storage, migrations, billing reconciliation and deletion tombstones; targets and achieved results are distinct. |

### ECC execution and persistent improvement

| ID | Required observable outcome |
|---|---|
| AC_ECC_01 | The actual Claude Code/ECC version, namespace, skills, agents, hooks and invocation restrictions are inventoried; no unverified alias is assumed. |
| AC_ECC_02 | Run evidence shows appropriate installed ECC capabilities were invoked for real tasks; unavailable capabilities and ordinary fallbacks are labeled honestly. |
| AC_ECC_03 | Delegated tasks receive relevant requirements, skills, permissions, file ownership, revision and acceptance checks; results contain actual evidence. |
| AC_ECC_04 | Concurrent writers have safe ownership/isolation and bounded concurrency; integrated changes are tested after reconciliation. |
| AC_ECC_05 | Confirmed behavioral defects have a failing reproduction/regression before the fix and passing evidence afterward, or an explicit justified manual equivalent. |
| AC_ECC_06 | All confirmed in-scope defects are tracked through root cause, fix and verification; repeated reports are deduplicated and external blockers stay distinct. |
| AC_ECC_07 | No test deletion, hidden failure, threshold reduction, unsafe mock substitution, disabled security or repeated-until-green flake handling creates a false pass. |
| AC_ECC_08 | A fresh review examines high-risk changes and the integrated final candidate; reviewer findings re-enter the defect ledger. |
| AC_ECC_09 | A fresh session loads the intended project instructions/lessons and resumes from a checkpoint verified against actual Git/CI state. |
| AC_ECC_10 | Learning capture/observer configuration is verified; secrets and child data are excluded before capture/analysis, with sanitized manual records as a safe fallback. |
| AC_ECC_11 | Saved lessons cite verified evidence and stay project-scoped; evolved rules cannot change approved requirements, permissions, tests, privacy or budgets. |
| AC_ECC_12 | Hooks are actually tested, preserve existing controls and handle recursion, cancellation, blockers and resource limits without endless continuation. |
| AC_ECC_13 | Agent/observer/CI development usage is bounded and separated from app runtime spend; repeated failed fixes trigger a new diagnosis, not uncontrolled agent spawning. |
| AC_ECC_14 | Completion is based on the final integrated candidate and required tests; known defects, skipped/blocked checks and owner-approved deferrals remain visible. |
| AC_ECC_15 | CI proves fail/pass behavior; any configured repair runner proves a bounded synthetic failure-to-reviewed-fix cycle and reports real status without unauthorized merge/release. |
| AC_ECC_16 | Learning and improvement preserve PencilLift's OpenAI runtime integration, educational protections, pricing and approved scope; no promise of model retraining or execution after the runner stops. |


### School referrals and monthly promotions

| ID | Required observable outcome |
|---|---|
| AC_PROMO_01 | An enabled template generates fresh monthly campaigns/codes exactly once despite concurrent jobs and retries; failed provider mapping is visibly unavailable. |
| AC_PROMO_02 | Each confirmed redemption grants exactly one provider monthly billing period, including February and month-end dates; code redemption expiration is separate. |
| AC_PROMO_03 | A family can redeem fresh eligible codes in three consecutive months, including 100% offers; there is no lifetime one-promotion limit or automatic carry-forward. |
| AC_PROMO_04 | Without a new confirmed code, the next billing period returns to the disclosed regular tier price; the previous code cannot be reused. |
| AC_PROMO_05 | One family cannot stack discounts in one period, reserve unlimited future periods, replay through another guardian or exceed campaign caps under concurrent requests. |
| AC_PROMO_06 | Requested 5–100% discounts use actual provider-supported amounts; unsupported native prices or repeat-redemption constraints are reported instead of silently changed. |
| AC_PROMO_07 | Stripe and native sandbox evidence verifies intended target invoice/offer, existing subscriber eligibility, repeated monthly redemption and expiry; a mock is not store evidence. |
| AC_PROMO_08 | A provider-confirmed 100% period grants legitimate access without a positive charge; failed renewal, cancellation, refund and billing retry are handled truthfully. |
| AC_PROMO_09 | Delayed/duplicate webhooks, timeouts, restore, channel switch and child-tier changes cannot duplicate or extend a benefit; failed new codes preserve current valid benefits. |
| AC_PROMO_10 | School reports distinguish unique family signups, active families, positive-paying and fully discounted families; children/guardians/code redemptions do not inflate counts. |
| AC_PROMO_11 | Each qualifying family-school-calendar-month accrues exactly 100 USD cents; full-price settlement grants $1, every discount from 5% through 100% grants $0, and later full-price renewal restores eligibility; one school and one donation per family/month are enforced, including concurrent school changes. |
| AC_PROMO_12 | Refunds, chargebacks, school changes and late events create auditable adjustments; already paid history is preserved and payout retries cannot duplicate transfers. |
| AC_PROMO_13 | School administrators see only their authorized aggregates; child mode and other families cannot access codes, financial administration or private family/student data. |
| AC_PROMO_14 | Parent confirmation displays exact discounted period, amount, regular renewal price and code status; monthly campaigns are not auto-applied without a fresh entry. |
| AC_PROMO_15 | Financial scenarios include recurring discounts, free-month service costs, school expenses and aggregate account fee thresholds; unknown costs remain labeled and discounted periods generate no school donation. |
| AC_PROMO_16 | Relevant installed ECC skills/specialists actually review billing, schema, concurrency and privacy; observed defects follow the reproduce–fix–retest learning cycle. |

Begin E1 now, establish the ECC execution and learning workflow in E5, then implement the first unblocked requirement. Use the verified skills and specialists, continue the test–fix–retest cycle, record lessons and resume state, and work through the authorized milestones. Bring the owner only concrete external blockers and decisions that materially affect the agreed product or budget.
