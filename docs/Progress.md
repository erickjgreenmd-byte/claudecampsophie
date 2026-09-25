# PencilLift progress (spec E1 record; resume from here)

Branch: `claude/new-session-vil6cz` (pushed after every lead commit; CI runs on every `claude/**` push).
Spec: `PencilLift_Claude_Code_Master_Prompt.md` Revision 8. Pricing: $39.99 first child + $9.99 each additional
(1–4 paid slots) — unchanged.

## Current state (2026-09-25; code at `54ca934`)

Software for every spec area is built and integrated on the branch; nothing is deployed, signed, submitted or
approved, and no live provider has been exercised (`docs/Connections.md`, `docs/Release_Readiness.md`).
Since round 5: the traced brand assets and the logo on every screen with iPad/Fire columns (`60955b5`), the Amazon
Appstore channel and the RevenueCat webhook store-name fix BUG-113 (`efb1142`), and the owner decision that the
parent is the sole safety recipient — no family hold, a flag email, two parent actions (`c49a7e7`; the lead's
dissent is in Owner action #24 and Threat_Model T34), and the owner dashboard with support cases and refund
requests (`99166da`: company overview, subscriptions and revenue by channel with owner-set store fee estimates,
support queue and case console, parent support intake on web and mobile; no refund is ever issued by code).
Later the same day: transactional email through Resend, fail closed, with draft copy for every template the code
sends (`04c17ac`; Owner action #14 names the GoDaddy DNS steps), and the support policy settings — refund window,
response targets, partial refunds — as admin settings with the refund window shown to parents (`a2aed0c`; Owner
actions #31 closed by decision, #32). Then the store-readiness pass (`6d0d5d0`): four store audits and their code
gaps closed — in-app account closure (soft delete through the Supabase Auth Admin API, migration 0830), a parental
gate before every pre-PIN outbound link, in-app legal links, subscription disclosures, native config (privacy
manifest, permissions, export compliance, no push stack, EAS linkage with loud variables), web legal pages final
under `VITE_LEGAL_REVIEWED`, security headers; the store submission checklist is in `docs/Release_Readiness.md`
and the owner-side rows are Owner actions #33–#37. Then hardening round 1 (`54ca934`): the fifteen findings the
adversarial bug hunt confirmed in its first round (BUG-116..130) fixed with a failing regression test each — control
characters refused in every free-text field, keyset paging for scans and points, per-family limits and a PIN-set
budget, the K-8 under-13 scope in the contracts (T38), parent sign-out on the device, honest sign-in and reset
errors, request timeouts with a stoppable upload, one page in memory at a time, honest reminder copy on both
planners, pairing recovery, a way home from every child screen, the sign-in offered to a signed-out parent, the
client-side unlock in memory only (privacy screen included) and store names per build. MCP connectors for Supabase, Stripe and Expo are attached to
the build session but no project, account or EAS project of PencilLift's exists yet (Connections).
Acceptance coverage (153 criteria; `docs/Requirement_Coverage.md`, each row with its gap): integration_tested 33,
unit_tested 16, db_tested 1, verified_by_inspection 22, mock_only 16, blocked_external 27, in_progress 37,
not_tested 1 (AC_GRADING_11, the frozen 200-question evaluation, needs real AI and labelled data).

Last local full gate (`scripts/verify.sh`, exit 0), run in an isolated worktree on the exact tree of `54ca934`:
api 952, domain 3,656, db 341, web 530, mobile 591, ai 49, contracts 20, ui-tokens 4 (6,143 tests, 0 failed,
0 skipped), gate audit, finance, release-artifact scan with negative control. Earlier gates caught BUG-114 (a
stale function re-creation, L-026) and BUG-115 (a pinned-clock time bomb, L-027) before their commits. CI runs and their results are listed in `docs/Test_Evidence.md` (the table
there is the source of truth; a records-only commit may still have its run in progress).

Open risks (not hidden by 'closed'): BUG-096 (answers the extraction model inserts into the child's transcription;
confirmed, mitigated, Owner action #28); BUG-091 and BUG-109 closed with documented residuals (rubric-label
heuristic limits; the word-list screen misses paraphrases and over-escalates by design); BUG-111 provider
moderation built but never run live (no key).

## Done and committed (lead-verified)

| Area | Evidence |
|---|---|
| Monorepo, CI (release-artifact secret scan with a negative control), fail-fast gate `scripts/verify.sh` with the test-count audit (floors ~95% of real counts, never lowered; the one past reduction restored), staged-tree pre-commit hook | BUG-024/034/081/089, AC_ECC_07/15 |
| Schema 0001–0780 with RLS, append-only ledgers, deletion purge, jobs, identity hardening, school-report zone pin, reward rules, safety screening (0760; its hold mechanism is unused since the owner decision), fake-catalog guard (0770), request instant for queued work (0780), parent flag review and email state (0790), Amazon Appstore channel (0800), support cases and ops settings (0810), purge of support cases (0820) | `supabase/tests` 255 tests on real Postgres 16 |
| Auth, PIN step-up, pairing (lock order fixed, BUG-106), sessions, one child token refresher | API auth/identity suites |
| Family, guardians, consent (test-provider consent only in development/test), privacy, deletion, exports | BUG-101, `runtime.test.ts` |
| Homework capture, scan pipeline, guarded coaching, rubric feedback (fail closed, three-reading safety screen) | BUG-078/088, BUG-091 |
| Child safety: word-list screen v4 before grading and after generation (recall first; no abuse, sexual or secrecy code from a printed prompt), provider moderation wired and failing closed (labeled mock), reviewed templates (drafts, v4), every flag visible to the parent at once with an email (`safety_flag_email`) and two parent actions; false-match clearing | BUG-084, BUG-107..112, Owner action #24 |
| Brand on every screen (traced assets, icons, splash, favicons), tablet column; Amazon Appstore channel for Fire tablets (`amazon_appstore`, migration 0800, `useAmazon` build flag, no offer codes) | `brand/ASSETS.md`, BUG-113, Owner actions #29/#30 |
| Owner dashboard (`/admin`, `/admin/support`, `/admin/revenue`): metrics with source and definition, attention list, revenue by month and channel, subscriptions, fee-rate settings; support cases with refund requests naming the family's own charge, staff notes, keyset queue; parent support on web and mobile | `admin-ops.test.ts`, `support.test.ts`, `support_cases*.test.ts`, Owner actions #31/#32, T36/T37, BUG-114 |
| AI spend cap fails closed (no budget → no AI outside development/test; upper-bound estimates; holds kept when metering fails) | BUG-092/094/095/097 |
| Learning, rewards, P16 monetization, P17 promotions/schools/donations; billing against labeled mocks | BUG-064..082 |
| Application clock decides when queued work is due | BUG-090 |
| Adversarial reviews of every module and lead change, five final-review rounds | `docs/ECC_Runs.md`, BUG-013..112 |

## In flight

- Adversarial bug hunt across every area (read-only, workflow `wf_2a9a8aa6-7c4`, two finder rounds with three-lens
  verification, still verifying its round-1 findings for billing, safety-privacy, database, jobs-AI and web). Its
  first fifteen confirmed findings (API auth/validation and mobile runtime) are fixed in `54ca934`
  (`wf_8b66cd30-e71`, BUG-116..130); the remaining confirmed findings go to a second fix workflow (failing test
  first, checkers, isolated gate). The four store audits of the same workflow are done and their code gaps are
  closed (`wf_b0de02d8-ca2`; store checklist in `docs/Release_Readiness.md`); the owner-side rows are Owner
  actions #33–#37.

## Next exact steps

1. Confirm CI green on the latest SHA; record it in `docs/Test_Evidence.md`.
2. When the bug hunt finishes: verify its remaining confirmed findings, run the second fix workflow, gate, commit,
   record (`docs/ECC_Runs.md`, `docs/Bug_Ledger.md`).
3. Owner actions in `docs/Owner_Actions.md` (#1–#37) unblock everything else: accounts (Apple, Google Play, Amazon
   developer, Cloudflare), a PencilLift Supabase staging project and a PencilLift Stripe account (test mode; the
   attached live account belongs to another business), consent provider, OpenAI key and ZDR approval, store
   products and prices, email provider, legal review incl. counsel's confirmation of the parent-only safety
   policy, spend budget, hosted Supabase checks, database production mark, child-safety package approval,
   BUG-096 residual.
4. Repeat the resume check in the next real session (AC_ECC_09).
