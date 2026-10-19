# Source of truth — what binds, what informs, and how a decision becomes binding

Written 2026-10-19. This page exists so that a person or a coding agent joining this repository can
tell, without asking, which documents they must obey, which are history, and what to do when the two
disagree. It is the convention the other repositories should adopt too.

## The problem this solves

An agent that infers how a system is supposed to work — from a previous conversation, from the shape
of the code, from a plausible-looking README — will produce something plausible rather than something
correct. The defence is not a longer prompt. It is a small set of documents that are **version
controlled, specific, and authoritative**, with everything else explicitly marked as not.

This repository has already been bitten four times by the opposite: records that read confidently and
were wrong (BUG-411, BUG-426, BUG-430, BUG-432). Each was found by checking a sentence against the
code. That is the habit this structure is meant to make cheap.

## The four tiers

### Tier 1 — BINDING. Obey without exception; a change needs an owner decision.

| Document | What it binds |
|---|---|
| `PencilLift_Claude_Code_Master_Prompt.md` | The product specification, Revision 8, preserved byte-for-byte. Prices, the six subjects, child privacy, protected parent solutions, P17 promotions. |
| `Acceptance_Register.md` | The acceptance criteria each requirement is judged against. |
| `School_and_Monthly_Promotions.md` | The owner's P17 promotion and donation terms, preserved byte-for-byte. |
| `Owner_Actions.md` (root) | The owner's own original action list, preserved byte-for-byte. The builder's working list is `docs/Owner_Actions.md`, which is Tier 2 — when they differ, this one is what the owner wrote and the other is what has since been learned about it. |
| `Audit_Notes.md` | The owner's audit instructions, preserved byte-for-byte. |
| `ECC_Execution_and_Learning.md` | The owner's required execution and learning loop (E5), preserved byte-for-byte. |
| `CLAUDE.md` | The engineering rules that are enforced rather than suggested: money in integer cents, UTC plus IANA zones, RLS on every public table, no secrets or real child data anywhere, the shared registration points only the lead changes. |
| `docs/Architecture.md` | Binding engineering decisions. **Note: §1 currently claims queue consumers the code does not have — see `docs/Architecture_Decisions.md`.** |

The six root files are the owner-supplied package and are in `.prettierignore` for that reason: they
are preserved byte-for-byte and `REVISION_MANIFEST.json` records their digests.

**Nothing in Tier 1 may be changed to make a test pass, a build green, or a deadline.** If the code
and a Tier 1 document disagree, that is a defect in one of them and it gets a ledger row.

### Tier 2 — AUTHORITATIVE RECORD. True as of its date; correct it rather than working around it.

| Document | What it describes |
|---|---|
| `README.md` | The entry point: what this is, its state, and where to go next. |
| `docs/Packet_Index.md` | Which document answers which reviewer question, and what is deliberately absent. |
| `docs/Source_Of_Truth.md` | This page. |
| `docs/Developer_Packet.md` | The handoff: architecture, what is proved, how to get a green run, what is left. |
| `docs/Product_Requirements.md` | What the product does, every user flow, and the business rules with their enforcing file. |
| `docs/Architecture_Decisions.md` | The major engineering decisions and why each service was chosen. |
| `docs/Database_Schema.md` | The schema explained: tables, roles, policies, and what the migrations do. |
| `docs/Access_And_Least_Privilege.md` | The minimum access a contributor needs, per service. |
| `docs/Test_And_CI_Inventory.md` | The test suite by category, and what CI runs. |
| `docs/API_Inventory.md` | The HTTP surface and what authenticates each route. **DERIVED** — `scripts/dump-api-inventory.mjs`. |
| `docs/Open_Work.md` | Every open defect, every residual, and the debt. **DERIVED** — `scripts/dump-open-work.mjs`. |
| `docs/schema/schema.sql` | The complete DDL, structure only. **DERIVED** — `scripts/dump-schema.sh`. |
| `docs/Deployment_Runbook.md` | How this is deployed, and every configuration identifier. |
| `docs/Data_Retention_And_ZDR.md` | What is retained, for how long, and the ZDR position. |
| `docs/Threat_Model.md` | The threats, the control for each, and the status of each control. |
| `docs/Owner_Actions.md` | What only the owner can do, numbered, with the preparation already done. |
| `docs/Owner_Beta_Checklist.md` | The same list reduced to an ordered runway, with costs. |
| `docs/Beta_Readiness.md` | Whether this can meet a real family yet, and what stands in the way. |
| `docs/Release_Readiness.md` | The store-submission checklists and the hard release blockers. |
| `docs/Connections.md` | Every external service, its credential state, and what is blocked without it. |
| `docs/Provider_Capability_Matrix.md` | What each store and provider can and cannot represent. |
| `docs/Cost_Analysis.md` | What this costs to run, and the spend controls. |
| `docs/Measured_Usage.md` | What has actually been measured. (Currently: nothing has.) |
| `docs/design/Consent_Design.md` | The consent design and its open commercial questions (owner action #7). |
| `docs/design/Stitch_Brief.md` | The visual design brief the screens were built to. |
| `brand/BRAND_GUIDE.md` | The approved brand: the logo reference, the palette and what may not change. |
| `brand/ASSETS.md` | Every committed brand asset and its budget. **DERIVED** — `scripts/brand/export-assets.mjs`. |

A **DERIVED** document is generated from the code and the gate fails if it has drifted. Never
hand-edit one; change its generator, or change what it describes.

These describe what is. When one is wrong, the fix is to correct it **with a dated note saying what
it said before** — not to quietly overwrite it, because a reader who remembers the old sentence needs
to know which is right. Every correction above was made that way.

### Tier 3 — LEDGERS. Append-only history. Never rewrite a row; add a new one.

| Document | What it accumulates |
|---|---|
| `docs/Bug_Ledger.md` | One row per defect: reproduction, rejected hypotheses, root cause, evidence. `docs/Open_Work.md` carries the current counts, derived. |
| `docs/Lessons_Learned.md` | One row per mistake that actually happened, with the rule that prevents it. |
| `docs/Requirement_Coverage.md` | One row per acceptance criterion. Its **status** column is current; its evidence column is append-only, so a test count inside it is correct as the history of a particular run and must not be "corrected". |
| `docs/Progress.md` | What was done, in order, with dates. |
| `docs/Test_Evidence.md` | CI runs and suite totals, per slice. |
| `docs/ECC_Runs.md` | Every workflow run: what it was given, what it returned, what that cost. |

A lesson row is the cheapest thing in this repository and the most useful to an agent: it is a defect
that actually happened, with the rule that prevents it. An agent given these will avoid a class of
mistake that no amount of general instruction prevents.

### Tier 4 — HISTORICAL. Context only. Never a source of requirements.

| Document | Why it is not current |
|---|---|
| `START_HERE.md` | The original build-instruction package. It tells its reader to paste a prompt into an agent, which is not what a developer should do with it. |
| `reference/` | Earlier revisions of the specification, kept for provenance only. |
| `docs/ECC_Capabilities.md` | An inventory of the build environment's capabilities as they were at the start. |
| `docs/hardening/README.md` | How the round-3 hardening worklists were organised. |
| `docs/hardening/round3-lead-worklist.md` | A finished round's worklist, with its figures as they were then. |
| `docs/design/Stitch_Prompts.md` | The prompts used to generate design candidates. |
| `finance/cost_report.md` | The owner's cost illustration of 2026-09-18, preserved. Explicitly unmeasured; `docs/Cost_Analysis.md` is the current record. |
| `finance/promo_school_report.md` | The owner's P17 cost extension of the same date, on the same basis. |
| `templates/README.md`, `templates/Bug_Ledger.md`, `templates/Lessons_Learned.md`, `templates/ECC_Runs.md`, `templates/ECC_Capabilities.md`, `templates/CLAUDE.fragment.md` | Blank record templates supplied with the specification. They were merged into the real records at the start and hold no evidence. |
| Superseded rows inside the ledgers | Each is marked where it was superseded. |

### Every record is classified, and the gate checks that

`scripts/check-doc-references.mjs` fails if a tracked markdown record exists that no tier above
names. A page that tells you which documents to trust is worthless if it does not mention the one in
front of you, so a new document is not finished until it appears here. That check exists because
this page shipped without classifying nineteen of the repository's own records (BUG-438).

## How something becomes binding

1. It is proposed, and marked **TENTATIVE** wherever it is written down.
2. The owner decides. The decision is recorded in `docs/Owner_Actions.md` against its numbered row,
   with the date and what was chosen.
3. It moves into Tier 1 or Tier 2, the TENTATIVE marker comes off, and — if it is a rule the code
   must obey — **a test is written that fails when the rule is broken**. A rule with no test is a
   preference, and this repository treats it as one.

Step 3 is the one that is usually skipped and the one that matters. `CLAUDE.md`'s rules are binding
because `supabase/tests/schema_invariants.test.ts` fails without RLS, `scripts/scan-secrets.mjs` fails
on a committed credential, and `apps/api/tests/deploy-secrets.test.ts` fails when the deploy path
cannot start the Worker. The rules that are *only* written down are the ones that drift.

## Marking a requirement that is not settled

Use these words, in bold, inline, where the statement is:

- **TENTATIVE** — proposed, not decided. May change entirely.
- **UNDECIDED** — a decision the owner owes, with the options named.
- **PLANNED** — decided, not built.
- **RESIDUAL** — a known gap that is being carried deliberately, with the row that explains it.

Do not write a tentative thing as a plain declarative sentence. The whole value of this structure is
that a reader can tell the difference at a glance, and an agent can be told to refuse anything not
marked settled.

## How to constrain an agent against this

Give it, in order: `CLAUDE.md`, the Tier 1 documents relevant to the area, `docs/Lessons_Learned.md`,
and the specific Tier 2 document for the subsystem. Then the rule that matters most:

> Where this repository's documents and your own reasoning disagree, the documents win. Where the
> documents and the CODE disagree, the code wins and you report the discrepancy as a defect. Never
> resolve a disagreement silently, and never treat a sentence marked TENTATIVE as a requirement.

That ordering is deliberate. Documents beat inference; code beats documents; and nothing beats saying
out loud that two sources disagree.

## Applying this to the other repositories

The structure is four files and a habit, not a framework: a `CLAUDE.md` of enforced rules, a product
spec, a Tier 2 set describing what is, and two append-only ledgers. The habit is that a rule gets a
test and a correction gets a date. **TENTATIVE** until the owner decides it applies elsewhere.
