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
| Child-safety package unapproved | The child safety messages, parent wording, family-hold default and runbook 5.1 escalation steps are drafts; readiness reports `safety_templates` blocked | Owner action #24 (owner, educator, counsel) |
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
