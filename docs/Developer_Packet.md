# PencilLift — developer handoff packet

Written 2026-10-17 at commit `cb74ccb` on branch `claude/new-session-vil6cz`.
For the non-code half — accounts, contracts, legal, store registrations — read
`docs/Owner_Beta_Checklist.md`. This page is for whoever writes the next line of code.

---

## 1. Read this part first

PencilLift is a homework-help product for families: a parent photographs a child's worksheet, the
system extracts the questions, grades them, builds daily and weekly practice, and keeps the parent in
control of everything. It is **built and not deployed**. Those are different kinds of done and
conflating them is how this product gets misjudged in either direction.

| | |
|---|---|
| Source | ~119,000 lines of TypeScript (excluding tests) |
| Tests | ~124,000 lines — **more test code than source code** |
| Suites | 7,503 passing, zero skipped, across 8 packages; every package's floor in `scripts/test-minimums.json` equals its actual count, so a deleted test fails CI |
| Database | 44 migrations, every `public` table under row-level security, 484 authorization cases run against a real PostgreSQL (16 **and** 17) |
| API | 171 routes |
| Defects | 434 recorded in `docs/Bug_Ledger.md`; **3 genuinely open** (BUG-096, BUG-244, BUG-420) plus two closed-with-residual rows a beta can still meet |
| Hardening | 7 adversarial hunt-and-fix rounds; the last four found 9, 3, 2 and 3 high-severity defects |
| Deployed | **Nothing.** No Worker, no portal, no native build, ever |

**The most important thing to understand about this codebase**: its tests are unusually strong about
logic and unusually silent about reality. Every OpenAI, RevenueCat, Stripe, Supabase Storage, Resend
and consent interaction has only ever met a labeled mock or a fake `fetch`. No iOS or Android build
has been produced, installed or launched. A green suite here means the rules are right; it says
nothing about whether a photograph of a real worksheet extracts correctly, because that has never
happened. `docs/Beta_Readiness.md` § "What has never run, and will therefore bite first" is the
honest list and you should read it before estimating anything.

---

## 2. Getting a green run locally

```sh
git clone https://github.com/erickjgreenmd-byte/claudecampsophie
cd claudecampsophie
pnpm install --frozen-lockfile
pnpm db:local              # starts a local PostgreSQL 16 (or set DATABASE_URL to any PG16/17)
scripts/verify.sh          # everything CI runs: format, lint, typecheck, all suites, finance
                           # checks, release-shaped builds and a secret scan with a negative control
```

Needs Node 22, pnpm 10 and a PostgreSQL available at `DATABASE_URL`. `scripts/verify.sh --only api,db`
narrows it while you work. Per-package: `pnpm --filter @pencillift/<name> run test | typecheck`.

The authorization suite is not a mock: `supabase/tests/harness.ts` creates a fresh database per test
file, installs a shim that emulates Supabase's roles and `request.jwt.claims`, applies every
migration, and runs queries as `authenticated`, `pl_child`, `anon` and `service_role`. RLS, grants
and `SECURITY DEFINER` functions are exercised for real.

### Running the app itself

`apps/api` has `wrangler dev` (copy `apps/api/.dev.vars.example` to `.dev.vars`); `apps/web` has
`vite dev`; `apps/mobile` is Expo. **There is still no single documented "run the whole thing
locally against mocks" path** — each surface starts on its own and you wire the API base URL by
hand. That is a real gap for a newcomer and worth a morning. (`README.md` now exists and orients a
new reader; `START_HERE.md` does not — it is the original build-instruction package and tells a
reader to paste a prompt into an agent, which is not what a hired developer should do with it.)

---

## 3. The shape of it

```
packages/
  domain/      pure business rules — pricing, grading, the question bank, the learning planner,
               rewards, scheduling, quotas, the answer-leak guard. No I/O. 3,670 tests.
  contracts/   zod request/response schemas shared by API, web and mobile, plus every shared
               user-facing sentence. The typed API client lives here too.
  ai/          OpenAI transport, prompts, moderation, the ZDR gate, spend metering. 119 tests.
  ui-tokens/   brand colours, spacing, type scale, contrast helpers.
apps/
  api/         Hono on Cloudflare Workers. 171 routes, durable jobs, a 5-minute cron.
  web/         Vite + React 19 parent portal and owner admin console.
  mobile/      Expo SDK 57. Parent area and a separate, locked child space.
supabase/
  migrations/  44 numbered SQL files — the real schema.
  tests/       the real-Postgres authorization suite.
```

**Conventions that are not optional**, all enforced by tests or CI (`CLAUDE.md` is the short version):

- Money is integer cents. Time is a UTC instant plus an IANA zone. Domain code takes `now` as an
  argument — nothing calls the clock directly.
- Every new `public` table needs RLS; `supabase/tests/schema_invariants.test.ts` fails without it.
- JSON into Postgres is `${JSON.stringify(x)}::text::jsonb` or `tx.json(x)`, never a bare `::jsonb`.
- Mobile token sources come only from `apps/mobile/src/lib/app-session.ts`. Never add a second child
  token refresher.
- A missing credential is a blocker, never a passing test. Mocks are labeled mocks and production
  readiness rejects them.
- No secrets, real child data or raw homework in code, fixtures, logs or docs. Synthetic names only.
  `scripts/scan-secrets.mjs` runs in CI over tracked files *and* over release-shaped builds, with a
  negative control that plants fake keys and requires the scan to find them.

`docs/Lessons_Learned.md` holds 83 numbered lessons from defects that actually happened here. The
ones a newcomer breaks first: L-054 (a guard over an empty set passes), L-077 (assert the syntax you
mean, not a name that happens to sit nearby), L-074 (a capability whose tests all pass without a
caller), L-080 (a docblock restriction the type does not express is an open defect), L-082 ("fail
closed" is a direction you must choose per control, not a default).

---

## 4. What is built, and how far each thing has been proved

| Subsystem | Where | Proved how far |
|---|---|---|
| Parent auth, sessions, PIN step-up | `apps/api/src/routes/adult.ts`, `middleware/auth.ts` | Real Postgres + API tests |
| Child pairing, child sessions, device lock | `routes/child-auth.ts`, `apps/mobile/src/lib/app-session.ts` | Real Postgres; **never on a device** |
| Family, children, guardians | `routes/family.ts`, `guardians.ts` | Real Postgres + rendered UI tests |
| Homework scan → extract → grade | `apps/api/src/jobs/scan-process.ts`, `packages/ai` | Labeled mocks only. **No real photograph has ever been through it** |
| Learning planner, daily sets, Thursday review | `apps/api/src/jobs/learning-jobs.ts`, `packages/domain/src/learning` | Real Postgres + property tests |
| Question bank | `packages/domain/src/bank` | Property tests over seeds |
| Rewards and points | `routes/rewards.ts`, `packages/domain/src/rewards` | Real Postgres |
| Safety screening | `packages/domain/src/safety`, `apps/api/src/jobs` | A large corpus; provider moderation is a mock |
| Adult identity check | migration 0990, `routes/identity.ts`, `providers/identity-openai.ts` | Built, reachable on both surfaces. The real adapter has never run |
| Billing, P17 promotions, donations | `routes/billing.ts`, `monetization.ts`, `packages/domain` | Webhook fakes only |
| Privacy, export, deletion, account closure | `routes/privacy.ts`, `account.ts`, migration 0620 | Real Postgres |
| Data-practices notice | `routes/data-practices.ts`, both surfaces | Real Postgres + rendered UI |
| Admin console and support queue | `apps/web/src/pages/admin` | Rendered UI tests |

---

## 5. What a developer actually has to do next

Ordered by what unblocks what. Owner-side items are in `docs/Owner_Beta_Checklist.md` and are not
repeated here.

**Blocking a beta walkthrough — hours, not days**

1. **Nothing to write.** The deployment chain is complete and reviewed — migrations, API and portal
   all deploy from GitHub Actions — and it waits on three repository secrets, which are the owner's:
   `SUPABASE_DB_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. **"Reviewed" is not
   "exercised":** no step of any of the three workflows has ever run, so treat the first run of each
   as a test. If one fails, read the log before touching code.

**Blocking a production deploy — found by an adversarial verification pass, not by a test**

2. **`APP_ENV=production` cannot boot.** `CONSENT_ADAPTERS` in `apps/api/src/config.ts` is an empty
   `Set` and `CONSENT_ADAPTER_FACTORIES` in `apps/api/src/index.ts` is an empty object, so
   `config.providers.consent` can never be `'configured'`, and `buildRuntimeOrThrow` returns
   NOT_READY for production unless it is. **Only `testbed` and `staging` can deploy today.** That is
   correct fail-closed behaviour, not a bug — but it means "deploy to production" is blocked on
   writing a consent adapter, not on configuration, and nothing in the readiness records said so.
   *Weeks, and only after the owner has contracted a provider.*
3. **`isProductionReady()` can never return true**, and nothing calls it. `productionReadiness()`'s
   `identity_provider` row requires `providers.identity === 'vendor'`, while the config parser only
   ever returns `openai_document | development_mock | unavailable` and refuses `'vendor'` outright.
   So the row is permanently `blocked`. Decide whether the gate is wrong or the parser is, rather
   than leaving a readiness predicate that no configuration can satisfy and no caller reads (L-074).
   *Hours.*

**Blocking a real child**

4. **Wire ZDR evidence into the Worker** once OpenAI approval exists: `ZDR_APPROVAL_EVIDENCE_REFERENCE`
   and `ZDR_APPROVAL_VERIFIED_AT` as Worker secrets. No code change — the gate already reads them.
5. **A consent provider adapter**, only if counsel's answer to owner action #48 requires one.
   `docs/design/Consent_Design.md` has the full design and the four questions for the vendor. The
   development adapter is a labeled mock that production readiness rejects. *Days to weeks.*

**Quality work that will pay for itself in the first week of a beta**

6. **Real-device verification of the mobile surfaces.** Camera capture, biometric unlock,
   SecureStore, app-switcher screen privacy and the navigation back stack are marked
   `verified_by_inspection` in `docs/Requirement_Coverage.md` — i.e. someone read the code. *Days.*
7. **Photo-quality floor for extraction.** Glare, shadow, skew, pencil on newsprint. The page and
   question-count limits are enforced; the quality floor is unknown. Needs real photographs. *Days.*
8. **Monitoring and alerting** — `docs/Deployment_Runbook.md` §7 is a to-do, not a configuration. A
   beta without it is one where an outage is invisible. *Hours.*
9. **A backup and restore rehearsal** — §6, never rehearsed. A beta without it is one where data loss
   is unrecoverable. *Hours.*
10. **The defects a beta family can actually meet.** Each has an owner decision attached; do not close
   one without it. *Days each.*
   - **BUG-244** (open) — a `/v1/child/refresh` response lost on the way back to a tablet unpairs it.
     Round 5 shipped a recovery and round 6 removed it, because the recovery let an attacker holding a
     captured request body renew a child session indefinitely. Frequency is unmeasured: no device or
     network testing has ever run. Owner action #45.
   - **BUG-096** (confirmed, mitigated) — the extraction model can insert an answer into a child's
     transcription. Labelled answers are withheld; an unlabelled `(84)` or `= 84` still reaches the
     child. Owner action #28.
   - **BUG-420** (open, accepted, with a named trigger) — 97 response schemas in `packages/contracts`
     are `z.strictObject`, which THROWS on an unknown key. The moment the server adds a field to a
     response, every already-installed app whose bundled schema predates it rejects the whole
     response and the parent sees a successful call reported as an error. This one matters more than
     its Medium severity suggests, because it is a *release-process* constraint on a product shipping
     to three stores where users stay on old builds: **it is not a bug you fix once, it is a rule
     about how you may evolve the API.** Read the row before the first field addition.
     **It appears in no readiness record** — this packet is its first.
   - **BUG-309's residual** (closed with residual) — a dense ten-page worksheet can be cut off in
     grading with no affordable retry; the caps are a floor guarantee only. Owner action #46.

**Repository hygiene — do this before a second person touches the code**

11. See §7. It is the single biggest difference between this repository and one a team can work in.

---

## 6. Environment and configuration

`apps/api/src/config.ts` is the authority and it fails closed: `loadConfig` collects every problem
and the Worker answers `503 NOT_CONFIGURED` rather than starting with a guess. `APP_ENV` is never
defaulted — a Worker whose vars lost it does not quietly become `development`.

**Worker secrets** (`wrangler secret put … --env <env>`): `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`,
`CHILD_TOKEN_SECRET`, `HASH_PEPPER`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`,
`OPENAI_PROJECT_ID`, `ZDR_APPROVAL_EVIDENCE_REFERENCE`, `ZDR_APPROVAL_VERIFIED_AT`,
`REVENUECAT_SECRET_API_KEY`, `REVENUECAT_WEBHOOK_AUTH`, `RESEND_API_KEY`, `EMAIL_FROM`,
`PARENTAL_CONSENT_*`, `STRIPE_*` (optional, off by default).

**Worker vars** (`wrangler.toml`): `APP_ENV`, `PROGRAM_TIMEZONE`, `IDENTITY_PROVIDER`,
`CONSENT_PROVIDER`, the TTLs, `INACTIVITY_DELETION_ENABLED`, `CORS_ORIGINS`.

**Client-public, compiled into bundles** — and only these may ever be: `VITE_API_BASE_URL`,
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_LEGAL_REVIEWED`, and the
`EXPO_PUBLIC_*` equivalents plus the RevenueCat public SDK keys. `scripts/scan-secrets.mjs`
`DOCUMENTED_PUBLIC` is the enforced allowlist.

**Provider selection is a rule, not a switch**: a credential present → the real provider; absent in
development/test → a labeled mock; absent in staging/production → `unavailable`, which refuses every
call. There is no path by which a mock serves production.

---

## 7. What is wrong with this repository as a place for a team

Stated plainly because it is the first thing a second developer will hit, and none of it is about the
code.

- **There is no `main` branch.** The default branch is `claude/new-session-vil6cz`, a working branch.
  There is no mainline, no release history and no tag.
- **There has never been a pull request.** Every commit went straight to the default branch.
- **There is no branch protection and no required check**, so CI passing is a convention rather than
  a gate.
- **The repository is public.** No secrets are in it — the scanner enforces that on every commit —
  but the threat model, the safety lexicon and every control are readable by anyone. That may be
  deliberate; it should be a decision rather than a default.
- **There is no CONTRIBUTING and no issue or PR template.** `README.md` (added with this packet) and
  `CLAUDE.md` are what a newcomer has; `CLAUDE.md` is written for an agent rather than for a person
  on their first morning.

What to do, in about an hour: create `main` from this commit and make it the default; protect it and
require the `CI` check; decide deliberately whether the repository should be public; open work as
pull requests from here on. None of it changes a line of product code, and all of it is settings
rather than engineering.

---

## 8. Where the truth lives

`docs/` is the project's own record and it is unusually candid — it contains its own corrections.
Treat it as the best available account, not as gospel: three separate records have been found
materially wrong and fixed (BUG-411, BUG-426, BUG-430), each time because someone checked a sentence
against the code. Do the same.

| File | What it is for |
|---|---|
| `Architecture.md` | binding engineering decisions. **§1 claims the API has "queue consumers". It does not** — there is no `[[queues]]` binding and `index.ts` exports only `fetch` and `scheduled`; durable work is a Postgres job ledger drained by a 5-minute cron. §4's migration list also stops at 0720 while 0990 ships |
| `Beta_Readiness.md` | what has to be true before a real family; the three absolute gates |
| `Owner_Actions.md` | the 49-row register of things only the owner can do |
| `Bug_Ledger.md` | every defect, with reproduction, root cause and the regression that holds it closed |
| `Lessons_Learned.md` | 83 lessons, each tied to a defect |
| `Deployment_Runbook.md` | environments, release order, readiness gates, incident procedures |
| `Data_Retention_And_ZDR.md` | what leaves the product, what it keeps, and the seven ZDR account steps |
| `Threat_Model.md`, `Cost_Analysis.md`, `Test_Evidence.md` | as named |
| `Requirement_Coverage.md` | the AC matrix. **Its Evidence column is stale**: 379 of 388 dated strings are from 2026-09-24 and quote totals (api 378, mobile 370) that are now 1,224 and 941. Re-rendering does not fix it — the prose is hand-written inside `docs/coverage_status.json` and copied verbatim. Treat it as a record of what was once run, not of the current suite. The 34 ACs marked `integration_tested` drive the real app over real Postgres, but with labeled mocks behind every provider |
| `Connections.md` | every external service and its exact blocker |

The spec is `PencilLift_Claude_Code_Master_Prompt.md` Revision 8, preserved byte-for-byte.
