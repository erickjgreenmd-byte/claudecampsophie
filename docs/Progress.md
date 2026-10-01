# PencilLift progress (spec E1 record; resume from here)

Branch: `claude/new-session-vil6cz` (pushed after every lead commit; CI runs on every `claude/**` push).
Spec: `PencilLift_Claude_Code_Master_Prompt.md` Revision 8. Pricing: $39.99 first child + $9.99 each additional
(1–4 paid slots) — unchanged.

## Current state (2026-09-25; code at `110ff0f`)

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
client-side unlock in memory only (privacy screen included) and store names per build. Then hardening round 2a
(`77c13b1`, BUG-131..142): chargebacks and won disputes settle the right amount, a re-enabled subscription is
observed, the stale-entitlement sweep rotates, the RevenueCat TRANSFER shape is accepted, non-USD charges stay out of
USD revenue and the donation rule, consent withdrawal ends the child's access and keeps a pending safety-flag email,
the privacy page names the real photo-removal paths, and migration 0840 adds job and safety-report indexes, 90-day
job retention, membership release at deletion request time and pseudo-zone refusal. Then round 2b (`6728bea`,
BUG-143..159): invitation links survive sign-in, a branded route error boundary, AA button contrast on the web,
the Amazon Appstore across the portal, honest promo-code copy, auth-link failure notices, a `VITE_STORE_LIVE` launch
switch, child-bound subject links and session housekeeping (migration 0850), a deletion purge and account closure
that re-queue after a dead letter, a 15 MiB per-scan bound with mobile downscaling, timeouts metered at their upper
bound and pipeline codes in the job ledger. Then round 2c (`110ff0f`, BUG-160..164): web homework photos shrunk in
the browser and pre-checked against the per-scan bound, Amazon Appstore promo templates that keep their channel, a
password reset requested in the mobile app that finishes on the web, AA contrast on every mobile screen, and child
copy for an oversize scan. MCP connectors for Supabase, Stripe and Expo are attached to
the build session but no project, account or EAS project of PencilLift's exists yet (Connections).
Acceptance coverage (153 criteria; `docs/Requirement_Coverage.md`, each row with its gap): integration_tested 33,
unit_tested 16, db_tested 1, verified_by_inspection 22, mock_only 16, blocked_external 27, in_progress 37,
not_tested 1 (AC_GRADING_11, the frozen 200-question evaluation, needs real AI and labelled data).

Last local full gate (`scripts/verify.sh`, exit 0), run in an isolated worktree on the exact tree of `02964f9`:
api 1,091, domain 3,656, db 403, web 741, mobile 733, ai 65, contracts 20, ui-tokens 4 (6,713 tests, 0 failed,
0 skipped), gate audit, finance, release-artifact scan with negative control. The gate earned its keep again in
round 3: its first run on that tree failed on three mobile fixtures that a tightened contract had made invalid,
which every package's typecheck had passed. Earlier gates caught BUG-114 (a
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

- The bug hunt's second finder round (`wf_2a9a8aa6-7c4` resumed on `110ff0f`): seven area finders told the
  first-round titles, three-lens verification of anything new; its confirmed findings go to a fix round.

**Paused 2026-09-25 22:35 UTC at the owner's request (usage limit).** Fix round 3 (`wf_b932ae15-34e`)
was stopped mid-run; its seven fixers' partial edits are in the container's working tree, unverified and
uncommitted, and are re-runnable rather than recoverable. The round-2 findings and the fix plan are saved
in `docs/hardening/` because the container is ephemeral. To resume: re-run the workflow from
`docs/hardening/round3-fix-plan.json` (regenerate the script from the template in the same directory),
then gate, push and record as the earlier rounds did.

## Next exact steps

1. Confirm CI green on the latest SHA; record it in `docs/Test_Evidence.md`.
2. Round 4 is done and now fully closed: nine read-only finders swept the round-3 diff (112 files, ~11k
   inserted lines) and returned 44 findings, 43 of which were fixed in the round itself
   (`docs/Bug_Ledger.md` BUG-211..246, ECC rows for `wf_8f2c40ab-4dd` and `wf_b0dabd41-8b0`, code at
   `02964f9`, 6,713 tests green). Two of the 44 were defects in round 3's own fixes, both written by the
   lead. The one held open — BUG-244, a lost `/v1/child/refresh` response unpairing a child's tablet — was
   held open on purpose rather than closed with the cheap remedy (a grace window, which would hand a
   replayer a live session in the same conditions, lesson L-047). It is now closed with the designed
   remedy: refresh is idempotent on a client `refreshRequestId` the device keeps across its own retries and
   across a cold start (migration 0880, owner action #45 withdrawn, 6,724 tests green). No round-4 finding
   is outstanding. **REVERSED in round 6 (item 4): that remedy was removed, migration 0880 deleted,
   BUG-244 reopened and owner action #45 restored. Read this paragraph as history, not as current state.**
3. Round 5 is done, and it is the round that read the previous round's fixes. Nine read-only finders swept
   the round-4 tree (76 files, 5,088 inserted lines that no reviewer had read) and returned 46 findings —
   3 high, 19 medium, 24 low — plus 132 properties they tried to break and could not. The findings and the
   lead's decision on each went in BEFORE any fixing (`c46b0c7`, `8f8b6e8`), then seven fixers with seven
   adversarial checkers, one bounded re-fix round, one final round and a lead pass over the last
   verifiers' observations. All 46 are closed: `docs/Bug_Ledger.md` BUG-248..BUG-293, lessons L-050..L-054,
   ECC rows for `wf_b34b376a-83f`, `wf_d57712a9-b6a`, `wf_e1311d21-86a` and `wf_f903d86b-047`, migrations
   0890, 0900 and 0910, code at `b802686`, 6,835 tests green.

   Three of the 46 were defects in the BUG-244 change committed an hour before the hunt read it, and the
   worst was a design error: the recovery checked that the replacement token was UNCLAIMED and treated that
   as proof the response had been lost, which it is not (lesson L-050). It was then bounded to two minutes
   from the rotation, ANDed with the id, and audited — and round 6 removed the whole recovery instead (item
   4), because the bound limited when a replay could start and not how long it lasted. Two more were defects in round-4 fixes: a parent
   screen that handed the next parent the previous parent's children on a shared tablet, and mobile copy
   promising a deletion could be cancelled.

   The process defect this round earned is L-052, a sharpening of L-048: the area file lists were verified
   to cover every file the FINDINGS named, and did — but the file holding the cost ceilings that one fix
   had to change was named by no finding, so that fixer correctly reported "not my file" and the defect
   shipped a red test instead of a fix. Four more fixes were built to the edge of a brief and left
   unconnected. Verify the union against the files the FIXES will touch, which means reading every
   suggested fix before dispatching.

4. Round 6 is done, and it is the round that reversed a decision. Ten read-only finders swept the round-5
   tree (73 files, 5,585 insertions — the round whose own job was fixing round 4, plus three fixes the lead
   made by hand with no independent review) and returned 52 findings: 2 high, 16 medium, 34 low, plus 147
   properties they tried to break and could not. All 52 are closed: `docs/Bug_Ledger.md` BUG-294..BUG-345,
   lessons L-055..L-058, ECC rows for `wf_69a04f5f-f6d`, `wf_18050cd1-c16`, `wf_9091459c-825` and
   `wf_791985a7-1d6`, migrations 0920/0930/0940 added and 0880 DELETED.

   **The headline is a reversal.** The idempotent child-refresh recovery built in round 5 was REMOVED. Its
   recorded residual said a captured request body was "served once"; in fact a recovery never marked the
   row it recovered, so the same body was served repeatedly for the whole window and each serving returned
   a full-lifetime rotating refresh token that then rotated on with no id, no window and no audit row —
   a self-renewing child session until the tablet's next refresh. Against a feature that only avoids an
   occasional re-pairing, that is the wrong trade for a children's product, so BUG-244 is REOPENED as an
   accepted, documented defect and owner action #45 is restored. Lesson L-058: count the repairs — a
   feature on its third fix in a week is telling you its premise is wrong.

   The round also found the lead's own cap raise had broken the oversize-request guard, because one
   constant was serving as both an admission bound and a stage budget (L-055). The two numbers are now
   separate and both properties hold.

   The process change that earned its place: every fixer states the fix's PREMISE and the observable fact
   establishing it, and every checker grades that premise separately from the behaviour. Five premises did
   not hold this round, including two the lead wrote. That is L-056, and it is the single most useful
   thing in this project's review loop.

   Next: the stopping rule, and it is now settled. Rounds 4, 5 and 6 found 9, 3 and 2 high-severity
   findings over trees of comparable size. A round-7 hunt would read about 8,600 inserted lines no finder
   has seen and, on that curve, return one or two high findings — worth doing, but no longer the binding
   constraint. The binding constraint is the owner-side list, so it is written down as its own record:
   `docs/Beta_Readiness.md` gives the ordered path to a first real family, the three gates that are
   absolute (consent provider, documented ZDR approval, legal and educator sign-off), the parent-only
   walkthrough that is available before them, and the honest list of what has never run — no device, no
   real provider call, no measured AI cost, no backup rehearsal, no real photograph of real homework.
5. Round 3 is done: all 50 round-2 reports were routed to seven fixers with disjoint files, 45 reproduced with a
   failing test first and are fixed, every area's acceptance checker ends `ok`, and the lead closed the checkers'
   cross-area residuals in the same round (`docs/Bug_Ledger.md` BUG-165..210, `docs/ECC_Runs.md` `wf_56274b45-95e`,
   code at `8bc022b`, 6,614 tests green). What was not reproduced, and what was deliberately left open, is listed
   in that ECC row rather than dropped. Next: a third finder round over the round-3 tree, or store submission.
6. Owner actions in `docs/Owner_Actions.md` (#1–#49, all open; #45 was withdrawn in round 4 and RESTORED in round 6 when the recovery that closed it was removed; #47–#49 were created by round 7's consent, identity and grade work) unblock everything else: accounts (Apple, Google Play, Amazon
   developer, Cloudflare), a PencilLift Supabase staging project and a PencilLift Stripe account (test mode; the
   attached live account belongs to another business), consent provider, OpenAI key and ZDR approval, store
   products and prices, email provider, legal review incl. counsel's confirmation of the parent-only safety
   policy, spend budget, hosted Supabase checks, database production mark, child-safety package approval,
   BUG-096 residual.
7. Repeat the resume check in the next real session (AC_ECC_09).

## Round 7 (2026-09-30)

The hunt returned 60 findings over `b802686`..`5ba16c3`, and TWO of them are against claims the lead wrote
hours earlier in the round-6 commit itself: a captured child-refresh body called “worthless” after rotation
(it is a repeatable remote unpair, and the false version was in the owner's own sign-off record), and a stage
budget called “not money” while it bounds every later attempt cumulatively. Both are the recorded-residual-
too-small defect that BUG-294 and L-058 exist to prevent — committed inside the change that corrected it.
Both are now fixed in all their records, and the coverage matrix's SOURCE too, because that file is generated
and the correction would otherwise have reverted on the next render (L-069).

The round's largest single shape, 7 of the 60, is a fix that reached the portal and not the phone. Those are
deliberately NOT split across a web fixer and a mobile fixer, because that split is how they diverged: one
agent owns both surfaces of each finding, and a structural test now fails if a section re-derives a decision
that a shared helper owns.

Owner-directed work landed alongside the hunt, at the owner's instruction to carry everything to completion
without further involvement:

- **Parental consent, per child, enforced in the database.** Migration 0970 stamps version, instant and which
  adult server-side, and two CHECK constraints make a child impossible to ACTIVATE without an attestation —
  whichever writer makes the row, including `authenticated` reaching the table through the Data API. A tick
  box alone would have left the requirement optional for anyone who read the API docs (L-060).
- **The adult ID check.** Migration 0980 records each attempt and composes the outcome in a GENERATED column,
  so no partial result reads as a pass. The document half works. The FACE COMPARISON does not and cannot: it
  is biometric identification, which the provider's policies prohibit and its models decline, so the adapter
  attempts it, records the refusal in the audit trail, declares `canCompareFaces: false` and fails closed.
  No mock answers “matched”. Owner action #47 is the vendor choice; #48 is counsel on the wording (L-065).
- **One code, one kid, one grade.** A pairing code is proven to bind to the child it was minted for and to
  carry that child's own grade, and no subject hands a child content from a grade further than two away.
  `SUBJECT_GRADE_REACH = 2` is the owner's amended number (“we can reach up or down 1 or 2”) and a test
  asserts it LITERALLY, because every earlier assertion read `<= SUBJECT_GRADE_REACH` and so stayed green
  with the reach set to 5 (L-067). Prerequisite work is deliberately uncapped: a grade-8 child with a
  grade-2 gap still gets grade-2 practice. Owner action #49 asks whether the other direction should exist.

Next: stage 4 (the 7 parity findings), then the round-7 coverage re-render and the remaining ledger rows.

## Zero data retention and the retention record (2026-10-01)

Two separate questions were conflated everywhere before this round, and the conflation is how a privacy
claim becomes untrue: what **OpenAI** keeps, which only OpenAI's approval decides, and what **PencilLift**
keeps, which only this product's migrations and jobs decide. `docs/Data_Retention_And_ZDR.md` now answers
them in separate sections and opens by saying that neither the document nor the code makes zero data
retention active or makes this product legally compliant.

The code half is `packages/ai/src/zdr.ts`: the eligible endpoints (`/v1/responses`, `/v1/moderations` and
the three others ZDR covers), the INELIGIBLE ones with a retention reason beside each — `/v1/files` carries
30-day abuse-monitoring retention AND application state until the file is explicitly deleted, which is why
homework images go inline as `data:` URLs and never through it — the single approved provider host, and a
metadata allow-list of `stage` and `prompt_version`. `store: false` is sent on every request even though an
approved ZDR organization forces it anyway, because the request made BEFORE any approval exists is the one
that needs it. Prompt caching is accepted and named rather than ignored; background mode, file search, code
interpreter, web search and image generation are refused, each with its reason written down.

Two real defects, found by writing the tests rather than by reading the code:

- **A child identifier on the wire** (BUG-427). `ResponsesRequest.metadata` was `Record<string, string>` with
  a docblock that said "pseudonymous ids only" — and the package's one fixture read
  `metadata: { child: 'pseudonymous-id' }`, in the exact place a developer copies from. `metadata` is the
  field a provider stores BESIDE the request, so it outlives the prompt. A docblock is not a control
  (L-080): the type is now the allow-list, the transport asserts the same allow-list for callers that cast,
  and a test scans this package's own fixtures for identifier-shaped keys.
- **A refusal retried forever** (BUG-428). The three guards were the first statements INSIDE the transport's
  `try`, whose `catch` answers `{ kind: 'error', retryable: true }` for anything thrown. So a request
  carrying a child's identifier was reported as a transient network error and retried, forever, by a job
  that could never succeed. The privacy control and the reliability control cancelled each other and both
  looked right alone. They now sit above the `try`, with a comment saying why (L-079).

`zdr.test.ts` is 23 synthetic-only cases over four areas — the production gate, the request settings, data
minimisation, and the logging protections — and the `@pencillift/ai` floor rose from 96 to 119. Eight
mutations red at least one case; the one survivor is stated as a residual in the test file rather than
covered with a contrived case, because the risk it stands for (repointing the moderation endpoint at
`/v1/files`) IS caught, by the eligibility test.

Next: the two GitHub repository secrets (`SUPABASE_DB_URL`, `CLOUDFLARE_API_TOKEN`), then `Apply database
migrations`, then `Deploy API` with environment `testbed` — the first live URL. Owner action #6 holds the
seven ZDR account steps; none of them is code.
