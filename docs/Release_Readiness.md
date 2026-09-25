# PencilLift release readiness (spec V2/F5; AC_RELEASE_*, AC_DEPLOY_*)

**Verdict: NOT releasable.** The software is built and tested locally; nothing is deployed, signed,
submitted or approved, and several child-safety gates depend on external approvals that do not exist
yet. This page separates what is *built*, *tested*, *deployed*, *signed*, *submitted* and *approved*
(AC_DEPLOY_08) so no stage is inferred from another.

| Stage | Status | Evidence |
|---|---|---|
| Built (source) | Yes, on branch `claude/new-session-vil6cz` | `docs/Progress.md`, git history |
| Tested locally (typecheck, lint, unit, real-Postgres authorization, jsdom UI) | Yes — see `docs/Test_Evidence.md` for the exact run | CI workflow `.github/workflows/ci.yml` mirrors `scripts/verify.sh` |
| Tested against live providers | **No** — every provider is blocked | `docs/Connections.md` |
| Deployed (staging / production) | **No** | `docs/Deployment_Runbook.md` (Hyperdrive ids are placeholders) |
| Native builds (iOS/Android) | **No** — Expo web export smoke only | Owner action #5 (EAS, signing) |
| Store products / agreements | **No** | Owner actions #1, #4, #11 |
| Submitted / approved | **No** | — |

## Store submission checklist (audited 2026-09-25, workflow `wf_2a9a8aa6-7c4`; code gaps being closed in `wf_b0de02d8-ca2`)

Evidence levels as in `docs/Provider_Capability_Matrix.md`: `doc-verified` (read in the store's current documentation
during the audit), `secondary`, `candidate` (documentation unreachable from the build environment — Amazon and
RevenueCat pages are blocked by the egress proxy). **Nothing has run on a real device or as a native build**: every
row below is a code or listing fact, not a device test. Owner-side rows are numbered in `docs/Owner_Actions.md`.

| Store | Requirement | State | Who / where |
|---|---|---|---|
| Apple (Kids Category) | No third-party analytics, ads or tracking SDKs; ATT not needed; custom camera/photo/Face ID purpose strings; IAP only through RevenueCat with restore and Ask-to-Buy handling; parent area behind password + server-verified PIN; children enter no personal information; Sign in with Apple not required (no social login); iPad supported | Compliant (`doc-verified`) | — |
| Apple | 5.1.1(v) account deletion in the app: the parent's sign-in itself, not only the family's data; guardians can remove themselves | **Code gap, blocker** — being built (`POST /v1/account/close`, soft delete through the Supabase Admin API, job after the purge) | Lead |
| Apple / Play | Outbound links reachable without the parent PIN sit behind a parental gate (sign-in links, child scan 'Open Settings') | Code gap — being built | Lead |
| Apple / Play | Privacy policy and terms links inside the app | Code gap — being built (parent home, plan, sign-in) | Lead |
| Apple 3.1.2 | Subscription disclosure before purchase: title, monthly length, price per period, auto-renewal until cancelled, charged to the store account, links to terms and privacy | Code gap — being built | Lead |
| Apple | Info.plist usage strings only for used permissions (no default microphone string); privacy manifest lists collected data types; export compliance declared; no push entitlement while notifications are unused | Code gap — being built (`app.config.ts`) | Lead |
| Apple 2.1 | No placeholder UI: export job registered (or section hidden), legal pages final | Code gap — being built | Lead / Owner #15 |
| Apple 2.1(b) | Four auto-renewable products in one subscription group, mapped in `store_product_mappings`, RevenueCat offerings | Owner — blocked on **Owner action #1** (iOS cannot charge $49.98 / $59.97 / $69.96) | Owner #1, #4 |
| Apple | App Privacy labels: Email Address, Photos or Videos, Other User Content, Purchase History, User ID — linked, App Functionality, no tracking (identical to the privacy manifest) | Owner (App Store Connect) | Owner #33 |
| Apple | Age rating: every descriptor None, Parental controls Yes, Unrestricted Web Access No → 4+; Kids Category, one age band (locked after approval) | Owner | Owner #33 |
| Apple 1.3 / 5.1.4 | Sponsor cards and affiliate links (P16) stay switched off for v1; say so in review notes | Owner decision | Owner #16 |
| Apple 5.1.4(a) | Verifiable parental consent through a vendor before any child data | Owner — vendor choice; the adapter follows | Owner #7 |
| Apple 2.3 | Screenshots from a TestFlight build (6.9-inch iPhone, 13-inch iPad), metadata without price promises, demo account in review notes | Owner | Owner #33 |
| Apple | Bundle id registered, App Store Connect record, `eas.json` submit profile (appleId, ascAppId, teamId), version 1.0.0 | Owner + lead | Owner #11, #34 |
| Google Play (Families) | Target SDK 36 met (RN 0.86); Play Billing 8.x through react-native-purchases 10.x; CAMERA and USE_BIOMETRIC only with location and others blocked; no ads; no social login | Compliant (`doc-verified` / `secondary`) | — |
| Play | Account deletion in-app + public URL; privacy link in-app; parental gate; no free-text child input at pairing | Code gap — being built | Lead |
| Play | Unused push stack (expo-notifications) removed from the build; IP-address storage stated in the policy | Code gap — being built | Lead |
| Play | Target audience (6-8, 9-12 plus adult bands), IARC questionnaire, Data safety form from the data inventory, 'no ads' declaration, Play App Signing, package name reserved | Owner (Play Console) | Owner #35 |
| Play | RevenueCat attribution / advertising-id collection off; its data statement for Data safety | Owner (RevenueCat dashboard) | Owner #4 |
| Play | Mixed-audience age determination: confirm 'parent login + parent-issued child code' satisfies the policy, else a neutral age screen | Owner / counsel (`candidate`) | Owner #35 |
| Amazon Appstore | No Google services or FCM at runtime; permissions limited to CAMERA and USE_BIOMETRIC | Code gap — being built (removal of expo-notifications; blocked permissions) | Lead |
| Amazon | Legal pages name the Amazon Appstore as a payment channel | Code gap — being built | Lead |
| Amazon | RevenueCat Amazon flavour / IAP receiver in the manifest for the Amazon profiles | `candidate` — being checked against the installed SDK | Lead |
| Amazon | Four monthly subscription items at the approved totals; `store_product_mappings` rows; App Tester sandbox run of buy / cancel / restore per tier; content rating questionnaire; listing assets (114 / 512 icons, ≥3 screenshots, promo image) | Owner | Owner #29, #36 |
| All stores | EAS project linked (`extra.eas.projectId`), `eas init` run once, required public variables per profile fail loudly when missing | Code gap (loud failures) — being built; project id is the owner's | Owner #34 |
| All stores | Public pages live over HTTPS: privacy, terms, support, account deletion; URLs recorded for each console | Owner (deploy) | Owner #8, #15 |
| All stores | Listing graphics from the brand assets (feature graphic 1024×500, Amazon icons) and a screenshot checklist | Lead (export script) + Owner (captures) | Owner #33, #36 |

## Hard release blockers (any one blocks production)

| Blocker | Why it blocks | Unblocked by |
|---|---|---|
| No verifiable parental consent provider | Child data may not be collected; production refuses to serve with the mock (AC_DEPLOY_07) | Owner action #7 + adapter |
| No documented OpenAI zero-data-retention approval | Under-13 data cannot reach the AI; scans would fail closed as `AI_NOT_AVAILABLE` | Owner action #6 |
| iOS cannot charge $49.98 / $59.97 / $69.96 | Approved prices would be misrepresented on iOS; the full-price donation rule never triggers for those iOS families | Owner action #1 decision |
| No native store purchase / offer-code step verified in a sandbox | Purchase, restore, capacity change and the P17 offer-code step are built, wired (mobile school and plan screens) and tested against labeled mocks only; nothing has run against StoreKit, Google Play Billing or RevenueCat | Owner actions #2, #4, #17, #18 + sandbox runs |
| No independent security/privacy and educator review | Spec V1 requires independent humans; our adversarial reviews are automated fallbacks | Owner action #10 |
| Legal pages are drafts | Store review needs live privacy/terms/support/deletion URLs | Owner action #15 + deployment |
| No transactional email provider | Guardian invitations, deletion receipts and inactivity notices go to a development outbox | Owner action #14 |
| Backup/restore and rollback not rehearsed | AC_RELEASE_03 | Deployment + rehearsal |
| Hosted Supabase not verified for migrations 0710/0720 | Sign-out must end API access; 0720 needs a trigger on `auth.sessions` that the local shim accepts but the hosted project may refuse | Owner action #20 + staging migration run |
| No AI spend cap for the launch month | Readiness blocks without this month's `spend_budgets` row; without it there is no application ceiling | Owner action #19 |
| AI quality, latency and cost unmeasured | Cost analysis is modelled, not measured; educator evaluation absent | Live AI access + evaluation set |
| Child-safety package unapproved | The child safety messages, parent wording, the parent flag email (job `safety_flag_email`, template draft pending approval), the two parent actions and the runbook 5.1 procedure are drafts; under the owner decision of 2026-09-25 every flag goes to the parent by email and in their list, and counsel must confirm that is lawful in the launch states; readiness reports `safety_templates` blocked | Owner action #24 (owner, educator, counsel) |
| Provider moderation not live | Built and wired (OpenAI omni-moderation before grading on the child's answers, after generation on coaching, rubric criteria and practice text; fails closed) but exercised only against a labeled mock; readiness keeps `ai_moderation` blocked until a real client is configured. Until then only the deterministic word-list screen reads real text (English plus a few Spanish phrases; misses paraphrases) | OpenAI key + ZDR approval (Owner action #6); confirm the outage rule (Owner action #26) |
| Database not marked production | The fixture/fake catalog guard activates only once the deployed database is marked; readiness reports `database_environment` blocked | Owner action #21 |
| Family read access to held safety flags undecided | The child's answer and safety message stay readable to family members through the Data API while a report is held | Owner action #25 (COPPA decision) |
| Answers can reach the child through the transcription (BUG-096) | Labelled answers in the extraction are withheld; an unlabelled insertion ('(84)', '= 84') in the printed prompt's transcription still shows | Owner action #28 |

## Gates that are implemented and tested (software level)

- Production refuses mock consent and in-memory storage; readiness reports every mock/blocked provider
  (`config.test.ts`, `auth.test.ts` readiness).
- Child data never reaches a non-mock AI provider without recorded ZDR evidence; mocks never run in
  production (`ai.test.ts`, `scan-process.test.ts`).
- Answer keys stay in the private schema; child responses are allowlisted and scanned by the answer guard
  (homework and scan tests).
- Deletion tombstones first, enqueues the purge atomically and removes storage before rows
  (`deletion_purge.test.ts`, `scheduled.test.ts`).
- Monetization ships with every kill switch off and cannot activate from booleans (monetization tests).
- Secret scan over tracked files in the verify gate and CI.
- Sign-out ends API access on every parent route; step-up is required for every private export; PIN
  attempts are serialized (`auth-session.test.ts`, `adult-pin.test.ts`, lead identity review tests).
- Pairing-code guessing is bounded per network and by a reserved service-wide budget that cannot be used
  to stop other families pairing (`child-auth-hardening.test.ts`).
- Deletion and consent withdrawal stop running scans; purges remove exports and late uploads; usage
  reservations survive child deletion (lead jobs/AI review tests, `scheduled.test.ts`).
- Every AI stage (scan and learning) takes a spend hold, so concurrent workers cannot overshoot the cap.
- Billing reconciliation (sync, webhooks, TRANSFER, scheduled sweep) grants a purchase to one family only
  (`billing.review.test.ts`, `webhooks-reconcile.test.ts`) — against the mock provider.
- A restated computation is never graded correct; keys that disagree fall back to reviewed templates
  (`scan-process.test.ts`).
- The pre-commit gate typechecks and secret-scans exactly the staged tree (BUG-034).
- Child safety (BUG-084, BUG-107..111): every child answer and printed prompt is screened **before grading** (a
  severe question gets no model call), and child-facing model output after generation; a severe answer gets a
  reviewed message with US resources and an escalated report without homework text; abuse-type reports are held
  from the family and never come from a printed prompt; a reviewer can clear a false match; provider moderation is
  wired and fails closed (labeled mock until the key exists) (`safety-screening.test.ts`,
  `provider-moderation.test.ts`, `packages/domain/src/safety`).
- Answer guard reads arithmetic expressions by default; only problem statements opt out (BUG-076,
  `guard-call-sites.test.ts`).
- Spend ceiling never lets a stage overshoot the owner's cap (BUG-064).
- Outside development/test no consent, billing, storage or email mock ever serves; missing credentials select
  providers that refuse every call (BUG-067, BUG-079, BUG-082, `runtime.test.ts`).
- Production never serves fixture or fake catalog rows; a database marked production refuses them (BUG-080, 0770).
- Uploads: image dimensions and frame structure checked before any decode; stored size and sha256 verified at
  finalize and at scan time (BUG-078, BUG-088).
- Release-shaped build artifacts are secret-scanned in CI with a negative control (BUG-081).
- The approved-price gate applies to every capacity change (BUG-065).
- School viewers cannot isolate small groups across time zones (BUG-074, 0740).

Residual risk is listed per threat in `docs/Threat_Model.md`; open defects in `docs/Bug_Ledger.md`.
