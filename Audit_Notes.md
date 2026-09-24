# PencilLift prompt audit — Revisions 4–5

September 18, 2026. This audit concerns the prompt and its illustrative financial arithmetic. It is not an audit of a built application.

The earlier combined document repeated full source documents with overlapping instructions, historical prices and cost assumptions. Revision 4 consolidates those into one current build specification, preserves the approved product behavior, and places historical material under `reference/`.

| Finding | Resolution in the rewritten prompt |
|---|---|
| Several documents could compete as the authority | One master prompt; explicit historical-only folder and a short Claude Code launch instruction |
| Development tools and runtime services could be mistaken for the same connection | Separate development setup and observable application integration evidence |
| Existing sign-ups could be treated as configured services | Inspect actual account/project/environment, reuse resources, verify scope and record results |
| Cost instructions appeared after much of the implementation | Cost baseline at milestone 0, measured update after a working workflow, and commercial report before release |
| Old cost tables mixed different daily-practice assumptions | All light/typical/heavy cases include 30 fresh daily sets; earlier calculators remain historical |
| A single small verifier allowance hid workflow differences | Separate verification budgets for homework, explanations, follow-ups, daily and Thursday packets, semantic practice answers and escalated results |
| A positive family contribution could hide a loss on added children | Explicit incremental sibling contribution and heavy-user sensitivities at unchanged approved prices |
| Contribution, reserves, profit and cash could be conflated | Expected expenses and contingency separated; net profit left unknown; startup cash and recurring development/operating costs distinguished |
| Flat fee assumptions could overstate or understate costs | RevenueCat account threshold, whole tracked-total fee, native/Stripe route separation, credits and fee sensitivities |
| Low shared infrastructure prices might look like scale guarantees | Scale tables show contribution available for overhead; capacity, actual overages and unpriced costs require separate measurement |
| A universal image-token estimate could become stale | Model-specific billing and actual API usage replace the fixed image rule |
| Trial/ad-free mechanics had no approved sellable offer | Implement and test fixtures; do not invent duration or price or activate a paid offer |
| Parent PIN or an approval flag could look like consent/provider eligibility | Explicit verified consent, account evidence and server enforcement; mocks remain development-only |
| RLS could be overclaimed when server code uses privileged database credentials | Privileged handlers must authorize independently; direct tenant and storage access tests required |
| Thursday work could start at the promised release time | Explicit lead time, evidence cutoff, queue monitoring and review versioning |
| Queued jobs or restored backups could recreate deleted records | Tombstones, cancellation/replay protection and restore/deletion reconciliation |
| “Precision” lacked a clear denominator | Define grading agreement, correct-judgment precision, coverage and error rates; freeze thresholds before final evaluation |
| Checklist identifiers were duplicated | 121 unique acceptance IDs, retaining original scope and adding connection, financial and release checks |
| A successful build/upload could be mistaken for a public release | Distinct evidence for build, installation, submission, review, approval and public availability |

## Scope traceability

| Previous material | Current location |
|---|---|
| Execution supplement: Claude Code/ECC, integrations and milestones | E1–E4, V1–V3 and AC_CONN/AC_RELEASE checks |
| Original product sections 1–14 | P1–P14, with clarified decisions and current internal references |
| Original store/deployment section 15 | P15 and V2 |
| Original verification/completion section 16 | V1–V3 and acceptance register |
| Original monetization section 17 and companion plan | P16 and AC_MON checks |
| Approved child pricing | P11, section F and AC_CAPACITY checks; $39.99/$49.98/$59.97/$69.96 preserved |
| Original cost and launch report/calculators | Replaced for current use by section F and `finance/`; originals retained only as reference |
| Original brand guide and logo | `brand/` preserved; standalone brand targets and missing-asset handling added to P1 |
| Owner setup checklist/configuration examples | Current Owner_Actions.md and E2/P2; old examples are historical |

## Verification performed for this revision

- Checked current official public pricing sources for Claude, Expo, Supabase, Cloudflare, RevenueCat, Stripe, Apple and Google, and the selected OpenAI model rates. Account-specific contracts, credits and eligibility were not inspected.
- Recalculated 144 workload/tier/scale/payment scenarios and 36 blended-family scenarios using decimal arithmetic.
- Ran meaningful checks on approved prices, RevenueCat threshold behavior, payment-route fee separation, cost reconciliation, heavy-use downside, family mix and break-even boundaries.
- Checked acceptance-ID uniqueness, section references, complete active-file packaging, matching master/report copies and unchanged approved logo bytes.

The key commercial finding is a risk to validate: under the unmeasured typical-use assumptions and 25% AI contingency, every additional child reduces budgeted monthly contribution by about **$3.80**. The $9.99 sibling price remains approved and unchanged. Actual profitability requires measured usage, full operating costs and outstanding quotes.

## Revision 5 — verified ECC use and persistent repair

The product and finance sections remain unchanged. The new E5 contract adds installed-version/namespace verification, role-to-skill routing, bounded specialist delegation, actual handoff/run evidence, regression-based repair, sanitized project lessons, fresh-session resume testing, hook safeguards and honest runner/CI status.

The owner has explicitly requested ECC specialist use. The earlier generic “use ECC” instruction now resolves real installed capabilities and requires evidence of their use. Current upstream docs identify legacy command migrations; the prompt does not assume that short aliases work on every installation. Learning means project knowledge and tests, not model retraining or unattended execution without a runner.

Added 16 AC_ECC acceptance checks, for 137 total unique checks. The existing OpenAI runtime/API requirements, approved prices, brand assets and 144 + 36 financial scenarios were preserved. This revision changes build instructions only; it does not claim ECC is installed/configured on the owner's machine or that the app has been implemented.

Validation: active master/package copies agree; all prior acceptance IDs remain; new IDs are unique; product/financial sections and brand/finance bytes remain unchanged; ZIP integrity passes. New templates are explicitly blank and unverified.

## Revision 6 — school contributions and recurring monthly code redemption

Added P17, F7, sixteen acceptance checks, a standalone requirements guide and a reproducible financial extension. Latest owner clarification controls: fresh codes are generated every month; a fresh family redemption can discount each subsequent month. Each individual offer remains one monthly billing period. There is no lifetime one-code rule. No code automatically renews. Provider compatibility is a required implementation verification, not a completed claim. Draft donation policy alternatives remain explicit. The base report is preserved as the no-promotion/no-donation baseline. Financial arithmetic was checked; the app, campaign scheduler, ECC installation and store releases are not implemented or validated by this document rewrite.

## Revision 7 — one school per family

The owner resolved school allocation: one school per family. This supersedes Revision 6 multiple-school alternatives. Added a one-school database constraint, one family/month donation key and next-calendar-month effective school changes. Updated the prompt, acceptance register, owner dependencies and cost model; the 1,728 scenarios now use one school. Free-family donation eligibility remains unresolved. Arithmetic checks passed; this edit does not implement the app.

## Revision 8 — no donations on any discounted period

Owner decision supersedes all earlier eligibility alternatives: only settled full-price monthly subscriptions generate the $1 donation. Every discount disqualifies its period. Updated active requirements, acceptance criteria, dependencies, ledger period mapping and calculator; 864 scenarios use the approved policy. Existing arithmetic checks now cover every whole discount percentage 5–100 and return to full-price eligibility. No app implementation is claimed.
