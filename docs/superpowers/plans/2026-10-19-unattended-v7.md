# cezar unattended v7 implementation plan

**Goal:** Install a project workflow using byte-identical Superpowers 7.0.0 prompts, shared probe artifacts, three execution tiers, and bounded failure paths.

**Spec:** `docs/superpowers/specs/2026-10-19-unattended-v7-design.md`

**Architecture:** A standalone bundle under the service package, installed into the existing local workflow and skill directories. No changes to the engine, HTTP API, defaults, or unrelated working changes.

## Task 1: Pin inputs and define verifiable behavior

- Preserve upstream skills and licenses, with source revisions and SHA-256 entries.
- Write node:test coverage for routing, missing/invalid evidence, cross-run isolation, installation and native graph traversal.
- Run the test before implementation and confirm failure.

## Task 2: Implement the workflow bundle

- Add the context/routing helper, installation script, graph and explicitly separated adapters.
- Use native executing-plans for fast/standard; SDD for deep, preserving the upstream role templates and repair rules.
- Every failure/verdict port has an explicit terminal or bounded continuation. Validation failure before review must still reach a full first review after repair.

## Task 3: Verify and install

- Run the focused suite, compare all source hashes, validate with loadWorkflows/graphIssues, and simulate all tiers and repair/blocked paths.
- Install locally and load the installed workflow and skill through cezar discovery.
- Document usage and the boundary between simulated validation and a real model run. Do not start a real task, commit, push, or change the default workflow.
