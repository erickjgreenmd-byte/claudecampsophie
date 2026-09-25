# PencilLift test evidence (spec E1/E5; AC_ECC_07, AC_DEPLOY_08)

What was run, on which commit, with what result. Software evidence only: every provider (Supabase project,
RevenueCat, Stripe, App Store, Google Play, Expo/EAS, OpenAI, email, storage) is replaced by a labeled mock or
blocked (`docs/Connections.md`), so nothing here is sandbox, device or production evidence.

## CI (GitHub Actions, `.github/workflows/ci.yml`)

| Run | Commit | Result | Steps |
|---|---|---|---|
| [#3](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/35967486861) | `c71786a` | **success** (07:02–07:07 UTC, 2026-09-24) | install (frozen lockfile) → format → secret scan → lint → typecheck → all tests incl. real Postgres 16 service (2 min 9 s) → finance arithmetic → gate audit with per-package test floors (`scripts/test-minimums.json`) — every step ran and passed |
| [#38](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36064658278) | `998dafa` | **success** (21:57–22:04 UTC) | every step on the round-5 code (`5f02621` is code-identical; later commits are records only) |
| [#39](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36065860039) | `df7f3a5` | **success** (22:09–22:15 UTC) | records-only commit on the round-5 code |
| [#40](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36089535564) | `efb1142` | **success** (2026-09-25 03:14–03:19 UTC) | every step on the brand commit `60955b5` + the Amazon Appstore channel commit `efb1142` (BUG-113); the same tree passed `scripts/verify.sh` in an isolated worktree first: domain 3,611, ui-tokens 4, db 308, contracts 15, mobile 452, web 425, ai 49, api 856 (5,720 tests, 0 failed) |
| [#41](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36089950097) | `db114c7` | **success** (03:20–03:26 UTC) | records-only commit on the brand + Amazon code |
| [#42](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36092151044) | `c49a7e7` | **success** (03:52–03:59 UTC) | every step on the parent-recipient commit (owner decision: no family hold, flag email, parent actions); the same tree passed `scripts/verify.sh` in an isolated worktree first: domain 3,613, ui-tokens 4, db 317, contracts 15, mobile 459, web 431, ai 49, api 876 (5,764 tests, 0 failed) |
| [#43](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36092614765) | `8c2dc42` | **success** (03:59–04:06 UTC) | records-only commit on the parent-recipient code |
| [#44](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36094912945) | `99166da` | **success** (04:33–04:39 UTC) | every step on the owner-dashboard / support-cases commit (migrations 0810, 0820); the same tree passed `scripts/verify.sh` in an isolated worktree first: domain 3,650, ui-tokens 4, db 335, contracts 15, mobile 507, web 461, ai 49, api 902 (5,923 tests, 0 failed); the first gate run of the slice failed four purge tests and caught BUG-114 before the commit |
| [#45](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36095353401) | `811f210` | **success** (04:39–04:46 UTC) | records-only commit on the owner-dashboard code |
| [#46](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36145382786) | `04c17ac` | **cancelled** (14:07–14:13 UTC) — superseded by #47 when `a2aed0c` was pushed six minutes later (the branch's concurrency group cancels an in-progress run); the tree of `04c17ac` had passed `scripts/verify.sh` in an isolated worktree: domain 3,650, ui-tokens 4, db 335, contracts 15, mobile 507, web 461, ai 49, api 911 (5,932 tests, 0 failed) | Resend email adapter |
| [#47](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36146044546) | `a2aed0c` | **cancelled** (14:13–14:16 UTC) — superseded by #48 when the records commit `8ac47ea` was pushed; the tree of `a2aed0c` had passed `scripts/verify.sh` in an isolated worktree: domain 3,656, ui-tokens 4, db 335, contracts 15, mobile 509, web 461, ai 49, api 913 (5,942 tests, 0 failed) | support policy settings |
| [#48](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36146212088) | `8ac47ea` | **success** (14:15–14:21 UTC) | every step on the Resend + support-policy code (`a2aed0c` is code-identical; `8ac47ea` adds records) |
| #37 | `1de2803` | **success** (19:49–19:55 UTC) | every step (records and the restored ai floor) |
| [#35](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/36049019610) | `e123e5c` | **success** (19:34–19:40 UTC) | every step, after 15:00 UTC real time: confirms the BUG-090 clock fix (at 4a07ac9 the pinned-clock tests would fail after 15:00) |
| [#34](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/35999435932) | `4a07ac9` | **success** (12:30–12:36 UTC) | every step |
| [#24](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/35988504627) | `13bb3dc` | **success** (10:39–10:45 UTC) | every step above plus the new release-artifact secret scan (web build, Worker dry run, Expo web export, native public config; negative control) |
| [#18](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/35983581731) | `b6e9998` | **failure** — web: one sponsor-card viewability test (BUG-083, a test race reproduced locally 1 in 12 under load; fixed in `48430c5`) | all other steps passed up to the web tests |
| [#17](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/35977752017) | `8872b98` | **success** (08:51–08:57 UTC) | every step |
| #15 | `c51ed37` | **success** | every step |
| #1, #2 and every run superseded by a newer push | — | cancelled (`cancel-in-progress`) | — |

CI first ran on this branch at `e067f32`, when pushes to `claude/**` were added to the triggers; before that it
had never executed (it triggered only on pull requests and `main`).

## Local full gate

`scripts/verify.sh` on the round-5 tree (committed as 8a84780..5f02621), 2026-09-24, reports written 21:50–21:53 UTC, exit 0: api 845,
domain 3,610, db 255, web 406, mobile 400, ai 49, contracts 14, ui-tokens 4 (5,583; 0 failed, 0 skipped); gate
audit; finance; release-artifact scan with negative control (69 files, 12.0 MiB). Floors raised to ~95% of these counts for every package with
more than 20 tests (api 800, domain 3,430, db 242, web 386, mobile 380, ai 46); contracts 13/14, ui-tokens 4/4.

`scripts/verify.sh` on the round-4 tree (committed as 1231198..e123e5c), 2026-09-24 ~19:05 UTC, exit 0: secret scan,
format, lint, typecheck, all tests (api 805, domain 3392, db 255, web 406, mobile 400, ai 18, contracts 14,
ui-tokens 4 — 5,294, 0 failed, 0 skipped), gate audit (every package at or above its floor), finance arithmetic,
release-artifact build and secret scan with the negative control (planted keys found).

Recorded after the final integration (see below). The first local run at `f308356` stopped at the domain tests
because one review test exceeded the default 5 s timeout under load (BUG-062: measured, the product path takes
0.1 ms; the test itself does 18 full-bank generations); fixed in `4ccc7c9`.

## Review and regression evidence

- Every adversarial review wrote failing tests first; each fix was integrated only after its review tests
  passed on the combined tree. Review test files for the lead's own code were diffed byte-for-byte against the
  reviewer's originals before integration (`docs/ECC_Runs.md`).
- Mutation checks recorded in the ledger (e.g. BUG-034 staged-tree gate, BUG-061 restated answers, secret scan
  in index mode): the new check was shown to fail with the fix removed and pass with it restored.
- Acceptance coverage per criterion, with the test names and counts each assessor ran and a skeptic re-ran:
  `docs/Requirement_Coverage.md` (generated from `docs/coverage_status.json`).
