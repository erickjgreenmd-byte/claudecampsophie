# Round 3 lead worklist (assembled 2026-09-26 01:20 UTC, from wf_56274b45-95e journal)

Workflow state at assembly: 7 fixers done; checkers done for mobile (ok), web (NOT ok),
family-api (NOT ok), privacy-safety (NOT ok); check:billing and check:jobs-exports running;
check:db queued; refix+recheck queued for web, family-api, privacy-safety (stage 3 of the
pipeline, so they run themselves — do NOT pre-empt them).

NO repo edits until every checker and refixer has returned: checkers do mutation checks
(revert a fix, watch the test fail, restore byte-for-byte), so a concurrent lead edit would
corrupt their evidence.

## A. Lead-owned code edits (no area owns these files)

A1. apps/api/tests/provider-moderation.test.ts — three edits, from two fixers:
    (a) ~line 412 ("an answer the word list misses but the provider flags…"): providerCodes moved
        off the family-readable audit row onto the reviewer-only row. Replace the
        `createdAudit(report!.id)` metadata assertion with a read of
        `action = 'safety_screen.codes' and metadata->>'reportId' = <id>`, asserting
        family_id is null and metadata matches { source: 'provider_moderation',
        providerCodes: ['PROVIDER_SELF_HARM_INTENT'] }.  (jobs-exports CS-R2-02)
    (b) ~line 456 ("a provider violence flag on the child's words…"): keep
        `expect(audit!.family_id).toBe(scan.fam.familyId)`; move the providerCodes assertion onto
        the same 'safety_screen.codes' row. The 'providerModeration: unavailable' assertion
        (~line 588) stays as is.  (jobs-exports CS-R2-02)
    (c) lines 484-505: replace the whole test with privacy-safety's supplied replacement
        ('a flag with no mapped PencilLift category is answered and reported (CS-R2-03)') —
        verbatim text in r3-lead-actions.json under fix:privacy-safety. The old assertion IS the
        defect, so it is replaced, not weakened; keep the comment naming CS-R2-03.
    Verified post-fix behaviour for (c): stages ['homework_extraction'] only, feedback kinds
    ['safety'], one report { screen_categories: ['abuse','violence'], status: 'escalated',
    family_visible: true }, assignment 'ready', log moderation_flag_child_input/
    PROVIDER_HARASSMENT, one safety_flag_email job.

A2. packages/domain/src/safety/templates.ts:26 — SAFETY_TEMPLATES_VERSION
    'safety-templates.v4' -> 'safety-templates.v5' (CS-R2-06 changed emailSent copy).

A3. apps/api/tests/safety-screening.test.ts — (1) add a NEW pinned digest line beside v4
    (never edit v4): 'safety-templates.v5':
    '7e19d12e9a62803e7ad492eda83c574d92f6bae60dd65fed9afb3ffbb4cac4a8', with a comment naming
    CS-R2-06; (2) line ~1073: expect(PARENT_SAFETY_FLAG_COPY.emailSent).toMatch(/PencilLift emailed/)
    instead of /PencilLift emailed the guardians/. Re-derive the digest locally before pinning it.

A4. apps/api/src/jobs/dispatcher.ts (jobs-exports' file — lead applies after that area lands):
    (a) add `endedCredentialRows: number;` to TickResult.identityHousekeeping and
        `endedCredentialRows: 0` to the identity_housekeeping step fallback; then drop the `?` in
        IdentityHousekeepingResult (apps/api/src/auth/housekeeping.ts) and the `?? 0` in
        apps/api/tests/auth-session.test.ts.  (db DB-R2-08)
    (b) replace the stale job-retention comment (CS-R2-01). Line numbers in the fixer's note are
        stale — find it by content, per L-026. New text: 'The horizon must exceed the raw scan
        retention (30 days). Every next-scan-version key (homework.ts scan and correction routes,
        privacy.ts queueClearanceRecheck) is the HIGHEST kept version + 1, never a count (L-033,
        CS-R2-01), so pruning an earlier row cannot re-derive a key a kept later row still holds.'
    (c) apps/api/src/jobs/scan-process.ts:2091-2092 — second stale comment CS-R2-03 falsified
        ('Every provider flag on the child's words is logged as a code, including those without a
        PencilLift category…'). Rewrite to the fail-closed behaviour.  (check:privacy-safety, low)

A5. apps/api/tests/family-profile.review.test.ts:220 — the 0860 backstop trigger makes the staged
    state unreachable. Replace the raw `update public.child_profiles set status='active'` with a
    replica-role transaction (`set local session_replication_role = replica` inside sql.begin), the
    pattern hardening_r1_db.test.ts already uses. EXPECT the family-api refixer to do this
    (ACC-FAM-02 is blocking for it); only apply if it does not.

A6. Parent-facing copy for two new scan codes, in the two result surfaces
    (apps/web/src/pages/app/HomeworkPage.tsx and the mobile results screen):
    SCAN_TOO_MANY_QUESTIONS — 'This worksheet has more questions than one check can handle. Split
    it into two scans with fewer pages each.'; AI_PAUSED_TOO_LONG — 'PencilLift could not check
    this scan in time. Send the pages again.'  (jobs-exports JOBS-R2-02 / JOBS-R2-06)

A7. packages/contracts/src/auth.ts — tighten adultUnlockResponseSchema.unlockSeconds from optional
    to required once the three web fakes carry it (SecurityPage.test.tsx:63,
    PrivacyControlsPage.test.tsx:314 and :674). A silently-missing field otherwise drops mobile
    back to the server-instant fallback with no contract failure (check:mobile residual).

A8. scripts/test-minimums.json — raise floors: db 390 -> 392, api +18/+1/+9 and the new suites,
    web +10, mobile +6. Recompute from the actual gated run, do not trust the increments.

## B. Cross-area residuals worth fixing this round (lead decision)

B1. CS-R2-07 (medium): the unresolved branch of GET /v1/safety-reports is now uncapped where HEAD
    always returned <= 100 rows. Reports default to 'open' and nothing auto-resolves them; 30
    parent reports/hour each with a 500-char note. Needs a keyset page (L-029), not a raw cap.
B2. ACC-FAM-03 (medium, regression): dropping deletion-pending children from GET /v1/family broke
    the child-name lookup on both privacy screens while a child-scope deletion is only
    requested/processing (still cancellable). Family-api's refixer has this as blocking.
B3. ACC-FAM-05 (medium): knownConstraintError now maps SQLSTATE 22003 to 400 VALIDATION_FAILED for
    every route, so an internal integer-cents overflow would read as the caller's fault. Narrow it
    to the date-cast sites.
B4. WEB-R2-04 residual (medium): the `recovery` flag in createSupabaseAuth is set once and never
    cleared, and the adapter lives at module scope, so recoveryActive() stays true for the life of
    the page after one legitimate reset. Web refixer has WEB-R2-05 as its only blocking item, so
    this one is the lead's to assign or apply.
B5. MOB-R2-01 residual (medium): the Android store-purchase exemption is unbounded — a promise that
    never settles disables the background lock, including the server relock HEAD did
    unconditionally. Bound it (deadline) rather than trusting the store.
B6. ACC-FAM-06 (low): the two new write routes have no per-family rate limit while each success
    writes an audit_events row. Add the neighbours' limiter.
B7. MOB-R2-01 residual (low): useParentAccess's AppState 'active' listener throws away the cleanup
    check() returns, so two overlapping checks can both setAccess.

## C. Items deliberately NOT closed this round (state them in the ECC row)

C1. DB-R2-05 sub-claims: has_recent_adult_unlock on learning-settings/support writes — not
    reproduced as an API rule (the routes never required a step-up); the per-family DB bounds are
    deliberately 2x each API rule (fixed-window limiter vs row count); the DELETE grant on
    test_dates left unguarded (own-family delete is neither a growth nor a flood vector).
C2. API-AUTH-R2-04 half: GET /v1/exports and GET /v1/family/promotions still hard-capped with no
    cursor (ACC-FAM-08).
C3. WEB-R2-09 half: the 214 kB supabase-auth chunk is still a static import of the entry chunk, so
    public pages still download it. Lazy-loading needs recoveryActive() to become async.
C4. JOBS-R2-02 closed with the parent-facing-code branch, not per-page extraction splitting.
C5. CS-R2-04 optional recovery sweep ('checking with no live job') not added — settled at source.
C6. DB-R2-03 second half: the month sum is index-only now but still grows with row count under the
    global spend_budgets lock; the durable fix is a running total in spend-ceiling.ts.
C7. Nine parent-role write sites could move to the service role so the DB enforces the exact API
    rule instead of a 2x bound (learning.ts x5, rewards.ts x2, support.ts x2).

## D. Records (lead-owned, all in docs/)

- Bug_Ledger.md from BUG-165: MOB-R2-01..07, API-AUTH-R2-01..05, WEB-R2-01..09, CS-R2-01..07,
  JOBS-R2-01..08, BILL-R2-1..6, DB-R2-01..08 — reproduced findings only, each with its regression
  test; not-reproduced ones go in the ECC row (see C).
- Lessons_Learned.md, new entries:
  * a server instant is not a lifetime — a client that judges expiry measures it from its own clock
    at receipt, so the API states the seconds, not only the deadline (MOB-R2-02/03).
  * a client sign-out is scope 'local' unless the parent asked for every device (WEB-R2-02).
  * a fixture instant that must still be in the future is derived from the clock, never hardcoded
    (the [APL-20] export fixture) — strengthens L-027.
  * a format-only contract (z.iso.date() accepts any four-digit year) lets an unrepresentable value
    reach a Postgres cast: bound the range in the contract AND map the SQLSTATE (API-AUTH-R2-03).
  * L-033 has a second independent site (privacy.ts queueClearanceRecheck): a retention-prunable
    derived key is audited repo-wide, not per call site.
- Test_Evidence.md: apps/api/tests/mobile-r2.review.test.ts, privacy-r2.review.test.ts (9),
  jobs-r2.review.test.ts (8), family-profile.review.test.ts, billing-r2.review.test.ts,
  supabase/tests/hardening_r2_db.test.ts (24), packages/ai/src/run-truncation.test.ts (4), the new
  mobile suites, plus the CI run for the gated commit.
- Requirement_Coverage.md: spec P4 retention, 'no generic database passthrough endpoints'
  (spec line 340).
- Threat_Model.md T26: the orphaned-export mitigation is now real (duplicate-on-retry treated as
  success, non-ready export paths purged on family deletion, export_build dead-letter compensation).
- Cost_Analysis.md: a truncated extraction now costs at most two calls, not ten.
- Deployment_Runbook.md: after deploying 0860, check
  `select defaclrole::regrole, defaclacl from pg_default_acl d join pg_namespace n on
  n.oid = d.defaclnamespace where n.nspname='public' and d.defaclobjtype='r'` and repeat the
  revoke as the owning role if a client role still carries D/x/t — `alter default privileges` is
  stored per granting role.
- Owner_Actions.md: (i) switch ON 'Secure password change' (reauthentication) in the hosted
  Supabase project — the server half of WEB-R2-04, not settable from code (no supabase/config.toml);
  (ii) confirm PROVIDER_FALLBACK_CATEGORY = 'violence' for a provider flag with no PencilLift
  mapping (migration 0760 allows only self_harm, abuse, violence, sexual, secrecy, personal_contact;
  a distinct 'nothing mapped' code would need a migration plus a child template line);
  (iii) Owner action #24 covers the CS-R2-06 emailSent wording — it is still DRAFT copy.

## E. Gate (unchanged from the r1/r2 pattern)

typecheck every package -> lint + prettier only the changed files -> temp commit via
read-tree/write-tree/commit-tree -> check that SHA out in scratchpad/wt -> scripts/verify.sh +
node scripts/assert-test-count.mjs (migration 0860 means the WHOLE db suite) -> git reset --mixed
<sha> -> push -> wait for CI -> records-only commit after CI is green (the concurrency group
cancels an in-progress run on a new push).
