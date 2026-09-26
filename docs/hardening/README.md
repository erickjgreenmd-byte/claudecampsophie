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

## Round 3 (the fix round): checker results and the lead's worklist

`round3-checker-results.json` is the raw return of every agent in the fix workflow — seven fixers
(what each reproduced, the regression test it wrote, what it could not do inside its own files) and
the acceptance checkers that re-ran those tests, mutated each fix and classified what survived as
`regression`, `listed` or `residual`. It is a record of the round, not a list of open defects: a
checker's `ok: false` is what sent that area into its one bounded re-fix.

`round3-lead-worklist.md` is what came out of reading all of it: the edits only the lead can make
(the shared test files two areas both depend on, the pinned safety-template digest, the tick report
field, the test-count floors), the cross-area residuals worth closing in the same round, and the
items deliberately left open with the reason. Anything in section C of that file is a decision, not
an oversight, and `docs/ECC_Runs.md` carries the same list.

## Round 4: the finder round over the round-3 tree

`round4-hunt-findings.json` is the raw return of nine read-only finders over the `110ff0f..8bc022b`
diff — 112 files and about 11,000 inserted lines written by seven different agents in one round, none
of it reviewed by anyone but its own area's checker. Each finder had to give a mechanism, the input or
state that triggers it, a repro, and a proof where one was cheap; each also reports what it swept and
found sound, so a thin sweep is visible instead of reading as a clean bill of health.

The round found defects in the previous round's own fixes, including two the lead wrote: the bounded
password-recovery grant is bypassed on the mobile-link path by a local state flag ORed in front of it,
and the oldest-end bound on the family's safety-report list does not drain for parent-filed reports,
because a parent cannot resolve their own report — only staff can. Both are recorded here with the
reasoning, not quietly fixed: a fix round follows, and every finding is reproduced with a failing test
before anything changes.

As in round 3, these rows are reports, not confirmed defects, until a failing test reproduces one. The
file now holds all nine areas: 44 findings (9 high, 15 medium, 20 low) and 120 entries the finders swept
and found sound.

`round4-fix-plan.json` is how they are routed: the same nine areas as disjoint file sets, every finding
carrying the finder's mechanism, repro and proof, and the lead's decision on the eighteen where the fix
was a judgement call rather than a mechanical change — among them that the family's report list is
bounded per reporter kind (a parent cannot resolve their own report, so an oldest-first page of those
never drains), that the family-data export carries the fact of a safety notice and not its wording,
that no cancel-deletion endpoint is being invented to make a wrong notice true (the copy is corrected
instead), and that migration 0870 revokes the sequence grants DB-R2-04's table sweep missed.
