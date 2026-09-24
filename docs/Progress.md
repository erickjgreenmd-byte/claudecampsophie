# PencilLift progress (spec E1 record; resume from here)

Branch: `claude/new-session-vil6cz` (pushed after every lead commit; CI runs on every `claude/**` push).
Spec: `PencilLift_Claude_Code_Master_Prompt.md` Revision 8. Pricing: $39.99 first child + $9.99 each additional
(1–4 paid slots) — unchanged.

## Current state (2026-09-24, checkpoint at `d0a7cfd`)

Software for every spec area is built and integrated on the branch; nothing is deployed, signed, submitted or
approved, and no live provider has been exercised (`docs/Connections.md`, `docs/Release_Readiness.md`).
Acceptance coverage (153 criteria; `docs/Requirement_Coverage.md`, each row with its gap): integration_tested 31,
unit_tested 16, db_tested 1, verified_by_inspection 21, mock_only 15, blocked_external 27, in_progress 41,
not_tested 1 (AC_GRADING_11, the frozen 200-question evaluation, needs real AI and labelled data).

Last full local runs on the combined tree (before the final review workflow): domain 2756, DB 243, API 720+,
mobile 397, web 405, contracts 14 — all passing; typecheck clean. CI: runs #15, #17, #24 green; #18 red on a test race
(BUG-083, fixed). See `docs/Test_Evidence.md`.

## Done and committed (lead-verified)

| Area | Evidence |
|---|---|
| Monorepo, CI (incl. release-artifact secret scan with a negative control), fail-fast gate `scripts/verify.sh` (now runs the test-count audit), pre-commit hook on the staged tree | BUG-024/034/081/089 |
| Schema 0001–0770 with RLS, append-only ledgers, deletion purge, jobs, identity hardening, school-report accuracy and zone pin (0730/0740), reward rules (0750), safety screening and family hold (0760), fake-catalog guard (0770) | `supabase/tests` 243 tests on real Postgres 16 |
| Parent/child auth, PIN step-up, pairing, sessions, sign-out ending API access; one child token refresher (BUG-012 reproduced and guarded) | API auth/identity suites; mobile `token-sources.test.ts` |
| Family, guardians, consent (explicit provider selection; mock only in development/test), privacy, deletion, exports | vertical suites; `runtime.test.ts` |
| Homework capture: image header limits, frame checks, stored size and sha256 verified at finalize and at scan time, HEIC/PDF refused honestly | BUG-078, BUG-088 |
| Scan pipeline with guarded coaching; answer guard reads arithmetic expressions by default; rubric feedback for children (labels only) | BUG-061, BUG-075, BUG-076 |
| Child safety: deterministic screen before and after generation, reviewed templates (drafts), escalated system reports, family hold | BUG-084..087 (approvals pending, Owner action #24) |
| Learning, rewards (published and configurable earning rules), P16 monetization (kill switches off; fake catalog never served), P17 promotions/schools/donations | BUG-064..073, BUG-077, BUG-080 |
| Billing: status/sync/capacity changes (price gate always applies), webhooks, TRANSFER, native offer step — against labeled mocks; no billing/storage/email mock outside development/test | BUG-065, BUG-079, BUG-082 |
| Spend ceiling admits a stage only if its estimate fits under the cap | BUG-064 |
| Adversarial reviews of every module, vertical and lead change, each followed by fixes and checks | `docs/ECC_Runs.md`, BUG-013..089 |

## In flight

- `wf_2e80c3c2-fd2`: fresh-context adversarial review of the child-safety second pass, the lead's jobs/AI changes and
  the lead's runtime/data changes (plus the unchecked capture-limits and release-gates second passes), then fixes and
  checks of confirmed findings.

## Next exact steps

1. Integrate `wf_2e80c3c2-fd2` area by area (verify on the combined tree, mutation checks, ledger, commit, push).
2. Final gate on an idle machine: `scripts/verify.sh` (format, lint, typecheck, all tests, gate audit, finance,
   release-artifact scan) and a green CI run on the same SHA; record both in `docs/Test_Evidence.md`.
3. Fresh-session resume check (AC_ECC_09): a new context reads `CLAUDE.md` and this file and reconciles with Git/CI.
4. Owner actions in `docs/Owner_Actions.md` (#1–#25) unblock everything else: accounts, consent provider, ZDR
   approval, store products and prices, email provider, legal review, spend cap, hosted Supabase checks, database
   production mark, safety-package approval.
