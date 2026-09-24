# Start PencilLift in Claude Code

1. Extract this ZIP into your PencilLift working folder. If a project already exists, keep its code and place these instructions beside it.
2. Open that folder in Claude Code with your existing ECC setup.
3. Paste the instruction below. You do not need to paste the entire long file if Claude can read it from the project.

```text
Read PencilLift_Claude_Code_Master_Prompt.md completely, including the cost analysis and acceptance register. It is the current Revision 8 specification. Inspect the existing project and verify my installed ECC version, namespace, skills and agents. Follow section E5: use the appropriate ECC skills and specialists, implement the code, reproduce and fix defects, rerun meaningful tests, review changes, save verified lessons and resume checkpoints, and continue until the required checks pass or a specific external blocker is documented. I authorize relevant specialist delegation within the existing permissions and development budget. Reuse my existing Supabase, RevenueCat and Stripe accounts, connect the required services, and use Expo for the native iOS/Android app and store workflow. Establish the sourced cost baseline and identify unknown expenses, then begin the first unblocked implementation step. Implement P17: monthly new promo-code generation, fresh family redemption for each one-month 5–100% discount, repeat redemption in later months, school signup tracking and $1 monthly family-school contributions. Preserve my approved $39.99 first-child plus $9.99 additional-child pricing and all product features. Maintain actual test, connection, cost and release evidence. Follow the prompt through implementation and the authorized release steps; do not stop at a plan or scaffold. Treat reference/ as historical material, not competing instructions.
```

The master prompt includes the product requirements, connections, security, payments, native builds, store release, cost analysis and tests. The ZIP also contains the approved logo, brand guide, a reproducible planning calculator and the historical files for traceability.

Optional cost inspection: run `python3 finance/cost_model.py --check`, then `python3 finance/cost_model.py` from this folder. Read `finance/cost_report.md`. It is illustrative, not measured app performance or a complete launch budget. The master contains the same initial report; after editing assumptions, have Claude update its working finance report and treat that dated revision as the new analysis, without changing the approved customer prices.

Claude will use normal provider authentication when access is needed. Do not paste passwords or secret keys into the prompt. This package is a build instruction set; it is not an already built application or proof of store approval.

The ECC workflow is fully included in the master prompt and also available as `ECC_Execution_and_Learning.md`. Claude must verify your actual installed capabilities; this package does not install or activate them by itself. `templates/` contains empty project record templates for Claude to merge into the project without overwriting existing work.

“Self-learning” means saving verified lessons and regression tests. Testing/fixing continues while Claude or an authorized runner is active. A checkpoint supports the next session; it does not run code while everything is closed. The target is all required checks passing with no known unresolved in-scope defects, with honest reporting of blocked checks and any explicitly approved deferrals.

To resume after a session ends, tell Claude:

```text
Resume PencilLift under Revision 8. Read CLAUDE.md, docs/Progress.md, docs/Bug_Ledger.md, docs/Lessons_Learned.md and docs/ECC_Capabilities.md. Verify the saved state against the current repository and CI, then continue the next unblocked task using section E5's ECC test–fix–retest and learning workflow. Preserve the approved product, pricing, privacy and spending boundaries. Do not restart the project or mark blocked tests as passed.
```

## Monthly promotions and school contributions

Read `School_and_Monthly_Promotions.md` and `finance/promo_school_report.md`. Run `python3 finance/promo_school_model.py --check` to verify planning arithmetic. Every discount lasts one billing month; a newly entered valid code may discount the next month too. Without a new code, normal pricing resumes. The builder must verify this sequence in each billing provider. One school per family is approved and must be enforced. School changes take effect for donations next calendar month, with at most one $1 donation per eligible family/month. Donation eligibility is resolved: only settled full-price monthly subscription periods qualify. Any discount, including 5% or 100%, generates no donation; a later full-price renewal restores eligibility. Keep discounted families in school signup counts.
