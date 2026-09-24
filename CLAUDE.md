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
| Pre-commit gate (fail-fast, no filters) | `scripts/verify.sh` (whole repo) or `scripts/verify.sh --only api,db` |
| Secret scan (tracked files) | `node scripts/scan-secrets.mjs` |
| Worker bundle dry run | `cd apps/api && npx wrangler deploy --dry-run --outdir <dir>` |
| Web build / Expo web smoke | `pnpm --filter @pencillift/web build` / `cd apps/mobile && npx expo export --platform web` |

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
- JSON into Postgres: `${JSON.stringify(x)}::text::jsonb` or `tx.json(x)`, never a bare `::jsonb` (L-006).
- Mobile token sources come only from `apps/mobile/src/lib/app-session.ts`; never add a second child
  token refresher (L-007).
- Shared registration points (`apps/api/src/app.ts`, `apps/web/src/routes.tsx`, contracts index, domain
  package exports, migrations numbering) are changed by the lead only.

## Records (read on resume, reconcile with Git/CI)

`docs/Progress.md` · `docs/Requirement_Coverage.md` · `docs/Bug_Ledger.md` · `docs/Lessons_Learned.md` ·
`docs/ECC_Capabilities.md` · `docs/ECC_Runs.md` · `docs/Connections.md` · `docs/Owner_Actions.md` ·
`docs/Test_Evidence.md` · `docs/Cost_Analysis.md` · `docs/Threat_Model.md` ·
`docs/Deployment_Runbook.md` · `docs/Release_Readiness.md` · `docs/Provider_Capability_Matrix.md`
