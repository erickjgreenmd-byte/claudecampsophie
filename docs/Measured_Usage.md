# PencilLift measured usage (spec F1, F3)

**No measurements yet.** No PencilLift AI request, scan, build or store transaction has been executed:
the OpenAI API is unreachable from the build environment and no provider account is connected
(`docs/Connections.md`). This file stays empty rather than holding estimates; assumptions live in
`finance/assumptions.json` and `docs/Cost_Analysis.md`.

When measurement starts, record per stage: request count, unique operations, model/version, input tokens
(incl. images), cached tokens, output tokens (incl. reasoning), latency p50/p95, retries, failed billed
requests and cost in micro-USD — from the `usage_events` table, never from homework content.
