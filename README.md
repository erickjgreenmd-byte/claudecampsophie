# PencilLift

A homework-help product for families. A parent photographs a child's worksheet; PencilLift extracts
the questions, grades them, builds daily and weekly practice from what the child actually got wrong,
and keeps the parent in control of all of it. Six subjects, K–8. Parent portal on the web, a parent
area and a separate locked child space on iOS, Android and Fire tablets.

**Status: built, not deployed.** Every suite passes and nothing is running anywhere. Those are
different kinds of done — see the packet below before forming an estimate.

## If you are a developer

Start with **[`docs/Developer_Packet.md`](docs/Developer_Packet.md)**: the architecture, what is
built and how far each part has been proved, how to get a green local run, the conventions that are
enforced rather than suggested, and what is actually left to do.

```sh
pnpm install --frozen-lockfile
pnpm db:local        # local PostgreSQL for the authorization suite
scripts/verify.sh    # everything CI runs
```

Needs Node 22, pnpm 10 and PostgreSQL 16 or 17.

## If you are the owner

Start with **[`docs/Owner_Beta_Checklist.md`](docs/Owner_Beta_Checklist.md)**: the ordered runway to
a beta — which accounts to open, in what order, what each costs, how long each makes you wait, and
the four things that stand between today and a URL a parent can open.

## Layout

| Path | What |
|---|---|
| `packages/domain` | pure business rules — pricing, grading, the question bank, the learning planner. No I/O |
| `packages/contracts` | zod schemas and shared copy used by every surface, plus the typed API client |
| `packages/ai` | OpenAI transport, prompts, moderation, the zero-data-retention gate, spend metering |
| `packages/ui-tokens` | brand colours, spacing, type scale, contrast helpers |
| `apps/api` | Hono on Cloudflare Workers — 171 routes, durable jobs, a 5-minute cron |
| `apps/web` | Vite + React parent portal and owner admin console |
| `apps/mobile` | Expo — parent area and child space |
| `supabase/` | 44 migrations and the real-Postgres authorization suite |
| `docs/` | the project's records: progress, defects, lessons, runbook, threat model, costs |

## How this project works

Changes are gated by `scripts/verify.sh` — the same checks CI runs — and nothing merges red. Every
meaningful defect goes through the same loop: reproduce it, write the failing regression, fix it,
re-test, review, and record the lesson. `docs/Bug_Ledger.md` has 431 entries written that way and
`docs/Lessons_Learned.md` has the 83 lessons they produced. The records are candid, including about
their own mistakes; three have been found materially wrong and corrected. Check a sentence against
the code before you rely on it.

House rules that are enforced by tests, not by convention, are in [`CLAUDE.md`](CLAUDE.md). The
product specification is `PencilLift_Claude_Code_Master_Prompt.md` (Revision 8), preserved
byte-for-byte; `reference/` is historical only.

## Privacy, stated up front

A child's homework is the most sensitive thing this product touches, so the controls are in the code
rather than in a policy document: no child personal data reaches a model without documented
zero-data-retention approval, a mock provider can never serve production, every `public` table is
under row-level security, and no prompt, image or model response is ever written to a log. The
position and what is still required of the owner are in
[`docs/Data_Retention_And_ZDR.md`](docs/Data_Retention_And_ZDR.md). Nothing in this repository makes
zero data retention active or makes the product legally compliant — both are the owner's to obtain.
