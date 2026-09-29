# PencilLift beta readiness — the path to the first real family

Written 2026-09-29 at code `5ba16c3`, after six hardening rounds. This page answers one question:
**what has to be true before a real parent and a real child use PencilLift**, and in what order.
`docs/Release_Readiness.md` covers store submission; this page is earlier and narrower.

## Verdict

**The software is ready to be beta tested. The beta cannot start, and the blockers are not software.**

Those are two separate claims and they need separating, because conflating them is how a product gets
put in front of a child before its consent path exists.

- **As software**, the product is in the best state it has been in: 6,966 tests pass with zero skipped,
  every package typechecks, six adversarial hunt-and-fix rounds have worked 344 recorded
  defects (`docs/Bug_Ledger.md`), all closed but the three carried deliberately below, and the last three rounds found 9, 3 and 2 high-severity defects — a curve
  that says the remaining density is low, not zero.
- **As a running service**, nothing exists. No Supabase project is connected, no Worker is deployed, no
  native build has ever been produced, and no line of this code has run on a phone or a tablet
  (`docs/Connections.md` — every provider row is a named blocker).

## The three gates that are absolute

These are not "nice before launch". Until all three are true, **no real child's homework may enter the
system**, and the code enforces that rather than trusting anyone to remember:

| Gate | Owner action | What enforces it |
|---|---|---|
| A verifiable-parental-consent provider is selected and contracted | #7 | `consent_provider` in `GET /v1/admin/readiness`; outside development a missing credential selects a provider that REFUSES every call, never a mock |
| OpenAI ZDR approval for under-13 data is documented with a reference and a past verification date | #6 | `zdr_evidence`, and `checkChildDataGate` in `packages/ai` blocks child data from reaching any model without it |
| Legal review of the public pages, the safety wording and the parent-only safety policy is signed off | #15, #24 | `safety_templates`; the web build fails without `VITE_LEGAL_REVIEWED=true`, an effective date and a support mailbox |

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
the consent provider, the OpenAI key, RevenueCat, or a store account.

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

