# PencilLift test evidence (spec E1/E5; AC_ECC_07, AC_DEPLOY_08)

What was run, on which commit, with what result. Software evidence only: every provider (Supabase project,
RevenueCat, Stripe, App Store, Google Play, Expo/EAS, OpenAI, email, storage) is replaced by a labeled mock or
blocked (`docs/Connections.md`), so nothing here is sandbox, device or production evidence.

## CI (GitHub Actions, `.github/workflows/ci.yml`)

| Run | Commit | Result | Steps |
|---|---|---|---|
| [#3](https://github.com/erickjgreenmd-byte/claudecampsophie/actions/runs/35967486861) | `c71786a` | **success** (07:02–07:07 UTC, 2026-09-24) | install (frozen lockfile) → format → secret scan → lint → typecheck → all tests incl. real Postgres 16 service (2 min 9 s) → finance arithmetic → gate audit with per-package test floors (`scripts/test-minimums.json`) — every step ran and passed |
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
