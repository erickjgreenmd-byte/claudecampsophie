# PencilLift deployment runbook (spec E2, P15, V2; AC_DEPLOY_*, AC_RELEASE_03)

Status: **nothing has been deployed.** Every step below that touches an external service is blocked on the
owner actions in `docs/Owner_Actions.md` (#3 Supabase, #4 RevenueCat/stores, #5 Expo/EAS, #6 OpenAI + ZDR,
#7 consent provider, #8 Cloudflare/DNS). The commands are the ones the repository is built for; none has
been run against a live account from this environment. Replace this banner with dated evidence as each
step is actually performed.

## 1. Environments

| Environment | API (Cloudflare Worker) | Database | Billing | AI | Consent |
|---|---|---|---|---|---|
| development | `wrangler dev` (apps/api) | local Postgres 16 via `pnpm db:local` / `scripts/dev-db.sh` | RevenueCat/Stripe mocks | labeled mock (no child data leaves) | labeled development mock |
| test (CI) | none (Hono app in-process) | Postgres 16 service container, one database per test file | mocks | mocks | mock |
| staging | `pencillift-api-staging` (`wrangler deploy --env staging`) | existing Supabase **staging** project (owner action #3) | RevenueCat sandbox | OpenAI project **only with ZDR evidence** | real provider sandbox |
| production | `pencillift-api-production` | Supabase production project | RevenueCat production | OpenAI with recorded ZDR approval | contracted provider |

`APP_ENV=production` refuses to serve with the development consent mock (HTTP 503 `BLOCKED_EXTERNAL`), and the
scan job never runs a mock AI provider in production (`checkChildDataGate`).

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
Bindings: `HYPERDRIVE` (the three ids in `apps/api/wrangler.toml` are placeholders named
`OWNER_ACTION_HYPERDRIVE_ID_*`; `wrangler deploy` fails until real ids replace them — intentionally).
Mobile: `EXPO_PUBLIC_API_BASE_URL` (public), RevenueCat public SDK keys (public by design).

## 3. Release order (staging first, then production)

1. **Verify the tree**: `scripts/verify.sh` (format → lint → typecheck → all tests → finance model) exits 0 on the
   exact commit; CI green on the same SHA.
2. **Database**: `supabase link --project-ref <staging-ref>` then `supabase db push`. Migrations are forward-only
   and ordered by file name (0001 … 0650). Before production, rehearse on a restored copy (§6). Confirm
   `select count(*) from pg_policies` and run the schema invariant queries from `supabase/tests/schema_invariants.test.ts`
   against the linked database (read-only) and record the output.
3. **Worker**: set secrets (§2), replace Hyperdrive placeholders, `cd apps/api && pnpm deploy:staging`.
   Check `GET /health` (200) and `GET /v1/admin/readiness` with an owner MFA session: every row must be
   `configured` or explicitly `blocked` with a reason — never a mock silently accepted.
4. **Cron**: confirm the `*/5 * * * *` trigger in the Cloudflare dashboard and a `scheduled_tick` log line;
   `select status, count(*) from public.jobs group by 1` must show jobs moving, no growing `queued` backlog.
5. **Webhooks**: RevenueCat → `https://<api>/webhooks/revenuecat` with the `Authorization` value; send a sandbox
   test event and confirm a `billing_provider_events` row with `status = 'processed'` or `'ignored'`.
6. **Web portal**: `pnpm --filter @pencillift/web build` → deploy `apps/web/dist` (Cloudflare Pages or the chosen
   static host) with `Referrer-Policy: no-referrer` and a CSP allowing only the API origin. Public pages
   (privacy, terms, support, account deletion) must be reachable before store review (AC_DEPLOY_04).
7. **Mobile**: `eas build --profile preview` (internal) then `production`; signing and store metadata per owner
   actions #5 and #11.

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

### 5.1 Safety reports: moderation and escalation (spec P4, P14; AC_SECURITY_01)

Reports come from the child's "Tell PencilLift" choices (`POST /v1/child/reports`: `upsetting`,
`wrong_or_confusing`, `answer_revealed`, `other`) and from parents (`POST /v1/safety-reports`, which also
offers `unsafe_content`). The child's "Tell a grown-up" card sends nothing, and PencilLift sends no
automatic parent alert; never tell a family that one was sent.

Queue: an owner admin with MFA (aal2) lists `GET /v1/admin/safety-reports?status=open` (oldest first) and
moves a report with `PATCH /v1/admin/safety-reports/:id`. There is no admin web screen yet; use the API.
Reviewers see ids, category, status, timestamps and whether a note exists, never homework text, the
child's nickname or the parent's note. Every change writes an `audit_events` row
(`safety_report.updated`, from/to status).

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

Escalation (serious concerns). Target: owner review within 1 hour of `escalated` (proposed; owner to approve).

1. The owner reviews the linked item through ids and audit records only; no casual browsing of child content.
2. If generated content is involved, switch child coaching to reviewed templates (withhold the AI key) until
   the cause is fixed and the answer-leak and moderation tests pass again.
3. If a child may be at risk of harm, the owner contacts the family owner by email and, where the law
   requires, the appropriate authorities, following the owner-approved safety policy. That policy and its
   message templates are an owner action that must be complete before launch (spec P4: "Safety templates
   and human review procedures must exist before launch").
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
