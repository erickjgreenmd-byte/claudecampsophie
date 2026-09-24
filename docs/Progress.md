# PencilLift progress (spec E1 record; resume from here)

Branch: `claude/new-session-vil6cz` (pushed after every lead commit; CI runs on `claude/**` pushes since e067f32).
Spec: `PencilLift_Claude_Code_Master_Prompt.md` Revision 8. Pricing: $39.99 first child + $9.99 each additional
(1–4 paid slots) — unchanged.

## Current state (2026-09-24)

Software for every spec area is built and integrated on the branch; nothing is deployed, signed, submitted or
approved, and no live provider has been exercised (`docs/Connections.md`, `docs/Release_Readiness.md`).
Acceptance coverage (153 criteria, skeptic-verified): integration_tested 29, unit_tested 16, db_tested 1,
verified_by_inspection 21, mock_only 14, blocked_external 26, in_progress 45, not_tested 1
(`docs/Requirement_Coverage.md`, with each row's gap).

## Done and committed (lead-verified)

| Area | Evidence |
|---|---|
| Monorepo, CI, fail-fast gate `scripts/verify.sh`; pre-commit hook typechecks and secret-scans the staged tree | `scripts/git-hooks/pre-commit`, BUG-024/034 |
| Schema 0001–0720 (+0730 in flight) with RLS, append-only ledgers, deletion purge, jobs and identity hardening | `supabase/tests` 212 tests on real Postgres 16 |
| Parent/child auth, PIN step-up, pairing, sessions, sign-out ending API access | API auth, identity-hardening and lead identity review tests |
| Family, guardians, consent (mock provider only), privacy, deletion, exports | vertical API/web/mobile suites |
| Homework capture and the scan pipeline (extraction → deterministic checks → grading → verification → guarded coaching) | `scan-process.test.ts` (labeled mock AI) |
| Learning: question bank, daily/Thursday/top-up jobs, practice API, planner (web, mobile), child practice/review | learning suites |
| Rewards, P16 monetization (every kill switch off), P17 promotions/schools/donations | vertical suites |
| Billing: status/sync/capacity changes, webhooks and TRANSFER, native offer step (mock provider only) | billing suites |
| Domain modules (pricing, entitlements, quotas, promotions, donations, rewards, grading, answer guard, learning, scheduling, monetization, bank) | `packages/domain` 2,129 tests |
| Independent adversarial reviews of every module, vertical and of the lead's own code, each followed by fixes and (for lead code) adversarial checks | `docs/ECC_Runs.md`, BUG-013..062 |

## In flight

- `wf_aea7bbc1-d46` fixes the concrete defects the coverage pass found: archived-child history on parent reads,
  PDF import offered but unsupported, rubric feedback not shown, school-report accuracy and late donation
  accruals (migration 0730), capacity-change price gate, ad-cohort environment filter, explicit consent
  provider selection, strict spend ceiling, arithmetic-expression answer leaks in hints.
- First CI runs on the branch (runs #1–#3; earlier runs are cancelled by newer pushes).

## Next exact steps

1. Integrate `wf_aea7bbc1-d46` slice by slice (verify on the combined tree, ledger, commit), then update the
   coverage entries it changes and re-render.
2. Full `scripts/verify.sh` + `node scripts/assert-test-count.mjs` on an idle machine; Worker bundle dry run,
   web build and Expo web export; record in `docs/Test_Evidence.md`; confirm a green CI run on the same SHA.
3. Owner actions in `docs/Owner_Actions.md` unblock everything else (accounts, consent provider, ZDR approval,
   store products and prices, email provider, legal review, spend cap, hosted Supabase check).
