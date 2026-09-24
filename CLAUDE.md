# PencilLift — project instructions

Spec: `PencilLift_Claude_Code_Master_Prompt.md` **Revision 8** (authoritative, preserved byte-for-byte;
`reference/` is historical only). Binding engineering decisions: `docs/Architecture.md`.

## Commands (verified 2026-09-24)

| Purpose | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Local Postgres for DB/API tests | `pnpm db:local` (or any PG16; set `DATABASE_URL`) |
| Everything CI runs | `pnpm check` then `node scripts/assert-test-count.mjs` |
| Unit tests only | `pnpm test:unit` |
| DB authorization tests | `pnpm test:db` (limit while authoring: `PL_MIGRATIONS_ONLY=0001,0300 pnpm test:db`) |
| One package | `pnpm --filter @pencillift/<name> run test` / `typecheck` |
| Lint / format | `pnpm lint` / `pnpm format` |
| Finance arithmetic | `pnpm finance:check` |

## Rules

- Preserve approved prices ($39.99 first child + $9.99 each additional, 1–4 paid slots), child privacy,
  protected parent solutions, OpenAI runtime routing and all six subjects. Never weaken a test, RLS
  policy, consent/ZDR gate or verification step to get a pass.
- Money is integer cents; time is UTC instants plus IANA zones; domain code takes `now` as input.
- Every new `public` table needs RLS; `supabase/tests/schema_invariants.test.ts` enforces it.
- Mocks are labeled mocks. A missing credential is a blocker, never a passing test.
- Meaningful defects: reproduce → failing regression → fix → retest → review → lesson
  (`docs/Bug_Ledger.md`, `docs/Lessons_Learned.md`).
- No secrets, real child data or raw homework in code, fixtures, logs or docs. Synthetic names only.

## Records (read on resume, reconcile with Git/CI)

`docs/Progress.md` · `docs/Requirement_Coverage.md` · `docs/Bug_Ledger.md` · `docs/Lessons_Learned.md` ·
`docs/ECC_Capabilities.md` · `docs/ECC_Runs.md` · `docs/Connections.md` · `docs/Owner_Actions.md` ·
`docs/Test_Evidence.md` · `docs/Cost_Analysis.md` · `docs/Threat_Model.md` ·
`docs/Deployment_Runbook.md` · `docs/Release_Readiness.md` · `docs/Provider_Capability_Matrix.md`
