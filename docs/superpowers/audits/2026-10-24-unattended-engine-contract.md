# Unattended workflow and shared-engine contract audit

## Scope and governing contracts

Reviewed every node in the built-in unattended graph: 41 nodes and 110 edges after adding the explicit environment repair path. The existing graph contract is defined by `packages/contract/src/workflows.ts`, implemented in `src/workflows/graph.ts`, and explained in `.ai/specs/2026-09-30-workflow-node-editor.md`. Agent lifetime, pending background results, launch restrictions and live caller returns follow `AGENT_PROTOCOL.md`.

Required invariants:

- An executable node emits a declared port; its outgoing edge determines the next node. Workflow-specific code must not launch another node behind the graph.
- Every cycle is bounded by an explicit loop's repeat port. Persisted counters survive Continue and process recovery.
- `session.continue` expresses session reuse. Backend/account affinity, cancellation and process lifetime remain engine responsibilities.
- Node inputs and outputs are explicit; renaming a node cannot silently change its skill, artifact requirements or return edge.
- Stored workflow snapshots remain unchanged. Legacy execution overlays are derived, and the task viewer receives the same executed graph without overwriting the snapshot.
- Ordinary built-ins and v1 workflows retain their default behavior. No new configuration, dependencies, graph node types or HTTP fields are required.

## Findings and changes

| Area | Finding | Resolution |
| --- | --- | --- |
| Probe and baseline | The engine directly re-entered probe during probe handoff and baseline execution. The extra work and retry did not appear in the graph. | Replace both paths with `environment-check → probe-retry(max=1) → probe-repair → environment-check`. The repair agent uses ordinary `session.continue`. Baseline still validates its own inputs. |
| Design and planning | Builder-recovery text and managed input construction were embedded in the engine. Renamed roles could lose their expected artifacts. | Workflow-owned launch preparation supplies these inputs. Roles follow declared skills and verdicts; actual node IDs remain the keys for checkpoints and question origins. |
| Adjudication | The engine knew the adjudicator skill and fixed caller-return edge names. Renaming the caller or judge could break live return. | The workflow runtime recognizes the judge's declared skill and actual return edge. The engine only parks/resumes an owned session and fences cancellation, account changes and stale results. |
| Execution variants | Toolchain environment, native/SDD context and execution ledgers were selected inside the engine. | Keep these rules in unattended preparation. Skill and declared verdicts distinguish fast, standard, deep-native and SDD artifacts. Dispatch, tools, token usage and wall-clock bounds stay generic. |
| Verification, review, fix and delivery | The engine directly selected unattended receipts, clarification records and artifact validation. | Workflow-owned validators check the current receipts and artifact contracts. They may reject a handoff, but cannot launch agents or alter transitions. Existing scope, verify, seal and review/fix paths remain ordinary nodes. |
| Restart and Continue | Recovery relied on fixed planner/reviewer/check IDs, and direct baseline recovery bypassed the new probe handoff. | Resolve roles from skills, checks from operation declarations, and return destinations from edges. Old baseline recovery enters the visible environment check; existing repair reservations consume the loop budget. |
| Task graph presentation | A legacy execution overlay would otherwise be absent from the task's pinned graph view. | Return a read-only projection containing the executed graph and derived steps after an added node is recorded. Persisted definitions are not modified. |
| Mixed backends and renamed blockers | Legacy repair could lose the original probe's runner/model; renamed blocker nodes could prevent environment recovery. | Synthesized repair copies the original launch overrides. Recovery identifies blockers by their declared operation. Both regressions were reproduced by failing tests before correction. Explicitly authored repair nodes retain their own runner/model settings, following the shared session contract. |

## Node-by-node coverage

| Nodes | Contract and ownership |
| --- | --- |
| `start` | Standard start edge. |
| `probe`, `probe-repair` | Ordinary agent nodes; workflow-owned read-only discovery capabilities and mapped artifacts. Repair resumes the original probe via `session.continue`. |
| `environment-check`, `probe-retry` | Standard check and loop, with explicit pass/fail/repeat/exhausted edges. Invalid artifacts receive at most one automatic repair. |
| `baseline` | Standard check; real build/test failures follow its fail edge, never a hidden probe invocation. Valid environment recovery does not rerun discovery. |
| `route`, `route-fast`, `validation-scope`, `scope-fast`, `scope-standard`, `execution-route`, `execution-sdd` | Standard checks and output conditions. Complexity and execution selection are produced by workflow actions and read from node outputs. |
| `fast-plan`, `design`, `plan` | Ordinary skill-backed agents. Artifact and readiness requirements belong to the workflow. |
| `clarification-round`, `adjudicator` | Explicit bounded question loop and declared caller-return verdicts. The engine owns the open-session lifecycle, not the decision content or caller selection. |
| `execute-fast`, `execute-standard`, `execute-deep-native`, `execute-deep` | Ordinary agent nodes with declared completion/question/blocking ports. Deep execution retains the existing 90-minute bounds. |
| `upgrade` | Explicit bounded loop; no resetting on recovery. |
| `verify`, `review`, `final-retry`, `fix`, `deliver`, `seal` | Existing validation/review/fix graph with its bounded final repair. Frozen validation, current-tree evidence and official reports remain checked. |
| `publish-mr`, `request-review` | Existing shared forge node types. Reviewer choice is template data; engine functionality remains reusable. |
| `notify-wecom`, `notify-review-failed`, `notify-publication-failed`, `notify-blocked` | Existing shared notification node type; targets and messages are workflow data. |
| `notification-failed`, `review-request-failed`, `publication-failed`, `done`, `stopped` | Explicit terminal statuses; failures are not converted into success. |

## Verification evidence

- Architecture tests reject unattended imports, skill identities and hidden probe repair in `run.ts`, and reject runner/session invocation in the unattended policy module.
- Every unattended node parses against the shared contract; every agent verdict/failure and check pass/fail has an explicit edge.
- New workflow and legacy-baseline recovery tests cover successful repair, exhausted repair, valid environment without re-probing, original session reuse and retained loop budgets.
- A renamed-node regression failed before the role/edge correction and passes afterward, including current checkpoints and answered questions under the actual caller ID.
- Full service test typechecking passes after workspace package links are pinned to this worktree's contract and API client. The previously observed twelve parity errors came from resolving another checkout's newer contract through shared dependencies.
- The ordinary graph-run suite passes all 15 tests with native Git Bash available. The system-node suite retains Windows directory-cleanup failures; a representative case also fails with the unmodified baseline engine. These are not counted as a green suite.

No paid-model task, merge-request creation or notification was triggered as part of this audit.

Final focused verification: 12 suites, 92 tests passed; full service source/test typechecking and git diff --check passed. Independent read-only review found no remaining actionable issues after the two reproduced regressions were fixed.
