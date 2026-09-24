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
| T1 | Cross-family read by changing IDs (AC_ACCESS_05) | RLS on every public table; membership helper; claims from verified tokens only; service-role handlers re-check ownership | `core_identity.test.ts` tenant isolation; `schema_invariants.test.ts`; cross-family API tests in rewards, homework, guardians, privacy, promotions, family-activation | Software-tested (local PG16) |
| T2 | Child session escalates to parent (AC_ACCESS_06) | Child token ≠ Supabase JWT; `pl_child` role; column allowlists (L-003); private schema | core tests (forged claims, private schema, RPC, no writes); homework child DTO serialization tests | Software-tested |
| T3 | Stale/revoked child device keeps access (AC_ACCESS_08) | `app.current_child_id()` checks session, device, child, family tombstone on every request | core tests; archive endpoint revokes sessions (`family-activation.test.ts`) | Software-tested |
| T4 | Parent solutions leak to child (AC_GRADING_06) | `private.question_solutions`; step-up SECURITY DEFINER read; child DTO allowlist | homework API tests (child responses searched for key fields); learning schema tests | Software-tested |
| T5 | Hint leaks the answer via encoding/acrostic/translation (AC_GRADING_07/08) | `answer-guard` multi-detector scan fails closed → reviewed template | answer-guard suite; `scan-process.test.ts` leaky packet withheld | Software-tested; not claimed complete (scan.ts lists limits) |
| T6 | Prompt injection in worksheet text | Worksheet text only in the DATA envelope; fixed instructions; no tools; strict output schemas | `scan-process.test.ts` (injection text never in instructions); AI package tests | Software-tested; live-model behaviour unmeasured |
| T7 | Under-13 data sent to AI without ZDR (AC_ACCESS_03) | Gate needs a recorded approval reference, not a flag (BUG-007); consent checked first | `ai.test.ts`; `scan-process.test.ts` (non-mock provider without evidence never called; no consent → nothing sent) | Software-tested; live ZDR blocked (owner action #6) |
| T8 | Forged purchase/capacity from client (AC_BILLING_05) | Capacity only from server-fetched provider state; activation needs a verified slot | webhooks tests; `family-activation.test.ts` | Software-tested; stores not connected |
| T9 | Webhook forgery/replay/out-of-order (AC_CONN_05) | Constant-time auth, event dedupe, fetch current state, stale guard, future-timestamp clamp (RV-entitlements-1), daily re-sync sweep | `webhooks.test.ts`; `scheduled.test.ts` entitlement sweep | Software-tested; live providers blocked |
| T10 | Promo abuse: guessing, replay, stacking, cap races (AC_PROMO_05) | 50-bit codes, rate limits, partial unique indexes, atomic reservations, reservation expiry, unmatched-discount flag (BUG-010) | promotions API/DB tests; scheduled tests | Software-tested |
| T11 | Donation double-counting (AC_PROMO_11) | Unique (family, month); exclusion constraint; refunds as adjustments | donations tests; admin-promotions tests | Software-tested |
| T12 | Points double-spend (AC_REWARDS_02) | Append-only ledger, idempotency keys, locked balance, non-negative check | rewards DB + API tests | Software-tested |
| T13 | Deleted family resurrected by job/webhook/backup (AC_ACCESS_10) | Tombstone first; purge job enqueued atomically; job guard + cancellation; webhooks ignore deleted families | `deletion_purge.test.ts`; `scheduled.test.ts`; webhook deleted-family test | Software-tested; backup-restore rehearsal not done |
| T14 | Parent data visible after switching to child mode (AC_ACCESS_07) | Cache clearing, relock on background (root session layer), fresh PIN to return | mobile `mode`/`family` tests | Logic-tested; device test blocked |
| T15 | Secrets in bundles/logs (AC_SECURITY_03/04) | Server-only secrets; payload-free logs; `scripts/scan-secrets.mjs` in verify + CI; only publishable keys in apps | secret scan passes over tracked files | Partial: pattern scan, not a full secret scanner |
| T16 | Commercial content in child sessions (AC_MON_02) | Placements only for unlocked adults; child routes never return commercial DTOs | monetization workflow tests (integration pending) | In progress |
| T17 | Unbounded AI spend (AC_FIN_09) | Stage caps, per-child allowance reservations, owner budget ceiling checked before AI, 50/80/100% alerts | quotas tests; `scheduled.test.ts` spend alerts; scan spend-ceiling path | Software-tested; owner cap not set |
| T18 | PIN brute force / takeover | Peppered PBKDF2, lockout, rate limits; reset only after account re-authentication | `auth.test.ts`; `family-activation.test.ts` PIN reset | Software-tested |
| T19 | Location/camera metadata leaves our systems (spec P4) | Server strips Exif/GPS/XMP/IPTC/text chunks before AI; malformed content asks for a retake (BUG-013) | `image-metadata.test.ts`; scan metadata test; `public-site.review.test.ts` | Software-tested; stored originals keep metadata until the 30-day purge |
| T20 | Child session revoked by token replay between two refreshers | One app session layer; single-flight refresh (BUG-012, L-007) | `family/child-session.test.ts` | Logic-tested; device test blocked |
| T21 | School recovers a suppressed small group by subtraction | Complementary suppression in SQL reports (RV-donations-4) | `school_report.test.ts` | Software-tested |
| T22 | Open redirect / account enumeration in sign-in | Same-origin `next` only; identical answers for known/unknown emails | web `auth.test.tsx` | Software-tested |

Critical-failure rule (spec A): unauthorized parent-key access, cross-family leak, consent bypass,
unbounded billing, ledger double-spend or missing deletion control blocks production.
