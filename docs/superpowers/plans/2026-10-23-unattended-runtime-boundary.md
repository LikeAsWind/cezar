# Unattended workflow ownership

**Goal:** Keep the shared run engine independent of unattended node names, skills, artifacts, prompts, and repair decisions.

**Architecture:** Use the existing graph vocabulary (`check`, `loop`, `agent`, `session.continue`) for environment validation and one repair. A workflow runtime interface owns launch context, receipts, clarification and recovery policy; its unattended implementation cannot launch nodes. The engine invokes generic lifecycle methods and executes only the current graph node. Other built-ins select no runtime and retain their existing behavior.

**Compatibility:** Preserve pinned definitions on disk. Derive the same explicit validation/repair graph for older unattended definitions when executing, keep existing loop counts and account affinity, and map baseline recovery to the validation node. A previous repair reservation consumes the derived repair loop rather than replenishing it. Added execution steps are recorded normally; no environment guessing or silent source changes.

- [x] Add architecture and graph tests that fail with the current template-specific engine branches.
- [x] Define the narrow runtime interface and unattended implementation; move existing prompts, input preparation, verification and recovery policy behind it.
- [x] Add explicit environment validation, retry and probe-repair nodes, using ordinary session continuation and node-output references. Remove nested agent execution and the probeRepair hook from run.ts.
- [x] Preserve legacy recovery and retry budgets; verify ordinary built-ins, live caller returns, backend/account changes, cancellation and command failures.
- [x] Run focused workflow tests, source/test typechecking where applicable, and inspect the final diff.
