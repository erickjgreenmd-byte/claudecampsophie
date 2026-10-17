# PencilLift — the owner's runway to a beta

Written 2026-10-17 at code `cb74ccb`. This is the non-code half of getting PencilLift in front of a
real family: the accounts, the contracts, the dashboard clicks and the two legal questions. The
engineering half is `docs/Developer_Packet.md`. `docs/Owner_Actions.md` is the full 49-row register
and stays the source of truth for detail; this page is the ORDER, the money and the waiting.

## Where this actually is, in one paragraph

The software is built and tested (**7,503** passing tests, zero skipped, seven adversarial hardening
rounds, 434 recorded defects of which three are open). **Nothing is deployed.** The
GitHub workflows that would deploy it have existed since 1 October and have never run, because the
repository secrets they read were never set. A Supabase project exists and is healthy; its schema has never
been applied. No Worker exists. No portal is hosted. No native build has ever been produced, so no
line of this code has run on a phone or a tablet. The distance between here and "a parent can open a
URL and make an account" is about **fifteen minutes of your clicking and three workflow runs** —
nothing engineering is holding it up. Those three runs have never been executed, so expect the first
attempt of each to surface something; the workflows are reviewed and validated as code, not
exercised.

## Do these four things this week — they are the whole deployment

Everything in this section is yours; none of it can be done from a build container.

### 1. Supabase database URL  → unblocks the schema

Supabase dashboard → project **pencillift-staging** → **Connect** (top bar) → **Session pooler**
(port **5432**, not the 6543 transaction pooler — migrations use statements it does not support).
Copy the whole URL. If it shows `[YOUR-PASSWORD]`, reset the password first under
**Settings → Database → Reset database password**, then copy the URL with the password in it.

Then: repository → **Settings → Secrets and variables → Actions → New repository secret**
- Name: `SUPABASE_DB_URL`
- Value: the pooler URL you just copied

> Link: https://github.com/erickjgreenmd-byte/claudecampsophie/settings/secrets/actions

### 2. Cloudflare API token  → unblocks the API and the portal

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Edit Cloudflare Workers** template,
then **add one more permission the template omits**: `Account → Hyperdrive → Edit`. Without it the
deploy fails at the Hyperdrive step, which is the Worker's only binding.

Add as repository secrets:
- `CLOUDFLARE_API_TOKEN` — the token
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard → Workers & Pages → the Account ID in the right
  sidebar. Only strictly needed if your login has more than one account, but set it anyway: a
  deploy that picks the wrong account is worse than one that refuses.

### 3. Run three workflows, in this order

Repository → **Actions** tab → pick the workflow → **Run workflow**.

| Order | Workflow | Input | What it does | Roughly |
|---|---|---|---|---|
| 1 | **Apply database migrations** | type `APPLY` | Applies all 44 migrations to pencillift-staging, then checks every public table has RLS on the real database and removes the leftover capability probe | 5 min |
| 2 | **Deploy API** | environment `testbed`, type `DEPLOY` | Creates the Hyperdrive config, deploys the Worker, sets the two token-verification values, prints **the API URL** | 5 min |
| 3 | **Deploy portal** | environment `testbed`, paste the API URL from step 2, type `DEPLOY` | Builds the portal with that API address compiled in, scans the exact bundle for secrets, publishes it, and checks a deep link does not 404 | 5 min |

Step 3 prints the URL to give a beta parent.

### 4. Supabase auth settings (2 minutes, after step 3)

In the Supabase dashboard, **Authentication → URL Configuration**, add the portal URL from step 3
with a wildcard — `https://pencillift-web-testbed.<your-subdomain>.workers.dev/**` — to the redirect
allow-list. Sign-up confirmation and magic links are refused without it (owner action #40).
While you are there: **Authentication → Settings**, switch on **Secure password change**
(reauthentication) — owner action #41.

**After these four, you have a working parent-only beta.** A parent can create an account, add
children as draft profiles, set subjects and grade, walk the planner, rewards, privacy controls, the
plan and purchase screens, support and account closure. No child data, no AI call, no consent
requirement, no legal sign-off (the legal pages carry a draft banner, which is the honest state).
`docs/Beta_Readiness.md` calls this the cheapest real information available about this product, and
it is right.

## Start the long poles NOW, in parallel — they are your schedule

Everything above takes an afternoon. Everything below takes weeks of someone else's time, and none of
it runs faster for being started later. Begin all four this week even though you will not need them
for a month.

| Item | What to do | Money | Waiting | Confidence |
|---|---|---|---|---|
| **Apple Developer Program** (#11) | Enrol. As an organization you need a D-U-N-S number first (free through Apple's lookup) | $99/yr | Apple publishes 2–4 weeks for organization enrolment; developers reported 2–8+ weeks through 2026 | `[evidence]` on the fee and the D-U-N-S requirement; `[strong inference]` on the backlog — forum reports, not Apple data |
| **Google Play Console** (#11) | Register. **Read this one carefully**: a PERSONAL account created after 13 Nov 2023 must run a closed test with **at least 12 testers opted in continuously for 14 days** before it may even apply for production access. An ORGANIZATION account (D-U-N-S) is widely reported to be exempt, but Google's own help text only scopes the rule to personal accounts | $25 once | The 14-day clock cannot be compressed, and it starts only once you have 12 real opted-in testers | `[evidence]` on the 12/14 rule for personal accounts; `[guessing]` on the organization exemption — verify on the Play Console help page before choosing an account type |
| **OpenAI zero data retention** (#6) | Apply for the dedicated PencilLift organization. The seven steps are in `docs/Data_Retention_And_ZDR.md` §3. **Ask which ZDR you are being offered**: the current product is ZDR with Private Safety Processing, which requires customer-controlled storage and customer-managed key management — infrastructure, not a form | Unknown; EKM is enterprise-tier | Review, not instant | `[evidence]` that ZDR is required before under-13 personal data; `[strong inference]` that PSP is now the only variant |
| **Counsel, one question** (#48, #15) | Ask: does sending a child's homework to a ZDR-bound processor count as DISCLOSING the child's personal data to a third party? The answer decides whether your own consent method stands or whether you need a paid identity vendor (#47). While they are engaged, have them review the public pages (#15) | Hourly | Days to weeks | `[evidence]` — the question is written out in `docs/Owner_Actions.md` #48 |

**If you register as an organization for both stores, do the D-U-N-S once** — Apple and Google both
accept the same number, and it is the longest single wait in this table.

## The three gates nothing softens

Until all three are true, **no real child's homework may enter the system**, and the code enforces
that rather than trusting anyone to remember. A beta with a friendly family is still a beta with a
real child.

| Gate | Yours to close | What enforces it in code |
|---|---|---|
| A consenting ADULT is established | #48 (counsel), and #47 only if counsel says a vendor is required | `public.adult_identity_established`, migration 0990, `POST /v1/identity/verification` |
| OpenAI ZDR approval is documented, with a reference and a past verification date | #6 | `checkChildDataGate` in `packages/ai/src/gate.ts` — it refuses, it does not warn |
| Legal and educator sign-off on the safety wording and the parent-only safety policy | #15, #24 | `safety_templates`; the public pages show a draft banner until then |

## The full runway, in order

**Phase 0 — a URL (this week).** Items 1–4 above. Owner actions #3, #8, #40, #41, and #21 (mark the
database once, which `Apply database migrations` now does for you).

**Phase 1 — a parent-only beta (immediately after).** Give the portal URL to two or three parents you
know. Nothing else is required. What this finds is the surface six hardening rounds kept landing in:
copy that promises an action the server refuses, screens that keep stale state, flows that say "done"
before the server was told.

**Phase 2 — email (a day, whenever).** #14: a Resend account, add the sending domain, put the SPF and
DKIM records into DNS at GoDaddy, then one recorded test send of each template. Without it guardian
invitations, inactivity notices and **the safety-flag email** are refused — and the safety email is
the one that must not fail silently. Free tier is enough for a beta. Verification is minutes once DNS
propagates.

**Phase 3 — phones and tablets (#5, #34, #17).** `npx eas init` once in `apps/mobile`, then the first
native build. **This is the step after which real behaviour starts being observable**: the camera
capture path, biometric unlock, secure storage, app-switcher screen privacy and the navigation back
stack are today covered by fakes and by reading the code. Expect the first real bug reports here.

**Phase 4 — a real child may scan homework.** All three gates above, plus #9/#19 (an authorized
monthly AI spend cap — staging and production admit no AI stage in a month without a budget row) and
#7 only if counsel requires a vendor.

**Phase 5 — a paid beta (#4, #18, #1, #38).** RevenueCat project and apps, store products at the
approved prices, restore behaviour kept on **Transfer** (not alias), and a decision on #1: Apple's
price points cannot represent $49.98/$59.97/$69.96 exactly. An unpaid beta on granted entitlements
needs none of this.

**Phase 6 — store submission (#33, #35, #36, #11, #29, #30, #22).** App Privacy labels, Play
declarations and the IARC questionnaire, Amazon Appstore if you want Fire tablets, the icon choice,
and the release-build secret scan.

## What this costs to run

**You are already paying for Supabase.** The `Pencillift` organization is on the **Pro** plan
(`tier_pro`, checked live 2026-10-17), not the free tier, so `pencillift-staging` sits in a billing
organization at roughly **$25/month** before any usage. `docs/Deployment_Runbook.md` §0.1 said
"nothing here bills" and was wrong about this half (BUG-433). Either accept it — Pro buys daily
backups and no project pausing, both of which a beta actually wants — or move the project to a free
organization now, while it holds no data.

Everything else at beta scale is genuinely free: Cloudflare Workers, Hyperdrive (100,000
queries/day, reset 00:00 UTC — confirmed on Cloudflare's live pricing page), Workers static assets,
Resend's free tier. The other certain spend is the store accounts ($99/yr + $25) and counsel.

**The AI is the one real variable, and every number in `docs/Cost_Analysis.md` is a priced hypothesis
from a rate table — not one observation.** No real scan has ever run. The per-stage caps and the
monthly ceiling are arithmetic. The first real photograph of a real worksheet is the first evidence
you will have, and the spend ceiling refuses to run at all without a budget row you set (#9, #19),
which is the safeguard against finding out expensively.

## Decisions waiting on you that are not blockers

These do not stop a beta but each one is a sentence someone has to write eventually: #13 (inactivity
retention policy), #25 (family read access while a report is held), #28 (BUG-096), #42 (fallback
safety category), #43 (EXIF orientation), #45 (BUG-244), #46 (BUG-252), #49 (work above grade level).
Each is written out with its options in `docs/Owner_Actions.md`.

## What was done for you, and what only you can do

Done from here, with no credential: the Supabase project exists and is healthy; CI is green on every
push; the migration, API-deploy and portal-deploy workflows are written, validated and waiting;
PostgreSQL 17 is proved compatible (all 484 authorization cases pass against `postgres:17` in CI);
the portal's hosting did not exist and now does.

**Not possible from here, at all:** setting a GitHub repository secret, resetting a Supabase database
password, creating a Cloudflare API token, holding a vendor account, signing a contract, or asking a
lawyer a question. Those six are the list, and the first three are this week's work.
