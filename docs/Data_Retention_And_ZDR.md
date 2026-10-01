# Data retention, deletion, and the OpenAI zero-data-retention position

Written 2026-10-01. Two different sets of rules live here on purpose, because conflating them is how
a privacy claim becomes untrue: what **OpenAI** retains is governed by OpenAI's data controls and by
whether PencilLift's organization has an approved zero-data-retention configuration; what
**PencilLift** retains is governed by this product's own migrations and jobs and is unaffected by
anything OpenAI does.

**Nothing in this document, and nothing in the code it describes, makes zero data retention active or
makes this product legally compliant.** ZDR is granted to an organization by OpenAI after their
review. The code can refuse to send a child's data until documented evidence of that grant exists —
which it does — and it can keep requests inside the shape such a grant covers. It cannot grant
anything, and a green test suite is not a legal opinion.

## 1. What PencilLift sends, and to which endpoints

| | |
|---|---|
| Endpoints called | `POST /v1/responses` (every AI stage) and `POST /v1/moderations` (safety screening). Nothing else. |
| `store` | `false`, sent explicitly on every request. Under an approved ZDR organization OpenAI documents `store` as forced false regardless; sending it anyway is what protects a development or staging call made *before* any grant exists. |
| Images | Inline in the request body as `data:` URLs. **Never** through `/v1/files`, which is not ZDR-eligible (30-day abuse-monitoring retention and application state until deleted). |
| Request `metadata` | `stage` and `prompt_version` only, enforced by type and at the transport (`ZdrSafeMetadata`). No child, family, parent, device or session identifier, pseudonymous or otherwise. |
| Prompt content | The question text, the child's answer, and the homework image. No name, nickname, email, date of birth, school or address: `packages/ai/src/prompts.ts` takes none of them. |
| Providers | `api.openai.com` only. There is no automatic fallback to a second AI provider; adding one requires its own verified privacy controls and its own retention position. |

Features reviewed and **not** enabled, each for a retention reason: the Files API, Uploads, hosted
containers (Code Interpreter, Hosted Shell), Assistants, vector stores, batches, background mode,
file search, web search and image generation. The reasons are written beside each in
`packages/ai/src/zdr.ts` so a reviewer meets a decision rather than a silence.

Prompt caching is **accepted**, and named rather than ignored: OpenAI documents it as encrypted
key/value tensors in GPU-local storage, expiring within 24 hours and not retained past expiry. It is
not an application-state store and is not opt-out per request.

## 2. What PencilLift itself keeps, and for how long

These are this product's own rules. They are enforced by migrations and scheduled jobs, not by any
provider setting, and they would be unchanged if PencilLift stopped using AI tomorrow.

| Data | Where | Retention | Deletion path |
|---|---|---|---|
| Homework image bytes | Object storage, written at upload | Deleted once the scan's extraction completes; never the backing store for a result | The scan pipeline deletes on completion; `request_deletion` purges any remainder |
| Extracted question text and the child's answers | `public.extracted_questions`, `public.attempts` | Kept while the family is active, because the learning plan is built from it | `app.purge_family_data` (migration 0620), child-scope or family-scope |
| Model responses used in a result | `public.question_results`, `private.question_solutions` | Same as above. Parent solutions are in `private` and never readable by a child | Same purge |
| AI usage and cost | `public.ai_usage_events` | Token counts, model id, stage, cost. **No prompt or response text** | Purged with the family |
| Safety reports | `public.safety_reports` | The flagged text is kept because the parent is the recipient and must be able to read what was flagged | Same purge |
| Security log | pseudonymous ids only; never homework or answers | per `docs/Threat_Model.md` | — |
| Backups | Supabase-managed | Expire on a documented schedule (length to be confirmed — owner action #13) | Not individually addressable; stated plainly on the privacy page |

Deletion is a parent-initiated request (`public.request_deletion`) that archives immediately and
enqueues a purge; the purge is idempotent and runs to completion. A family-wide request also ends
every child session. None of this depends on, or is affected by, OpenAI's retention posture.

## 3. What is still required, and is not code

The following are account and legal steps. **No code change can substitute for any of them, and the
gate in `packages/ai/src/gate.ts` will keep refusing child data until the evidence from step 4
exists.**

1. **Create a dedicated OpenAI organization/project for PencilLift**, separate from any personal or
   experimental use, so a data-controls setting cannot be changed for an unrelated reason.
2. **Apply to OpenAI for zero data retention** for that organization. ZDR is granted by OpenAI after
   review; it is not a dashboard toggle a developer can set. Ask explicitly for the endpoints this
   product uses — `/v1/responses` and `/v1/moderations` — to be covered.
3. **Confirm in writing which models and endpoints the approval covers.** Approval is per
   configuration, not blanket. If the answer excludes an endpoint in
   `ZDR_ELIGIBLE_ENDPOINTS`, remove it from that list.
4. **Record the approval as evidence**: set `ZDR_APPROVAL_REFERENCE` to the identifier OpenAI gives
   (a ticket, contract or confirmation id — not the word "approved") and `ZDR_APPROVAL_VERIFIED_AT`
   to the date an administrator checked it against the OpenAI dashboard. The gate rejects
   switch-like words and future dates, so neither can stand in for a check.
5. **Re-verify on a schedule**, and after any change of OpenAI plan, organization or project. The
   verification date is a claim about a past check; it does not stay true by itself.
6. **Confirm the under-18 position with counsel** (owner action #48). OpenAI's under-18 guidance
   states a developer should not process personal data of children under 13, or the local age of
   digital consent, without first implementing zero data retention. That is the rule the gate
   enforces; whether PencilLift's overall method satisfies COPPA is a legal question, not a code one.
7. **Keep the API key server-side only.** It is a Worker secret set with `wrangler secret put`, is
   never a `VITE_*` or `EXPO_PUBLIC_*` variable, and `scripts/scan-release-artifacts.sh` scans the
   built web bundle, the Worker bundle and the Expo export for it on every CI run, with a negative
   control that plants a fake key and requires the scan to find it.

## 4. Where the checks live

`packages/ai/src/gate.ts` refuses child personal data without documented evidence and refuses a mock
provider in production. `packages/ai/src/zdr.ts` holds the eligible-endpoint list, the ineligible list
with a reason attached to each, the metadata allow-list and the single approved provider host.
`packages/ai/src/zdr.test.ts` drives all of it with synthetic data only — a made-up fraction question
and a 1×1 PNG — and asserts the logging protections by reading this package's own source for
`console.*` and its own fixtures for identifier-shaped metadata keys.
