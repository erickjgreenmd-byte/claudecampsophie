# PencilLift ECC execution evidence (spec E5.3, AC_ECC_02/03)

ECC is not installed in this environment (`docs/ECC_Capabilities.md`). Every row is a **fallback** run with
Claude Code built-ins, labeled as such. No row claims an ECC skill or agent ran.

| Task / requirement | Capability actually used (fallback for ECC role) | Run reference | Starting → integrated revision | Files owned | Commands / exit codes | Findings / next | Usage |
|---|---|---|---|---|---|---|---|
| DOMAIN-* (9 modules: entitlements, quotas, promotions, donations, rewards, grading, answer-guard, learning, scheduling) | Workflow tool subagents: implement (for `tdd-workflow`) → fresh-context adversarial review writing failing tests (for `code-reviewer`) → fix (for `build-error-resolver`/`tdd-guide`) | Workflow run `wf_937b0690-525` | 9234b08 → b73d8ff (promotions, donations, entitlements, quotas), 69e0a31 (grading, answer-guard, rewards, learning, implementation stage); reviews/fixes pending | `packages/domain/src/<module>/` per agent | Recorded per module in `docs/Test_Evidence.md` after integration | Pending | Within session budget |
| Feature verticals (public site, rewards, homework, family/guardians/consent, privacy, P17 UI) | Workflow subagents: implement → adversarial review (failing regression tests) → fix | Workflow run `wf_984c4069-620` | c1590e3 (registration points pre-created) → pending | Enumerated per agent in the workflow script (`owns:`); shared files (app.ts, routes.tsx, contracts index) reserved to the lead | Pending | Pending | Within session budget |
| P16 monetization (DB 0640, domain, API, web, mobile) | Workflow subagents: backend → UI → adversarial review → fix | Workflow run `wf_96d96581-4a8` | a7b1de1 (registration points) → pending | `supabase/migrations/0640_monetization.sql`, `packages/domain/src/monetization/**`, `routes/monetization.ts`, `routes/admin-monetization.ts`, contracts, pages | Pending | Pending | Within session budget |
| Learning vertical (question bank, daily/Thursday jobs, practice API, exports, planner UI) | Workflow subagents: backend → UI → adversarial review → fix | Workflow run `wf_b5f6dbc1-69a` | 2db9bd5 (bank registration point) → pending | `packages/domain/src/bank/**`, `routes/learning.ts`, `jobs/learning-jobs.ts`, `jobs/export-build.ts`, `services/pdf.ts`, migration 0650, pages/screens | Pending | Pending | Within session budget |
| Lead-owned integration: scheduler/deletion purge, scan pipeline, jsonb fix, billing reconciliation | Lead (main loop) with real-Postgres tests; no ECC agent | Commits 1c9851d, f820986, 69e0a31 | — | `apps/api/src/jobs/*`, migrations 0620/0630, services | `vitest run tests/scheduled.test.ts` 11/11, `tests/scan-process.test.ts` 11/11, DB suite 130/130 (exit 0) | BUG-008/009/010 found and closed | — |

## Concurrency deviation (AC_ECC_04)

The ECC guide's resource default is at most two concurrent helpers. From commit a7b1de1 onward up to four
workflows ran at once (each capped at two concurrent agents by the tool, so up to eight helpers). Reason: the
owner enabled multi-agent orchestration for this session and asked for all phases to proceed without
waiting. Safeguards actually used: every agent's writable files are enumerated in its prompt and disjoint
from every other agent's; shared registration points (app.ts route mounts, web route table, contracts
index, domain package exports) were pre-created and committed by the lead before launch; migrations use
reserved numbers (0640 monetization, 0650 learning) and the lead applies/integrates them; agents never run
git or repo-wide formatters; the lead commits only after re-running checks on the combined tree.
Known cost of the deviation: the build machine has 4 CPUs, so timing-sensitive tests run slower while agents
execute; the final verification is therefore run sequentially after all workflows finish, and any
timing failure is investigated rather than retried until green.
