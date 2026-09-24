# PencilLift ECC capability inventory (spec E5.1, AC_ECC_01)

Inspected 2026-09-24 in the Claude Code **cloud session** that is building PencilLift (not the owner's
local computer). Re-run this inventory in every new environment; a different machine can differ.

## Verified facts

| Item | Observed value | Evidence |
|---|---|---|
| Claude Code version | 2.1.281 | `claude --version` |
| ECC (Everything Claude Code) plugin | **Not installed** | `~/.claude/plugins/` contains only an empty synced org bucket; no `ecc` manifest, skills or agents present |
| Can ECC be installed here? | **Not installed** | `github.com` is denied by the environment's network policy (`curl https://github.com/affaan-m/ECC` → proxy 403), so the plugin marketplace install path fails. Correction (2026-09-24 coverage pass): `raw.githubusercontent.com` answers (a status-only request for the ECC `plugin.json` returned HTTP 200), so a manual file-by-file install would have been technically possible. It was not done: that would run unvetted third-party skill/agent code with this session's permissions, and every ECC role had a built-in fallback. The claim "cannot be installed" is therefore narrowed to "not installed by decision; marketplace path blocked" |
| ECC upstream version named by spec | `ecc` 2.2.1 (spec E5.1) | Not verifiable from this environment |
| Project `.claude/` settings | None existed before this session | `ls .claude` → absent |
| Hooks active in this session | Platform stop hook `~/.claude/stop-hook-git-check.sh` (blocks stopping with uncommitted/unpushed work; has `stop_hook_active` recursion guard); reply-gate hooks for the session UI | File inspection; not project-configured |
| Project memory / learning observer | No ECC `continuous-learning-v2`; no observer running | Not installed |
| Development budget | Owner authorized relevant specialist delegation "within the existing permissions and development budget"; no numeric cap was supplied | START_HERE.md instruction |

**Conclusion:** No ECC capability can be claimed as used in this environment. Every ECC role below is
performed by a clearly named Claude Code built-in fallback and recorded as such in `docs/ECC_Runs.md`.
This is an honest fallback, not an ECC run (spec E5.1: "Do not report ordinary reasoning as an ECC agent run").

## Role routing: ECC candidate → capability actually used

| Responsibility (spec E5.2) | ECC candidate (unavailable) | Capability actually used here | Invocation | Restrictions |
|---|---|---|---|---|
| Decomposition / risky design | `planner`, `architect` | Lead session + `docs/Architecture.md` decisions | Direct | Lead remains accountable |
| Implement + reproduce defects (TDD) | `tdd-workflow`, `tdd-guide` | Claude Code **Workflow** tool subagents with a mandatory tests-first prompt contract | `Workflow` script, `agent()` per module | Directory ownership, no git/installs, max 2 concurrent (machine has 4 CPUs) |
| Code review | `code-reviewer` | Fresh-context adversarial reviewer subagents that must prove each finding with a failing test; built-in `code-review` skill for integrated diffs | `Workflow` review stage; `Skill: code-review` | Reviewer cannot edit implementation |
| Database / RLS review | `database-reviewer` | Real-Postgres authorization tests + schema invariant tests + reviewer subagents | `pnpm test:db` | Tests run as real roles, never as superuser |
| Security review | `security-review`, `security-reviewer` | Built-in `security-review` skill + adversarial security reviewer subagents | `Skill: security-review`; `Workflow` | Not an independent human assessment (spec V1) |
| Build repair | `build-error-resolver` | Lead session / subagent with real rebuild | Direct | No weakened compiler/lint settings |
| E2E journeys | `e2e-testing`, `e2e-runner` | Vitest + Testing Library (web); native E2E **blocked** (no device/simulator, no EAS credentials) | — | Browser tests are not native proof |
| AI eval / verification loop | `eval-harness`, `verification-loop` | `pnpm check` + `scripts/assert-test-count.mjs`; AI eval **blocked** (OpenAI API denied by network policy, no account access) | — | — |
| Repair loop / learning | `loop-operator`, `continuous-learning-v2` | Repository records: `docs/Bug_Ledger.md`, `docs/Lessons_Learned.md`, `docs/Progress.md` (sanitized, manual) | — | No background observer claimed |
| Docs / cleanup | `doc-updater`, `refactor-cleaner` | Lead session; built-in `simplify` skill when warranted | `Skill: simplify` | Behavior-preserving only |

## To activate ECC on the owner's machine

1. In the owner's local Claude Code: install ECC from its official source and note the exact version and namespace it reports.
2. Replace the "Capability actually used" column with the installed callable names after a harmless test run of each.
3. Keep the fallbacks listed for anything that doesn't load.
