# Start PencilLift in Claude Code

This package contains the complete combined build prompt, the approved logo reference, and the original product requirements. It contains instructions and source assets, not a finished app.

1. Unzip this package on the computer where you use Claude Code.
2. If you already have PencilLift code, place this package in a `project-brief` folder inside that existing project. Keep the existing code. If you are starting fresh, use this package folder as your starting workspace.
3. Open that project in Claude Code (the Code view in Claude Desktop, the VS Code extension, or the terminal). Enable your existing ECC installation.
4. Give Claude the instruction below, adjusting the path if you used `project-brief`.
5. Complete provider sign-in screens when Claude identifies an actual required connection. You already have Supabase, RevenueCat and Stripe accounts; Claude is instructed to reuse the correct resources.

Paste this into Claude Code:

```text
Read PencilLift_Claude_Code_Master_Prompt.md in full, including every embedded specification and acceptance checklist, and inspect brand/approved_logo_reference.png. Use it as my complete PencilLift build brief. Inspect this workspace and my installed ECC setup, connect the appropriate existing accounts through the official integrations, then implement and test the project. Begin with Part A1 and continue through all unblocked milestones. Do not stop after a plan or prototype. Preserve my existing work and record any exact owner sign-ins or approvals needed.
```

For an existing repository with this package under `project-brief`, use `project-brief/PencilLift_Claude_Code_Master_Prompt.md` and `project-brief/brand/approved_logo_reference.png` in that instruction.

## Which file matters most?

- `PencilLift_Claude_Code_Master_Prompt.md`: the complete instruction file. It includes the original master prompt, child pricing, monetization requirements, all acceptance tests, cost references, brand guide, account dependency checklist and example configuration, plus the new Claude/ECC/Expo integration and release workflow.
- `brand/approved_logo_reference.png`: the exact approved visual reference, preserved unchanged. Claude must derive production assets faithfully; this board is not a ready-made app icon.
- `SOURCE_MANIFEST.json`: source checksums for the preserved documents and image.
- Other original files are supporting references. The combined prompt governs the execution workflow. Costs are dated estimates, not demonstrated results.

## What you will still do

Sign in through official account screens; provide company/store information where required; test the actual app on devices; complete applicable external reviews; and authorize the specific public release when the finished builds are ready. Do not paste passwords, secret API keys or signing credentials into chat. Claude should complete other useful work while an external dependency is pending.

No prompt guarantees bug-free software, a completed independent security review or store approval. Require the dated test/build evidence and accurate status reports specified in the combined prompt.
