# Architecture decisions — why PencilLift is built this way

Written 2026-10-19 for an external engineer evaluating this codebase. Tier 2 (authoritative record)
under `docs/Source_Of_Truth.md`: true as of its date, corrected with a dated note rather than
overwritten.

**This is not a technology list.** For *what* the architecture is, read `docs/Architecture.md`
(Tier 1, binding) and `docs/Developer_Packet.md`. This file answers *why* — and where nobody ever
wrote a reason down, it says so. "Chosen without a recorded rationale" appears several times below.
That is the honest answer and it is the useful one: those are the decisions you can challenge
cheaply, because no argument is being defended.

Nothing in this file is a requirement. Where a decision is still open it is marked **UNDECIDED**;
where a design exists that the code does not implement it is marked **TENTATIVE**.

## Context you need before reading any decision

| Fact | How it changes the way you read the reasoning |
|---|---|
| **Nothing has ever been deployed.** No Worker, no portal, no native build. `.github/workflows/deploy-api.yml`, `deploy-web.yml` and `db-migrate.yml` have run zero times. | Every operational claim below is a property of code and configuration, not of observed behaviour. No decision here has been validated under load, latency, or real provider failure. |
| The Supabase project `pencillift-staging` (ref `uroolgscjkbpcsioqogm`, us-west-1, PostgreSQL 17.11) exists and its schema has **never been applied** — zero tables in `public`, `private`, `app`. | The 44 migrations in `supabase/migrations` are proven against local Postgres 16 and 17 in CI, and against nothing else. |
| **Production cannot boot, deliberately.** `CONSENT_ADAPTERS` in `apps/api/src/config.ts` is an empty `Set`; `CONSENT_ADAPTER_FACTORIES` in `apps/api/src/index.ts` is an empty object; `buildRuntimeOrThrow` returns `NOT_READY` when `environment === 'production'` and `providers.consent !== 'configured'`. | This is decision 11, not an oversight. Only `testbed` and `staging` can serve. |
| 7,503 tests pass across 8 packages, zero skipped; the floors in `scripts/test-minimums.json` equal the actual counts exactly (3670 + 1224 + 484 + 991 + 941 + 119 + 70 + 4). | The suites are the main evidence for every decision below, and the main thing a replacement would have to keep. |
| The repository is **public on GitHub**. | Only names of secrets appear anywhere; no values. That constraint shaped decision 11. |
| HEAD is `70d352c` on `claude/new-session-vil6cz`, which is also the default branch. There is no `main`, and no pull request has ever existed. | There is no review history to mine. The reasoning is in file headers and in the ledgers, nowhere else. |

## Where the reasoning actually lives

Most of this codebase's reasoning is in **file headers**, not in design documents. The headers are
long on purpose and they are the primary sources for this file.

| Source | What kind of reasoning it holds |
|---|---|
| `PencilLift_Claude_Code_Master_Prompt.md` (Revision 8, byte-for-byte) | The owner's constraints. Several "decisions" below are not decisions — the spec mandated them. Lines 37, 206 and 212 are the platform mandate. |
| `docs/Architecture.md` | The binding decisions, stated. Thin on *why*; §8 is the only explicit rejected-alternatives table in the repository. |
| `docs/Lessons_Learned.md` (append-only; `docs/Open_Work.md` carries the current count) | The richest source. Most rows are a decision with the defect that forced it. Cited below as L-nnn. |
| `docs/Bug_Ledger.md` (434+ rows) | Root causes that are decisions, and — in BUG-420 — a decision *not* to fix something, with the trade written out. |
| `apps/api/wrangler.toml` | ~40 lines of commentary on environment selection, the testbed, and why `workers_dev` differs per environment. |
| `packages/ai/src/zdr.ts` | Why each OpenAI endpoint and feature is or is not allowed, with the date the sources were read. |
| `apps/api/src/providers/identity-openai.ts` | Why the adult ID check cannot work with OpenAI alone. |
| `apps/api/src/pg-client.ts`, `src/db.ts`, `src/jobs/dispatcher.ts`, `supabase/tests/harness.ts` | Driver options, role switching, lease arithmetic, test isolation. |
| `CLAUDE.md` | The rules that are enforced rather than suggested. |

## Decision index

| # | Decision | Was it reasoned? |
|---|---|---|
| 1 | Cloudflare Workers for the API | Spec mandate; no engineering rationale recorded |
| 2 | Hono as the HTTP framework | **No recorded rationale at all** |
| 3 | Supabase Postgres + Supabase Auth; auth not hand-rolled | Spec mandate; the "don't hand-roll" half is well reasoned from defects |
| 4 | Postgres job ledger + 5-minute cron instead of a queue | Consequences well reasoned; **the substitution itself has no recorded rationale** |
| 5 | Hyperdrive as the database binding | Driver consequences reasoned; the choice of Hyperdrive itself is not |
| 6 | pnpm monorepo; pure domain package taking `now` as an argument | Well reasoned from defects |
| 7 | Expo/React Native for mobile; Vite/React for the portal | Mobile mandated; Vite unreasoned. Most expensive decision, measured |
| 8 | RLS as the authorization boundary | Explicitly reasoned, twice, including a rejected alternative |
| 9 | Children are not Supabase auth users | Explicitly reasoned; carries an open defect |
| 10 | OpenAI only, no automatic fallback | The best-reasoned decision in the repository |
| 11 | labeled-mock / unavailable / real selection, fail-closed readiness | Reasoned from a specific destructive defect |
| 12 | Shared zod contracts across three surfaces | Reasoned; the `strictObject` cost is an accepted open defect |
| 13 | Integer cents, UTC instants + IANA zones | Spec mandate plus arithmetic reasoning |
| 14 | RevenueCat as entitlement truth; Stripe off by default | Spec mandate plus four defect-driven refinements |
| 15 | Real Postgres per test file; floors equal to actual counts | Reasoned, with its own limits recorded honestly |

---

# Decision records

## 1. Cloudflare Workers for the API

**Decision.** `apps/api` is a single Cloudflare Worker — `apps/api/wrangler.toml`,
`main = "src/index.ts"`, `compatibility_flags = ["nodejs_compat"]`. `apps/api/src/index.ts`
default-exports exactly two handlers, `fetch` and `scheduled`.

**Context that forced it.** The spec, not an engineering judgement. Spec line 206: "`apps/api`:
TypeScript API and background workers. Suggested deployment: Cloudflare Workers plus Queues/Cron,
with a documented alternative runtime only if a required package cannot run there. Never rely on an
in-process timer for critical jobs." Spec line 37 lists "API/queue/hosting" as "Existing authorized
Cloudflare account or justified compatible runtime". The owner already had the account.

**Alternatives considered.** None recorded. The spec left the door open to another runtime *with a
written justification*, and nobody wrote one — so the alternative was never evaluated, rather than
evaluated and rejected.

**Consequences being lived with.**

- No long-running process, so all scheduled work had to become a cron-driven tick (decision 4).
- Worker invocation wall time leaks into job arithmetic. In `apps/api/src/jobs/dispatcher.ts`:
  `TICK_WALL_LIMIT_MS = 15 * 60_000`, `JOB_LEASE_MINUTES = 20` (deliberately longer than an
  invocation can live, "so a lease only expires when its worker is really gone"),
  `TICK_CLAIM_BUDGET_MS = 10 * 60_000`, plus a per-kind worst-case claim filter. Both corrections to
  that arithmetic (R4-JOBS-4, HUNT6-D-2) are written into the constants' own docblocks.
- `nodejs_compat` is required, which constrains which libraries can be used at all.
- CPU-heavy work is an open question. Spec line 212 says to keep heavy PDF rendering and image
  preprocessing in a compatible isolated worker "if required"; `apps/api/src/services/pdf.ts` lives
  in the Worker. Whether it fits Workers' CPU limits has never been measured, because nothing has
  been deployed. **UNDECIDED.**

**Where the reasoning is recorded.** The spec. The *environment* choices are reasoned at length in
`apps/api/wrangler.toml` — LRD-5: no top-level `APP_ENV`, so a `wrangler deploy` without `--env`
answers 503 rather than silently running as development with every mock; `workers_dev = true` for
staging and the testbed only, because no routes are defined anywhere in the file and a staging deploy
would otherwise succeed and produce a Worker nothing can reach. The choice of Workers itself has **no
recorded rationale beyond the spec's suggestion**.

## 2. Hono as the HTTP framework

**Decision.** `hono@4.13.8` (`apps/api/package.json`), composed in `apps/api/src/app.ts`.

**Context.** A Workers-native router with no Node runtime assumptions.

**Alternatives considered.** None recorded anywhere — not in `docs/Architecture.md`, not in the
ledgers, not in a file header. **Chosen without a recorded rationale.** It is the least-defended
choice in the stack and also the cheapest to replace: the framework surface actually used is routing
plus three middleware modules (`apps/api/src/middleware/{auth,context,rate-limit}.ts`).

**Consequences.** `createApp()` is the single composition point and is a lead-only file per
`CLAUDE.md`. The shared parent-token verifier is installed once there, which is what made L-013's fix
possible: a session check installed on one middleware was inert; installing it on the shared
dependency every caller uses was not.

## 3. Supabase for Postgres and Auth, and why auth is not hand-rolled

**Decision.** Supabase Postgres is the only durable store. Supabase Auth issues parent/guardian
identity; the API verifies those JWTs against Supabase JWKS (`apps/api/src/config.ts`
`supabase.jwksUrl` / `jwtSecret`, `apps/api/src/auth/parent.ts`). Children are **not** Supabase auth
users — decision 9.

**Context that forced it.** Spec line 212: "Use Supabase Postgres for durable records, Supabase Auth
for adult identity, private object storage for uploads". Spec line 34 requires reusing the correct
existing staging project. This was mandated, not chosen.

**Why auth is not hand-rolled — the recorded reasoning.** Two threads, both learned rather than
asserted:

- Supabase Auth brings email verification, MFA/AAL levels and password reset, and the authorization
  model leans on claims it issues: `aal = aal2` is the owner-admin gate (`docs/Architecture.md` §3),
  and `session_id` is what binds an adult step-up unlock to one session.
- The parts that *were* hand-rolled cost the most. Eight of the lessons are failures in token and
  session handling this project owns: L-007 (a second refresher eventually replays a rotating token
  and the server revokes the session), L-034 (a PKCE link opened in another browser left `?code=`
  unexchanged with no error), L-038 (the API stated only a database deadline, so a device 20 minutes
  slow presented already-expired tokens and one 20 minutes fast bounced every correct PIN), L-039
  (`supabase-js` defaults to sign-out scope `global`), L-040 (a recovery flag set once and never
  cleared left a no-current-password form standing), and L-047 / L-049 / L-050 (the child-refresh
  replay problem). L-058 is the summary: the idempotent child-refresh recovery was "designed, defended
  twice and repaired three times inside two days", and the fourth review showed its recorded residual
  understated the exposure by an order of magnitude. That is the measured cost of owning an auth
  mechanism, on the one mechanism this project had to own.

**Consequences being lived with.**

- Supabase's default grants are a hazard the schema must counteract: Supabase grants table privileges
  to `anon`/`authenticated` in `public` by default, so **a table without RLS is a data leak**
  (`docs/Architecture.md` §3). `supabase/tests/schema_invariants.test.ts` fails without RLS, and the
  test shim reproduces the default so the test is meaningful.
- The PostgREST Data API is a live second entry path the API does not control. L-060 states the cost
  best: "Add a consent checkbox" reads as a front-end task and is not one, because `authenticated`
  reaches `public.child_profiles` through the Data API with the parent's own token and never passes a
  Hono handler. The parental attestation is therefore enforced **in the schema**, by two `check`
  constraints added in `0970_parental_attestation.sql` — `child_profiles_attestation_complete`
  (version, instant and attesting adult are all three present or all three null) and
  `child_profiles_active_requires_attestation` (no child reaches `status = 'active'` without one) —
  not by a zod literal. **Corrected 2026-10-19:** this bullet said a *generated column*. 0970
  contains none; the generated column is `identity_verifications.adult_confirmed` in
  `0980_identity_verification.sql`, which is the adult identity check (decision 10) and a different
  claim about a different subject.
- A trigger on `auth.sessions` (migration `0720_identity_hardening.sql`) is required so that sign-out
  ends API access; every parent token check requires `app.auth_session_active` and fails closed. That
  is a write into Supabase's own schema and hosted Supabase must permit it — Owner Action 20, which
  this bullet first presented as an open risk. **Corrected 2026-10-19: it is answered.** It was
  settled on 2026-10-01 by probing `pencillift-staging` directly: `create trigger … after delete on
  auth.sessions` succeeded and a `security definer … set search_path = ''` function reading
  `auth.sessions` returned a count, so 0720 and 0830 will apply (`docs/Owner_Actions.md` #20). Those
  probe objects are the two leftovers still on the project, and `db-migrate.yml` drops them. The
  fallback if a hosted role ever refuses is recorded in the same row — a Supabase Auth hook in place
  of the trigger — and 0720 fails loudly rather than silently.
- Cost: the Supabase organization is on the **Pro** plan, roughly 25 USD/month before usage,
  corrected into `docs/Deployment_Runbook.md` §0.1 on 2026-10-17 (BUG-433) after that document had
  said "nothing here bills".

## 4. A Postgres job ledger drained by a 5-minute cron, instead of a queue

**Decision.** `public.jobs` (migration `0600_operations.sql`, hardened by `0710_jobs_hardening.sql`)
is a durable job ledger. A Cloudflare Cron Trigger (`crons = ["*/5 * * * *"]`, set per environment in
`apps/api/wrangler.toml`) calls `runScheduledTick` in `apps/api/src/jobs/dispatcher.ts`, which claims
one job at a time:

```sql
update public.jobs set status = 'running', attempts = attempts + 1, locked_until = $lease
 where id = ( select j.id from public.jobs j
               where j.status in ('queued','failed_retryable') and j.run_after <= $now
                 and j.kind = any($kinds) and (/* family not tombstoned */)
               order by j.run_after, j.created_at, j.id
                 for update of j skip locked limit 1 )
returning id, kind, family_id, child_id, payload, attempts, max_attempts
```

**There are no Cloudflare Queues.** `apps/api/wrangler.toml` has no `[[queues]]` binding, producer or
consumer; `apps/api/src/index.ts` exports only `fetch` and `scheduled`; no module in `apps/api/src` is
a queue consumer.

> **`docs/Architecture.md` §1 is wrong about this.** It describes `apps/api` as "Hono on Cloudflare
> Workers: HTTP API, **queue consumers**, cron handlers". The queue consumers do not exist. The claim
> traces to the spec's suggested shape ("Cloudflare Workers plus Queues/Cron") being written down as
> if it had been built. `docs/Source_Of_Truth.md` and `docs/Developer_Packet.md` both carry a note
> pointing here. Do not plan work against that sentence. (The same document's §4 migration list stops
> at 0720 while the tree ships 0990.)

**Context that forced a ledger of some kind.** Spec line 212 requires "a durable queue for scan
processing/scheduling/deletion" and spec line 206 forbids relying on an in-process timer. A row in
the same Postgres that holds the family's data buys three things a managed queue does not:

- **Transactional enqueue.** A job is inserted in the same transaction as the state change that
  justifies it, so there is no window in which one exists without the other. The deletion path
  (`0620_deletion_purge.sql`, `0840`, `0930`) and `app.schedule_late_page_removal` depend on this.
- **Idempotency by unique constraint.** `CLAUDE.md` requires every retryable mutation to carry an
  idempotency key "enforced by a unique DB constraint, not by an in-memory check" — a database
  capability, not a queue one. L-010 is the lesson behind that rule: peek-then-hit and
  read-modify-write in application memory let concurrent requests pass together, for the PIN lockout,
  the pairing budget and the spend cap alike.
- **Inspectability and tenancy.** Per-family reads use the `jobs_family_child` index; lease recovery
  uses `jobs_running`; the ledger is the audit trail of a deletion (`docs/Architecture.md` §4).

**Alternatives.** Cloudflare Queues was the spec's own suggestion and is the obvious alternative. **No
record anywhere states that it was evaluated and rejected.** The three bullets above are reconstructed
from what the ledger's design makes possible — treat them as my reading, not the author's argument.

**Consequences being lived with.**

- **A latency floor of up to 5 minutes** for every piece of asynchronous work, including the homework
  scan a parent is waiting on. Nothing in the records measures what that feels like.
- All concurrency control is hand-written: a 20-minute lease, a 10-minute claim budget, and a
  per-kind worst-case filter so a job is not claimed when its worst case no longer fits the remaining
  wall time.
- Step ordering inside the tick is load-bearing, and was a defect: the entitlement sweep (up to 25
  sequential provider fetches, each bounded at 10 s but their *sum* unbounded) ran before the job
  ledger, so a slow store delayed every scan, safety email and export in that tick (BUG-195, L-045).
  The ledger now runs first, and `docs/Architecture.md` §4 records why that ordering is right
  (entitlement staleness is measured in days, so a sweep cut short loses nothing).
- Dead-lettering needed a special case for jobs backing a legal promise: a generic bounded retry
  dead-lettered the deletion purge after five failures and nothing re-queued it, so a deletion
  promised "within 30 days" could stop for good (BUG-156, L-035). Such jobs now get a versioned
  successor plus an error-level log code.
- Retention had to be invented: terminal rows older than 90 days are pruned by
  `app.prune_terminal_jobs` (migration `0840_hardening_r1_db.sql`), except `deletion_purge` and
  `account_close`. Adding that delete then broke a route that derived a version key from a row count
  (BUG-139, L-033).
- A fixed-batch sweep starved the rows it existed for: a static `order by id limit N` plus a predicate
  that permanently matches terminal rows re-selects the same N every tick (BUG-133, L-031).

Every one of those bullets is work a managed queue would have done differently, and most were
discovered by defect rather than by design. This is the decision I would scrutinise hardest — see the
closing section.

## 5. Hyperdrive as the database binding

**Decision.** The Worker's only binding is `HYPERDRIVE` (one `[[hyperdrive]]` block per environment in
`apps/api/wrangler.toml`). `apps/api/src/index.ts` builds the Postgres client from
`env.HYPERDRIVE.connectionString` as the *last* step of runtime construction, "so a refused
configuration never opens a client".

**Context.** Workers cannot hold a conventional connection pool. Spec line 212: "If Cloudflare is
chosen, use supported Postgres HTTP/pooler access and documented runtime-compatible libraries."

**What it implies, and what the code already pays for it.**

- `prepare: false` is mandatory. `apps/api/src/pg-client.ts`: "`prepare: false` keeps statements
  unnamed, which Hyperdrive's pooling requires." Server-side prepared statements are lost everywhere.
- `fetch_types` stays **on** (the postgres.js default), against Cloudflare's own suggestion to turn it
  off. The recorded reason is BUG-063: with it off, postgres.js cannot serialize JavaScript arrays and
  the API binds arrays in 30+ places. The cost is one type query per connection. L-014 is the lesson —
  the tests had built their own client with default options, so a production-only option broke 30+
  queries without a single failing test. Hence one factory (`createPostgresClient`) used by the Worker
  *and* by `apps/api/tests/helpers.ts`.
- `max: 5` per client, set in `pg-client.ts`.
- **Deployment coupling.** The three ids in `wrangler.toml` are deliberate placeholders
  (`OWNER_ACTION_HYPERDRIVE_ID_*`) so that `wrangler deploy` fails rather than pointing at an invented
  database. The Cloudflare API token needs a permission the "Edit Cloudflare Workers" template omits —
  Account → Hyperdrive → Edit — documented in `docs/Deployment_Runbook.md` §0.1 part **B** step 3
  (§0.1 has two numbered lists, A for the Supabase password and B for the token) with the reason
  (product-level Workers roles grant no access to Hyperdrive, R2, D1, KV, Queues or Vectorize; see
  also `docs/Access_And_Least_Privilege.md`).
- **The connection string must be a session pooler URL on port 5432.** The runbook forbids the direct
  `db.<ref>.supabase.co` host (IPv6-only on new projects without the IPv4 add-on) and the transaction
  pooler on 6543 (it does not support every statement a migration uses).
- The API is *intended* to connect as a login role that is a member of `authenticated`, `pl_child`
  and `service_role`, because the role switching in decision 8 needs all three. **Dated correction
  (2026-10-19): that is a file comment, not a built step.** `apps/api/src/db.ts`'s header asserts it
  and points at `docs/Deployment_Runbook.md`, but the runbook has **no role-setup section** — grep it
  for `login role`, `member of` or a `grant … to` of those three roles and you get nothing. No
  migration creates the role either: the only `create role` anywhere in `supabase/migrations` is
  `create role pl_child nologin noinherit` (`supabase/migrations/0001_core_identity.sql:19`), and
  there is no owner action for the grants (`docs/Owner_Actions.md`). Treat the connection role as an
  **unwritten operator prerequisite**, not a property of this repository — whoever runs the first
  deploy has to derive it, and if the pooler role is not a member of all three, every `set local role`
  in `createDb` fails. **TENTATIVE** until the step exists somewhere executable.
- Cost: Hyperdrive on the Workers Free plan has a 100,000 database-queries-per-day cap; Workers Paid
  (5 USD/month minimum) lifts it (`docs/Deployment_Runbook.md` §0.1).

**Not established.** `wrangler.toml` sets no `caching` configuration, and every API query runs inside
a transaction opened by `sql.begin` in `apps/api/src/db.ts`. I have **not** verified what Hyperdrive's
query cache does with that shape, and no document in this repository addresses it. Treat Hyperdrive's
caching behaviour here as unmeasured; whether it should be configured explicitly is **UNDECIDED**.

**Where the reasoning is recorded.** `apps/api/src/pg-client.ts` (driver options, BUG-063),
`apps/api/src/db.ts` (roles), `docs/Deployment_Runbook.md` §0.1 (token, pooler, cost). The choice of
Hyperdrive *over* the Supabase pooler alone has **no recorded rationale**; `db.ts` itself says the
production API connects "through Hyperdrive or the Supabase pooler", so the code does not depend on
Hyperdrive specifically.

## 6. The pnpm monorepo and its package boundaries

**Decision.** One pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `supabase`), eight
test-bearing packages. Packages are consumed as **TypeScript source** — each `exports` entry points at
`./src/index.ts` — and the three bundlers (wrangler/esbuild, Vite, Metro) compile them. `tsc` is
typecheck-only (`noEmit`). Relative imports carry explicit `.ts` extensions.

**Context.** Three client surfaces (Worker, Vite portal, Expo app) must agree on the same contracts
and the same business rules. Publishing build artifacts between them would mean a build step and
version skew. `docs/Architecture.md` §1 records the source-consumption decision and the
import-extension convention that goes with it.

**Why `packages/domain` is pure and takes `now` as an argument.** This is the best-reasoned boundary in
the repository, and it is reasoned from defects:

- `CLAUDE.md`: "Money is integer cents; time is UTC instants plus IANA zones; domain code takes `now`
  as input." `docs/Architecture.md` §2 adds that randomness is an injected `RandomSource`, never
  `Math.random` "for anything security- or money-relevant".
- The cost of not doing it is L-019/BUG-090: jobs enqueued in SQL used `now()` while the dispatcher
  used the application clock, and a pinned test clock made 14 tests fail on every run after a fixed
  real time. The fix was for the application to state its clock for the transaction
  (`pencillift.request_now`, migration `0780_request_instant.sql`, `stateRequestInstant` in
  `apps/api/src/db.ts`).
- L-027 extends it to fixtures: a fixture row whose timestamp came from a database default sat beside
  a pinned request clock; the test was green for 24 hours and then failed on the calendar.
- `docs/Architecture.md` §4 states the counterpart rule — "one clock per check": an expiry that SQL
  compares with `now()` (adult unlocks, child sessions) is *written* with `now()` in SQL, never from
  the request clock.
- The practical payoff: `packages/domain` has exactly one runtime dependency (`luxon@3.7.2`), so 3,670
  of the 7,503 tests run with no database, no network and no fake timers.

**Consequences being lived with.**

- **Purity is a convention, not an enforced rule.** `eslint.config.js` bans `eval`/`new Function`,
  floating and misused promises, non-exhaustive switches and `==`; it contains **no**
  `no-restricted-imports` or `no-restricted-globals` rule, and nothing scopes a rule to
  `packages/domain`. Purity holds today — the package's dependency list means no I/O library is even
  reachable — but nothing fails if someone calls `Date.now()` tomorrow. By `docs/Source_Of_Truth.md`'s
  own standard ("a rule with no test is a preference"), domain purity is currently a preference. That
  is a gap, not a decision.
- Shared registration points (`apps/api/src/app.ts`, `apps/web/src/routes.tsx`, the contracts index,
  domain package exports, migration numbering) are lead-only by `CLAUDE.md`, because parallel agents
  kept colliding there.
- Partial commits are unsafe in a shared tree: commit 39ca165 imported `@pencillift/domain/scheduling`
  while it was still untracked and passed every check (BUG-034, L-008). The pre-commit path now
  typechecks the index itself.
- File-ownership splits cannot partition an invariant (L-072) and leave orphan files between briefs
  (L-048, L-052: "nine fixers all correctly reported 'not my file' and nobody did the work").
- Package subpath exports are fine-grained (`@pencillift/domain/quotas`, `/safety`, `/learning`,
  `/ops`, `/bank`), which keeps Metro and Vite from pulling the whole domain into a bundle.

## 7. Expo/React Native for mobile, Vite/React for the portal

**Decision.** `apps/mobile`: Expo `57.0.24` with `expo-router` and React Native `0.86.3`.
`apps/web`: Vite `8.3.0`, React `19.3.0`, `react-router` `8.4.0`.

**Context.** Mandated for mobile. Spec line 7 names Expo; spec line 13 states "Expo provides the app
framework, native build and submission workflow"; spec line 33 requires the correct Expo/EAS owner and
project with native build profiles. The portal is the "responsive parent website" of spec line 7 and
also ships the owner admin (`docs/Architecture.md` §1).

**Alternatives considered.** None for mobile — the spec named it. None recorded for Vite over
Next.js/Remix: **chosen without a recorded rationale.** A plausible reconstruction is that the portal
needs no server runtime (it talks to the Worker) and a static bundle is the cheapest thing to host —
`apps/web/devDependencies` includes `wrangler@4.137.0`, so the intended host is Cloudflare — but
nobody wrote that down.

**Consequences being lived with, and this is the expensive one.** Two React codebases that share no
components is the single largest recurring defect class in the project:

- L-070: five separate fixes were made inside `apps/web` alone — HUNT6-G-2, HUNT6-H-4, WEBR4-03,
  HUNT5-F-1, HUNT6-G-8 — and "every one left the phone printing the old sentence". Seven of round 7's
  60 findings were that one shape, the round's largest cluster.
- The phone's own suite could not catch any of them, because the rule lived inside a component
  `apps/mobile` cannot render.
- Four rounds were then spent deleting second copies of sentences so the surfaces could not drift
  (L-078) — and the mirror defect arrived in that same work: one shared sentence told a parent to
  enter a date "as year-month-day", right for the phone's free-text field and wrong for the portal's
  native date picker. It was caught by rendering the screen and looking at it, after every suite was
  green.
- L-037: a new server bound broke the surface with no matching client step (the web uploaded unshrunk
  photos), and a password reset started by the mobile implicit-flow client could not be finished by
  the web's PKCE client.
- L-039: `supabase-js` defaults to sign-out scope `global`, so signing out of the phone silently ended
  the parent's portal session, and the reverse.

What is shared is deliberate and narrow: `@pencillift/contracts`, `@pencillift/domain`,
`@pencillift/ui-tokens`, and nothing visual. `react-native-web` is present in `apps/mobile` and
`npx expo export --platform web` is a verified command in `CLAUDE.md`, but the portal is **not** built
from the Expo app and no record proposes that it should be. Whether to collapse the two surfaces is
**UNDECIDED**.

## 8. RLS as the authorization boundary, not application checks alone

**Decision.** User requests run under the caller's own Postgres role. `apps/api/src/db.ts` opens a
transaction, sets `request.jwt.claims`, then `set local role authenticated` (parents) or `pl_child`
(paired children); `asService` uses `service_role` and bypasses RLS. Every family-scoped `public`
table carries `family_id` and has RLS enabled; policies call helpers defined in migration 0001
(`app.current_user_id()`, `app.is_family_member()`, `app.is_family_owner()`,
`app.has_recent_adult_unlock()`, `app.current_child_id()`, `app.is_owner_admin()`,
`app.prevent_mutation()`).

**Context that forced it.** Two independent reasons, both recorded:

1. `docs/Architecture.md` §8 rejects the alternative explicitly — "API uses only the service-role key
   and authorizes in code" — because it is a "single layer; one missed check leaks a family."
2. **The Data API means application checks cannot be the only layer even in principle.**
   `authenticated` can reach `public` tables through PostgREST with the parent's own token, never
   touching the Worker (L-060). "Application-layer checks only" is not a simpler design here; it is an
   incomplete one.

**Consequences being lived with.**

- The API must hold three roles on one login role — nothing in the repository sets that up, see the
  dated correction in decision 5 — and every handler using `asService` must independently verify
  family membership and row ownership (`docs/Architecture.md` §3 states the second half; §3 describes
  the per-request roles and says nothing about the connection role; spec E4).
- Postgres default grants fight you. L-002: Postgres grants `EXECUTE` to `PUBLIC` by default, and a
  schema-level `ALTER DEFAULT PRIVILEGES … REVOKE` cannot remove a global default — the *first*
  version of that lesson was wrong about this and had to be corrected. Fix: a global revoke in 0001
  plus an explicit revoke/grant per `SECURITY DEFINER` function, with `schema_invariants.test.ts`
  failing if `anon` can execute any.
- Child reads use **column-level** grants, so `select *` is denied rather than filtered (L-003). Every
  child query and DTO builder must name allowlisted columns explicitly.
- `TRUNCATE` was the one write that bypassed both RLS and `app.prevent_mutation()`; migration
  `0860_hardening_r2_db.sql` revokes `truncate`, `trigger` and `references` from client roles.
- Every parameter of a `SECURITY DEFINER` function granted to `authenticated` is attacker-chosen. A
  school viewer could call the counts report directly with two time zones and difference the results,
  which per-call suppression cannot see (BUG-074, L-015). API-only parameters are now pinned inside
  the database (migrations `0730`, `0740`).
- Lock ordering becomes an architectural concern: a route locked child rows then inserted, whose
  trigger locked the parent row then the same child rows; overlapping requests deadlocked into a 503
  first dismissed as a flake (BUG-106, L-021). Rule: one order for every writer of the same rows.
  **Corrected 2026-10-19:** BUG-106 itself was fixed in the *route*, not in a migration — the
  pairing-code route now takes the child row `for no key update` before it touches any code row
  (`apps/api/src/routes/family.ts`) — and the order is not the slogan "parent row first, then
  children". The canonical order, stated in `0930_deletion_lock_order.sql`, is the family row, then
  `public.child_slot_assignments`, then `public.child_profiles`. That migration realigns one later
  writer (`request_deletion`, added by 0890) to it, and its own header is explicit that it is **a
  defensive ordering, not the repair of a reachable deadlock** — and that the earlier rationale for
  it, that the store's downgrade webhook took no family lock, was false and was retracted in the
  file. Read the header before you rely on either claim.
- Parent solutions live in schema `private`, unreachable through PostgREST, readable only through a
  `SECURITY DEFINER` function that checks membership **and** a recent adult unlock.

**Where the reasoning is recorded.** `docs/Architecture.md` §3, §4 and §8; migration 0001's header;
`docs/Access_And_Least_Privilege.md`; lessons L-002, L-003, L-015, L-021, L-060.

## 9. Children are not Supabase auth users

**Decision.** A parent issues a single-use pairing code; the API issues a short-lived child access
token signed with an API-only key, plus a rotating opaque refresh token stored hashed. The child's
database role is `pl_child` with API-set claims `{role, child_id, family_id, child_session_id}`.
`pl_child` is never granted to the PostgREST authenticator, so a child token cannot be used against
the Data API at all; RLS additionally re-checks that the child session is live.

**Context.** `docs/Architecture.md` §8: children as Supabase auth users "would require child
emails/credentials and makes a child token usable against PostgREST directly." Child privacy is a
Tier 1 constraint.

**Consequences, including an open defect.** This is the one credential mechanism the project owns and
it cost the most (decision 3). The replay story is worth reading in full before touching it: L-047 (a
grace window cannot distinguish the rightful holder's retry from a replay — "every remedy argued from
time was wrong"), L-049 (making the retry identify itself with a client-minted id), L-050 (the premise
"the successor is unclaimed" is not "the holder never received it"), L-058 (the feature was removed in
round 6 and migration **0880 deleted** — which is why the migration sequence skips 0880). **BUG-244 is
open and accepted**: a lost refresh response unpairs a child's tablet, and the remedy was withdrawn
rather than shipped. `docs/Architecture.md` §3 states that consequence plainly, which is the right way
to carry it.

Separately, L-088 records that `private.child_pins` has existed since migration 0001 with a hash, an
attempt counter and a lockout column, and **nothing has ever written it**. Spec P3 requires a child
PIN; no code implements one. Treat the child PIN as **PLANNED**, not built.

## 10. OpenAI as the only AI provider, with no automatic fallback

**Decision.** `packages/ai` is a server-only adapter over the OpenAI Responses API.
`APPROVED_AI_PROVIDER_HOSTS` in `packages/ai/src/zdr.ts` is a one-entry list (`api.openai.com`) and
`assertApprovedProviderHost` throws for anything else. Model ids are configuration
(`packages/ai/src/routing.ts`: `gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-luna`), to be verified against
the owner's account at activation.

**Context that forced it.** Child data. Zero data retention is a property of the OpenAI
*organization*, granted after review — "not something code can turn on" (`zdr.ts` header). OpenAI's
under-18 guidance states that a developer should not process personal data of children under 13 (or
the local age of digital consent) "without first implementing zero data retention in the API", which
is the rule `packages/ai/src/gate.ts` enforces. A second provider would need its own documented
retention position and its own evidence.

**Why there is no fallback, in the author's words** (`zdr.ts`): a second provider "needs its own
verified privacy controls and its own retention position before any child data reaches it; there is no
automatic fallback", and the single-entry list is the honest way to hold that — "a list a test can
read, not the absence of a second one."

**What else that file decides, each with a reason attached.** An endpoint allowlist, with the
*ineligible* ones named and justified: `/v1/files` ("NOT ZDR-eligible: 30-day abuse-monitoring
retention AND application state kept until the file is explicitly deleted" — so homework images travel
inline as data URLs), `/v1/uploads`, `/v1/containers`, `/v1/assistants`, `/v1/vector_stores`,
`/v1/batches`. Feature positions for things that are not endpoints but change what is retained. A
closed `metadata` key type, because `metadata` is what the provider stores beside the request, and the
one fixture in the repository had put a child-derived id there (L-080). An endpoint missing from the
eligible list is treated as ineligible, which is the safe direction.

**Consequences being lived with.**

- A single vendor outage stops all AI work. No record evaluates that risk.
- Child-facing teaching is pinned to the flagship model and never silently downgraded for cost
  (`routing.ts`), so the obvious cost lever is unavailable exactly where spend is highest.
- Model ids are strings that must exist in the owner's account. Nothing has verified them because
  nothing is deployed. **UNDECIDED** until activation.
- The guard must sit at the transport, not the call site: three ZDR assertions were written as the
  first lines inside the transport's `try`, whose `catch` classifies anything thrown as a retryable
  network error — so a request carrying a child's identifier would have been retried forever instead
  of refused (L-079).
- Spend is controlled by a hold-before-send ceiling (`docs/Architecture.md` §7,
  `apps/api/src/jobs/spend-ceiling.ts`): every stage takes a hold for its upper-bound cost under a
  monthly budget row lock and is admitted only if recorded spend + live holds + the estimate stays
  inside the owner's cap. L-020 and L-055 are the ways that escaped before — a per-item constant
  masquerading as an upper bound, a missing month read as "no cap", a failed metering write that
  released the hold, and one constant doing duty as both the admission bound and the retry budget.
- The adult ID check inherits a hard limit. `apps/api/src/providers/identity-openai.ts` is explicit:
  the adapter **can** establish adulthood from a document (transcription) and **cannot** establish
  same-person (biometric comparison, which OpenAI's policies forbid and its models decline). It asks
  anyway, once, so the refusal lands in the deployment's own audit trail; `adult_confirmed` is a
  generated column requiring `matched` (migration `0980_identity_verification.sql`), so no later code
  change can read a refusal as a pass. `canCompareFaces` is false, so a deployment with only this
  adapter **cannot meet 0980's standard**. **Corrected 2026-10-19:** that is not the standard the
  product runs on, and this bullet read as if it were. `0990_adult_identity_declaration.sql` adds a
  second, weaker, separately named standard — `public.identity_declarations.adult_declared`, also a
  generated column, true only on government photo ID **and** an adult date of birth on it **and** a
  versioned holder declaration — on an owner decision of 2026-09-30, and it is implemented
  (`POST /v1/identity/verification`, `apps/api/src/routes/identity.ts`). 0990's own header calls
  0980's biometric standard "currently UNREACHABLE … Kept for the day a vendor is contracted", and
  deliberately did *not* redefine `adult_confirmed` so the two standards cannot be confused.
  `public.adult_identity_basis()` reports which one an adult met (`'verified'` or `'declared'`).
  Whether the declaration is legally sufficient is owner action #48, with counsel — **UNDECIDED**.
  L-065 is the lesson: specifying it as one step would have
  produced an adapter that always answers "couldn't tell", "and the tempting next move is a mock that
  looks like verification."

## 11. Provider selection: labeled mock / unavailable / real, and fail-closed readiness

**Decision.** Every external dependency is selected by an explicit enum in `apps/api/src/config.ts`
(`providers.consent`, `.identity`, `.billing`, `.webBilling`, `.ai`, `.moderation`, `.storage`,
`.email`, `.authAdmin`). `MOCK_ENVIRONMENTS` is `{development, test}`. For billing, web billing,
moderation, email and auth-admin the rule is one helper:

```ts
function mockOrUnavailable(environment: Environment): 'development_mock' | 'unavailable' {
  return MOCK_ENVIRONMENTS.has(environment) ? 'development_mock' : 'unavailable';
}
```

In staging and production a missing credential therefore selects `unavailable` — a provider that
**refuses every call** and is explicitly `isMock: false` (`createUnavailableConsentProvider`,
`createRefusingModerationClient`, `createRefusingAuthAdmin`, `createUnavailableStorage`,
`createUnavailableEmail`) — never a mock and never a silent skip. Each `select*` function in
`apps/api/src/index.ts` then ends with
`if (provider.isMock && !MOCK_ENVIRONMENTS.has(config.environment)) return NOT_READY;`, so the Worker
refuses a mock outside development/test whatever the configuration says.

**Two providers do not follow that helper, and you should know which.** In `config.ts`,
`ai: env.OPENAI_API_KEY ? 'openai' : 'development_mock'` and
`storage: env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'development_mock'` — the
*config value* is `development_mock` in every environment. The guards are elsewhere and differ in kind:

- **Storage**: `selectStorageAndEmail` builds `createUnavailableStorage()` when mocks are not allowed,
  and `buildRuntimeOrThrow` refuses to boot production unless `storage === 'supabase'`.
- **AI**: there is no `isMock` gate in the runtime selection. Instead the `scheduled` handler in
  `apps/api/src/index.ts` registers `scan_process` **only when `OPENAI_API_KEY` is present**, so
  without a key scans stay queued rather than being graded by a mock; and `checkChildDataGate` in
  `packages/ai/src/gate.ts` refuses a mock provider when `environment === 'production'`. Note the
  asymmetry: that gate's mock check is production-only, so staging's protection is the handler not
  being registered, not the gate. Re-read both files before changing either.

**Context that forced the rule.** BUG-079, recorded as L-016: "A mock returns empty or successful
state, and empty provider state is destructive: a staging webhook and the stale sweep revoked paid
plans from the mock's empty answer." That is the whole argument — a mock is not a neutral stand-in; its
empty answer is a destructive instruction. `CLAUDE.md` states the rule: "Mocks are labeled mocks. A
missing credential is a blocker, never a passing test."

**Consequences being lived with.**

- **Production cannot boot, by design.** `CONSENT_ADAPTERS` and `CONSENT_ADAPTER_FACTORIES` are both
  empty because **no consent vendor has been chosen** (Owner Action #7; the design and the ranked
  COPPA methods are in `docs/design/Consent_Design.md`, where k-ID is a *candidate*, not a decision —
  **UNDECIDED**). `apps/api/tests/runtime.test.ts:201` asserts the two lists are equal, so adding a
  name to one without the other fails.
- An unrecognised `CONSENT_PROVIDER` or `IDENTITY_PROVIDER` is a configuration **error**, not a
  fallback to the mock: "a deployment that meant to verify adults must not quietly stop doing so"
  (`config.ts`). `identity: 'vendor'` returns `NOT_CONFIGURED` because no vendor adapter exists, "so a
  deployment cannot believe it is verifying adults when it is not."
- `APP_ENV` is never defaulted (LRD-5). `wrangler.toml` sets it only under `[env.*.vars]`, so a
  `wrangler deploy` with no `--env` produces a Worker answering 503 `NOT_CONFIGURED` instead of running
  as development with every mock enabled.
- The **testbed** environment exists to make this liveable: a deployed, mock-backed Worker named
  `testbed` rather than `development` so nothing reads as "the developer's machine", carrying
  `APP_ENV = "development"` on purpose. Its header in `wrangler.toml` states the cost rather than
  burying it — "the consent mock verifies anything, the identity mock confirms any adult, the billing
  mock grants slots nobody paid for … NO REAL CHILD'S WORK MAY EVER GO HERE" — and the exit path: a
  credential always beats the environment, so providers become real one at a time with no rebuild, and
  the move to `--env staging` is the proof that nothing mock-shaped is left.
- Mock-written rows are marked `is_test_provider`, and test-provider consent records only count as
  consent where that mock may be wired, so a row a staging database inherited is never consent there
  (BUG-067). A database marked production refuses fixture catalog data (migration
  `0770_catalog_fixture_guard.sql`); an *unmarked* database blocks readiness.
- Per-job refusals back the runtime ones where a mock would be silently useless: the safety-flag email
  job and the account-close job each refuse a mock provider outside development/test
  (`dispatcher.ts` — "an email that goes to an in-memory outbox is not an email").
- L-085 is the lesson that none of this is sufficient: `deploy-api.yml` "was reviewed line by line,
  parsed as valid YAML, and had three real bugs found in it by reading — and it still produced a
  Worker that answered 503 on every path", with required secrets never set and the workflow's own
  probe printing the 503 as success. Fail-closed readiness tells you *that* it will not serve; it does
  not tell you the deploy pipeline was never exercised.

## 12. Zod contracts shared across three surfaces — and the `strictObject` cost

**Decision.** `packages/contracts` holds zod 4 (`4.6.5`) schemas for every request, response and error
code, plus the typed HTTP client (`packages/contracts/src/client.ts`) that both the portal and the app
use. One `index.ts` re-exports the modules and is a lead-only registration point.

**Context.** Three surfaces must agree, and a typed client that parses responses against the same
schema the server validated against turns contract drift into a test failure rather than a runtime
surprise. It also centralises input hardening, which was a real defect class:

- L-028/BUG-116: Postgres cannot store `U+0000` in `text` (SQLSTATE 22021), and nobody had a rule for
  where control characters are refused, so each route grew — or forgot — its own check; rewards was
  fixed while eleven other fields still answered 500. Every free-text field now goes through
  `freeTextSchema` in `packages/contracts/src/common.ts`, with `apps/api/src/errors.ts` mapping
  22021/22P05 as the last line of defence.
- L-041: `z.iso.date()` accepts any four-digit year, so `0000-01-01` passed the contract and raised
  SQLSTATE 22008 on a `::date` cast — a 500 for what was the caller's input.
- L-073 is the counterexample that bounds the previous one: `calendarDateSchema` bounds years to
  2000..2100 for school calendars and promo months, and reusing it for a date of birth refused every
  parent born before 2000. A shared schema is only shared where its bounds mean the same thing.
- L-036: every UI enumeration of a contract enum must read the schema's `.options`, because a literal
  three-channel list silently dropped `amazon_appstore` on save.

**The forward-compatibility cost — BUG-420, OPEN and accepted, not fixed.** The ledger's measurement:
97 of 114 response/status/view schemas are `z.strictObject` and 0 are loose. **Dated correction
(2026-10-19): the second half of that is wrong, and the first half I could not reproduce.** Two
*object-shaped* response/view schemas in `packages/contracts/src` are not spelled `z.strictObject`,
and one of them is
deliberately loose: `privacyFamilyViewSchema` (`packages/contracts/src/privacy.ts:733`) is `z.object`
with a comment saying so — "non-strict on purpose … the family vertical owns that response, and
unknown fields are stripped (never rendered)". So the asymmetric fix below is not hypothetical;
one schema already has it, with a reason. (`dataPracticesResponseSchema`, `privacy.ts:1007`, is
`z.object({…}).strict()` — strict in effect, not spelled `strictObject`, so a mechanical grep misses
it in the other direction.) Re-derived 2026-10-19 by classifying every non-test
`export const …Schema` in `packages/contracts/src` whose *name* carries `Response`, `Status` or
`View` — whitespace normalised first, because 20 of these are written `z` newline `.strictObject(`
and a naive `z\.strictObject` grep misses them — there are **117** such schemas:
99 `z.strictObject`, 2 `z.discriminatedUnion` (`closeAccountResponseSchema`,
`preparePayoutResponseSchema`), 14 `z.enum` (not objects at all), 1 loose `z.object`
(`privacyFamilyViewSchema`) and 1 `z.object(…).strict()` (`dataPracticesResponseSchema`). So of the
103 object-shaped ones, **exactly one is loose** — near the ledger's figures but not equal to them,
and the ledger does not say what it counted.
Treat 97/114 as **an order-of-magnitude measurement, not an audited number**; the argument does not
depend on the exact value. The raw occurrence count is 306 `strictObject` constructions across
non-test files plus one mention in prose (`family.ts:135`) — 307 raw string hits from
`grep -o strictObject packages/contracts/src/*.ts | grep -v test.ts | wc -l`, requests included —
not the 287 an earlier draft of this paragraph claimed. `strictObject` **throws** on an unknown key rather than
ignoring it, so the moment the server adds a field to a response, every already-installed build whose
bundled schema predates it rejects the whole response, and the parent sees a successful call reported
as an error. PencilLift ships to three stores where users stay on one build for weeks.

The decision *not* to fix it is recorded with its reasoning, which is the interesting part:

- Impact in beta is **zero** — there are no installed clients, so the defect cannot occur before the
  first public build.
- The strict parse is **load-bearing in the suites**: the portal's identity tests parse every fixture
  through the real schema precisely so a fixture the server could not send fails in the test instead
  of passing on a shape the server cannot produce.
- Rewriting 97 schemas touches every vertical for no beta benefit.
- **The intended fix** (**TENTATIVE**, its own slice): requests stay `strictObject` — the reason is
  good and is given in `packages/contracts/src/identity.ts`'s header, that no client can smuggle in
  the outcome it wants — and responses become `z.object`, which strips unknown keys. That asymmetry is
  the standard one; the existing comment only ever justified the request half.
- **Trigger: the first response-schema field addition after the first public build.** Until then the
  ledger row is the whole mitigation, cross-referenced from `docs/Release_Readiness.md`.

Read BUG-420 in `docs/Bug_Ledger.md` before changing anything in `packages/contracts`.

## 13. Integer cents, UTC instants plus IANA zones

**Decision.** Money is integer minor units (USD cents) as `number`; AI token costs are micro-USD
integers (`usdMicros`). Times are stored `timestamptz` and carried as ISO-8601; local-time rules use
Luxon with an IANA zone, never a fixed offset. Approved prices are a pure function in
`packages/domain/src/pricing/index.ts`: `monthlyPriceCents(n) = 3999 + 999 * (n - 1)`, n ∈ 1..4 —
3999, 4998, 5997, 6996, pinned by test.

**Context.** Spec F2 forbids floats for money (`docs/Architecture.md` §8: "Rounding drift; forbidden
by spec F2"). The product's core features are time-local by nature — a parent-selected daily practice
time, a Thursday review, a program calendar month, a provider billing period — so a fixed offset
breaks on DST, and computing a billing period as `+30 days` breaks on February and month-end (§8
again: "provider period boundaries are authoritative").

**Consequences.** Calendar values are typed strings (`YYYY-MM`, `YYYY-MM-DD`, `YYYY-Www`) in the
family's zone. Rounding is specified where it is visible: the discount preview is
`round-half-up(regular × (100 − pct) / 100)` in cents, and the provider-reported amount always
overrides the preview. The two implementations do agree: `previewDiscount`
(`packages/domain/src/promotions/discount.ts:35`) computes
`divideRoundHalfUp(regularCents * (100 - percentOff), 100)`, whose helper
(`packages/domain/src/shared/money.ts:15`) is integer half-up via `(2n + d) / 2d` in `BigInt`, and
`finance/promo_school_model.py:23` computes `(price(children) * (1 - percent/100)).quantize(D('.01'),
rounding=ROUND_HALF_UP)` — the same quantity, one in cents and one in dollars. Spot-checked both ways:
5% off 3999 → 3799 cents, which is the `37.99` the Python asserts at `promo_school_model.py:61`.

**Dated correction (2026-10-19): nothing enforces that agreement.** `pnpm finance:check` is
`python3 finance/cost_model.py --check && python3 finance/promo_school_model.py --check`
(`package.json:17`) — **two Python scripts asserting Python-internal invariants.** It imports no
TypeScript, and no TypeScript test reads the Python or its JSON output; the only link between the two
is a pair of source comments (`money.ts:13`, `discount.ts:27`). So this is **not** a cross-language
check, and if someone changes the rounding on one side the whole suite and `pnpm check` stay green.
Worth knowing before you trust the pairing: the Python's own line above that formula calls it
"Illustrative USD rounding; actual provider currency/price behavior must be verified", and
`--check` prints "app behavior remains unimplemented". A test asserting the TypeScript against the
Python's published scenarios (`finance/promo_school_results.json`) is the missing piece — **TENTATIVE**,
nobody has proposed it in a record.
Micro-USD for AI cost exists so holds and ledger entries never need a float, and amounts that cannot
be compared exactly fail closed (`docs/Architecture.md` §7).

**Where recorded.** `CLAUDE.md`, `docs/Architecture.md` §2 and §6, spec F2, `finance/`.

## 14. RevenueCat as the entitlement truth; Stripe optional and off by default

**Decision.** One opaque family billing identity (`families.billing_ref`) is the RevenueCat
`appUserID` and the Stripe customer metadata key for every guardian of the family. One normalized
server ledger (`family_entitlements`) is the only source of truth for paid capacity. RevenueCat
(Apple/Google/Amazon) and Stripe (optional) feed it through authenticated webhooks → dedupe by
provider event id → **fetch current provider state** → upsert. Stripe sits behind
`flags.stripeWebBillingEnabled`, read from `OPTIONAL_STRIPE_WEB_BILLING_ENABLED === 'true'` — off
unless explicitly set.

**Context that forced the shape.**

- Spec P11 forbids a local quantity multiplier for extra children; capacity tiers are distinct store
  products in one subscription group (`docs/Architecture.md` §8). So capacity must map from verified
  store product ids (`store_product_mappings`), never from client input, and "local booleans never
  unlock service".
- Out-of-order webhooks cannot be ordered reliably, so reconciliation never trusts event order: every
  path (webhook, `POST /v1/billing/sync`, the scheduled stale sweep) runs one whole-family routine,
  `reconcileFamilyBilling` in `apps/api/src/services/billing-sync.ts`, from a **complete** provider
  fetch.
- Stripe's status is a launch-policy decision, not an engineering one. Spec line 36 keeps live
  checkout "conditional on launch policy and authorization"; spec line 700 forbids silently activating
  Stripe. Readiness requires that if the flag is on, `webBilling === 'stripe'`. **UNDECIDED** by the
  owner.

**Consequences being lived with.** Four lessons came out of this one integration, and together they
are the best argument for the "fetch, don't trust the event" rule:

- L-025: RevenueCat's REST payloads spell stores lowercase and its webhooks uppercase. A
  lowercase-only map silently dropped every real webhook's billing period — and the mock fixtures
  shared the code's assumption, so no test could catch it. Rule: one normalizing function, and webhook
  tests written from the provider's own sample payloads, not from the mock's fixtures.
- L-030/BUG-132: subscriber fetches carry no last-modified instant, and ordering snapshots by the
  newest state marker fails for state *removals* — when the provider clears a marker the next complete
  fetch orders older than the stored row and the ledger discards it as stale, so a family never left
  `cancelled_active`. A complete fetch is now authoritative, ordered by its own fetch instant.
- L-005/BUG-006: an `on conflict … do update … where` guard that fails turns the write into a silent
  no-op, and later logic trusting in-memory state is then silently wrong. Keys for provider objects
  must be globally unique and include the subscriber identity.
- L-033/BUG-131: a chargeback began writing the disputed amount while its reversal still only flipped
  the status, so a won dispute kept the money refunded. Two fixes each correct alone, wrong together.
- Refunds are never issued by PencilLift code. Store refunds are the store's and are only reflected
  from `billing_periods.refunded_cents`; a Stripe refund is issued by the owner in the dashboard and
  recorded on the support case with its reference, enforced by a check constraint
  (`docs/Architecture.md`, support-cases section).
- The stale-entitlement sweep makes up to 25 sequential provider calls, which is why tick ordering
  matters (decision 4, L-045).

## 15. Testing: real Postgres per test file, floors equal to the actual counts

**Decision.** DB authorization tests run against a **real** Postgres. `supabase/tests/harness.ts`
creates a freshly named database per test file, applies the Supabase platform shim
(`supabase/tests/shim/supabase_platform_shim.sql`) and all project migrations, then runs each query
inside a transaction after `set local role` with `request.jwt.claims` populated "exactly as PostgREST /
the PencilLift API does". "Nothing here mocks the database." CI runs the whole suite on Postgres 16 and
runs the authorization suite again on Postgres 17 (`.github/workflows/ci.yml`), because the hosted
Supabase project is PG 17.11 — "if 17 breaks a migration or changes a policy's behaviour, this is red
and the hosted project is the thing that must not be migrated until it is green."

**Context that forced it.** RLS, column-level grants and `SECURITY DEFINER` semantics cannot be
simulated. Decision 8 puts authorization in the database, so the tests have to be in the database too.
`PL_MIGRATIONS_ONLY=0001,0300` exists so an author can test one area against the core without
depending on unrelated in-progress files; CI never sets it.

**Why the floors equal the counts.** `scripts/assert-test-count.mjs`, line 1: "a green run that
executed zero relevant tests is a failure." Every workspace package with a `test` script must have
written a vitest JSON report with at least its configured minimum passing tests and **zero failures or
skips**. The floors in `scripts/test-minimums.json` are exact, so deleting or skipping a test is a red
build rather than a quieter one, and a legitimate deletion requires editing the floor in the same
commit. `docs/Source_Of_Truth.md` states the principle: "A rule with no test is a preference, and this
repository treats it as one."

**Consequences being lived with.** The DB suite needs a Postgres it owns, which is exactly why it
**cannot certify a hosted project**: it creates databases per run and installs a shim emulating
Supabase's roles, and Supabase permits neither (`docs/Deployment_Runbook.md` §0). So the suite proves
the schema, not the deployment. A local Postgres is a prerequisite for `pnpm check`.

**The honest limits, recorded in the lessons.** The suite is strong and it has repeatedly been green
over real defects; the project wrote down each way:

- L-014: tests that build their own client prove their own configuration, not production's.
- L-054: five assertions that could not fail — one searched a page for copy that did not exist, one
  bounded a negative regex to 400 characters of a branch that had grown longer, one ran as the single
  role its migration had not revoked.
- L-064: a test searched the whole document for a line carrying a stage name and a figure; a second
  table in the same file carried both, so deleting the row the test existed to protect left it green.
  Found only by mutating the fix.
- L-071: testing a pure function proves the function and says nothing about whether the screen hands
  it the real state — "the mutation that kept the call and changed its argument walked straight past
  it."
- L-066/L-067: three call sites agreeing is not an invariant when the helper they all call is wrong;
  and every grade-reach test asserted distances against the constant, so moving the constant left the
  file green while a kindergarten child would be handed grade-5 work.
- L-074: the adult ID check had a migration with 14 green authorization cases, a contract, a provider
  port and an adapter — and no route, no screen, no importer. Every test passed.
- L-078: the date-format contradiction was caught by rendering the screen and looking at it, after
  every suite was green.

7,503 green tests with zero skips is a real asset. It is not evidence that the product works, and this
repository is unusually clear about the difference.

---

# What I would question if I were evaluating this

Ranked by how much a different answer would change your scope and your quote. I wrote the document
above; these are criticisms of the thing I just described.

**1. The job ledger plus 5-minute cron is the highest-risk structural choice, and the substitution for
a queue has no recorded rationale.** Six separate defect classes came out of it: BUG-133 starvation,
BUG-139 retention-vs-counts, BUG-156 a dead-lettered deletion purge that backed a legal promise,
BUG-195 tick ordering, and two corrections to the claim arithmetic. Everything a managed queue gives
you — visibility timeouts, dead-letter queues, backoff, concurrency — is hand-written in
`apps/api/src/jobs/dispatcher.ts` and has never run anywhere but tests. **The tradeoff of switching:**
you lose transactional enqueue and database-enforced idempotency, the two properties `CLAUDE.md`
depends on, and you must re-derive the deletion-purge guarantee on top of at-least-once delivery. The
cheaper half is worth considering on its own — keep the ledger as the record of intent and use a queue
or a shorter cron only to *trigger* the drain, which cuts the latency floor without touching the
idempotency model.

**2. A 5-minute floor on work a parent is watching.** A homework scan is interactive from the parent's
point of view and asynchronous from the system's. No record measures perceived latency and nothing has
been deployed to measure it on. **Tradeoff:** shortening the cron costs invocations and tightens the
claim-budget arithmetic; moving the scan onto the request path costs Worker CPU limits and loses
durability.

**3. Two React codebases with no shared components is the most expensive decision in the repository,
and it is measured.** L-070 is explicit: seven of round 7's 60 findings were one surface fixed and the
other left stale, the largest cluster in the round; the portal's per-field edit rule was fixed three
times and the phone's never. Four further rounds went on de-duplicating prose. **Tradeoff:**
`react-native-web` (already a dependency) or a shared presentational layer would collapse the class, at
the cost of a worse desktop portal or a significant refactor of both surfaces. Doing nothing means
paying this tax on every copy change forever.

**4. `strictObject` on the response schemas is a shipped-client time bomb with a known fix that has
not been applied (BUG-420).** The reasoning for deferring is sound *while nothing is installed*. The
trigger is the first response field added after the first public build, and triggers like that get
missed. **Tradeoff:** flipping responses to `z.object` is mechanical and weakens the suites in exactly
the way the ledger row describes — fixtures the server could not produce would stop failing — so it
wants a compensating test, not a find-and-replace.

**5. Production cannot boot because no consent vendor exists, and consent is a product gating decision
disguised as a configuration gap.** `CONSENT_ADAPTERS` will stay empty until Owner Action #7 is
answered — and Owner Action #15 asks counsel whether the monthly subscription charge can itself serve
as the COPPA §312.5(b)(2) monetary-transaction method, which if answered yes may mean **no paid vendor
is needed at all**. A quote that assumes a vendor integration may be quoting work that evaporates.
Read `docs/design/Consent_Design.md` before pricing it.

**6. Adult verification runs on the weaker of two named standards, and whether that is enough is a
legal question nobody has answered.** **Corrected 2026-10-19 — this item was wrong, and wrong in the
direction that costs money.** It said adult verification "cannot be completed with the current
provider set" and that the funnel has an unimplemented dependency on an identity vendor. It does not.
`canCompareFaces` is false, so `openai_document` can never satisfy
`identity_verifications.adult_confirmed` (migration 0980, biometric) — but migration 0990 adds
`identity_declarations.adult_declared` (government photo ID + an adult date of birth on it + the
holder's versioned legal declaration), that path is built (`POST /v1/identity/verification`,
`apps/api/src/routes/identity.ts`), and `docs/Owner_Actions.md` #47 states the vendor is "OPTIONAL
NOW, and only if counsel says so in #48" because the owner's decision of 2026-09-30 took it off the
critical path. **Do not quote an identity-vendor integration as a required line item.** What to price
instead is the conditional: owner action #48 asks counsel whether sending homework to a ZDR-bound
processor is a third-party disclosure under COPPA; if it is, the 0980 standard is required and a
vendor comes back — **UNDECIDED**. Note also how the gate actually works, because the old wording
("pairing codes are gated on the adult check (migration 0980)") is not what the code does: both
recorders write a `verified` `public.consent_records` row when their standard is met, and the
pairing-code route gates on `consentAllowsChildAccess` (`apps/api/src/routes/family.ts`), not on a
direct identity read. `public.adult_identity_established()` exists for that purpose and is called by
no API code today — only by `supabase/tests/identity_declaration.test.ts`. L-074 still shows the
shape of the risk: the whole feature was green and uncallable for a round.

**7. Single AI vendor, single flagship model, no fallback, and the model ids are unverified strings.**
The privacy argument against automatic fallback is strong and I would keep the rule. The operational
consequence — total AI outage on one vendor's bad hour, with no degraded mode — is nowhere evaluated,
and `gpt-6-astra` / `gpt-5.6-terra` / `gpt-5.6-luna` have never been resolved against a real account.
**Tradeoff:** a reviewed second provider costs its own ZDR evidence, retention position and prompts; a
degraded mode that *defers* rather than downgrades is cheaper and fits the existing `JobDeferral`
mechanism already in the dispatcher.

**8. Hyperdrive may not be buying anything.** `apps/api/src/db.ts` says the API connects "through
Hyperdrive or the Supabase pooler"; every query runs inside a transaction, `prepare: false` is forced,
and no caching is configured. Meanwhile Hyperdrive adds a Cloudflare API-token permission most token
templates omit, three placeholder ids to replace per environment, and a daily query cap on the free
plan. I found no recorded reason to prefer it over the Supabase session pooler directly. Worth ten
minutes of your evaluation.

**9. The AI provider is the one place the mock rule is enforced by omission rather than by a gate.**
`config.ts` selects `development_mock` for AI in every environment; what stops a staging Worker from
grading a child's homework with a mock is that `scheduled` does not register `scan_process` without
`OPENAI_API_KEY`, while `checkChildDataGate`'s mock refusal keys on `production` only. That is two
mechanisms where the other providers have one. It is correct today, and it is exactly the shape L-056
warns about: a guard that establishes a fact *adjacent* to the one its comment claims.

**10. Domain purity is unenforced.** `eslint.config.js` has no rule stopping `Date.now()`, `fetch` or a
filesystem import inside `packages/domain`. The purity is real today — the package depends only on
`luxon` — and it is what 3,670 fast tests rest on, but it is a convention, which by
`docs/Source_Of_Truth.md`'s own standard makes it a preference. One lint rule fixes it. If it is not
worth a rule, it is not worth claiming as an architectural property.

**11. `docs/Architecture.md` is Tier 1 — binding — and §1 contains a false statement about queue
consumers, while §4's migration list stops nine areas short.** A wrong sentence in the binding document
is a process defect, not a typo. The repository has four recorded instances of confident-and-wrong
records (BUG-411, BUG-426, BUG-430, BUG-432) and L-084/L-086 are specifically about citations nobody
re-reads. When you find a disagreement between a document and the code, `docs/Source_Of_Truth.md` says
the code wins and the document gets a dated correction. Expect to use that rule.

**12. Nothing has ever been deployed, and the deploy pipeline has a recorded history of looking correct
while being broken.** L-085: `deploy-api.yml` was reviewed line by line, had three real bugs found by
reading, and still produced a Worker answering 503 on every path — with the workflow's own probe
printing the 503 as success. Price the first deployment as discovery work, not a button press.

**13. The authorization suite cannot test the thing it will run on.** It needs a Postgres it owns, so
it proves the migrations against local PG16 and PG17 and certifies nothing about hosted Supabase
(`docs/Deployment_Runbook.md` §0). The first real migration run will also be the first test of these
migrations in their actual environment, against a project whose schema has never been applied — and
whose only current contents are two leftover probe artifacts that `db-migrate.yml` removes.
