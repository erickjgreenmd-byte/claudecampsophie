# Developer packet — index

Written 2026-10-19 at commit `70d352c`. This maps the twelve items that were asked for onto the
documents that answer them. Everything here is in the repository, version controlled, and contains
**no secrets, no credentials and no user data**.

**Scope note, stated first because it is the biggest mismatch with the request.** The brief asks for
three packets for three repositories. This GitHub account holds two repositories:
`erickjgreenmd-byte/claudecampsophie` (PencilLift — this packet) and
`erickjgreenmd-byte/claudecampjojo`, which is **empty: zero commits, no branches**. No third
repository exists on this account, and no Vercel projects exist either. One packet is therefore all
that can be produced from here; see the owner's note for where the other work may live.

## The twelve items

| # | Asked for | Where it is |
|---|---|---|
| 1 | Repository and current branch/deployment state | [`Developer_Packet.md`](Developer_Packet.md) §1 and [`Owner_Beta_Checklist.md`](Owner_Beta_Checklist.md). Short version: branch `claude/new-session-vil6cz`, which is also the default branch; no `main`; no pull request has ever existed; **nothing is deployed, ever** |
| 2 | Repo-grounded developer packet | [`Developer_Packet.md`](Developer_Packet.md) |
| 3 | Product requirements and complete user flows | [`Product_Requirements.md`](Product_Requirements.md) |
| 4 | Current architecture and major engineering decisions | [`Architecture.md`](Architecture.md) for the structure, [`Architecture_Decisions.md`](Architecture_Decisions.md) for the reasoning behind each choice and what is open to challenge |
| 5 | Database schema plus complete/reconciled migrations | [`Database_Schema.md`](Database_Schema.md), with [`schema/schema.sql`](schema/schema.sql) — the full DDL the 44 migrations produce, 10,208 lines, structure only |
| 6 | APIs, integrations, infrastructure, deployment | **[`API_Inventory.md`](API_Inventory.md)** — derived: all 171 routes and what authenticates each. Then [`Developer_Packet.md`](Developer_Packet.md) §3 and §6, [`Deployment_Runbook.md`](Deployment_Runbook.md), [`Connections.md`](Connections.md), [`Provider_Capability_Matrix.md`](Provider_Capability_Matrix.md) |
| 7 | Authentication, authorization, security and privacy | [`API_Inventory.md`](API_Inventory.md) for the guard on every route (and the four that have none, with why), [`Database_Schema.md`](Database_Schema.md) for the roles and the 87 RLS policies, [`Threat_Model.md`](Threat_Model.md) for all 41 threats with the control and status of each, [`Data_Retention_And_ZDR.md`](Data_Retention_And_ZDR.md) for what leaves the product |
| 8 | Test-suite and CI/CD inventory | [`Test_And_CI_Inventory.md`](Test_And_CI_Inventory.md) |
| 9 | Known bugs, technical debt, incomplete work | **[`Open_Work.md`](Open_Work.md)** — derived: every open defect, every residual a closed fix left, the debt, and what has never run. Behind it: [`Bug_Ledger.md`](Bug_Ledger.md) for one defect's full reproduction, [`Lessons_Learned.md`](Lessons_Learned.md) for the rule each taught, [`Developer_Packet.md`](Developer_Packet.md) §5 and §7 |
| 10 | Planned features and tentative requirements, separated | [`Product_Requirements.md`](Product_Requirements.md) §6–8, and [`Source_Of_Truth.md`](Source_Of_Truth.md) for the marking convention |
| 11 | Specifications and planning documents that influenced the implementation | listed below |
| 12 | Minimum access requirements per service | [`Access_And_Least_Privilege.md`](Access_And_Least_Privilege.md) |

## Item 11 — the documents that materially shaped this build

| Document | What it is | Authority |
|---|---|---|
| [`../PencilLift_Claude_Code_Master_Prompt.md`](../PencilLift_Claude_Code_Master_Prompt.md) | The product specification, Revision 8, 904 lines, preserved byte-for-byte | **Binding** |
| [`../Acceptance_Register.md`](../Acceptance_Register.md) | The acceptance criteria each requirement is judged against (193 lines) | **Binding** |
| [`../School_and_Monthly_Promotions.md`](../School_and_Monthly_Promotions.md) | The P17 promotion and school-donation design | **Binding** |
| [`../CLAUDE.md`](../CLAUDE.md) | The engineering rules that are enforced by tests rather than suggested | **Binding** |
| [`design/Consent_Design.md`](design/Consent_Design.md) | Verifiable parental consent: the three methods ranked, the vendor questions | Design, decision open |
| [`design/Stitch_Brief.md`](design/Stitch_Brief.md), [`design/Stitch_Prompts.md`](design/Stitch_Prompts.md) | The UI design brief and prompts | Design |
| [`../ECC_Execution_and_Learning.md`](../ECC_Execution_and_Learning.md) | The build workflow the project followed: reproduce → failing regression → fix → retest → review → lesson | Process |
| [`../Audit_Notes.md`](../Audit_Notes.md) | The opening audit of the inherited material | Historical |
| [`hardening/`](hardening/) | The raw findings and fix plans from seven adversarial hunt rounds | Historical evidence |
| [`../reference/`](../reference/) | The original material the spec was assembled from — earlier prompts, pricing sheets, cost calculators | **Historical only. Not a source of requirements** |

[`Source_Of_Truth.md`](Source_Of_Truth.md) explains which tier each document sits in and what to do
when two disagree.

## What is deliberately not here

- **No secrets, tokens, keys, passwords or connection strings.** `scripts/scan-secrets.mjs` enforces
  that over every tracked file on every commit, and over built release artifacts in CI with a
  negative control that plants fake keys and requires the scan to find them.
- **No user data of any kind.** There is none to leak — no family has ever used this software, the
  hosted database is empty, and every fixture in the repository is synthetic.
- **No production database access is needed to review any of this.** The complete schema is in
  `schema/schema.sql`; see [`Access_And_Least_Privilege.md`](Access_And_Least_Privilege.md).

## One thing to know before reading any of it

The records in `docs/` are candid, including about themselves. Six have been found materially wrong
and corrected — BUG-411, BUG-426, BUG-430, BUG-432, BUG-433 and BUG-436 — each time because someone
checked a sentence against the code rather than reading it. The last two were found writing this
packet, which is why four of these documents are now **derived** from the code and four mechanical
cross-reference checks run in CI (`scripts/check-doc-references.mjs`, `dump-api-inventory.mjs`,
`dump-open-work.mjs`, `check-schema-dump.mjs`). Where a document and the code disagree, the code
wins and the document gets a dated correction. Do the checking anyway.
