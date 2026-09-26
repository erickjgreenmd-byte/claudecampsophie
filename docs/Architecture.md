# PencilLift architecture and binding engineering decisions

Status: adopted 2026-09-24 for Revision 8 of `PencilLift_Claude_Code_Master_Prompt.md` (the spec).
These decisions are the implementation contract every contributor (human or agent) follows. A change
to any of them is an explicit, reviewed decision recorded in this file.

## 1. Repository layout (spec P2)

```
apps/api          Hono on Cloudflare Workers: HTTP API, queue consumers, cron handlers
apps/web          Vite + React + React Router: public site, parent portal, owner admin
apps/mobile       Expo + Expo Router: native iOS/Android parent + child app
packages/domain   Pure business rules. No I/O, no clock, no randomness unless injected.
packages/contracts  Zod schemas: role-specific DTOs, request/response contracts, error codes
packages/ai       Server-only OpenAI Responses adapter, prompt/schema registry, gates, metering
packages/ui-tokens  Brand tokens + contrast helpers
supabase          Versioned SQL migrations, RLS, test harness (@pencillift/db)
finance           Owner cost model (Python) + reports; extended, never silently replaced
docs              Records required by spec E1/E5 (see CLAUDE.md for the index)
```

Packages are consumed as TypeScript source (`exports` → `./src/index.ts`); bundlers (wrangler/esbuild,
Vite, Metro) compile them. `tsc` is typecheck-only (`noEmit`). Relative imports use explicit `.ts`
extensions.

## 2. Cross-cutting conventions

| Concern | Decision |
|---|---|
| Money | Integer minor units (USD cents) as `number`. Never floats for customer money. Token costs use micro-USD integers (`usdMicros`) to keep precision without floats in ledgers. |
| Approved prices | `monthlyPriceCents(n) = 3999 + 999 * (n - 1)`, n ∈ 1..4 (configurable max tier). Fixed by the owner; code may not change them. |
| Time | Store UTC instants (`timestamptz`, ISO-8601 strings in DTOs). Local-time rules (daily practice, Thursday review, program calendar) use Luxon with an IANA zone. Never fixed offsets. Domain functions receive `now` as an argument. |
| Calendar values | Calendar month = `YYYY-MM` string; calendar date = `YYYY-MM-DD`; ISO week = `YYYY-Www` in the family's zone. |
| IDs | UUID v4 strings. Public codes (pairing, promo) are separate high-entropy strings, stored hashed where they grant access. |
| Errors | Domain functions return `Result<T, E>` = `{ ok: true, value } \| { ok: false, error: { code, message, details? } }` for expected business failures, and throw only for programmer errors. Error `code`s are stable SCREAMING_SNAKE strings exported as const unions. |
| Randomness | Injected `RandomSource` (`(n) => Uint8Array`), default `crypto.getRandomValues`. Never `Math.random` for anything security- or money-relevant. |
| Idempotency | Every mutating operation that can be retried carries an idempotency key enforced by a unique DB constraint, not by an in-memory check. |
| Untrusted text | Worksheet text, model output, provider payloads and user input are data. Never `eval`, `new Function`, or template them into SQL. |

## 3. Identity and authorization model (spec P3, E4)

Principals:

| Principal | How it authenticates | DB role used by API | Notes |
|---|---|---|---|
| Parent / guardian | Supabase Auth JWT (verified email; optional MFA) verified by the API against Supabase JWKS | `authenticated` with `request.jwt.claims` = verified claims | Family access only via active `family_memberships`. |
| Recently unlocked adult | Parent JWT + server-verified PIN/biometric step-up → row in `private.adult_unlocks` (short TTL written with the database clock, bound to the Supabase `session_id`) | `authenticated` | Required server-side for solutions, every data export download except the child-safe question sheet, rewards approval and parent point spending, purchases/capacity, guardian changes, pairing codes, deletion. PIN attempts are serialized per adult (row lock); PIN reset and change revoke other sessions' unlocks. |
| Child | Parent-issued single-use pairing code → API-issued child access token (short-lived, signed with an API-only key) + rotating opaque refresh token stored hashed | `pl_child` with API-set claims `{role:'pl_child', child_id, family_id, child_session_id}` | Not a Supabase auth user. The child token is not a Supabase JWT, so PostgREST rejects it; `pl_child` is never granted to the PostgREST authenticator. RLS re-checks that the child session is live. |
| Owner admin | Parent JWT with `aal = aal2` + row in `admin_users` | `authenticated` | Least privilege; admin views expose aggregates, never casual child-content browsing. |
| Jobs / webhooks | Worker secret | `service_role` (bypasses RLS) | Privileged handlers independently verify family membership / ownership of every referenced row (E4 tenant isolation). |

Rules:

- Never trust a role, family ID, price, slot count or child ID from a request body; derive from verified claims and the database.
- Sign-out ends API access: a trigger on `auth.sessions` records ended sessions (migration 0720) and every parent token check, installed once on the shared verifier in `createApp`, requires `app.auth_session_active`, failing closed. Hosted Supabase must allow the trigger (Owner Action 20).
- One clock per check: an expiry that SQL compares with `now()` (unlocks, child sessions) is written with `now()` in SQL, never from the request clock.
- Invariants routes rely on are enforced in the schema and mapped by constraint name in `errors.ts`: one active family per adult, one live pairing code per child, IANA family time zones.
- Mobile: the session layer (`apps/mobile/src/lib/app-session.ts`) registers parent data token sources that are empty in child mode; only the step-up source (PIN unlock and relock) keeps the raw session.
- Supabase service-role keys, AI keys, webhook secrets and signing keys exist only in Worker secrets. The mobile/web bundles contain only the Supabase URL + publishable anon key and the API base URL.
- Parent solutions live in schema `private` (not exposed through PostgREST, no grants to `anon`/`authenticated`/`pl_child`) and are read only through a `SECURITY DEFINER` function that checks membership **and** a recent adult unlock.
- Every family-scoped table carries `family_id` and has RLS enabled. Supabase grants table privileges to `anon`/`authenticated` by default in `public`, so a table without RLS is a data leak; the test shim reproduces that default.

## 4. Database conventions (spec P13)

- Schemas: `public` (exposed, RLS on every table), `private` (never exposed: solutions, token hashes, PIN hashes, provider secrets refs, raw provider payload digests), `app` (helper functions used by policies; not exposed).
- Core helper functions (migration 0001): `app.current_user_id()`, `app.is_family_member(family uuid)`, `app.is_family_owner(family uuid)`, `app.has_recent_adult_unlock()`, `app.current_child_id()`, `app.current_child_family_id()`, `app.is_owner_admin()`, `app.prevent_mutation()` (trigger for append-only ledgers).
- Families are tombstoned (`deleted_at`) before purge; helper functions treat tombstoned families as inaccessible, and job/webhook handlers must refuse to write into tombstoned families (no resurrection).
- Financial and learning ledgers are append-only (`app.prevent_mutation()` trigger); corrections are new adjustment rows.
- The job ledger (`public.jobs`) is not append-only: terminal rows (succeeded, cancelled, dead-lettered) older than
  90 days are pruned by the tick's `job_retention` step (`app.prune_terminal_jobs`, migration 0840), except the
  `deletion_purge` and `account_close` kinds, which stay as the audit trail of a deletion. Per-family reads of the
  ledger use `jobs_family_child`; lease recovery uses `jobs_running`.
- The scheduled tick runs the JOB LEDGER before the provider sweeps (round 3, JOBS-R2-04). Each provider request is
  bounded (`BILLING_REQUEST_TIMEOUT_MS`, 10 s), but the entitlement sweep makes up to 25 of them one after another,
  and the work a family is waiting on — a scan, a safety email, an export — is in the ledger. Entitlement staleness
  is measured in days, so a sweep cut short by the end of the tick loses nothing. The claim budget is measured from
  the tick's own start, and a kind whose worst case no longer fits the remaining wall time is not claimed.
- Client roles hold no `truncate`, `trigger` or `references` on any `public` table (migration 0860): TRUNCATE was the
  one write that bypassed both RLS and `app.prevent_mutation()`. Where the API writes as the parent role (learning,
  reward and support tables), the API's own per-family rules are backstopped by BEFORE triggers that fire only when
  `current_user = 'authenticated'`, so the Data API path cannot be a generic database passthrough (spec line 340);
  where it writes only as the service role (`child_profiles`, `safety_reports`), the client grants are revoked.
- A family-scope deletion request releases the adults' memberships in the same transaction as the tombstone
  (`revoked_at = deletion_requested_at`, migration 0840), so a parent can start a new family before the purge
  runs; the deletion view, account closure and the account-close job treat a membership the deletion itself
  released like an active one until that purge completes.
- Migration files: `NNNN_area.sql`, applied in lexicographic order. Areas: `0001_core_identity`, `0100_learning`, `0200_billing`, `0300_promotions_schools`, `0400_rewards`, `0600_operations` … `0720_identity_hardening` (monetization is `0640`, learning runtime `0650`). Until any shared environment applies a migration it may be edited in place; after that, changes are new migrations only. `0710` and `0720` redefine deletion, purge, inactivity and rate-limit functions: later migrations must start from those versions. An area migration may reference only `0001` and lower-numbered areas it explicitly depends on (`0300` depends on `0200`).
- Tests run against real Postgres 16 via `@pencillift/db/testing` (fresh database per file, Supabase shim, real `SET ROLE` + claims). `PL_MIGRATIONS_ONLY=0001,0300` limits applied files while authoring; CI applies all.

## 5. Billing and entitlements (spec P11, E2)

- One opaque family billing identity (`families.billing_ref`, e.g. `fam_…`) is the RevenueCat `appUserID` and the Stripe customer metadata key for every guardian of the family.
- One normalized server entitlement ledger (`family_entitlements`) is the only source of truth for paid capacity. RevenueCat (Apple/Google) and Stripe (optional, disabled by default) feed it through authenticated webhooks → dedupe by provider event ID → fetch current provider state → upsert. Out-of-order events cannot regress state because reconciliation uses fetched provider state, not the event order.
- Paid capacity tiers map from verified store product IDs (`store_product_mappings`), never from client input. Local booleans never unlock service.
- Every reconciliation path (webhook, `POST /v1/billing/sync`, the scheduled stale-entitlement sweep) runs one whole-family routine, `reconcileFamilyBilling` in `services/billing-sync.ts`, from a complete provider fetch: a subscription the provider no longer lists is revoked, former holders of a newly claimed purchase are re-verified, children whose slot a verified change released return to draft, and open capacity requests settle. RevenueCat TRANSFER events re-verify every family they name.
- Pricing shown at checkout, due-now and proration come from the store/provider; the app displays the approved list totals only as the regular recurring price.

## 6. P17 promotions, schools and donations

- Campaign month (calendar redemption window in the template's timezone) is distinct from the beneficiary billing period. A redemption targets exactly one provider billing period, identified by the provider's period start, and is keyed `(family_id, target_period_start)` with a partial unique index over live states so a period can never be discounted twice.
- Redemption state machine: `reserved → provider_pending → confirmed | rejected | expired → reconciled`. Ambiguous in-flight reservations are not released until provider reconciliation decides.
- Donation eligibility is a pure function of a settled provider billing period: regular approved tier price, zero discount of any kind (any promo 5–100%, any promotional credit), settled payment, monthly subscription period (not proration-only/add-on/tax), plus a valid school designation effective for the program calendar month containing the period start. One accrual per `(family_id, donation_month)` enforced by a unique constraint; one active school per family enforced by an exclusion constraint on non-overlapping effective ranges; school changes take effect the first day of the next program month.
- School reports: amounts count only payments that stand (accruals and adjustments in paid or adjusted batches; refunded periods are not active), one suppression rule hides every figure and pairwise difference worth 1–4 families, and a school viewer reads counts only in the program zone the API states for the transaction (0730, 0740). Late settlements accrue to their original program month within a 12-month lookback.
- Discount preview rounding: charged = round-half-up(regular × (100 − pct) / 100) in cents, matching `finance/promo_school_model.py`. The provider-reported amount always overrides the preview and is what is stored.

## 7. AI (spec P4, P12)

- OpenAI Responses API through a server-only fetch adapter in `packages/ai`. Model IDs are configuration (`gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-luna` per spec) verified against the owner's account at activation.
- Child-data calls are hard-blocked unless a recorded ZDR approval (evidence reference + verification date) exists for the configured project; an env boolean alone fails closed.
- Every prompt/schema is versioned; outputs are validated against strict schemas; child-facing packets pass the answer-leak guard and fail closed to a reviewed template.
- A test double adapter exists and identifies itself as a mock; production readiness rejects it.
- Spend ceiling: every AI stage (scan and learning) takes a hold for its upper-bound cost under the monthly budget row lock before it runs, and is admitted only when recorded spend + live holds + that estimate stays within the owner's cap (domain `evaluateSpend`), so no stage overshoots it; the first refusal raises the 100% alert; amounts that cannot be compared exactly fail closed; a refused learning stage keeps the reviewed bank items. Without a global budget row for the current UTC month, development/test run uncapped and staging/production admit no AI stage (`SpendBudgetMissing`: scans pause, practice keeps bank items). Every unexpired hold counts whatever its month; the admitted estimate bounds the request actually sent (UTF-8 bytes of instructions, schema and text plus 1,500 tokens per image), and a stage whose usage cannot be recorded keeps its hold at the billed amount.
- Time: the application's clock decides when work is due. Jobs enqueued inside the database take the request instant the API states (`pencillift.request_now`, migration 0780), else the database clock; the API passes `run_after` explicitly wherever it inserts a job.
- Written work: the child sees only the rubric's criterion labels in fixed wording (short plain labels, otherwise dropped); the rubric notes stay parent-only behind step-up. No AI call is made for it.
- Consent provider is selected explicitly by configuration: the labeled mock only in development/test, an unavailable provider in staging/production until an adapter exists, and the Worker refuses any mock outside development/test.
- Answer protection covers the key that decided the verdict (the model-free prompt key when present); keys that disagree, or cannot be parsed into a protectable form, fall back to the reviewed template. An unevaluated restatement of a computation is never graded correct.
- Scan work re-checks family, child, deletion request and consent before each AI stage and inside each write batch; deletion moves in-flight assignments to `deleted`.

## 8. Explicitly rejected alternatives

| Alternative | Why rejected |
|---|---|
| API uses only the service-role key and authorizes in code | Single layer; one missed check leaks a family. We keep RLS as a second layer by running user requests under `authenticated`/`pl_child`. |
| Children as Supabase auth users | Would require child emails/credentials and makes a child token usable against PostgREST directly. |
| Local quantity multiplier for extra children | Spec P11 forbids; capacity tiers are distinct store products in one subscription group. |
| Computing billing periods as `+30 days` | Wrong for February/month-end; provider period boundaries are authoritative. |
| Floats for money | Rounding drift; forbidden by spec F2. |

## Safety flags go to the parent (owner decision, 2026-09-25)

The parent is the only person PencilLift sends a safety message to, and the parent addresses the concern. Every flag the screen or provider moderation files is visible to the family at once and emailed to every active guardian (no homework text, child name or category in the email); the parent can mark a flag addressed or a false alarm from the portal and the app after a PIN unlock; the owner-admin queue remains a support tool. The family-hold mechanism (0760 `family_visible`, admin release) stays in the schema but `FAMILY_HOLD_CATEGORIES` is empty. The rule that abuse, sexual and secrecy codes never come from a printed prompt keys on `HOUSEHOLD_SENSITIVE_CATEGORIES`, not on the hold list. The lead's dissent: this can deliver a disclosure to the person it names; recorded in Owner action #24 and Threat_Model T34.

## Support cases and the owner-operations dashboard (2026-09-25)

- **Support cases** (migration 0810): a parent opens a case from the portal or the app (`POST /v1/support/cases`;
  kinds complaint, refund_request, billing_issue, bug, safety_question, other; subject ≤ 120 and body ≤ 2000
  characters, enforced by the schema and the API). Case text is the parent's account text: the intake notice
  forbids child names and homework, and no child data is ever copied into a case. A refund request names one of
  the family's own provider billing periods by the natural key `(channel, provider_period_id)`, so a case can only
  point at a charge the provider actually reported. Replies are messages; staff notes are `internal` and never
  reach the family (RLS is the second layer behind the API's parent-role reads). Rate limits: 10 cases and 30
  replies per family per hour. A family purge removes the family's cases and messages (migration 0820); a
  child-scoped purge keeps them.
- **Refunds** are never issued by PencilLift code. Store refunds (App Store, Google Play, Amazon) are the store's
  and are only reflected from `billing_periods.refunded_cents` and pending refunds. A Stripe refund, when web
  billing is enabled, is issued by the owner in the Stripe dashboard and recorded on the case as
  `stripe_refund_issued` with the reference (required by a check constraint); `stripeRefundFromCase` is `false`
  in the contract until a refund call exists behind the web-billing flag.
- **Owner dashboard** (`/v1/admin/overview`, `/revenue`, `/subscriptions`, `/support/*`, `/settings/store-fee-rates`;
  web `/admin`, `/admin/support`, `/admin/revenue`): every metric carries its source table and definition, months
  are UTC keys and `now` is an input, money is integer cents, store fees are an owner-set rate per channel in basis
  points (estimated, never presented as the provider's statement), churn is floored basis points with `null` when
  there is no base. The attention list names every rule, zero counts included, and says honestly when no owner
  console exists for a row (failed jobs, deletion requests, safety reports — the last are the parent's under the
  2026-09-25 decision). All owner routes require `requireParent` + `requireOwnerAdmin` (aal2); a `support` staff
  role does not exist: the owner works the queue (Owner action #31, decided 2026-09-25).
- **Support policy** (Owner action #32): `ops_settings.support_policy` holds the refund window (days), a
  response-time target per case kind (hours) and whether partial refunds are granted; the domain module
  `packages/domain/src/ops/policy.ts` validates it and computes hours over target and the refund window with
  `now` as input; `/v1/admin/settings/support-policy` (owner-only, audited as ids and values, never case text)
  edits it from `/admin/support`; `/v1/support/policy` gives parents the window and the targets with a fixed
  sentence that promises no refund. Absent or invalid stored values fall back to the defaults and say so.

