# PencilLift progress (spec E1 record; resume from here)

Branch: `claude/new-session-vil6cz` (pushed after every lead commit; CI runs on every `claude/**` push).
Spec: `PencilLift_Claude_Code_Master_Prompt.md` Revision 8. Pricing: $39.99 first child + $9.99 each additional
(1–4 paid slots) — unchanged.

## Current state (2026-09-24, after final review round 5)

Software for every spec area is built and integrated on the branch; nothing is deployed, signed, submitted or
approved, and no live provider has been exercised (`docs/Connections.md`, `docs/Release_Readiness.md`).
Acceptance coverage (153 criteria; `docs/Requirement_Coverage.md`, each row with its gap): integration_tested 33,
unit_tested 16, db_tested 1, verified_by_inspection 21, mock_only 16, blocked_external 27, in_progress 38,
not_tested 1 (AC_GRADING_11, the frozen 200-question evaluation, needs real AI and labelled data).

Last local full gate (`scripts/verify.sh`, exit 0) on the round-5 tree: api 845, domain 3,610, db 255, web 406,
mobile 400, ai 49, contracts 14, ui-tokens 4 (5,583 tests, 0 failed, 0 skipped), gate audit, finance, release-
artifact scan with negative control. CI: #34 (4a07ac9) and #35 (e123e5c, after 15:00 UTC) green; see
`docs/Test_Evidence.md` for the run on the latest SHA.

## Done and committed (lead-verified)

| Area | Evidence |
|---|---|
| Monorepo, CI (release-artifact secret scan with a negative control), fail-fast gate `scripts/verify.sh` with the test-count audit (floors ~95% of real counts, never lowered; the one past reduction restored), staged-tree pre-commit hook | BUG-024/034/081/089, AC_ECC_07/15 |
| Schema 0001–0780 with RLS, append-only ledgers, deletion purge, jobs, identity hardening, school-report zone pin, reward rules, safety screening and family hold (0760), fake-catalog guard (0770), request instant for queued work (0780) | `supabase/tests` 255 tests on real Postgres 16 |
| Auth, PIN step-up, pairing (lock order fixed, BUG-106), sessions, one child token refresher | API auth/identity suites |
| Family, guardians, consent (test-provider consent only in development/test), privacy, deletion, exports | BUG-101, `runtime.test.ts` |
| Homework capture, scan pipeline, guarded coaching, rubric feedback (fail closed, three-reading safety screen) | BUG-078/088, BUG-091 |
| Child safety: word-list screen v4 before grading and after generation (recall first; no held code from a printed prompt), provider moderation wired and failing closed (labeled mock), reviewed templates (drafts), escalated and held reports, false-match clearing | BUG-084, BUG-107..112 |
| AI spend cap fails closed (no budget → no AI outside development/test; upper-bound estimates; holds kept when metering fails) | BUG-092/094/095/097 |
| Learning, rewards, P16 monetization, P17 promotions/schools/donations; billing against labeled mocks | BUG-064..082 |
| Application clock decides when queued work is due | BUG-090 |
| Adversarial reviews of every module and lead change, five final-review rounds | `docs/ECC_Runs.md`, BUG-013..112 |

## In flight

- Nothing. Final gate on the latest SHA and the fresh-context resume check (AC_ECC_09) are the remaining steps.

## Next exact steps

1. Confirm CI green on the latest SHA; record it in `docs/Test_Evidence.md`.
2. Fresh-session resume check (AC_ECC_09): a new context reads `CLAUDE.md` and this file and reconciles with Git/CI.
3. Owner actions in `docs/Owner_Actions.md` (#1–#27) unblock everything else: accounts, consent provider, OpenAI key
   and ZDR approval (live moderation and AI), store products and prices, email provider, legal review, spend budget,
   hosted Supabase checks, database production mark, child-safety package approval, moderation-outage rule,
   reviewer capacity.
