# PencilLift beta readiness — the path to the first real family

Written 2026-09-29 at code `5ba16c3`, after six hardening rounds. This page answers one question:
**what has to be true before a real parent and a real child use PencilLift**, and in what order.
`docs/Release_Readiness.md` covers store submission; this page is earlier and narrower.

## Verdict

**The software is ready to be beta tested. The beta cannot start, and the blockers are not software.**

> UPDATED 2026-09-30, and the update includes a correction against this record's own earlier claim. The adult identity check was listed as complete software waiting on a vendor. It was not complete: it had a migration, a contract and a provider adapter, and **no route and no screen** — nothing in the repository imported its contract except itself. A parent could not have done the check at all, whichever vendor was contracted. The route and its tests landed in `f13eb76`; **both screens landed in `aa0fcbc`, so the consent path is now walkable end to end** — `/app/identity` in the portal and `(parent)/identity` on the phone, 31 and 32 cases. Building the route surfaced a defect nothing could have caught while nothing called it: `statedDateOfBirth` was validated with a schema whose floor is the year 2000, so every parent born before it — anyone 27 or over in 2026, which is most parents — was refused before their licence was read.
>
> WIRING THE SCREENS THEN FOUND FIVE MORE, and the worst was in code this record had already called complete. The real OpenAI adapter still derived a failure code from a face comparison the shipped method never asks for, so a genuine adult's row would have carried `adult_declared` true **and** a non-null `failure_code` — a combination migration 0990's own CHECK constraint forbids, which means the insert would have RAISED. **Every adult submission in production would have returned a 500 on the only path to a paid account.** Every suite was green, because every suite runs the labeled development mock and no test had ever constructed the real adapter (BUG-415, and L-074 is the lesson, written about this very capability a round earlier). The other four are in the ledger as BUG-416..419.
>
> What this says about the verdict, plainly: "ready to be beta tested" was true of the tests and not of the product, twice in two days, on the same capability. The difference now is that the capability has a caller on both surfaces and the caller is exercised — which is the only thing that would have found any of the five.

Those are two separate claims and they need separating, because conflating them is how a product gets
put in front of a child before its consent path exists.

- **As software**, the product is in the best state it has been in: 6,966 tests pass with zero skipped,
  every package typechecks, seven adversarial hunt-and-fix rounds have worked 349 recorded
  defects (`docs/Bug_Ledger.md`), all closed but the three carried deliberately below plus BUG-411's
  open divergences, and the last four rounds found 9, 3, 2 and (round 7) 3 high-severity defects — a
  curve that says the remaining density is low, not zero. At `aa0fcbc` the asserted floors are api
  1,203, mobile 894, web 961, contracts 42, db 484, domain 3,665, ai 96, ui-tokens 4.
- **As a running service**, nothing exists. No Supabase project is connected, no Worker is deployed, no
  native build has ever been produced, and no line of this code has run on a phone or a tablet
  (`docs/Connections.md` — every provider row is a named blocker).

## The three gates that are absolute

These are not "nice before launch". Until all three are true, **no real child's homework may enter the
system**, and the code enforces that rather than trusting anyone to remember:

| Gate | Owner action | What enforces it |
|---|---|---|
| An approved method establishes that a consenting ADULT is present. **CHANGED by the owner's decision of 2026-09-30, and this is the gate that moved** | **#48** (counsel), with #7 only if counsel requires a vendor | Two standards now exist and the code reads both through one predicate, `public.adult_identity_established`. The owner's method — a government photo ID whose own date of birth makes an adult, PLUS the holder's legal declaration that they are the person on it and the child's parent or guardian — is BUILT and reachable: migration 0990, `POST /v1/identity/verification`, and a verified `consent_records` row written in the same transaction, which every existing gate already reads. So this no longer waits on a vendor contract. What it waits on is counsel answering ONE question (#48): whether sending homework to a ZDR-bound processor is a disclosure to a third party. If it is not, the internal-use standard applies and this method very likely clears 16 CFR 312.5(b)(2); if it is, the stronger biometric standard is required and #7 returns. `public.adult_identity_basis` records which standard each adult met, so that reversal would re-verify only the affected adults. The residual is stated in 0990's header and in docs/Threat_Model.md: reading a licence is not the FTC's database check, and anyone holding an adult's licence passes the document half |
| OpenAI ZDR approval for under-13 data is documented with a reference and a past verification date | #6 | `zdr_evidence`, and `checkChildDataGate` in `packages/ai` blocks child data from reaching any model without it |
| Legal review of the public pages, the safety wording and the parent-only safety policy is signed off | #15, #24 | `safety_templates`. **CORRECTED 2026-10-01**: this row said "the web build fails without `VITE_LEGAL_REVIEWED=true`, an effective date and a support mailbox". The opposite is true, and the difference decides how soon a beta can start. A build with the flag UNSET succeeds and ships a draft banner on every legal page (`isLegalReviewed` in `apps/web/src/lib/config.ts`, `DraftBanner`); proved by building the portal with none of the three set — exit 0. What throws is CLAIMING review without the evidence: `VITE_LEGAL_REVIEWED=true` with no effective date or support mailbox. So legal review gates the CLAIM, not the build, and it does not block the parent-only walkthrough below — which means that walkthrough waits on two accounts, not on counsel. It does still gate a real child, through the safety templates and #24 |

A beta with a friendly family is still a beta with a real child. The consent and ZDR gates do not
soften because the parent is someone the owner knows.

## What a beta can do before those gates: a parent-only walkthrough

There is a genuinely useful test that does not need them, and it is worth naming because it is
available now and would find real problems:

A parent creates an account, adds children as **draft** profiles, sets subjects, grade, age band and
time zone, walks the planner, the rewards screen, the privacy controls, the plan and purchase
confirmation, the support pages and account closure — and never pairs a tablet or scans homework. No
child data, no AI call, no consent requirement. What this exercises is exactly the surface six rounds
of findings kept landing in: copy that promises an action the server refuses, screens that keep the
previous state, and flows that say "done" before the server was told.

This still needs the deploy chain below (a Supabase project, a Worker, a web build). It does not need
the consent provider, the OpenAI key, RevenueCat, a store account — or, per the correction above, legal
sign-off: the pages carry a draft banner until #15 lands, which is the honest state for a beta anyway.
In owner-action terms the whole of it is **#3 and #8**, plus the Supabase configuration those imply
(#20, #21, #40, #41). That is the cheapest real information available about this product, and nothing
in the code is holding it up.

## The ordered path, with what each step unblocks

1. **Supabase staging project** (#3). Nothing else can start: the API, the portal and the mobile app all
   authenticate against it. Then #20 (confirm the migrations may create the `auth.sessions` trigger and
   SECURITY DEFINER functions), apply every migration in order, and #21 (mark the database once with the
   migration role — the mark is what makes it refuse fixture rows), #40 (auth redirect allow-list) and
   #41 (switch on secure password change).
2. **Cloudflare account and DNS** (#8). `wrangler deploy` the API Worker and its queues and cron. The
   Worker refuses to start with mock consent, mock billing, mock AI or missing ZDR evidence, so expect
   the readiness report to be mostly `blocked` at this point — that is the gate working, not a fault.
3. **Web portal build and host**, with `VITE_API_BASE_URL`, `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY`. A production build fails at build time without all three.
   → The parent-only walkthrough above is possible from here.
4. **Resend and the sending domain** (#14). SPF and DKIM records at GoDaddy, then one recorded test send
   of each template. Without it guardian invitations, inactivity notices and the safety flag email are
   refused, and the safety email is the one that must not fail silently.
5. **Expo/EAS and signing** (#5, #34). `eas init` once, then the first native build. This is the step
   after which real behaviour starts being observable — see the untested list below.
6. **Consent provider** (#7), **OpenAI key + ZDR** (#6), **monthly AI spend cap** (#9, #19), **legal and
   educator sign-off** (#15, #24). → A real child may now scan homework.
7. **RevenueCat, store accounts and products** (#4, #11, #1). Only needed for a paid beta; an unpaid
   beta can run on granted entitlements.

## What has never run, and will therefore bite first

Every item below is tested by unit tests and fakes and by nothing else. This list is the honest
expectation of where a beta's first bug reports will come from:

- **No device, ever.** No iOS or Android build has been produced, installed or launched. The camera
  capture path, biometric unlock, SecureStore, the app-switcher screen privacy and the navigation back
  stack are covered by fakes and by reading the code (`docs/Requirement_Coverage.md` marks these
  `verified_by_inspection`).
- **No real provider call.** Every OpenAI, RevenueCat, Stripe, Supabase Storage, Resend and consent
  interaction has only ever met a labeled mock or a fake `fetch`. Request shapes are `candidate` until
  the first real delivery — the Resend adapter and the RevenueCat TRANSFER field list especially (#39).
- **No measured AI cost or latency.** Every number in `docs/Cost_Analysis.md` is a priced hypothesis
  from a rate table, not an observation. The per-stage caps and budgets are arithmetic, and the first
  real scan is the first evidence.
- **No backup or restore rehearsal** (`docs/Deployment_Runbook.md` §6) and no monitoring configured
  (§7). A beta without either is a beta where a data loss is unrecoverable and an outage is invisible.
- **Photo reality.** Real homework photographed by a real parent — glare, shadow, skew, a phone held at
  an angle, pencil on newsprint — has never been through extraction. The ten-page and question-count
  limits are enforced, but the quality floor is unknown.

## Open defects a beta family can meet

Carried deliberately, each with an owner decision attached rather than hidden:

| Defect | What the family experiences | Owner action |
|---|---|---|
| BUG-244 (High) | A `/v1/child/refresh` response lost on the way back to the tablet unpairs it; the parent mints a new pairing code. Round 5 shipped a recovery for this and round 6 removed it, because the recovery bought an attacker holding a captured request body a self-renewing child session. Frequency is unmeasured — no device or network testing has run | #45 |
| BUG-252 | A dense ten-page worksheet can still be cut off in grading with no affordable retry (the bound is question bytes, not pages: reachable to about 85 questions of average length) | #46 |
| BUG-096 | The extraction model can insert an answer into a child's transcription; labelled answers are the mitigation | #28 |

## The stopping rule on hunting

Rounds 4, 5 and 6 found 9, 3 and 2 high-severity findings over trees of comparable size. A seventh hunt
over the round-6 tree would read about 8,600 inserted lines that no finder has seen, and on that curve
would be expected to return one or two high findings — worth doing, but no longer the binding
constraint. **The binding constraint is now the owner-side list above.** More hunting on undeployed
code has a lower expected value than the first real photograph of a real worksheet.

