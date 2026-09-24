# PencilLift progress (spec E1 record; resume from here)

Branch: `claude/new-session-vil6cz` (pushed after every lead commit). Spec: `PencilLift_Claude_Code_Master_Prompt.md`
Revision 8. Pricing: $39.99 first child + $9.99 each additional (1–4 paid slots) — unchanged.

## Current milestone

M2–M4 build (software) with M0 records done. Everything that needs an external account is blocked on
`docs/Owner_Actions.md`; nothing is deployed, no live provider has been exercised, no measured AI usage exists.

## Done and committed (lead-verified)

| Area | Evidence |
|---|---|
| Monorepo, CI, fail-fast gate `scripts/verify.sh` | CI workflow + local runs |
| Schema 0001–0630 with RLS, append-only ledgers, deletion purge, jsonb shape checks | `supabase/tests` 130 tests on real Postgres 16 |
| Parent/child auth, PIN step-up, pairing, sessions | `apps/api/tests/auth.test.ts` |
| P17: parent school/promo flows, owner console API, monthly generation, donation accrual, billing webhooks with promo reconciliation | `promotions`, `admin-promotions`, `webhooks` API tests |
| Durable scheduler + job ledger (SKIP LOCKED, retries, dead letters), deletion purge job, retention, reservation expiry | `apps/api/tests/scheduled.test.ts` 11 tests |
| Scan processing pipeline (extraction → checks → verification → guarded coaching) | `apps/api/tests/scan-process.test.ts` 11 tests (mock AI, labeled) |
| Domain: pricing, promotions, donations, entitlements, quotas, rewards, grading, answer-guard, learning | package tests (≈1,500) |

## In flight (background workflows; see `docs/ECC_Runs.md`)

- `wf_937b0690-525` domain modules: adversarial reviews + fixes for all nine modules (scheduling not yet committed).
- `wf_984c4069-620` feature verticals: public site, rewards, homework, family/guardians/consent, privacy, P17 UI.
- `wf_96d96581-4a8` P16 monetization (migration 0640, domain, API, web, mobile).
- `wf_b5f6dbc1-69a` learning vertical (question bank, daily/Thursday jobs, practice API, exports, planner UI).

Uncommitted working-tree files belong to those agents until the lead integrates them.

## Next exact steps

1. As each workflow finishes: read its journal result, run `scripts/verify.sh` on the combined tree, record
   findings in `docs/Bug_Ledger.md`, commit, push.
2. Integration items owned by the lead: wire `enqueueDueLearningJobs` + learning handlers + export builder +
   `purgeExpiredServes` into the tick; wire the Supabase Storage adapter in `apps/api/src/index.ts`;
   reconcile the privacy route's purge enqueue with `request_deletion` (which now enqueues the purge itself);
   make the mobile scan flow convert HEIC to JPEG (the pipeline refuses HEIC/PDF until the converter exists).
3. Final: sequential full verification, `Test_Evidence.md`, `Release_Readiness.md`, coverage render, report.
