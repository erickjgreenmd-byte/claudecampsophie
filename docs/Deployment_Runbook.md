# PencilLift deployment runbook (spec E2, P15, V2; AC_DEPLOY_*, AC_RELEASE_03)

Status: **nothing has been deployed.** Every step below that touches an external service is blocked on the
owner actions in `docs/Owner_Actions.md` (#3 Supabase, #4 RevenueCat/stores, #5 Expo/EAS, #6 OpenAI + ZDR,
#7 consent provider, #8 Cloudflare/DNS). The commands are the ones the repository is built for; none has
been run against a live account from this environment. Replace this banner with dated evidence as each
step is actually performed.

## 1. Environments

| Environment | API (Cloudflare Worker) | Database | Billing | AI | Consent |
|---|---|---|---|---|---|
| development | `wrangler dev` (apps/api; `APP_ENV` from `apps/api/.dev.vars`, §2) | local Postgres 16 via `pnpm db:local` / `scripts/dev-db.sh` | RevenueCat/Stripe mocks | labeled mock (no child data leaves) | labeled development mock |
| test (CI) | none (Hono app in-process) | Postgres 16 service container, one database per test file | mocks | mocks | mock |
| staging | `pencillift-api-staging` (`wrangler deploy --env staging`) | existing Supabase **staging** project (owner action #3) | RevenueCat sandbox | OpenAI project **only with ZDR evidence** | real provider sandbox |
| production | `pencillift-api-production` | Supabase production project | RevenueCat production | OpenAI with recorded ZDR approval | contracted provider |

`APP_ENV=production` refuses to serve with the development consent mock (HTTP 503 `BLOCKED_EXTERNAL`), and the
scan job never runs a mock AI provider in production (`checkChildDataGate`). Labeled mocks (consent, RevenueCat,
Stripe) are wired only in development and test: staging and production without the server keys get an
unavailable provider that refuses every call, never a mock (§3.1). The same rule decides consent records:
a record the development consent mock wrote (`is_test_provider = true`) counts as verified consent only in
development and test (`acceptsTestProviderConsent`, `apps/api/src/config.ts`). In staging and production
every child-data gate refuses it with 422 `CONSENT_REQUIRED`: child activation, homework registration,
upload and finalize, the scan job and AI re-theming in the learning jobs. A staging database that
holds such rows (from before BUG-067, a seed, or a development Worker pointed at it) needs consent recorded
again through the real provider.

## 2. Configuration (names only — values are never committed)

Worker **secrets** (`wrangler secret put <NAME> --env <env>`):

| Name | Purpose |
|---|---|
| `SUPABASE_JWT_ISSUER` | Expected `iss` of parent access tokens |
| `SUPABASE_JWKS_URL` | Parent token verification keys (staging/production); `SUPABASE_JWT_SECRET` only for local HS256 |
| `CHILD_TOKEN_SECRET` | Signs API-issued child session tokens (≥ 32 random bytes) |
| `HASH_PEPPER` | HMAC pepper for PINs, pairing codes and refresh tokens (≥ 32 random bytes) |
| `CORS_ORIGINS` | Comma-separated parent portal origins |
| `REVENUECAT_SECRET_API_KEY` | Server-side subscriber state fetch |
| `REVENUECAT_WEBHOOK_AUTH` | Exact `Authorization` header value configured on the RevenueCat webhook |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Optional web billing (only with `OPTIONAL_STRIPE_WEB_BILLING_ENABLED=true`) |
| `OPENAI_API_KEY`, `OPENAI_PROJECT` | Server-only AI; without a key scans stay queued and readiness reports AI blocked |
| `ZDR_APPROVAL_EVIDENCE_REFERENCE`, `ZDR_APPROVAL_VERIFIED_AT` | Documented zero-data-retention approval (a boolean is rejected) |
| `CONSENT_PROVIDER` | Reserved for the consent adapter the owner selects (owner action #7). No adapter exists yet: leave unset — an unknown value fails configuration on purpose |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Private homework storage adapter (`providers/supabase-storage.ts`) |

Worker **vars** (`wrangler.toml`): `APP_ENV`, `PROGRAM_TIMEZONE` (donation month zone, default UTC),
`PAYOUT_TRANSFERS_ENABLED` (keep `false` until owner action #12), `INACTIVITY_DELETION_ENABLED` (keep `false` until owner action #13; `INACTIVITY_MONTHS`/`INACTIVITY_NOTICE_DAYS` default 12/30).

`APP_ENV` is required and never defaulted (LRD-5). It is set only in `[env.staging.vars]` and
`[env.production.vars]`; the top-level `[vars]` deliberately leave it out. So always deploy with `--env
staging` or `--env production` (`pnpm deploy:staging` does). A deploy without `--env` produces a Worker with no
`APP_ENV`, and that Worker answers every request with 503 `NOT_CONFIGURED`. Its Cron Trigger only logs
`scheduled_not_configured`. It never runs as development with the labeled mocks. For local `wrangler dev`,
copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars` (gitignored, never uploaded by a deploy) and add the
local-only secrets there. Other configuration errors fail the same way, with 503 `NOT_CONFIGURED`: an unknown
`CONSENT_PROVIDER`, a `SUPABASE_URL` that is not `https` (plain `http` only to `localhost`/`127.0.0.1`), a
`SUPABASE_SERVICE_ROLE_KEY` under 20 characters, and a missing `HYPERDRIVE` binding (logged as
`runtime_not_configured` with the error class only).
Bindings: `HYPERDRIVE` (the three ids in `apps/api/wrangler.toml` are placeholders named
`OWNER_ACTION_HYPERDRIVE_ID_*`; `wrangler deploy` fails until real ids replace them — intentionally).
Mobile: `EXPO_PUBLIC_API_BASE_URL` (public), RevenueCat public SDK keys (public by design).

## 3. Release order (staging first, then production)

1. **Verify the tree**: `scripts/verify.sh` (format → lint → typecheck → all tests → finance model → release
   artifact build, secret scan and negative control, §3.2) exits 0 on the exact commit; CI green on the same SHA.
2. **Database**: `supabase link --project-ref <staging-ref>` then `supabase db push`. Migrations are forward-only
   and ordered by file name (0001 … 0770 at the time of writing; list `supabase/migrations`). 0720 creates a trigger on
   `auth.sessions`: confirm the hosted project accepts it (Owner Action 20) — if it is refused the migration fails
   loudly and a Supabase Auth hook must replace it. Before production, rehearse on a restored copy (§6). Confirm
   `select count(*) from pg_policies` and run the schema invariant queries from `supabase/tests/schema_invariants.test.ts`
   against the linked database (read-only) and record the output.
3. **Worker**: set secrets (§2), replace Hyperdrive placeholders, `cd apps/api && pnpm deploy:staging`.
   Check `GET /health` (200) and `GET /v1/admin/readiness` with an owner MFA session: every row is `ready` or
   explicitly `blocked` with a reason — never a mock silently accepted. Production launches only when every row
   is `ready` (§3.1).
4. **Cron**: confirm the `*/5 * * * *` trigger in the Cloudflare dashboard and a `scheduled_tick` log line;
   `select status, count(*) from public.jobs group by 1` must show jobs moving, no growing `queued` backlog.
5. **Webhooks**: RevenueCat → `https://<api>/webhooks/revenuecat` with the `Authorization` value; send a sandbox
   test event and confirm a `billing_provider_events` row with `status = 'processed'` or `'ignored'`.
6. **Web portal**: `pnpm --filter @pencillift/web build` with the release public values (`VITE_API_BASE_URL`,
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; nothing else), then scan that exact build:
   `node scripts/scan-secrets.mjs --artifacts apps/web/dist` must pass before it is uploaded (§3.2). Deploy
   `apps/web/dist` (Cloudflare Pages or the chosen static host) with `Referrer-Policy: no-referrer` and a CSP
   allowing only the API origin. Public pages (privacy, terms, support, account deletion) must be reachable
   before store review (AC_DEPLOY_04).
7. **Mobile**: before each EAS build, with the `EXPO_PUBLIC_*` values that build uses, scan the public config it
   embeds: `cd apps/mobile && mkdir -p <dir> && npx expo config --type public --json > <dir>/app.config.json`,
   then `node scripts/scan-secrets.mjs --artifacts <dir>` must pass (§3.2).
   `eas build --platform ios --profile preview` and `eas build --platform android --profile preview`
   (internal), then the `production` profile; `app.config.ts` needs `extra.eas.projectId` from the owner's Expo
   project, app icons/splash (brand assets), and an iOS privacy manifest that declares the collected data types
   (photos, email address, user content) — signing and store metadata per owner actions #5 and #11.
8. **DNS and TLS**: point `pencillift.com` (public site and portal) and the API hostname at Cloudflare (owner action
   #8); certificates are issued by Cloudflare's edge. Enforce HTTPS-only and HSTS on both hostnames, and confirm the
   public legal pages load over HTTPS before store review. Record the hostnames in `docs/Connections.md`.

### 3.1 Readiness gates (AC_DEPLOY_07)

`GET /v1/admin/readiness` (`productionReadiness()` in `apps/api/src/config.ts`) reports each check as `ready` or
`blocked`. Checks added or changed for the mock-billing and fake-catalog clauses, and what enforces them:

| Check | Ready when | Enforced beyond the report |
|---|---|---|
| `billing_provider` | `REVENUECAT_SECRET_API_KEY` is set | Staging/production without it get an unavailable client (`selectBillingProviders`, `apps/api/src/index.ts`): RevenueCat webhooks answer 503 and are retried later, `POST /v1/billing/sync` reports the store as unreachable, the stale-entitlement sweep skips the family. Nothing is granted or revoked from an empty mock state. |
| `web_billing_provider` | Optional web billing is off, or `STRIPE_SECRET_KEY` is set | Same rule for the Stripe client |
| `catalog_data` | No live fixture or fake catalog rows (`app.fake_catalog_rows()`, migration 0770); the detail gives counts per catalog | A database marked production refuses them (below) |
| `database_environment` | This database is marked `production` | The mark activates the fixture guard (fake rows are refused on write and the mark is refused while any exist). A production Worker also leaves fake resources and campaigns out of what it serves (`withoutFakes`), but launch only once this check is `ready` |

A catalog row is **fake** when it carries the labeled-fixture convention (`fixture:` evidence or licence
references, including sponsor creative image licences; `fixture.`, `fixture_`, `fixture-` or `fixture:` product,
plan and offer ids; `fixture-` resource keys), points at a host reserved for documentation and testing
(`example.com`/`.net`/`.org`, `.example`, `.test`, `.invalid`, `.localhost`: resource merchant URLs, sponsor
creative destinations and sponsor allowed domains), or is a merchant resource marked `available` that the
catalog's own link check never confirmed. A sponsor campaign is fake when its creative or its sponsor is. It is
**live** while it can be served: resources not retired, affiliate/sponsor approvals pending or approved, store
product and ad-free mappings active, provider offers ready, sponsors active, sponsor campaigns in review,
scheduled, active or paused. Rows are never deleted: retire, revoke, deactivate, suspend the sponsor, end the
campaign or mark the offer `failed` (with a reason) to clear one.

A link check result belongs to the URL that was checked (LRD-2). Changing a resource's merchant URL clears the
previous check: the 0770 trigger `resource_catalog_check_reset` sets `availability = 'unknown'`, whoever
writes the change. A check that was still running when the URL changed records nothing. `POST
/v1/admin/monetization/catalog/:id/link-check` answers 409 `CONFLICT` ("The merchant link changed during the
check; run it again"). Run the check again for the new URL before approving the resource.

Mark each deployed database once, with the migration role (the API's service role can read the mark but never
change it):

```sql
insert into private.deployment (environment) values ('production')  -- 'staging' on the staging project
  on conflict (singleton) do update set environment = excluded.environment;
```

Marking `production` is refused while any live fake row exists. Once marked, inserting or updating a live fake row
in any of the seven catalogs fails (a draft creative or campaign may be stored, but cannot go to review). Staging stays `staging`, so labeled fixtures keep working there and its
`database_environment` check stays blocked (correct: it must not serve real families).

### 3.2 Secret scanning (AC_SECURITY_04)

- **Tracked files**: `node scripts/scan-secrets.mjs` (CI) and `--staged` (pre-commit gate, `scripts/verify.sh`).
- **Release-shaped builds (CI)**: `scripts/scan-release-artifacts.sh` (CI's last step; `scripts/verify.sh` in
  whole-repository mode, `--no-artifacts` skips it) builds the web portal, the Worker bundle (`wrangler deploy
  --dry-run --env production`; nothing is deployed), the Expo web export and the public app config that native
  builds embed (`npx expo config --type public --json`), and runs `node scripts/scan-secrets.mjs --artifacts` on
  all four. Every `VITE_*`/`EXPO_PUBLIC_*` variable holds an obviously fake value of the documented public shape
  (a legacy anon-role key, RevenueCat `appl_`/`goog_` keys, `.invalid` URLs), assembled at run time, so the
  bundles carry these variables as a release build does and the allowlist is exercised on real output.
- **Negative control (CI)**: the same script rebuilds the web portal and the app config with four fake secrets
  in public build variables: a service-role key and a Stripe test-mode secret key in the web portal, and an
  `sb_secret_` key and a database URL with an inline password in the app config. It fails unless the scan
  fails and names each planted detector (`service-role JWT`, `Stripe test secret`, `Supabase secret key`,
  `database URL with password`). A build that stops embedding those variables where the scan looks, or a scan
  that stops seeing one of them, fails CI.
- **The release builds themselves**: CI never holds the release values, so a secret pasted into a public build
  variable at release time is only caught by scanning that exact build. Scan `apps/web/dist` before upload
  (§3 step 6) and the app config before each EAS build (§3 step 7); a failed scan stops the release.
- **Detectors**: the same in both modes. JWTs are decoded (compact or whitespace-formatted JSON), so a Supabase
  service-role key is found whatever the base64 alignment of its role claim. A value is found at the start of a
  word or right after an escape a string literal or URL puts in front of it (`\n`, `\u0022`, `\x22`, `%20`),
  never inside a longer word. In artifacts every other signed JWT also fails, except the documented public
  client values (`docs/Connections.md`): the Supabase publishable/anon key and the RevenueCat public SDK keys.
  The allowlist is `DOCUMENTED_PUBLIC` in the script. Stripe secret and restricted keys are found in live and
  test mode (`sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`). Database URLs with an inline password are found
  too (postgres, mysql/mariadb, mongodb, redis, amqp). Loopback and reserved test hosts are ignored, and so
  are placeholder passwords such as `${X}`, `$X`, `<…>`, `[YOUR-PASSWORD]` and `password`. Base64 `data:` URIs are
  decoded and scanned up to two levels deep; a hit is reported as `<detector> in base64 data URI` (LRD-3).
- **Files**: minified bundles are scanned whole, and findings give `file:line:column` and the detector, never
  the value. Source maps are scanned as the original sources they embed (findings name the source); their VLQ
  `mappings` are skipped. Binary files are read byte for byte and as UTF-16. gzip, brotli (`.br`) and zstd
  files are scanned decompressed. Symlinked directories are followed, each real directory once. A zip or other
  archive, or a compressed file that cannot be decompressed, fails the scan as unscannable (exit 2): unpack it
  and pass the directory. A missing or empty artifact directory fails the scan.
- **Not covered yet**: EAS native builds (.ipa/.aab) and deployed endpoints, which need a deployment (owner
  actions #5, #8). When they exist, unpack the build and pass the directory to `--artifacts`.
- **Last local run** (2026-09-24, `scripts/scan-release-artifacts.sh <scratch dir>`, exit 0 in 18 s): web
  portal, Worker bundle (production env), Expo web export and app config, 69 files / 11.7 MiB →
  `Artifact secret scan passed (69 files, 11.7 MiB in 4 directories)`. Negative control: in the web portal,
  `Stripe test secret` and `service-role JWT` (2 files, 4 findings); in the app config, `Supabase secret key`
  and `database URL with password` (1 finding each).

## 4. Scheduled work and durable jobs

One Cron Trigger calls `runScheduledTick` (`apps/api/src/jobs/dispatcher.ts`): monthly promo generation
(and next month within 5 days of month end), donation accrual for the previous and current program month,
expiry of unsubmitted promo reservations (30 min), raw scan retention purge (30 days), spend alerts at the owner's thresholds, re-sync of stale/lapsed entitlements (lost-webhook safety net), the daily inactivity sweep (03:00 UTC, only when enabled), then due jobs from
`public.jobs` claimed with `FOR UPDATE SKIP LOCKED`. Every step is idempotent; overlapping ticks are safe.

Dead letters: `select id, kind, attempts, last_error_code, updated_at from public.jobs where status = 'dead_letter'`.
Error codes are payload-free (exception class names or pipeline codes such as `EXTRACTION_PROVIDER_FAILED`).
To retry after fixing the cause, insert a **new** job with a new idempotency key version (e.g. `scan:<id>:v3`);
terminal job rows are immutable by trigger. Scans that exhausted retries are already `failed_final` with their
allowance released; the parent can resubmit.

## 5. Incident procedures

| Incident | Detection | Action |
|---|---|---|
| Webhook failures | `billing_provider_events.status = 'failed'`, provider retry dashboard | Fix cause; the provider's retry re-opens the failed event (dedupe allows reprocessing only failed rows) |
| Unmatched promo discount | `audit_events.action = 'promo.unmatched_discount'` | Reconcile campaign caps/budget manually; the donation for that period is already $0 |
| AI outage / spend ceiling | `scan_retry` / `SPEND_CEILING` codes, `ai_usage_events` | Scans retry with backoff; raise or keep the owner cap (`spend_budgets`); never bypass verification |
| Leak report | `safety_reports` category `answer_revealed`, `coaching_blocked_by_guard` log rate | Review guard findings; disable coaching (template-only) by withholding the AI key if needed |
| Consent withdrawal | Parent action | Queued work is cancelled in the same transaction; verify no new `scan_process` jobs start for the family |
| Deletion request | `deletion_requests` | Purge job runs on the next tick; `purge_report` records counts; storage objects are removed before rows |

### 5.1 Safety reports: moderation and escalation (spec P4, P14; AC_SECURITY_01, AC_SECURITY_02)

Reports come from the child's "Tell PencilLift" choices (`POST /v1/child/reports`: `upsetting`,
`wrong_or_confusing`, `answer_revealed`, `other`), from parents (`POST /v1/safety-reports`, which also
offers `unsafe_content`) and from PencilLift's safety screen (system reports, below). The child's "Tell a
grown-up" card sends nothing, and PencilLift sends no automatic parent alert; never tell a family that one
was sent.

System reports (migration 0760). The scan job screens every extracted answer and printed prompt with the
deterministic first-layer screen (`@pencillift/domain/safety`, version `SAFETY_SCREEN_VERSION`) and sends
the child's answers (never the printed prompt) to provider moderation (OpenAI omni-moderation; labeled mock
until the key and ZDR approval exist) BEFORE any grading call. Audit rows of system reports carry `source`
(`safety_screen`, `provider_moderation` or both), `providerCodes` (`PROVIDER_*`) and
`providerModeration: 'unavailable'` when a word-list flag was held because moderation failed. A provider
violence flag on the child's own words arrives as a held abuse+violence report: the model cannot tell a
victim's report from a threat, so the reviewer decides. If moderation fails (outage, timeout) no model call
runs; a retryable failure retries, a final one ends the scan as MODERATION_NOT_AVAILABLE. On a severe-risk result that question gets no
model call at all (no grading, verification or coaching; it gets no verdict and no worked solution), the
child is shown the reviewed safety template (feedback kind `safety`: talk to a trusted grown-up; 988 for
self-harm; Childhelp 1-800-422-4453 for abuse, secrecy, sexual content or stranger contact; 911 for
immediate danger) and one report is filed per question per transcription: `reporter_kind = 'system'`,
category `severe_risk`, status `escalated` from the start (serious by default; the database keeps it
`escalated` or `resolved`). Both are written before grading starts, so a grading failure, a spend-ceiling
pause or a dead-lettered scan cannot delay or drop them. The scan's status follows its other questions (a
flag never moves it to parent review, so a held flag is not announced to the household); the parent sees
the flagged question as not checked. The report holds ids and the screen's category codes only, never
homework text. The child's results screen shows the template as its header and body as soon as it is
filed, whatever the scan's status (still being checked, waiting for a retry, failed for good; the child
API returns the latest notice before any result is visible), and hints and "Try again" are hidden for that
question. If a grown-up later corrects the flagged answer's transcription, the child keeps the template
(also while the recheck waits), the tutor is still not called and no new report is filed unless the
corrected text screens severe again; the queue marks the original report `transcriptionCorrected: true`
(never the corrected text), so check whether the edit was an honest transcription fix. Until a reviewer
clears it, a flagged question stays unchecked (a parent's verdict override answers "No result to
override") and keeps its template even after a correction. The screen leans toward escalation for a
child's first-person words (a missed disclosure is worse than a false flag), so false matches are
expected and are cleared by a person (below; the documented ones are listed in the screen's KNOWN LIMITS). The screen also reads the printed prompt,
but never for a held category (round 5): an `abuse`, `sexual` or `secrecy` flag always comes from the
child's own answer, while a `self_harm`, `violence` or `personal_contact` flag can come from the printed
prompt (a worksheet that quotes "I want to die" or asks what to do when a grown-up wants a secret kept), so
check the prompt first when reviewing one of those. A first person in the prompt ("In our unit we discuss
...") is the worksheet's, never the child's, and a child's disclosure that the extraction put into the
prompt field is not read for the held categories (KNOWN LIMITS). The family
sees a visible report in its report list as "Answer flagged for a grown-up", "Flagged by PencilLift", with a
note that PencilLift sent no automatic alert and the same resources; the family never sees the category
codes. Family hold (proposed default; owner and counsel to approve): a report whose codes include `abuse`,
`sexual` or `secrecy` starts HELD (`family_visible = false`): the family's list does not show it (RLS) and
its audit rows carry no `family_id` (family members can read their family's audit log) until the owner
releases it. The hold only stops PencilLift from drawing the household's attention to the flag; it does not
hide the child's own answer, which the family can always see in the scan, or the child's feedback rows.
`self_harm`, `violence` and `personal_contact` reports are visible at once. A child's own report (the results
screen's "Get help" button, `POST /v1/child/reports`) about a question with a held system report, or naming
its template row, starts held too (`familyVisible: false` in the queue); otherwise it would show the
household the held question at once. Release it on its own, like the system report. The child templates and parent
wording are drafts until the owner and an educator approve them (`SAFETY_TEMPLATES_STATUS`). Blocked model output (coaching, rubric labels, practice intros and stories) is
logged as a code only (`coaching_blocked_by_safety`, `rubric_label_blocked_by_safety`,
`practice_ai_blocked_by_safety`) and creates no report: watch the rates as with `coaching_blocked_by_guard`.

Queue: an owner admin with MFA (aal2) lists `GET /v1/admin/safety-reports?status=open` (oldest first; use
`?status=escalated` for system reports) and moves a report with `PATCH /v1/admin/safety-reports/:id`. A page
holds at most 200 reports; while `nextCursor` is not null, fetch the next page with `&after=<nextCursor>`
and keep going to the end, because a new severe flag is the newest item. There is no admin web screen yet;
use the API. Reviewers see ids, category, status, timestamps and whether a note
exists, never homework text, the child's nickname or the parent's note. A system report adds
`screenCategories` (`self_harm`, `abuse`, `violence`, `sexual`, `secrecy`, `personal_contact`) and
`familyVisible` and `transcriptionCorrected`, and links the question (`questionId`) and the template shown
(`feedbackId`). The resolution note is internal: the family's list and the family's database access show a
report's status and timestamps, never its resolution note (migration 0760 grants no family read of it), so
record authority and family-contact decisions there as the steps below say. Every change
writes an `audit_events` row (`safety_report.updated`, from/to status); a system report's creation writes
`safety_report.created` with actor `system`. To release a held report to the family's list, send
`PATCH /v1/admin/safety-reports/:id` with `{"familyVisible": true}` (alone or with a status); it is
forward only (a report is never hidden again) and writes `safety_report.released_to_family`.

Clearing a false match (round 3; spec P4 "human review procedures"). When the review shows the screen's
word match was wrong (a house rule, homework hyperbole, a game, a lesson; read the one question's
transcription through the service role only if ids and categories cannot settle it, and record that access
in the note, never the text), resolve the system report with
`PATCH /v1/admin/safety-reports/:id` and `{"status": "resolved", "resolution": "false_match",
"resolutionNote": "<the screen category and the kind of false match>"}`. The queue shows the screen
categories (`screenCategories`), not the rule that fired, so the note names the category and the kind of
false match in general words ("self_harm; homework hyperbole", "abuse; a house rule about snacks"), never
the text. The clearance is that report's question and transcription, and it is final.

Clear every system report on the question (round 4). A question can carry several system reports, one per
transcription (the original and a grown-up's correction that screened severe again): find them in the
`?status=escalated` queue by their `questionId` (every page; `transcriptionCorrected: true` marks the older
ones) and clear each one the review covers. The question is graded only after the LAST of them is
cleared; until then its notice stays, a recheck grades and coaches nothing, and the child never sees hints
next to a notice, so clearing only some of them is harmless but leaves the question unchecked. Each
clearance answers with its own `recheck` value (below); the one for the last report grades the question.
- Once every system report on the question is cleared, the child's results stop showing its safety notice
  at once (the notice rows are kept, not deleted; nothing about the answer text is stored with the
  clearance).
- The response's `recheck` says what happens to grading: `queued` (the scan was ready or waiting for parent
  review; it moves to `checking` and a re-check grades the question normally with coaching, like a
  corrected answer), `on_retry` (the scan is waiting for a retry, which grades it), or `none` (the scan
  failed for good, was cancelled or sent back for a retake, or the family is being deleted; nothing is
  graded). A scan that is still being checked is refused (`SCAN_STILL_CHECKING`): clear it once the scan
  settles, and the report stays `escalated` until then.
- A held report stays held for good: combining the clearance with `familyVisible` is refused (400), and a
  later release answers `FALSE_MATCH_NOT_RELEASABLE` (migration 0760 refuses it too). Its audit rows carry
  no `family_id` and the re-check job is not family-readable, so the family never learns of a held report
  that was cleared; they can see only that the scan was checked again and that the question now has a
  result. A child's own "Get help" report about the question stays held until you release it on its own,
  and so does one filed LATER (a cleared held report stays held, so a report about a hint the recheck
  wrote starts held too, migration 0760 `child_report_content`): after clearing a held flag, check the
  queue for the question's child reports (`?status=open`) for as long as the scan's results are shown, and
  release each one on its own when the review allows it. A visible report stays in the family's list as
  resolved, with wording that a reviewer found it was not a concern and that the child's results no longer
  show the message (`clearedAsFalseMatch`; draft wording `safety-templates.v3`).
- If a grown-up later corrects the transcription, the new text is screened afresh: a new severe match files
  a new report and shows the notice again, and needs its own review.
- Only system reports can be cleared (`FALSE_MATCH_SYSTEM_ONLY`). Record the category and the kind of false
  match in the note so the rules can be tuned in a new `SAFETY_SCREEN_VERSION` if the same false match
  recurs; the screen's KNOWN LIMITS (`packages/domain/src/safety/index.ts`) list the expected ones (for
  example "World War I" or "Act I" next to a sensitive word, an adjective "ill" before a verb, a blade or a
  room in an accident, a note about a lesson written in the first person; since round 5 also a wrist cut in
  an accident, a body-safety lesson that says "my private parts", a lesson that quotes "our secret",
  homework frustration such as "I can't do this anymore", and "I don't think ... is the only way out").

| Status | Meaning | Allowed next |
|---|---|---|
| `open` | Not reviewed yet | `triaged`, `escalated`, `resolved` |
| `triaged` | Category confirmed; routine follow-up in progress | `escalated`, `resolved` |
| `escalated` | Serious concern with the owner (the escalation contact) | `resolved` |
| `resolved` | Closed with a required resolution note; final (a new concern is a new report) | none |

Triage. Target: every `open` report reviewed within 1 business day (proposed; owner to approve).

1. `upsetting` and `unsafe_content` are serious by default: set `escalated` at once, then follow the
   escalation steps.
2. `answer_revealed`: follow the "Leak report" row above, then resolve with the guard finding in the note.
3. `wrong_or_confusing`: check the grading or hint path by ids (`question_results`, `child_feedback`), fix or
   record the defect, then resolve.
4. `other`: triage by ids and escalate anything that could involve a child's safety.
5. `severe_risk` (system) arrives `escalated`: go straight to the escalation steps. The screen is a word
   match and can be wrong (fiction, quotes, a sibling squabble, a house rule); a false match is cleared
   as above (`resolution: "false_match"`, every system report on the question) with a note naming the
   category and the kind of false match so the rule can be tuned, never with the text.

Escalation (serious concerns). Target: owner review within 1 hour of `escalated` (proposed; owner to approve).

1. The owner reviews the linked item through ids and audit records only; no casual browsing of child content.
2. If generated content is involved, switch child coaching to reviewed templates (withhold the AI key) until
   the cause is fixed and the answer-leak and moderation tests pass again.
3. If a child may be at risk of harm, the owner contacts the family owner by email and, where the law
   requires, the appropriate authorities, following the owner-approved safety policy. That policy and its
   message templates are an owner action that must be complete before launch (spec P4: "Safety templates
   and human review procedures must exist before launch").
   For a system report, the screen code decides the first step (proposed; owner and counsel to approve).
   Precedence when a report carries several codes: `abuse`, `sexual` or `secrecy` first (their step
   replaces the family contact of the others), then `self_harm`, then `personal_contact`, then `violence`.
   - `abuse`, `sexual`, `secrecy` (held from the family list): the concern may involve someone in the
     household, so do not contact the family first; follow the safety policy for the authorities (child
     protective services, or 911 if the danger is immediate). Release the report to the family only when
     the policy allows it, and record the decision in the resolution note.
   - `self_harm`: contact the family owner by email the same day with the 988 Lifeline information; 911 if
     the danger is immediate. This is a person's message, not an automatic alert, so the family list's
     "PencilLift sent no automatic alert" stays true; record the contact in the resolution note.
   - `personal_contact`: the request came from someone outside the household (a stranger or an online
     contact), so contact the family owner the same day; follow the safety policy for the authorities if
     the child was asked to meet or to send pictures.
   - `violence`: contact the family owner; if a specific school or person is named as a target, follow the
     safety policy for the school or the authorities. A victim's words ("he said if I tell he will hurt my
     mom") screen as `abuse`, not `violence`.
   If ids and codes cannot settle it, the owner may read that one question's transcription through the
   service role; the access is recorded in the resolution note (never the text itself).
4. Resolve with a note stating the outcome and any product change, without homework text or names.

## 6. Backup, restore and rollback (not yet rehearsed)

- Worker rollback: `wrangler rollback --env <env>` to the previous version. Database migrations are forward-only;
  a bad migration is fixed with a new forward migration, never by editing an applied file.
- Restore rehearsal (required before production, AC_RELEASE_03): restore the latest Supabase backup into an
  isolated project, apply pending migrations, then re-run deletion for every family whose `deleted_at` is set
  after the backup time (tombstones are retained so a restored backup cannot silently resurrect a deleted
  account: `select id from public.families where deleted_at is not null`). Storage objects must be restored
  and purged the same way. Record achieved RPO/RTO separately from targets; none has been measured.

## 7. Monitoring (to configure at deployment)

Queue age (`min(run_after)` of queued jobs), dead-letter count, failed webhooks, scan failure rate by code,
`coaching_blocked_by_guard` rate, grading disputes (`question_results.parent_override_verdict`), AI spend vs
`spend_budgets`, p95 latency per stage from `ai_usage_events`. Logs are payload-free JSON lines (ids, status,
codes, latency) — never homework, answers, names or tokens.
