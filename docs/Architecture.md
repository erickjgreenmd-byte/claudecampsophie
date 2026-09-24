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
| Recently unlocked adult | Parent JWT + server-verified PIN/biometric step-up → row in `private.adult_unlocks` (short TTL, bound to the Supabase `session_id`) | `authenticated` | Required server-side for solutions, answer-key exports, rewards approval, purchases/capacity, guardian changes, deletion. |
| Child | Parent-issued single-use pairing code → API-issued child access token (short-lived, signed with an API-only key) + rotating opaque refresh token stored hashed | `pl_child` with API-set claims `{role:'pl_child', child_id, family_id, child_session_id}` | Not a Supabase auth user. The child token is not a Supabase JWT, so PostgREST rejects it; `pl_child` is never granted to the PostgREST authenticator. RLS re-checks that the child session is live. |
| Owner admin | Parent JWT with `aal = aal2` + row in `admin_users` | `authenticated` | Least privilege; admin views expose aggregates, never casual child-content browsing. |
| Jobs / webhooks | Worker secret | `service_role` (bypasses RLS) | Privileged handlers independently verify family membership / ownership of every referenced row (E4 tenant isolation). |

Rules:

- Never trust a role, family ID, price, slot count or child ID from a request body; derive from verified claims and the database.
- Supabase service-role keys, AI keys, webhook secrets and signing keys exist only in Worker secrets. The mobile/web bundles contain only the Supabase URL + publishable anon key and the API base URL.
- Parent solutions live in schema `private` (not exposed through PostgREST, no grants to `anon`/`authenticated`/`pl_child`) and are read only through a `SECURITY DEFINER` function that checks membership **and** a recent adult unlock.
- Every family-scoped table carries `family_id` and has RLS enabled. Supabase grants table privileges to `anon`/`authenticated` by default in `public`, so a table without RLS is a data leak; the test shim reproduces that default.

## 4. Database conventions (spec P13)

- Schemas: `public` (exposed, RLS on every table), `private` (never exposed: solutions, token hashes, PIN hashes, provider secrets refs, raw provider payload digests), `app` (helper functions used by policies; not exposed).
- Core helper functions (migration 0001): `app.current_user_id()`, `app.is_family_member(family uuid)`, `app.is_family_owner(family uuid)`, `app.has_recent_adult_unlock()`, `app.current_child_id()`, `app.current_child_family_id()`, `app.is_owner_admin()`, `app.prevent_mutation()` (trigger for append-only ledgers).
- Families are tombstoned (`deleted_at`) before purge; helper functions treat tombstoned families as inaccessible, and job/webhook handlers must refuse to write into tombstoned families (no resurrection).
- Financial and learning ledgers are append-only (`app.prevent_mutation()` trigger); corrections are new adjustment rows.
- Migration files: `NNNN_area.sql`, applied in lexicographic order. Areas: `0001_core_identity`, `0100_learning`, `0200_billing`, `0300_promotions_schools`, `0400_rewards`, `0500_monetization`, `0600_operations`. An area migration may reference only `0001` and lower-numbered areas it explicitly depends on (`0300` depends on `0200`).
- Tests run against real Postgres 16 via `@pencillift/db/testing` (fresh database per file, Supabase shim, real `SET ROLE` + claims). `PL_MIGRATIONS_ONLY=0001,0300` limits applied files while authoring; CI applies all.

## 5. Billing and entitlements (spec P11, E2)

- One opaque family billing identity (`families.billing_ref`, e.g. `fam_…`) is the RevenueCat `appUserID` and the Stripe customer metadata key for every guardian of the family.
- One normalized server entitlement ledger (`family_entitlements`) is the only source of truth for paid capacity. RevenueCat (Apple/Google) and Stripe (optional, disabled by default) feed it through authenticated webhooks → dedupe by provider event ID → fetch current provider state → upsert. Out-of-order events cannot regress state because reconciliation uses fetched provider state, not the event order.
- Paid capacity tiers map from verified store product IDs (`store_product_mappings`), never from client input. Local booleans never unlock service.
- Pricing shown at checkout, due-now and proration come from the store/provider; the app displays the approved list totals only as the regular recurring price.

## 6. P17 promotions, schools and donations

- Campaign month (calendar redemption window in the template's timezone) is distinct from the beneficiary billing period. A redemption targets exactly one provider billing period, identified by the provider's period start, and is keyed `(family_id, target_period_start)` with a partial unique index over live states so a period can never be discounted twice.
- Redemption state machine: `reserved → provider_pending → confirmed | rejected | expired → reconciled`. Ambiguous in-flight reservations are not released until provider reconciliation decides.
- Donation eligibility is a pure function of a settled provider billing period: regular approved tier price, zero discount of any kind (any promo 5–100%, any promotional credit), settled payment, monthly subscription period (not proration-only/add-on/tax), plus a valid school designation effective for the program calendar month containing the period start. One accrual per `(family_id, donation_month)` enforced by a unique constraint; one active school per family enforced by an exclusion constraint on non-overlapping effective ranges; school changes take effect the first day of the next program month.
- Discount preview rounding: charged = round-half-up(regular × (100 − pct) / 100) in cents, matching `finance/promo_school_model.py`. The provider-reported amount always overrides the preview and is what is stored.

## 7. AI (spec P4, P12)

- OpenAI Responses API through a server-only fetch adapter in `packages/ai`. Model IDs are configuration (`gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-luna` per spec) verified against the owner's account at activation.
- Child-data calls are hard-blocked unless a recorded ZDR approval (evidence reference + verification date) exists for the configured project; an env boolean alone fails closed.
- Every prompt/schema is versioned; outputs are validated against strict schemas; child-facing packets pass the answer-leak guard and fail closed to a reviewed template.
- A test double adapter exists and identifies itself as a mock; production readiness rejects it.

## 8. Explicitly rejected alternatives

| Alternative | Why rejected |
|---|---|
| API uses only the service-role key and authorizes in code | Single layer; one missed check leaks a family. We keep RLS as a second layer by running user requests under `authenticated`/`pl_child`. |
| Children as Supabase auth users | Would require child emails/credentials and makes a child token usable against PostgREST directly. |
| Local quantity multiplier for extra children | Spec P11 forbids; capacity tiers are distinct store products in one subscription group. |
| Computing billing periods as `+30 days` | Wrong for February/month-end; provider period boundaries are authoritative. |
| Floats for money | Rounding drift; forbidden by spec F2. |
