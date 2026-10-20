# SDD ledger — plan: docs/superpowers/plans/2026-10-20-generic-workflow-migration.md

Ruling: Work in the existing codex/gitlab-repository-support checkout — the requested workflow and uncommitted source already live here; a clean worktree would omit the implementation being migrated. Preserve unrelated GitLab changes and user-authored probe text.

Pre-flight: Tasks 1–3 share the operation command identity and artifact resolver. Task 2 changes new templates only; Task 3 recognizes both exact host commands and legacy pinned runtime commands.

Ruling: Keep the old bundle runtime and artifact module as compatibility assets. Move new execution into host scripts/workflow-action.mjs and scripts/workflow/artifacts.mjs with host zod resolution. This preserves standalone old snapshots; cost is temporarily retaining the legacy implementation.

Ruling: Do not introduce graph node types or API fields. Ordinary check nodes call the host action script; the CLI exposes the same functions through workflow-action. No target-project dependency installation is required.

Task 1: host action implementation and dependency-free isolated-worktree verification implemented. Test exercises actual baseline/verify/seal, a changed diff, and a real exit 7.

Task 2: new template commands and in-prompt route commands migrated. An explicit template marker preserves legacy snapshot interpretation. Regression tests observed red (old runtime command and missing generic guard) then green.

Task 3: host guards recognize exact shared commands without a Superpowers pin or fixed check-node id. Probe initialization selects host actions for new graphs; legacy initialization remains pinned. Continue test now explicitly checks that generic actions do not require a vendor pin.

User-edited probe text changes old prose assertions; update tests to the user's current format, without editing their prompt.

Task 4: verification/review/activation in progress.

Final review found and fixed: public CLI action strings must join the same guard path as generated script commands; stage artifact/question contracts must follow selected skills and graph return edges when Agent nodes are renamed. Both regression tests failed before the fix and passed afterward. Lightweight plans remain distinct from full plans by their declared verdicts.

Ruling: Also make the YAML directly copyable through loadWorkflows, instead of merely changing its private placeholder expansion. Portable commands bind in the common loader; supporting original templates are read from the pinned skill root. A raw-YAML copy/load regression failed on unresolved placeholders before this change.

Verification so far: legacy bundle/artifact scripts 35/35; initial workflow suite 49/49; host action/probe scripts 4/4; full typecheck and pack passed. After review fixes the combined workflow suite had 49 passes and one 30-second integration-test timeout under concurrent builds; that test plus action compatibility tests passed 5/5 with one worker. Final low-concurrency suite follows.

Final workflow suite: 9 files, 51 tests passed with one worker. Final script suite: 39 tests passed, covering host operations, legacy operations, artifact paths and probe boundaries. Independent reviewer rechecked both fixes and ordinary-YAML loading; no further important findings. HTML data remains 28 nodes and 87 edges and now reflects the portable commands.

Task 4: complete. Final full typecheck and npm pack check passed (980 files, 132 UI assets). Activated snapshot be67f3e26fe5012b67f381a07ed41c7b161396e30420429789743a4866c51e91 after confirming no active tasks; existing pins unchanged. Restarted development service; live API catalog reports unattended with host workflow-action commands and no runtime.mjs reference. No paid-model business task was rerun.
