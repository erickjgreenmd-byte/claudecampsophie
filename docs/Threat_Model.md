# PencilLift threat model (spec P3, P4, E4, V1)

Revision 2026-09-24. Scope: code in this repository. Not a substitute for the independent security and
privacy review the spec requires before release.

## Assets (highest sensitivity first)

1. Child data: homework images, transcriptions, answers, learning evidence, nicknames, grade/age band.
2. Parent-only solutions / answer keys (must never reach child sessions).
3. Billing state: entitlements, paid capacity, promo redemptions, donation ledger, payouts.
4. Rewards ledger (family motivational value; double-spend is a defect class).
5. Credentials: Supabase service role, AI keys, webhook secrets, child-token signing key, PIN pepper.

## Principals and trust boundaries

`anon` → public pages only · `authenticated` (verified parent, Supabase JWT) → own family via RLS ·
recently unlocked adult (server-side step-up row bound to the auth session) → solutions, exports,
purchases, guardians, deletion · `pl_child` (API-issued token, API sets claims) → own child rows only ·
owner admin (`admin_users` + aal2) → aggregates/admin · `service_role` (jobs, webhooks) → bypasses RLS,
so handlers re-verify ownership. Untrusted inputs: worksheet images/text, model output, provider
webhooks, all request bodies.

## Threats, controls and evidence

| ID | Threat | Control | Evidence (test) | Status |
|---|---|---|---|---|
| T1 | Cross-family read by changing IDs (AC_ACCESS_05) | RLS on every public table; membership helper; claims from verified tokens only | `supabase/tests/core_identity.test.ts` "tenant isolation"; `schema_invariants.test.ts` (no table without RLS) | Core: db-tested. Later areas: pending |
| T2 | Child session escalates to parent (AC_ACCESS_06) | Child token ≠ Supabase JWT; `pl_child` role; column allowlists; private schema | core tests: forged claims, private schema denied, RPC denied, no writes | Core: db-tested |
| T3 | Stale/revoked child device keeps access (AC_ACCESS_08) | `app.current_child_id()` checks session, device, child status, family tombstone every query | core tests: revoked device, expired session, archived child, draft child | db-tested |
| T4 | Parent solutions leak to child (AC_GRADING_06) | Solutions in `private`; SECURITY DEFINER read requiring recent unlock; child DTO allowlist; answer-guard scan fails closed | answer-guard module tests; learning schema tests (pending) | In progress |
| T5 | Hint leaks the answer via encoding/acrostic/translation (AC_GRADING_07/08) | `answer-guard` multi-detector scan + template fallback; not claimed complete | answer-guard adversarial suite | In progress |
| T6 | Prompt injection in worksheet text | Worksheet text is data in strict-schema prompts; no tools/browsing; routing fixed server-side | AI package tests (pending) | Pending |
| T7 | Under-13 data sent to AI without ZDR (AC_ACCESS_03) | Gate requires recorded approval evidence, not an env flag; fails closed | AI package tests (pending) | Pending |
| T8 | Forged purchase/capacity from client (AC_BILLING_05) | Capacity only from server-fetched provider state; client results never grant | entitlements module tests | In progress |
| T9 | Webhook forgery/replay/out-of-order (AC_CONN_05) | Provider auth check, event-ID dedupe (unique constraint), fetch current state, ignore older snapshots | entitlements tests; API tests (pending) | In progress |
| T10 | Promo abuse: guessing, replay via second guardian, stacking, cap races (AC_PROMO_05) | 50-bit codes + check symbol, rate limits, family-level uniqueness, partial unique index on target period, atomic reservations | promotions tests; DB tests (pending) | In progress |
| T11 | Donation double-counting (AC_PROMO_11) | Unique (family, month); exclusion constraint on designations; pure eligibility | donations tests; DB tests (pending) | In progress |
| T12 | Points double-spend (AC_REWARDS_02) | Append-only ledger, unique idempotency keys, locked balance row, non-negative check | rewards tests; DB tests (pending) | In progress |
| T13 | Deleted family resurrected by job/webhook/backup (AC_ACCESS_10) | Tombstone first; helper functions deny; service handlers check `app.family_is_active` | core tombstone test; job tests (pending) | Partial |
| T14 | Parent data visible after switching to child mode on shared device (AC_ACCESS_07) | Client clears caches/back stack; server requires fresh step-up | Mobile tests (pending; device test blocked) | Pending |
| T15 | Secrets in bundles/logs (AC_SECURITY_03/04) | Server-only secrets; payload-free logging; secret scan in CI (pending) | Pending | Pending |
| T16 | Commercial content in child sessions (AC_MON_02) | Child DTO forbidden-field scan; placements served only to unlocked adults | answer-guard forbidden fields; monetization tests (pending) | Pending |
| T17 | Unbounded AI spend (AC_FIN_09) | Reservations incl. in-flight, stage caps, global ceiling requiring an explicit owner budget | quotas module tests | In progress |
| T18 | PIN brute force | Peppered hash, attempt counter, lockout, rate limits | API tests (pending) | Pending |

Critical-failure rule (spec A): unauthorized parent-key access, cross-family leak, consent bypass,
unbounded billing, ledger double-spend or missing deletion control blocks production.
