# Probe environment handoff implementation plan

**Goal:** Reject incomplete probe environments before baseline and allow one targeted repair in the original session.

**Architecture:** Reuse the exported `validationPlan` validator. Persist the repair reservation in the host run directory before requesting repair, and validate again before accepting ready. Baseline retains its existing validation.

**Scope:** The approved conversation design; no toolchain guessing, build execution during probe, new settings, or business source changes.

- [x] Add regression tests for valid environments, missing execution bindings, successful repair, unsuccessful repair, and retry persistence across recovery.
- [x] Add a probe handoff helper using the existing validator and an exclusive persisted repair reservation.
- [x] Wire the helper before graph step completion, resume the probe session with targeted feedback, and route unresolved validation to blocked.
- [x] Clarify the probe contract and run focused tests plus service typechecking.

## Verification notes

## Legacy baseline recovery follow-up

The original handoff guard did not run when Continue resumed an existing task directly at baseline. Add the same guard before the baseline check executes, restoring the original probe session for one targeted repair and preserving loop budgets. Share the existing persisted repair reservation with the handoff guard. Valid environments proceed directly to baseline.

Regression: recover from baseline with a toolchain missing its execution binding. Successful repair must resume the original probe session before baseline; unsuccessful repair must prevent baseline. Both cases fail without the additional gate (zero probe invocations), and the repaired path preserves the existing final-retry budget.

Follow-up verification: all 60 tests in the six workflow suites pass, service source typecheck passes, and `git diff --check` passes.

- All 58 tests in the six focused workflow suites pass with one worker; `git diff --check` passes.
- Replacing `run.ts` with the main version makes both new workflow regression cases fail: only one probe invocation occurs instead of a resumed repair. Restore the fix to pass.
- Service source typecheck passes. Full test typecheck reports twelve existing contract-parity errors; the same errors reproduce with the main version of `run.ts`.
- The workflow-action script suite has two existing failures (blocked handoff contents and the artifact catalog), both reproduced with the main version of the script.
