# PencilLift — product requirements

The product half of the developer handoff packet. The engineering half is
[`docs/Developer_Packet.md`](./Developer_Packet.md); binding engineering decisions are in
[`docs/Architecture.md`](./Architecture.md). This page does not repeat either.

**Provenance.** Written 2026-10-19 at `70d352c` on branch `claude/new-session-vil6cz`, which is also
the repository's default branch (there is no `main`, and no pull request has ever been opened). The
authoritative product specification is `PencilLift_Claude_Code_Master_Prompt.md` **Revision 8**,
preserved byte-for-byte; `Acceptance_Register.md` and `School_and_Monthly_Promotions.md` at the repo
root are its acceptance and P17 companions. Where this page and the spec disagree about what exists,
this page describes the **code** and says so.

**How to read the labels.** Everything unmarked is **ESTABLISHED**: implemented in the tree at this
commit, at the cited path. Anything that is a proposal, a design the code does not build, or an owner
decision not yet taken is marked **TENTATIVE** or **UNDECIDED** inline, in bold. The spec proposes
several things the code deliberately does not build; those are called out where they arise.

**Two facts that bound every claim below.**

1. **Nothing is deployed, ever.** No Worker, no portal, no native build. CI has run; the deploy and
   migration workflows have run zero times. A Supabase project exists (`pencillift-staging`, ref
   `uroolgscjkbpcsioqogm`, us-west-1, PG 17.11) and the schema has **never been applied** — zero
   tables in `public`, `private` or `app`. Every behaviour described here is behaviour of code and
   its 7,503 passing tests, not of a running service. See
   [`docs/Beta_Readiness.md`](./Beta_Readiness.md) and [`docs/Connections.md`](./Connections.md).
2. **`APP_ENV=production` cannot boot.** `CONSENT_ADAPTERS` in `apps/api/src/config.ts:274` is an
   empty `Set` and `CONSENT_ADAPTER_FACTORIES` in `apps/api/src/index.ts:91` is an empty object, so
   `providers.consent` can never reach `configured` and `buildRuntimeOrThrow` returns `NOT_READY`.
   Only `testbed` and `staging` deploy. Closing this is a vendor/legal decision (owner actions #7,
   #15, #48), not a code gap.

This repository is **public on GitHub**. Nothing below contains a credential value, a production
identifier that is a secret, or any real family's data. Example names are synthetic (the spec fixes
them as Riley and Sam).

**Re-verification pass, 2026-10-19, and an adversarial pass over it.** Every path and constant cited
below was opened and read again at `70d352c`, and then a second reader tried to break the result.
Corrections are listed here rather than applied silently, per
[`docs/Source_Of_Truth.md`](./Source_Of_Truth.md):

* `app.is_owner_admin()` is at `0001_core_identity.sql:388`. An earlier draft of this paragraph
  "corrected" it to `:387`, which is the comment line above the function — the correction ran
  backwards, the same shape as BUG-426.
* The owner school-report route handler opens at `apps/api/src/routes/admin-promotions.ts:526` and
  calls `public.school_month_report` at `:542`; both citations are right, for different things.
* **The owner-admin reach into family rows in §2 was overstated** and is now enumerated policy by
  policy. Child homework content and the answer key are architecturally out of reach, not merely
  audited.
* **It was still overstated after that enumeration, and by one table that matters most (BUG-439).**
  The list read *eleven* policies and included `safety_reports`, citing `0600_operations.sql:303` —
  a policy `0670_privacy_hardening.sql:13` **drops** and replaces with a family-member-only one,
  precisely so an owner admin stops reading other families' reports and notes through RLS, and which
  `0760_safety_screening.sql:185` then narrows again. The count is **ten**, and the one line of §2
  that named a child's own report note as an owner-readable residual said the opposite of what the
  migration it cited does. The same sentence called `0200_billing.sql`'s three policies "four". Both
  are corrected in §2. A policy citation is only as good as the last migration that touched that
  policy: `grep -n 'drop policy' supabase/migrations/*.sql` is the check that was missing.
* **The child's column-grant list in §2 was not exhaustive.** Three later migrations extend it and
  one grant is table-level rather than a column list; §2 now names them.
* Three screen/route pairings — §3.3 (pairing code), §3.8 (`/submitted`) and §3.9
  (`/billing/capacity-changes`) — named a surface that does not make the call. Corrected inline.
  This is the L-074 failure mode and it recurred three times in one document.
* **The "no T41 in the threat model" divergence in §3.2 was false.** T41 exists
  ([`docs/Threat_Model.md`](./Threat_Model.md) line 67), added in this commit under BUG-435. The box
  in §3.2 now retracts the accusation instead of repeating it.
* The child-PIN gap in §3.3 is newly recorded here and appears in no other document.
* The defect count in §5 was stale; §5 now points at the derived record instead of carrying a
  number.
* `scripts/test-minimums.json` holds the eight test floors (api **1,224**), which sum to **7,503**,
  the actual passing count. [`docs/Beta_Readiness.md`](./Beta_Readiness.md) carries those same
  figures — it was corrected at this commit under BUG-436. An earlier draft of this paragraph said
  that record still read 1,219 and was "stale by 5"; it does not, and the accusation was false.

---

## 1. What the product is, and who pays

PencilLift is a US-market, English, K–8 homework-help service for families. A parent owns the
account; a child scans completed homework with a phone or tablet, and the system extracts each
question, grades what can be graded deterministically, and coaches the child through mistakes
**without ever handing over the answer key**. Earned points buy parent-defined rewards that the
parent fulfils outside the app. Daily extra-credit practice is offered every local day; a weekly
subject review (Thursday by default) prioritises that week's errors ahead of a Friday test. The
parent gets the complete solutions behind a PIN step-up, skill trends, and reviewed physical
learning resources. Six subjects are supported: math, reading, spelling/vocabulary,
grammar/writing, science, social studies (`packages/contracts/src/learning.ts:23`).

**The parent pays, and only the parent.** A monthly subscription of **USD $39.99 for the first child
plus $9.99 for each additional child**, 1–4 paid child slots ($39.99 / $49.98 / $59.97 / $69.96),
charged through Apple, Google or the Amazon Appstore via RevenueCat; an optional Stripe web route
exists but ships disabled. A child never pays, never purchases and has no email address, login or
public profile. A school never pays: PencilLift funds a **$1 per eligible family per calendar month**
donation to a family's designated school as its own expense (P17). Advertising and Amazon affiliate
revenue are built but switched off (§6).

Read that paragraph against header fact 1: the prices, the donation and the three storefront
channels are rules implemented and tested in code, not revenue that has happened. No charge has
ever been made, no entitlement has ever been granted by a real store, and **donation payouts are
disabled — accrual is built, transfer is owner action #12 and UNDECIDED** (§3.8 step 6).

---

## 2. User roles

Taken from the roles, predicates and grants in the migrations and
`apps/api/src/middleware/auth.ts`, not from the spec's prose.

| Role | Authenticates as | Can see | Can never see |
|---|---|---|---|
| **Parent / family owner** | Supabase Auth email+password (or magic link) → Postgres `authenticated`. Every parent token check also confirms the Supabase `auth.sessions` row still exists, so a sign-out ends API access immediately (`withLiveSessionCheck`, defined at `apps/api/src/auth/parent.ts:138` and wrapped round every parent verify at `apps/api/src/middleware/auth.ts:25`). Privileged actions need a *recent adult unlock*: `app.has_recent_adult_unlock()`, default TTL 300 s (`ADULT_UNLOCK_TTL_SECONDS`, `apps/api/src/config.ts:227`) | Everything in their own family: children, scans, **private solutions and answer keys** (step-up), skill evidence, points and reward ledger, usage, subscription, school designation and promotions, safety flags, exports | Any other family's anything (RLS `app.is_family_member(family_id)` on every table); owner-admin surfaces; another family's school report |
| **Additional guardian** | Identical to the owner — the same `authenticated` role and the same `family_memberships` row, reached by accepting a verified invitation (`POST /v1/invitations/accept`) | Everything the owner sees. Access is equivalent after acceptance | Anything outside the one family. An adult has **at most one** active membership (unique index, migration 0720); two would make the request fail rather than pick one (`currentFamilyId`, `apps/api/src/middleware/auth.ts:102`) |
| **Child** | A parent-issued 8-character pairing code (`PAIRING_CODE_LENGTH`, `apps/api/src/auth/pairing.ts:6`), 600 s TTL (`PAIRING_CODE_TTL_SECONDS` default 600, `apps/api/src/config.ts:230` — not in `pairing.ts`, which holds only the length and the alphabet). Mints a **child-scoped session only** — Postgres role `pl_child`, 15-minute access token, 30-day rotating refresh token (`CHILD_ACCESS_TTL_SECONDS` 900, `CHILD_REFRESH_TTL_SECONDS` 2,592,000, `apps/api/src/config.ts:228-229`). **These four TTLs are the shipped defaults and no `wrangler.toml` `[env.*.vars]` block or `eas.json` build profile overrides any of them — those files set only `APP_ENV`, `PROGRAM_TIMEZONE`, and the Expo public API base URL and store — but no test pins the literal numbers either.** The only assertion anywhere compares a response field with `api.config.*` (`apps/api/tests/mobile-r2.review.test.ts:124`, `:148`, `:172`), which would follow a changed default rather than fail on it; a contractor who edits one of these defaults will not red a test | Only explicit column grants: their own subject list, assignment status and page count, extracted prompt text, verdict (`correct`/`try again`/unresolved), child-safe feedback, practice sets and items, their own points balance, ledger, reward catalogue and redemption states (`0001_core_identity.sql:525-527`, `0100_learning.sql:541-549`, `0400_rewards.sql:342-346`). **Three later migrations extend that list and a reader who stops at those three ranges will under-count it:** `grant select (release_at, child_intro) on public.practice_sets` (`0650_learning_runtime.sql:38`), `grant select (parent_override_verdict) on public.question_results` and `grant select (corrected_prompt_text, corrected_student_answer_text) on public.extracted_questions` (`0660_integration_grants.sql:20-21`). One grant is table-level, not a column list — `grant select on public.point_balances` (`0400_rewards.sql:343`), four columns, narrowed by RLS to the child's own row (`:351-352`). No answer key or solution field is in any of them: the added columns are a verdict, a parent's override of a verdict, the parent's corrected transcription of the child's own question and answer, a release instant and a 200-character intro. `app.current_child_id()` re-derives the child from the JWT and returns null unless the session, device, profile and family are all live (`0001_core_identity.sql:349`). **Caveat on how this is enforced:** `supabase/tests/schema_invariants.test.ts` asserts RLS on every `public` table, that no client role holds anything in `private`, and that `pl_child` holds no *write* privilege — it does **not** assert the exhaustive `pl_child` SELECT column set, so a new column grant to `pl_child` would not fail the build. A contractor adding one must check it by hand | **Any answer key or solution** — those live in `private.question_solutions` with no `pl_child` grant and `parent_assignment_solutions()` revoked from `pl_child` (`0100_learning.sql:434`). Also: a sibling's or another family's rows, any parent screen, any purchase, any promotion or donation control, any commercial placement |
| **Owner admin** | Supabase Auth **plus** an `admin_users` row with `role = 'owner_admin'` and `revoked_at is null` **plus** an MFA (`aal2`) claim on the live session. A table row alone is not enough (`app.is_owner_admin()`, `0001_core_identity.sql:388`) | Aggregate operations: promo templates, campaigns and codes, schools and donation payouts, monetization approvals/sponsors/creatives/kill switches, revenue imports, support cases, readiness, exact (unsuppressed) school figures. **Plus** ten family-row policies, enumerated at this commit: `audit_events` (`0001_core_identity.sql:522`), three billing tables — `family_entitlements`, `family_capacity`, `billing_periods` (`0200_billing.sql:311`, `:314`, `:323`) — five promotion/donation family tables (`0300_promotions_schools.sql:450`, `:453`, `:468`, `:470`, `:473`) and `deletion_requests` (`0600_operations.sql:293`). Over those ten **this is a real residual**: MFA, least privilege and the append-only `audit_events` table are the only controls over it. **Correction, 2026-10-19 (BUG-439): an earlier draft of this row said *eleven* and counted `safety_reports` (`0600_operations.sql:303`) among them, calling a child's own 500-character report note (`0600_operations.sql:185`) a residual an owner admin can read through RLS. That is backwards — BUG-426's shape.** `0670_privacy_hardening.sql:13` **drops** that policy and recreates it as `app.is_family_member(family_id)` alone, for the stated reason that "an owner admin no longer reads every family's reports (including parents' free-text notes) through RLS"; `0760_safety_screening.sql:185` drops it again and narrows it to `app.is_family_member(family_id) and family_visible`. The admin queue is served by the API with the service role after the `aal2` owner check and selects ids, category, status and timestamps only — never homework text, child nicknames or the note (`apps/api/src/routes/privacy.ts:1138`, column list at `:1127`, reason at `:1157-1160`) | **Homework, graded answers and any solution.** Child content is *not* reachable: `assignments`, `source_pages`, `extracted_questions`, `question_results`, `child_feedback`, `attempts`, `attempt_overrides`, `target_answer_attempts`, `practice_sets` and `practice_items` carry `app.is_family_member(family_id)` with **no** `or app.is_owner_admin()` disjunct (`0100_learning.sql:517-536`); the single `is_owner_admin()` policy in that migration is on `question_templates`, the bank, not on a child's work (`:537-538`). `private.question_solutions` is doubly out of reach — `authenticated` holds no `usage` on the `private` schema (`0001_core_identity.sql:14-15`) and `public.parent_assignment_solutions()` requires `app.is_family_member()` of the assignment's own family plus a recent unlock inside the function (`0100_learning.sql:386`, `:389`). A family's **safety reports** are likewise out of RLS reach (`0670_privacy_hardening.sql:13`, re-narrowed by `0760_safety_screening.sql:185`); the owner's queue reaches them only through the API's service-role query, which never selects the note or any homework text. The spec's "no casual browsing of child content" is therefore enforced by RLS for homework and for safety reports, and by audit only for billing, promotions and deletions |
| **School viewer** | **Nothing today.** `public.school_admins`, `app.is_school_admin(uuid)` and the suppressed reporting functions `public.school_month_report` / `school_month_report_counts` exist (table at `0300_promotions_schools.sql:32`, predicate at `:344`, RLS at `:415` and `:446`, report functions in `0690`, `0730`, `0740`), and RLS grants a school admin read of their own school row. There is **no API route, no screen and no production writer for `school_admins` anywhere in the tree** — re-verified at this commit by grepping `apps/`, `packages/`, `scripts/` and `supabase/`: the name occurs in that one migration and in four files under `supabase/tests/`, which hold the only `insert` statements (`school_report.test.ts:20`, `promotions_schools.test.ts:428`, `school_report_accuracy.test.ts:34`, `lead-billing-p17.review.test.ts:28`). **There is no seed file at all** — `supabase/` contains `migrations`, `scripts`, `tests` and nothing named `seed`, so no fixture path populates the role either. The only caller of the report functions is the owner-admin route `GET /v1/admin/schools/:id/report` (`apps/api/src/routes/admin-promotions.ts:526`, calling at `:542` and `:561`). So the authorization path a school viewer would use is tested, and the way a school viewer would come to exist is not built | By design, authorized **aggregates only** for their own school and month: attributed signups, donation-eligible families, accrued and paid cents — with complementary suppression so a group of 1–4 families can never be derived (BUG-022, BUG-027, BUG-072, BUG-074) | Family or student identity, homework, child data, codes, payment credentials, any other school |
| **Support** | **Role name only.** `admin_users.role` accepts `'support'` (`0001_core_identity.sql:382`) and nothing reads it: there is no `app.is_support_staff()` and no `requireSupportStaff` gate. Owner decision 2026-09-25 (owner action #31): the owner works the support queue from `/admin/support` as `owner_admin` with `aal2`; no support-staff role exists or is needed now | — | — |

Not a role: `service_role`. The API acts as the service role for its own writes after its own checks
(`db.asService`), and client roles never hold that grant. `anon` can execute nothing in `app`
(BUG-002) and holds no TRUNCATE/TRIGGER on `public` (BUG-207, migrations 0860/0910/0940).

---

## 3. End-to-end user flows

Route = API path (`apps/api/src/routes/*.ts`). Screen = web page (`apps/web/src/routes.tsx`) or
Expo route (`apps/mobile/app/`).

### 3.1 Parent sign-up and family creation

1. Public landing → pricing → sign-up (`/`, `/pricing`, `/sign-up`; `pages/public/*`,
   `pages/auth/SignUpPage.tsx`). On mobile, `(parent)/sign-in.tsx`.
2. Supabase Auth email + password, with email verification, password reset
   (`/reset-password`, `/update-password`) and optional MFA. A magic-link or reset email opened in a
   different browser gets an explanation rather than a dead end (BUG-148).
3. `POST /v1/families` creates the family with a display name and an **IANA** time zone; the zone
   must be one the scheduler can use (`'localtime'`, `'Factory'` and friends are refused, BUG-141).
   `PATCH /v1/family` corrects both afterwards (BUG-181).
4. The parent sets a 6-digit PIN (`PUT /v1/adult/pin`) and unlocks with
   `POST /v1/adult/unlock`; `POST /v1/adult/lock` ends the step-up. Screens: `/app/security`,
   `/app/security/reset-pin`, mobile `(parent)/unlock.tsx`.
5. A second adult: `POST /v1/guardians/invitations` → emailed link → `POST /v1/invitations/accept`
   (screen `/app/guardians`). Removal (`DELETE /v1/guardians/:userId`) invalidates access and any
   pending privileged action immediately, including unexpired pairing codes the removed adult
   issued (BUG-041).

### 3.2 Adult identity verification

This is the gate in front of children, payment and pairing codes.

1. Screen `/app/identity` (web) or `(parent)/identity.tsx` (mobile). `GET /v1/identity/verification`
   reports whether the adult may proceed and on what evidence.
2. `POST /v1/identity/verification` takes photographs of a government photo ID plus the adult's
   stated date of birth and their affirmation of `IDENTITY_ATTESTATION_STATEMENT`.
3. The provider answers only two questions — is this a government ID, and does its date of birth
   make an adult — and the stated date of birth is checked against the document (`DOB_MISMATCH`).
   `adult_declared` is a **generated** column: the route cannot assert it
   (`supabase/migrations/0990_adult_identity_declaration.sql`).
4. No image and nothing read off the document is stored; `images_discarded_at` is NOT NULL.
5. On success a `verified` `consent_records` row is written in the same transaction (migration 0980),
   which every existing child-data gate already reads. `public.adult_identity_basis` records which
   of the two standards each adult met.
6. The stronger standard — the same document checks **plus a face comparison** — exists in
   `identity_verifications` (migration 0980) and is **unreachable**: no contractable provider will
   perform the biometric comparison. **TENTATIVE: turning it on requires owner action #47 and only
   if counsel answers #48 the strict way.**

**The residual is stated in `supabase/migrations/0990_adult_identity_declaration.sql`'s header**:
reading a licence is not 16 CFR 312.5(b)(2)(v)'s check against *databases* of such information, and
anyone holding an adult's licence passes the document half. Two things narrow it and neither closes
it — the submitter's stated date of birth is checked against the document, and the declaration
carries the legal consequence of a false statement. **UNDECIDED** whether this clears COPPA at all —
owner action #48.

> **Previously-reported divergence, now closed — do not act on it.** An earlier draft of this page
> said that the migration header and owner actions #47 and #48 cite `docs/Threat_Model.md` **T41**
> but that no such row existed, the highest id being T38. That was true for about three weeks and is
> **not true at this commit**: T41 is present at [`docs/Threat_Model.md`](./Threat_Model.md) line 67,
> added in this commit under BUG-435 along with T39 and T40, and the threat model now has 41 rows.
> `scripts/check-doc-references.mjs` re-checks every threat citation against the rows, so this class
> of gap now fails the gate rather than waiting for a reader. Nothing needs adding or correcting.

### 3.3 Adding a child and pairing a device

1. `POST /v1/children` creates a **draft** profile: nickname, grade (0–8), age band
   (`5-7` / `8-10` / `11-13`), subjects, optional notes. A draft costs nothing. Cap 12 profiles per
   family (`apps/api/src/routes/family.ts:28`), enforced in the database too (migration 0860) so the
   Supabase Data API cannot add a 13th.
2. The per-child **parental attestation** is stamped server-side with its version and the adult who
   made it (migration 0970, two CHECK constraints: the three columns move together, and
   `status <> 'active'` unless `attested_at` is set). A child cannot be activated without it,
   whichever writer makes the row.
3. `POST /v1/children/:childId/activate` assigns a **paid slot**. If an unused slot exists this
   needs no purchase; otherwise the parent goes through §3.9 first. Screen `/app/children`, mobile
   `(parent)/children.tsx`.
4. `POST /v1/children/:childId/pairing-code` issues an 8-character single-use code, 600 s TTL,
   bound to that one child. On web the call is made from `/app/children`
   (`apps/web/src/pages/app/ChildrenPage.tsx:327`), **not** from `/app/devices` — that page only
   lists and unpairs (`GET /v1/devices`, `POST /v1/devices/:deviceId/revoke`, step 6). On mobile it
   is `(parent)/pair-device.tsx`.
5. On the child's device: `app/pair.tsx` → `POST /v1/child/pair` → a `pl_child` session.
   `GET /v1/child/me`, `POST /v1/child/refresh` (rotating; a replayed refresh token revokes the
   session), `POST /v1/child/logout`.
6. `GET /v1/devices` and `POST /v1/devices/:deviceId/revoke` list and unpair. A device the parent
   disconnected can take a new code at once (BUG-126); a device that signed itself out no longer
   reads "Connected" (BUG-172, BUG-213).
7. `POST /v1/children/:childId/archive` retires a profile. Parent-readable history, exports and
   reward records survive (BUG-070).

> **Spec divergence, recorded as BUG-437 and threat T39.** Spec P3 says "A child PIN
> selects/unlocks that child on an already paired device". There is **no child PIN**. The table
> `private.child_pins (child_id, pin_hash, …)` exists at `0001_core_identity.sql:290` and the only
> statements that touch it anywhere in the tree are three `delete` lines in the purge functions
> (`0620_deletion_purge.sql:213`, `0710_jobs_hardening.sql:501`, `0820_support_cases_purge.sql:119`)
> plus one DB test that asserts a child cannot *read* it (`supabase/tests/core_identity.test.ts:362`).
> Nothing writes a hash, nothing verifies one, there is no route and no screen — the table is
> guarded and unused. A device is bound to
> **one child** by the pairing code it redeemed, and the way to put a second child on the same tablet
> is a second pairing code and a second session (which is supported — `POST /v1/child/logout` only
> marks the device revoked when no other live session remains on it, BUG-172). The practical
> consequence for a shared family tablet is that switching children means re-pairing, not entering a
> PIN. **TENTATIVE: building the PIN selector is unstarted work; the schema is the only part that
> exists, and it is dead until something writes to it.**

### 3.4 Photographing homework through to a graded result

1. `GET /v1/assignments/limits` returns the live limits **before** the camera opens: default 10 pages
   per scan, 15 MiB per page, 15 MiB per scan in total
   (`packages/contracts/src/homework.ts:31`, `:52`). Configured limits may only tighten the database
   ceilings (`apps/api/src/routes/homework.ts:87`).
2. `POST /v1/assignments` (draft) → `POST /v1/assignments/:id/uploads` returns signed storage URLs;
   bytes go to private object storage, never through the API body. `POST /v1/assignments/:id/cancel`
   stops it; `POST /v1/assignments/:id/finalize` commits. Screens: `/app/homework`,
   mobile `(child)/scan.tsx`.
3. Validation before anything is decoded or sent: declared type vs real signature, byte size, page
   count, pixel bounds (10,000 px/side, 60 MP), JPEG/PNG frame structure. Finalize compares each
   stored page's measured size **and sha256** with its registration (BUG-078, BUG-088).
4. Exif, GPS, XMP, IPTC and comment data are stripped by an allow-list walk before any model call
   (`apps/api/src/services/image-metadata.ts`, BUG-013, BUG-059, BUG-201).
5. A durable job (`scan_process`) runs the state machine
   `draft → uploading → queued → extracting → checking → verifying → ready`, with explicit
   `needs_rescan`, `needs_parent_review`, `failed_retryable`, `failed_final`, `cancelled`, `deleted`
   (`packages/contracts/src/homework.ts:129`). Every operation carries a client idempotency key.
6. Deterministic checking first — rational arithmetic, unit conversion, safe parsers, never `eval`.
   AI semantic grading for open responses; **rubric feedback, never a forced right/wrong, for
   subjective writing** (BUG-075, BUG-091).
7. The child sees `GET /v1/child/assignments/:id`: their own submitted answer, a verdict, and
   method-level coaching. The private solution is a separate table reached only by
   `GET /v1/assignments/:id/solutions` **after a recent parent unlock**.
8. The parent can correct a transcription (`POST /v1/questions/:id/correction`) or override a verdict
   (`POST /v1/questions/:id/override`). Both are audited, recompute affected skill evidence, and
   clear coaching written for the superseded verdict (BUG-099); an override does not claw back
   earned rewards unfairly.

### 3.5 Daily practice and the Thursday review

* Daily: available **every local day including weekends**, from a parent-selected local time
  (default 15:30, `packages/domain/src/scheduling/daily.ts:18`). Default 5 questions, configurable
  3–10 (`packages/domain/src/learning/daily-set.ts:19`). Mix 60% recent weak skills / 20% spaced
  review / 20% confidence (`DAILY_MIX_PERCENT`, same file:22). Pause, vacation dates and subject
  exclusions are supported and **never expire earned points or penalise a missed day**
  (`DAILY_PRACTICE_POINTS_POLICY`). Child routes: `GET /v1/child/practice/today`,
  `POST /v1/child/practice/items/:itemId/answer`; screen `(child)/practice.tsx`.
* Thursday review: default ISO weekday 4 at 16:00 in the **family's IANA zone**, with DST handled
  (`packages/domain/src/scheduling/review.ts:25-26`). Parent-adjustable day, time and per-subject test
  dates and skip weeks; a Friday test-date change reschedules that subject. Idempotency key
  `(child, subject, review_week, schedule_version)`. Durable jobs run with the app closed; a tick
  racing a schedule change no longer cancels the new job (BUG-051), and DST no longer skips a week
  (BUG-052). Child: `GET /v1/child/reviews/current`, screen `(child)/review.tsx`. Parent planner:
  `/app/learning`, mobile `(parent)/planner.tsx`, with `GET /v1/children/:childId/learning-schedule`,
  `/test-dates`, `/study-materials`, `/skills`, `/practice-sets`.
* Answer keys: `GET /v1/practice-sets/:id/answer-key` and `POST /v1/exports/answer-key` require a
  recent unlock and are a **distinct protected route**. `POST /v1/exports/review-pdf` produces the
  child's questions-only PDF; no parameter switches a key into it.

### 3.6 Rewards

1. Parent defines rewards (`POST /v1/rewards`, `PATCH /v1/rewards/:id`) with a point target,
   optional image and instructions — "$5 paid outside the app", a book, an outing. Screen
   `/app/rewards`, mobile `(parent)/rewards.tsx`.
2. Earning rules are per-family and visible: `GET /PUT /v1/reward-rules`. Defaults 2 points for a
   meaningful attempt, +3 for an independently correct response, 5 for completing a set
   (`packages/domain/src/rewards/rules.ts:19`). Caps: one award per unique question instance
   (configurable only to 1), one per set, ≤100 points per rule, and a minimum response time of
   1,500 ms configurable only within 500 ms–60 s so the anti-farm floor cannot be configured away.
3. Child requests (`POST /v1/child/rewards/:rewardId/request`, screen `(child)/rewards.tsx`); points
   are atomically reserved; parent approves, declines or marks fulfilled
   (`POST /v1/reward-requests/:id/decision`); the child may cancel
   (`POST /v1/child/reward-requests/:id/cancel`). States: pending, approved, fulfilled, declined,
   cancelled. Decline or cancel returns the reserve exactly once.
4. The ledger is append-only with unique idempotency constraints; a parent adjusts with a reason
   (`POST /v1/points/adjustments`) rather than editing a balance. `GET /v1/points/history` is
   cursor-paged (BUG-117).
5. **PencilLift transfers no money, sells no points, buys nothing and runs no wallet.** Fulfilment
   is a record of what the parent did.

### 3.7 The safety-flag path

Owner decision 2026-09-25 (owner action #24, migration
`0790_parent_flag_review.sql`): **the parent is the sole recipient of safety messages and the one who
acts; no flag is held from the family; PencilLift does not contact authorities.** The lead advised
against sending abuse, sexual-content and secrecy flags to a household that may contain the person
named (Threat_Model T34) and was overruled. **UNDECIDED: counsel must confirm this is lawful in the
launch states before launch.**

1. A deterministic screen runs over the child's words **before** the tutor model sees them — moved
   ahead of grading and verification precisely so a severe-risk answer is never sent (BUG-107).
   Provider moderation runs before generation on the child's text and after generation on
   child-facing output. Levels `none` / `sensitive_educational` / `severe`; severe categories
   `self_harm`, `abuse`, `violence`, `sexual`, `secrecy`, `personal_contact`, `companion_persona`,
   `diagnosis`, `ungrounded_topic` (`packages/domain/src/safety/types.ts`). Sensitive-but-educational
   topics (anatomy in science, war in history, "kill" in a food chain) never block tutoring.
2. A severe match on child text yields an age-appropriate safety template plus a **system report**;
   a severe match on model output yields a reviewed fallback, never the unchecked text.
3. The system report enqueues a `safety_flag_email` job: every active guardian is emailed, with **no
   homework text, no child name and no category** — only that something was flagged and where. The
   delivery is recorded so the family's list says truthfully whether an email was sent (BUG-204,
   BUG-226). A queued safety email is sent even if consent is withdrawn first (BUG-137).
4. A child can always ask for help themselves: `POST /v1/child/reports`, screen `(child)/help.tsx`.
5. The parent reads `GET /v1/safety-reports` (screen `/app/privacy`, mobile `(parent)/privacy.tsx`)
   and acts after a recent unlock with `PATCH /v1/safety-reports/:id`: `addressed` ("I've looked into
   this" — resolved, notice stays, no AI on that question) or `false_match` ("a false alarm" — notice
   hidden, question rechecked). The family-readable audit row never carries the category (BUG-202).
6. The owner-admin queue (`GET /PATCH /v1/admin/safety-reports`) remains as a support tool.

### 3.8 School referrals, donations and monthly promotions (P17)

Parent side — screen `/app/school`, mobile `(parent)/school.tsx`:

1. `GET /v1/schools` lists active schools; `PUT /v1/family/school` designates **one** school.
   A change takes effect for donations at the start of the next program calendar month; the current
   month's designation and ledger are preserved. Choosing the current school while a change is
   pending cancels the pending change (BUG-005).
2. `POST /v1/family/promotions/quote` shows the exact target billing period, discounted amount,
   regular renewal amount and next billing date **before** confirmation.
   `POST /v1/family/promotions/redeem` reserves atomically;
   `POST /v1/family/promotions/:id/submitted` records the store hand-off — **this one is reachable
   from the mobile app only** (`apps/mobile/src/billing/offer-step.ts:86`, driven from
   `apps/mobile/app/(parent)/school.tsx`); the web page `/app/school` quotes, redeems and lists but
   never calls `/submitted`, because the store hand-off it precedes happens in the app;
   `GET /v1/family/promotions` lists status. Redemption state machine: `reserved`,
   `provider_pending`, `confirmed`, `rejected`, `expired`, `reconciled`
   (`packages/domain/src/promotions/redemption-state.ts`). An ambiguous in-flight reservation is not
   released until provider reconciliation decides.

Owner side — screens `/admin/promotions`, `/admin/schools`:

3. `GET /POST /PATCH /v1/admin/promo-templates`, `POST .../activate`: school scope, exact
   percentage, eligible tiers, subscriber eligibility, redemption cap, budget cap, calendar time zone
   and validity window. Drafts default to UTC calendar months and the selected zone is visible
   before activation.
4. `GET /v1/admin/promo-generation/preview`, `POST .../run`: idempotent monthly generation keyed on
   `(template, month)`. Codes are cryptographically unpredictable and globally unique. Concurrent
   workers and retries create no duplicate campaign or code.
5. `PUT /v1/admin/campaigns/:id/offer-mappings` records each channel × tier provider offer as
   `pending`, `ready`, `unsupported` or `failed` — with a required reason for the last two. A code is
   never advertised as usable on a channel whose mapping is not `ready`; the parent sees
   `CHANNEL_UNAVAILABLE`. `POST /v1/admin/campaigns/:id/action` pauses, resumes or revokes.
6. `GET /v1/admin/schools/:id/report` returns the month's aggregates (suppressed unless the caller is
   owner admin). `POST /v1/admin/payouts/prepare` → `/approve` → `/mark-paid` with statuses accrued,
   approved, paid, failed, adjusted, an external transfer reference, and no duplicate submission.
   **Transfers stay disabled until owner action #12 supplies verified recipient details.**

### 3.9 Subscription and capacity changes

1. `GET /v1/billing/status` shows the verified paid slot count, assigned profiles, pending changes
   and the managing store. Screen `/app/subscription`, mobile `(parent)/plan.tsx`. The web screen is
   **read-only plus `POST /v1/billing/sync`**: it tells the parent to choose or change a plan in the
   PencilLift app (`apps/web/src/pages/app/SubscriptionPage.tsx:102`, `:286`).
2. `POST /v1/billing/capacity-changes` is **called from the mobile app only**
   (`apps/mobile/src/billing/actions.ts:88`); the string does not occur anywhere under
   `apps/web/src`. A contractor costing "change the plan from the portal" is costing new work, not
   a wiring fix. It requires a **recent parent reauthentication** and refuses
   before opening any store if the verified store price for the target tier differs from the approved
   table (BUG-047, BUG-065). Child mode cannot start a purchase.
3. The store confirms; `/webhooks/revenuecat` and `/webhooks/stripe` reconcile. Webhook authenticity
   is checked per provider's real mechanism, event ids are deduplicated, out-of-order events
   reconcile to current provider state, and sandbox transactions are never booked as production
   billing (BUG-017). `POST /v1/billing/sync` is the manual pull.
4. Downgrades take effect on the provider-confirmed date; the parent chooses which profiles stay
   active. Released children are set `draft` and **lose paid AI without losing history** (BUG-046,
   BUG-093). Deleting or archiving a profile never claims store cancellation or a lower renewal.
5. Support: `GET /v1/support/policy`, `/billing-periods`, `GET /POST /v1/support/cases`,
   `POST /v1/support/cases/:id/messages` (screen `/app/support`); owner side `/admin/support`,
   `/admin/revenue`. Store refunds are issued by Apple/Google/Amazon and only reflected; a Stripe
   refund is issued in Stripe and recorded on the case with its reference.

### 3.10 Export, deletion and account closure

1. `POST /v1/exports` builds a private family export; `GET /v1/exports` lists;
   `GET /v1/exports/:id/download` returns a signed URL valid **60 s**
   (`apps/api/src/routes/export-download.ts:8`), replaceable without a page reload (BUG-178).
   Whole-family export requires step-up (BUG-060). The export contains the child's answers,
   feedback, reward requests and profile notes (BUG-203).
2. `POST /v1/deletion` (child scope or family scope; **family scope is owner-only**) archives
   immediately, signs out affected devices, cancels queued work and enqueues an idempotent purge.
   `GET /v1/deletion` reports progress. A pending job cannot recreate deleted data after a race
   (BUG-053). Screens `/app/privacy` and the public `/account-deletion`.
3. `POST /v1/consent/withdraw` stops the child's use of PencilLift, not merely the record
   (BUG-136), and settles the scans whose jobs it cancels (BUG-187).
4. `POST /v1/account/close` closes an adult's sign-in. For a family owner it runs after the family
   purge (`after_family_purge`); for a guardian it only revokes their membership
   (`packages/contracts/src/account.ts`).
5. Retention: raw homework scans 30 days by default, active-store deletion target 30 days
   (`PRIVACY_RETENTION`, `packages/contracts/src/privacy.ts:14`); inactivity 12 months idle with a
   30-day notice (`INACTIVITY_MONTHS` 12, `INACTIVITY_NOTICE_DAYS` 30, `apps/api/src/config.ts:253`;
   migration 0680 refuses deletion without a recorded notice). See
   [`docs/Data_Retention_And_ZDR.md`](./Data_Retention_And_ZDR.md) for the full table — it is the
   authority and this page does not duplicate it. **UNDECIDED: the inactivity policy itself is owner
   action #13.**

---

## 4. Business rules enforced in code

| Rule | Enforced in |
|---|---|
| Price = `3999 + 999 × (slots − 1)` cents, integer, slots 1..4. There is no separate family account fee, and no subscription means no recurring charge. The tier ceiling is a named constant (`DEFAULT_MAX_PAID_SLOTS = 4`) so later expansion is a configuration change, not a rewrite; `isRegularTierPrice()` is the single predicate the donation rule and the store-price gate both ask | `packages/domain/src/pricing/index.ts:5` |
| A tier whose verified store price ≠ the approved price blocks activation, never rounds silently | `apps/api/src/routes/billing.ts`; BUG-047, BUG-065 |
| Non-USD charges are recorded with their currency, excluded from USD revenue sums and from donation eligibility, and audited as `billing.unexpected_currency` | `packages/domain/src/shared/billing.ts:38`; BUG-135 |
| Promo discount is a **whole** percentage 5..100; charged = round-half-up(regular × (100 − pct) / 100); 100% charges 0 | `packages/domain/src/promotions/discount.ts:5` |
| One monthly billing period per confirmed redemption; one discount per family billing period; at most one pending next-period promotion; one redemption per family per campaign; per-code and per-campaign caps; budget cap | `packages/domain/src/promotions/redemption.ts:201-335`; partial unique indexes `promo_redemptions_once_per_campaign`, `one_per_period`, `one_in_flight` (migration 0300) |
| Fresh codes each month; **no lifetime one-promo limit and no carry-forward**; without a new confirmed code the next period is regular price | same, plus `packages/domain/src/promotions/scenarios.test.ts` |
| An existing subscriber must redeem on the channel managing the subscription (`CHANNEL_MISMATCH`); a school-scoped code refuses only families designated elsewhere, never overwrites a designation | `redemption.ts:238`, `:277` |
| Redemption is parent-only and step-up-gated (`CHILD_MODE_FORBIDDEN`, `STEP_UP_REQUIRED`) | `redemption.ts:201` |
| School donation = exactly **100 cents** per eligible family per calendar month, policy `full_price_only`; any discount 5–100%, promotional credit, intro offer, proration/add-on/tax-only invoice, unsettled or refunded period, non-USD charge, or missing/inactive school designation yields $0 | `packages/domain/src/donations/eligibility.ts:22` (`DONATION_INELIGIBLE_REASONS`) |
| One active designated school per family; one donation per family/month; a school change applies from the next program month; refunds/chargebacks create append-only adjustments (−100 once, +100 reinstatement once, terminal final reversal), never a deleted ledger row | `packages/domain/src/donations/adjustments.ts:70`; migration 0300 exclusion + unique family/month keys |
| Late settlement accrues to the **original** program month, not the run month | BUG-073 |
| There is exactly one donation policy and deliberately no permissive variant: `DONATION_POLICY = 'full_price_only'`, with the rule text version (`DONATION_RULES_VERSION = 'p17-f7-full-price-only-v2'`) stamped into every eligibility snapshot so an audit knows which wording produced it. The spec forbids an administrator toggle that would allow donations on discounted periods, and none exists | `packages/domain/src/donations/eligibility.ts:25-31` |
| Grade reach: no subject serves content further than **2 grades** from the child's grade; prerequisite work is deliberately uncapped | `packages/domain/src/bank/generate.ts:198` (`SUBJECT_GRADE_REACH = 2`, asserted literally by a test) |
| Launch scope K–8 and under-13: grade 0..8, age bands `5-7`/`8-10`/`11-13` only | `packages/contracts/src/family.ts:379-386`; BUG-120 |
| Capture limits: 10 pages/scan, 15 MiB/page, 15 MiB/scan; DB ceilings 50 pages / 15 MiB are only tightenable | `packages/contracts/src/homework.ts:30` (`:52` for the per-scan total); `apps/api/src/routes/homework.ts:87`, `:91` |
| Per-child generation allowance: **proposed pilot** 40 homework pages per paid child per billing period; append-only reservation ledger so archiving, removing or reassigning a profile cannot reset usage; an unreadable or permanently failed scan releases its reservation | `packages/domain/src/quotas/allowance.ts:23`; `packages/contracts/src/homework.ts:120`; BUG-056, BUG-100. **TENTATIVE: not an owner-approved advertised limit and not a measured cost — do not show it as a plan feature** |
| None of the three limits above, nor the 3-attempt retry cap, is environment-configurable: there is **no env var** for `maxPages`, `maxPageBytes` or the allowance in `apps/api/src/config.ts`, `apps/api/wrangler.toml` sets only `APP_ENV` and `PROGRAM_TIMEZONE` in every environment block, and `apps/api/.dev.vars.example` holds one line (`APP_ENV=development`). `homeworkRoutes()` is registered with no overrides, so `DEFAULT_HOMEWORK_CONFIG` — the contract defaults — is what runs. Changing a limit is a code change and a redeploy | `apps/api/src/app.ts:159`; `apps/api/src/routes/homework.ts:90-95`, `:680`; `packages/domain/src/learning/retry.ts:14` (`MAX_ALLOWED_TARGET_ATTEMPTS = 3`, a hard ceiling no config can raise) |
| Spend ceiling: an AI stage is admitted only when committed + in-flight holds + this request's upper-bound estimate ≤ the owner's explicitly configured budget. `null` budget is refused — no default budget is ever invented. Alerts fire at 50/80/100% of the configured budget — **TENTATIVE: the three percentages are the shipped default and the source labels them "proposed alert thresholds", not owner-approved; the budget figure itself is open decision #9** | `packages/domain/src/quotas/spend.ts:12` (`DEFAULT_ALERT_THRESHOLDS_PERCENT`); BUG-064, BUG-092, BUG-094, BUG-097 |
| Billed-but-failed attempts (timeout, network, 5xx) still count against caps; a usage-recording failure does not release the hold | BUG-095, BUG-158 |
| Model rates are a versioned server table stored with every metered operation | `packages/domain/src/quotas/rates.ts:30` |
| Target-answer attempts: 3 maximum, then method practice or parent help; the limit may be lowered to 1 but **never raised above 3** | `packages/domain/src/learning/retry.ts:9` |
| Mastery: fewer than 5 distinct independent attempts reads "Not enough evidence"; `needs_practice` below 0.6 weighted independent accuracy with independent errors on ≥2 instances; re-served questions do not count as new evidence | `packages/domain/src/learning/summary.ts:37`; BUG-051 |
| Reward earning caps and anti-farm floor (above, §3.6) | `packages/domain/src/rewards/rules.ts` |
| Retention windows: raw scans 30 d, deletion target 30 d, inactivity 12 months + 30-day notice, pairing-code/credential rows pruned after 30 d | `packages/contracts/src/privacy.ts:14`; `apps/api/src/config.ts:253`; `apps/api/src/auth/housekeeping.ts:29` |
| Monetization is off by default: four kill switches (`global`, `provider:sponsor_direct`, `provider:amazon_associates`, `provider:ad_network`) all seeded `false` | `supabase/migrations/0640_monetization.sql:372` |
| A commercial path needs switches on **and** a recorded approval matching provider, platform, property identifier and locale, approved, reviewed in the past, unexpired, with a real evidence reference — and for mobile Amazon, a recorded permitted-linking-tool reference. A boolean, an account key or a tag never passes | `packages/domain/src/monetization/gates.ts:11` |
| No points, cashback, scan allowance or discount may be triggered by an impression, click or affiliate purchase | `packages/domain/src/monetization/*`; AC_MON_13 |
| Every `public` table has RLS; a new one without it fails the build | `supabase/tests/schema_invariants.test.ts` |

---

## 5. Edge cases already considered

Mined from [`docs/Bug_Ledger.md`](./Bug_Ledger.md), which records seven adversarial hunt-and-fix
rounds. The ledger row count, how many are still open and what each closed fix left behind are
derived in [`docs/Open_Work.md`](./Open_Work.md) — read it there rather than from a number copied
into this page (an earlier draft said "349+", which was stale). Each line below is the **rule that
now holds**, with the defect that produced it.

**Money and billing**

* A paying family always gets its capacity: the subscription key includes the family's opaque billing
  ref, and the upsert throws when nothing was written so the provider retries, instead of silently
  granting 0 slots (BUG-006).
* A store price that differs from the approved table blocks the sale rather than showing a notice
  (BUG-047), and a capacity change is refused **before** any store sheet opens (BUG-065).
* Sandbox/TestFlight transactions are never booked as production billing or accrued as donations;
  production requires `PRODUCTION` (BUG-017).
* A refund arriving **before** its charge event is parked in `pending_refunds` and applied when the
  period is recorded, so no $1 accrues for a refunded month (BUG-016).
* A Stripe dispute references a charge, never an invoice, so charges and disputes resolve through the
  API to the recorded period; a won dispute reinstates once (BUG-019, BUG-131).
* A partial refund is recorded as partial with its real amount (BUG-020).
* A renewal invoice that lists proration lines first keeps its coupon: the period and price come from
  the non-proration subscription line with the latest start (BUG-021).
* A family tombstoned mid-webhook gets no entitlements, capacity or periods written — the ledger
  transaction locks the family row and aborts (BUG-023).
* Churn is a fraction of paying **families**, not of ledger rows, so an upgrade is not a churn event
  (BUG-189); a deleted account leaves the owner's subscription figures (BUG-190).
* A billing-retry state blocks a parallel purchase (BUG-048). Auto-renew turned back on is observed
  at the next sync (BUG-132). The stale-entitlement sweep reaches refunded families (BUG-133).
* Full-price donation eligibility is decided on the subscription charge **net of sales tax**, not on
  Stripe's `amount_paid`, which carries it: `subscriptionChargeCents()` prefers the subscription
  line's own amount, then `total_excluding_tax`, then subtotal less invoice-level discounts, and only
  then `amount_paid` minus tax (BUG-192; later bounded by money actually collected when a credit
  balance settles part of the invoice, BUG-233).
* A payout batch nets only reversals of the accruals it pays (BUG-193).

**Promotions and schools**

* A lapsed family's code confirms against the first charge-bearing period after the lapse, whether
  the store calls it a purchase or a renewal (BUG-014).
* A `provider_pending` redemption whose target renewal never happens is rejected from
  provider-derived facts rather than blocking the family for good and leaking a cap slot (BUG-015).
* A store-side promo redeemed outside the app (an App Store URL) arrives as a discounted renewal with
  no PencilLift redemption; it is recorded as `promo.unmatched_discount` for owner review instead of
  being ignored — caps and budgets would otherwise under-count (BUG-010).
* A school can never derive a group of 1–4 families, including by subtracting amounts from counts
  ($1/family makes amounts into counts) — complementary suppression over both (BUG-022, BUG-027,
  BUG-072), and the report time zone is **pinned server-side** rather than caller-chosen (BUG-074).
* A webhook body that cannot be parsed is visible to the owner and the provider's retry is processed
  after a fix (BUG-194). No external provider request can hold the scheduled tick — all have
  timeouts (BUG-195).

**Child isolation and the answer key**

* Hints never carry the answer in **any** form: not literally, not as an expression ("The answer is
  6 × 7"), not spelled in words, not zero-padded past 40 digits, not in non-strict UTF-8/UTF-16, not
  as `\cfrac`, `{,}`, an index-form multiple-choice key, an acrostic, a short link, non-ASCII digits
  or an ideographic dot (BUG-037, BUG-038, BUG-039, BUG-055, BUG-076, BUG-098).
* Restating the problem is not an answer: `35 ÷ 5` for `35 ÷ 5 =` is `UNEVALUATED_EXPRESSION`, not
  "correct" — in the domain and in the scan pipeline (BUG-025, BUG-061).
* Rubric labels on written work are answer-guarded and fail closed; the child never receives
  model-written text to copy (BUG-075, BUG-091).
* A removed guardian's unexpired pairing code mints nothing (BUG-041). A child whose deletion is
  pending cannot be re-activated or paired (BUG-182).
* Parent data never survives into child mode: the mobile approvals screen is gated by
  `useParentAccess()` and parent token sources refuse in child mode (BUG-029); mode `parent` does not
  persist across a restart (BUG-129); leaving the app or tapping "Lock parent area" closes the parent
  area on the device, not only the server step-up (BUG-165); the back arrow and Android/Fire Back
  re-enter child mode (BUG-169); the unlock screen hides Sign out and biometric controls from a child
  (BUG-168, BUG-217).
* One child device = one token source. Two independent refreshers on one device presented the same
  refresh token and the API correctly revoked the session; the duplicate refresher was deleted and a
  test fails if a second module constructs a child session (BUG-012, lesson L-007).
* Subjects, test dates, study materials and scans can only name a subject **of the same child**; the
  keys bound subjects to the family (BUG-153).

**Capture and processing**

* Duplicate upload/finalize events create one job and one quota charge; a lost finalize response
  returns the current state rather than failing forever (BUG-044, AC_CAPTURE_06).
* An unreadable or mismatched scan never consumes allowance, even if the release fails after the
  `needs_rescan` transition (BUG-100).
* Delete-and-re-add cannot reset the family's monthly pages — reservations survive the child
  (BUG-056).
* A scan refused at the spend ceiling costs nothing while it waits; it no longer re-downloads,
  re-hashes and re-strips every hour (BUG-199).
* An answer cut off at `max_output_tokens` is not re-sent unchanged ten times (BUG-197).
* At most one page's bytes live in JS memory at a time (BUG-124), and multi-page extraction no longer
  sends every page in one request (BUG-157).
* A child whose pages are too large together hears it in child words, before anything is sent
  (BUG-164); the two new endings `SCAN_TOO_MANY_QUESTIONS` and `AI_PAUSED_TOO_LONG` have parent and
  child copy (BUG-210).
* Every printed question is checked: "keep the first" under the unique
  `(assignment, page, question number)` constraint was silently dropping questions (BUG-205).
* Jobs claimed in a batch never run twice when earlier jobs outlast the lock; dead letters do not
  leave scans and reservations stuck (BUG-057); work enqueued inside the database is due by the
  **application's** clock (BUG-090).

**Learning and scheduling**

* With only 3–5 weekly weaknesses the Thursday review fills with prerequisites and current material
  and honours the teacher's test scope; a UTC day boundary no longer counts one evening as two
  sessions (BUG-035).
* A `−05:00` written with U+2212 no longer passes the fixed-offset rejection and shifts releases
  (BUG-040). DST no longer skips a review week (BUG-052).
* A subject with no bank content gets an honest empty section, never invented items (AC_LEARNING_05).
* Guessed-through sets do not earn completion; concurrent last answers do not leave sets open
  (BUG-052).
* Parents keep read access to an archived or downgraded child's history, exports and reward records
  (BUG-070) — while no paid AI runs for that child, including a queued recheck from a transcription
  correction (BUG-071, BUG-093).
* A parent's child-edit form no longer sends all three fields and silently reverts the other
  guardian's grade change (BUG-222).

**Privacy, deletion and safety**

* Location metadata never reaches the model (BUG-013); the strippers are allow-lists, not deny-lists,
  so vendor APPn carriers cannot pass GPS text through (BUG-059).
* A family or child deletion during a running scan stops the homework reaching the AI (BUG-053);
  exports are not orphaned by the purge, and late uploads under a still-valid signed URL are removed
  (BUG-054).
* `app.purge_family_data` deletes in an order that does not strand safety-report text (BUG-085);
  five failed purge attempts no longer abandon the closure (BUG-156).
* A child-scope deletion releases the child's paid slot, so activating a sibling does not tell the
  parent to buy capacity they already pay for (BUG-228).
* Inactivity notices are stamped only when an email was actually delivered, and paying families —
  including those in a store grace period — are never deleted (BUG-058).
* A moderation flag whose category PencilLift does not map still reaches the parent (BUG-186);
  **UNDECIDED** which category it should be filed under (owner action #42).
* A guardian or reviewer can clear a false alarm and the question is then rechecked (BUG-110,
  BUG-185). Every flag waiting on a grown-up is in the family's list — a flat `limit 100` was
  dropping older open ones (BUG-188).
* Public and in-app copy is derived from the enforcing code and copy-tested: the deletion page no
  longer tells parents to export first, no longer implies any parent can delete the family, and names
  retained consent/audit records (BUG-031); the privacy page promises only controls that exist
  (BUG-138, BUG-226); the planner no longer offers device reminders and quiet hours the app does not
  send (BUG-125); the deletion warning names **this build's** store (BUG-130).

**Accounts, sessions and clocks**

* Concurrent wrong PINs lock out and cannot clear a lock; one adult cannot own two families
  (BUG-060, BUG-043).
* A device clock more than 5 minutes fast no longer bounces every correct PIN (BUG-167), and a child
  keeps working while their pairing is valid regardless of device clock skew (BUG-166).
* A PIN reset does not drop an owner's `aal2` session (BUG-179, BUG-224).
* Sign-out exists and works on both surfaces, and a refused sign-out is not reported as success
  (BUG-121, BUG-173, BUG-219).
* `U+0000` in any free-text field is a 400, not a 500 (BUG-116); an implausible calendar date such as
  `0000-01-01` is a 400 (BUG-183).
* Every parent create route has a per-family limit, and rules the API enforced only in routes — the
  12-profile cap, grade and age-band bounds — are enforced in the **database** too, because the
  Supabase Data API is a second writer (BUG-119, BUG-208, lesson L-060).

**Accessibility and UX**

* White 16 px bold on `#008D87` was 4.07:1 and is fixed on web and mobile (BUG-145, BUG-163); the
  global focus ring is navy at 12.4:1, not gold at 1.63:1 (BUG-032).
* Every page sets a title and moves focus on a client-side navigation (BUG-177); route error
  boundaries exist so a stale chunk after a deploy does not blank the portal (BUG-144, BUG-171);
  every child screen has a way home and the hardware Back never discards captured pages (BUG-127).

---

## 6. The MVP boundary

### In the current build

Parent account, PIN/biometric step-up and device management; two guardians by verified invitation;
the adult identity declaration; draft/active/archived child profiles with per-child attestation;
pairing and child sessions; homework capture → extraction → deterministic and AI grading →
child-safe coaching and parent solutions; parent transcription correction and verdict override;
learning evidence and skill summaries; daily practice; Thursday reviews with per-subject test dates;
the original question bank across all six subjects K–8; points, rewards and the append-only ledger;
the safety screen, parent flag email and parent actions; school designation, monthly promo
generation and redemption, donation accrual/adjustment and payout batches; subscription status,
capacity changes and store webhook reconciliation; support cases and the owner-operations dashboard;
export, child- and family-scope deletion, consent withdrawal and account closure; the public
marketing/support/privacy/terms/deletion/contact pages; the owner admin console (promotions, schools,
monetization, support, revenue, readiness). Three storefront channels are modelled: App Store, Google
Play and Amazon Appstore.

### Explicitly out

| Out | Status in the tree |
|---|---|
| **Any deployment** | Nothing has ever run as a service; no native build exists; no real provider call has ever been made — every OpenAI, RevenueCat, Stripe, Supabase Storage, Resend and consent interaction has only met a labeled mock or a fake `fetch` ([`docs/Beta_Readiness.md`](./Beta_Readiness.md)) |
| **Production boot** | Blocked by the empty consent adapter registry (see the header) |
| **Push notifications** | No push stack at all. `expo-notifications` is neither a plugin nor a dependency, asserted by a test (`apps/mobile/src/app-config.test.ts:83`, `:295`; `apps/mobile/app.config.ts:265`). `public.notification_devices`, `private.push_tokens` and `public.notification_deliveries` are created in `0600_operations.sql:135`, `:150`, `:157` and purged in `0620_deletion_purge.sql:203-207`, and **nothing under `apps/api/src` or `apps/mobile/src` reads or writes the two device/token tables** — re-verified at this commit by grepping for `notification_devices`, `push_tokens`, `exp.host`, `expo.dev/--/api/v2/push`, `fcm.googleapis.com` and `api.push.apple.com`: zero non-test hits outside the migrations. The job registry holds `deletion_purge`, `safety_flag_email`, `export_build` and `account_close` plus the learning and scan handlers, and no sender (`apps/api/src/jobs/dispatcher.ts:687-692`, `apps/api/src/index.ts:513-530`). `packages/domain/src/scheduling/notifications.ts` models quiet hours and audiences with no sender; its `scheduleNotification` is re-exported from the scheduling barrel (`packages/domain/src/scheduling/index.ts:83-89`) and called only from two test files, never from the API or either app. The planner copy was corrected to stop promising reminders (BUG-125) |
| **Stripe web billing** | Adapter built, `OPTIONAL_STRIPE_WEB_BILLING_ENABLED` defaults false (`apps/api/src/config.ts:249`) |
| **Amazon Associates / affiliate links** | `amazon_associates` merchant mode implemented; the switch is seeded `false` and the gate additionally requires a recorded property approval and a permitted-linking-tool reference. `education_only` and `plain_link` are the available modes |
| **Third-party ad SDK / ad network** | No vendor, no SDK. An adapter boundary and a `provider:ad_network` switch (seeded false) only |
| **Sponsor cards in practice** | Implemented for the reauthenticated adult dashboard and adult Resources screen only, behind the kill switches. Never in child or unknown-role sessions, capture, explanations, practice, reviews, redemption, pushes or account flows |
| **Ad-free paid entitlement** | A `feature = 'ad_free'` row type exists (`0640_monetization.sql:446`); no sellable offer |
| **School-facing portal** | Data model, RLS and suppressed report functions only — no route, no screen, no way to create a `school_admins` row (§2) |
| **Support-staff role** | Role name accepted by a CHECK constraint; no predicate, no gate (owner decision #31) |
| **Child PIN to switch children on one device** | `private.child_pins` exists and is written by nothing; a device is bound to one child per pairing code (§3.3). Spec P3 asks for it |
| **HEIC and PDF capture** | Refused at registration with `FORMAT_NOT_SUPPORTED_YET`; the mobile picker no longer offers "Add a PDF" (BUG-068). The spec asks for both |
| **Grades 9–12 / age band 14-18** | Database CHECK allows grade ≤ 12 and the safety module knows the `14-18` band, but the contract caps grade at 8 and offers three bands only, so no profile can be declared outside under-13 scope (BUG-120) |
| **Above-grade work** | `SUBJECT_GRADE_REACH = 2` caps forward reach; there is no parent opt-in for harder work. Today the answer is no, silently (owner action #49) |
| **Face-match identity standard** | In the schema, unreachable (§3.2) |
| **Live video, human tutoring, school SIS integration, cash transfer, chance-based rewards, public leaderboards, cross-family comparison** | Not built, and the spec excludes all of them from this launch |

---

## 7. Planned / future functionality

Every item here is **TENTATIVE**: a design, a spec clause the code does not build, or a capability
waiting on an owner decision. None is a commitment.

* **TENTATIVE — Push notifications.** Spec P14 requires parent-opted-in device notifications with
  generic readiness text, quiet hours and child reminders only with parent permission. The timing
  domain exists; the delivery stack, token registration and the APNs/FCM/Expo Push setup do not.
  Expect this to be the largest single piece of absent spec surface.
* **TENTATIVE — Stripe web billing.** Adapter and entitlement reconciliation exist behind a flag.
  Turning it on brings storefront/region link-out rules, and it is entangled with the consent
  question (owner action #15: a card PencilLift charges itself is a different legal animal from an
  in-app purchase).
* **TENTATIVE — Amazon affiliate activation.** Requires Amazon's specific determination for this
  child-directed property plus a permitted-linking-tool determination (owner action #16). Until then
  `education_only`/`plain_link` keep the learning feature useful.
* **TENTATIVE — Sponsor campaigns and any ad network.** Needs owner-approved contracts, reviewed
  creatives, and per-platform policy evidence; a campaign approval can never override a platform
  gate.
* **TENTATIVE — A sellable ad-free offer.** Behaviour provable with fixtures today; the offer stays
  inactive.
* **TENTATIVE — School-facing portal.** The aggregates, suppression and RLS are built; a sign-in
  path, an invitation mechanism for school administrators and a screen are not.
* **TENTATIVE — Face-match adult verification.** Turning it on is contracting a vendor (owner action
  #47) and re-verifying only the adults `public.adult_identity_basis` names.
* **TENTATIVE — A child PIN for shared devices** (spec P3). The hash table is in the schema and
  nothing uses it; a PIN that only *selects* a child on an already paired device must not enumerate
  other families, must be hashed and rate-limited like the parent PIN, and must not become a second
  token source (lesson L-007). Until it exists, switching children on one tablet means a new pairing
  code. See the box in §3.3.
* **TENTATIVE — HEIC and PDF study-guide import**, including an isolated PDF page parser.
* **TENTATIVE — Grades 9–12 and a 14-18 age band**, which would move the product out of under-13
  consent scope and change the whole ZDR position.
* **TENTATIVE — A per-child parent opt-in for above-grade work** (owner action #49 describes exactly
  how it should be built if wanted: a deliberate per-child opt-in, not a widened default).
* **TENTATIVE — Luna vision route for cost reduction**, gated on comparative handwriting/diagram
  tests; Astra stays the child-teaching route until then (spec P12).
* **TENTATIVE — An owner console view for unmatched store discounts** (BUG-010's open follow-up) and
  per-family Apple codes, which would close the attribution gap entirely.
* **TENTATIVE — Measured economics.** Every number in [`docs/Cost_Analysis.md`](./Cost_Analysis.md)
  is a priced hypothesis from a rate table. The published allowance (40 pages/child/period), the
  per-stage caps and the viability case all need real measurement before any limit is advertised.

---

## 8. Open product decisions

From [`docs/Owner_Actions.md`](./Owner_Actions.md), restricted to product and commercial decisions —
account chores and verification steps (#3, #4, #5, #8, #11, #14, #17, #18, #19, #20, #21, #22, #23,
#33, #34, #35, #36, #37, #39, #40, #41, #43, #44) are excluded; read that page for them. Options are
reproduced as the record states them. **Every item here is UNDECIDED.**

| # | Decision | Options as recorded |
|---|---|---|
| 1 | **UNDECIDED — iOS prices for 2–4 children.** Apple's USD price points cannot represent $49.98, $59.97, $69.96 (nearest $49.49/$49.99/$50.00, $59.99/$60.00, $69.99/$70.00) | (a) accept nearest points on iOS only; (b) nearest points on iOS and exact totals on Google/web; (c) change the approved totals everywhere. **Knock-on:** the donation rule requires a charge exactly equal to the approved tier price, so under (a) or (b) no 2–4-child iOS family earns the $1 unless the owner also defines the iOS store price as that channel's regular price |
| 2 | **UNDECIDED — how iOS/Google monthly promos behave when a percentage is not representable.** Apple offers use price points, not percentages, and allow one redemption per customer per offer | Per-channel `unsupported` status with the smallest compliant alternatives listed in [`docs/Provider_Capability_Matrix.md`](./Provider_Capability_Matrix.md) §2–3 |
| 6 / 48 | **UNDECIDED — the consent and ZDR position, which decides whether the product may touch a child's homework at all.** #48 is one question to counsel: does sending homework to a ZDR-bound processor count as *disclosing* a child's personal information to a third party? | If **not** a disclosure: the internal-use standard applies and the owner's method (photo ID read for age + legal declaration) very likely clears 16 CFR 312.5(b)(2). If it **is**: the stricter list applies, reading a licence is not an approved method, and #47 (a face-match vendor) returns. Also to approve: the two statements `IDENTITY_ATTESTATION_STATEMENT` and `CONSENT_ATTESTATION_STATEMENT`, which ship as drafts |
| 7 | **UNDECIDED — verifiable-parental-consent vendor.** k-ID is the candidate; the supplied repository is its Agent Skills marketplace, not an SDK | Settle contract, DPA and per-verification pricing; one verification per **adult** rather than per child; what a **revoked** consent does; whether a second guardian owes their own attestation. Design and ranked methods: [`docs/design/Consent_Design.md`](./design/Consent_Design.md). Ask #15 first — a yes there removes the vendor entirely |
| 9 | **UNDECIDED — the authorized monthly AI spending cap**, and per-template campaign budget caps | No default is ever invented: with no configured budget every AI stage is refused (`spend.ts`, BUG-092) |
| 12 | **UNDECIDED — school payout mechanics**: recipient verification details and a transfer method | Transfers stay disabled until provided; accrual is not payment |
| 13 | **UNDECIDED — the inactivity retention policy.** Spec P4 proposes 12 months idle then a notice then deletion; the build uses 12 months with a 30-day notice | Approve as built, or set different periods |
| 15 | **UNDECIDED — legal review of the public pages and the operator identity**, plus the payment-as-consent question (see #48) | Legal review gates the **claim**, not the build: with the flag unset the pages ship a draft banner; claiming review without an effective date and a monitored mailbox fails the build |
| 16 | **UNDECIDED — whether P16 revenue is wanted at all**, and if so the Amazon Associates determination for this child-directed property, sponsor contracts and approved creatives | Monetization stays off until switches **and** approvals exist |
| 24 | **UNDECIDED — the child-safety package**, with an educator and counsel: the child safety messages and parent wording (`safety-templates.v4`, `safety-screen.v4`), the parent email on every flag (template status `draft_pending_owner_and_educator_approval`), the two parent actions, and runbook 5.1 | The 2026-09-25 decision stands (parent is sole recipient; no flag held; no authority contact). Counsel must confirm lawfulness in the launch states given mandated-reporting duties |
| 25 | **UNDECIDED — family read access while a report is held.** The child's own answer and their `safety` feedback row stay readable by family members through the Data API even while a report is held (parental review rights) | Accept or change |
| 27 | **UNDECIDED — the support path for parents who cannot tell a false alarm from a concern.** Recall-first screening escalates ordinary homework frustration ("I can't do this anymore") and a child's own body-safety lesson answers; under the 2026-09-25 decision all of these reach the parent | The owner-admin queue remains a support tool |
| 28 | **UNDECIDED — BUG-096.** Labelled answers are withheld, but an unlabelled insertion such as `(84)` or `= 84` that the extraction model puts into the printed prompt still reaches the child | (a) accept the residual, recorded as `deferred_by_owner`; (b) fund a fix — a second extraction pass, or showing the child only the photo |
| 30 | **UNDECIDED — the iOS icon variant and the dark splash** | `icon-ios-1024.png` (teal tile, white rocket; currently wired) or `icon-ios-light-1024.png` (white tile, full colour). The app is light-only today, so no dark splash is wired |
| 32 | **UNDECIDED — support policy and store fee rates** (both are admin settings): refund window in days, response-time target per case kind, whether partial refunds are granted (defaults 14 days; 24–72 h; yes), and per-channel store fee rates | Parents see the refund window on their support page and nothing else of the policy. Notice wording (`SUPPORT_INTAKE_NOTICE`, `SUPPORT_REFUND_NOTICE`) needs #24's reviewers |
| 38 | **UNDECIDED — store availability and currency policy.** The launch market is the US and every store charge is booked as USD cents | (a) restrict App Store, Play and Amazon listings to the United States before release; (b) sell abroad, which needs per-currency revenue, per-storefront price tables and a redesign of the $1 donation rule. Until (b), a non-USD period is recorded with its currency, excluded from revenue sums and donation eligibility, and audited |
| 42 | **UNDECIDED — the fallback safety category for a provider flag with no PencilLift mapping** (BUG-186) | Owner's written choice, recorded in [`docs/Connections.md`](./Connections.md) |
| 45 | **UNDECIDED — BUG-244 (High), carried deliberately.** A lost `/v1/child/refresh` response makes the tablet's next refresh look like token theft, so the session is revoked and the parent must mint a new pairing code. A round-5 remedy was removed in round 6 because it let an attacker holding a captured request body self-renew a child session | Confirm it stays, or commission a different design. Frequency is unmeasured — no device or network testing has run |
| 46 | **UNDECIDED — BUG-309's residual.** Grading is bounded by question bytes, not pages: a dense ten-page worksheet can still end as "this worksheet has too many questions" after one billed generation (full retry reachable to about 85 questions of average length, none past about 149) | Accept (the parent is told to send it in two batches, which works), or fund raising the grading ceiling |
| 49 | **UNDECIDED — whether a parent may opt a child into work above their grade.** Today the answer is no, silently. Measured over K–8 the two-grade reach fires in exactly two cases, both kindergarten (spelling and grammar have no grade-0 content and use grade 1). Prerequisite work is deliberately uncapped | If wanted, build it as a deliberate per-child opt-in, not a widened default |

---

## Where to look next

| For | Read |
|---|---|
| Repository layout, identity model, DB and AI conventions, rejected alternatives | [`docs/Architecture.md`](./Architecture.md) |
| Code-level handoff: how to run it, what to touch first | [`docs/Developer_Packet.md`](./Developer_Packet.md) |
| Requirement-by-requirement status with test evidence and the weakest clause of each | [`docs/Requirement_Coverage.md`](./Requirement_Coverage.md) |
| Every defect, its reproduction and its regression test | [`docs/Bug_Ledger.md`](./Bug_Ledger.md) |
| What must be true before a real family uses it, in order | [`docs/Beta_Readiness.md`](./Beta_Readiness.md) |
| Store submission state | [`docs/Release_Readiness.md`](./Release_Readiness.md) |
| Retention, deletion and the OpenAI ZDR position | [`docs/Data_Retention_And_ZDR.md`](./Data_Retention_And_ZDR.md) |
| Per-channel billing and promo capability, with evidence grades | [`docs/Provider_Capability_Matrix.md`](./Provider_Capability_Matrix.md) |
| Threats, residuals and the recorded dissents | [`docs/Threat_Model.md`](./Threat_Model.md) |
| Priced cost hypotheses (not measurements) | [`docs/Cost_Analysis.md`](./Cost_Analysis.md) |
| Provider/account state, every row a named blocker | [`docs/Connections.md`](./Connections.md) |
