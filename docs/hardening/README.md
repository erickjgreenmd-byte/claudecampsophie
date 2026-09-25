# Hardening round 2: findings and fix plan (evidence)

The adversarial bug hunt (`wf_2a9a8aa6-7c4`) ran two finder rounds. Round 1's 48 findings were each
verified by three independent reviewers; 44 were confirmed and every one is fixed and closed in
`docs/Bug_Ledger.md` (BUG-116..164).

**Round 2 was not verified.** Its seven finders reported the 50 findings in `round2-findings.json`
on the tree of `110ff0f`, and the hunt was stopped before its three-lens verification: round 1 had
refuted only 4 of 48, so reproducing each finding inside its fix was judged the cheaper check.
Nothing in that file is confirmed: **treat every row as a report, not a defect**, until a failing
test reproduces it.

`round3-fix-plan.json` is how those 50 were routed: seven areas with disjoint files, the lead's
decision for each finding, and the rule that a fixer which cannot reproduce a finding changes
nothing and says so. `fix-workflow-template.js.txt` is the workflow (kept with a `.txt` suffix so the repo lint, which types every `.js` against a tsconfig project, leaves this evidence file alone) that runs it (fixer → acceptance
checker with mutation checks → one bounded re-fix).

These files are evidence for `docs/ECC_Runs.md`; they are kept here because the analysis behind them
cost more than the code it produced. They are not part of the build and nothing imports them.
