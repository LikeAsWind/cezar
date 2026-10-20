# GitLab Forge Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Support GitLab.com and configured self-managed GitLab alongside existing GitHub projects, with explicit provider capability limits.

**Architecture:** Preserve GitHub behavior and the existing API paths. Implement GitLab through glab with project-scoped provider resolution, separate normalization and bounded REST calls. Plain Git works without either platform CLI; workspace health does not regain project fields.

**Tech Stack:** Node 20+, strict TypeScript ESM, Hono, Zod contract, Vitest, React 19, existing npm workspaces.

**Spec:** `.ai/specs/2026-10-16-gitlab-forge-parity.md` (read in full before implementation).

## Global Constraints

- Work on `codex/gitlab-repository-support`; preserve existing untracked files. Do not modify yc-sale-control-server.
- GitHub uses gh; GitLab uses glab. No direct HTTP transport, Token forms, credential store, new mandatory config or CEZ flag.
- Self-managed hosts come from glab metadata; never identify arbitrary remotes by a gitlab substring.
- All wire shapes originate in packages/contract, remain Node-free, and use inferred types. Chain routes and validate through middleware.
- Health omits forge/repo/repoRoot/bootProject. GitHub existing defaults and reference behavior remain valid.
- GitLab review/review-request/re-review polling triggers are unsupported. Individual approval-observed snapshots have explicit limitations.
- canOverride is false; reject override requests. Unknown policy/CI does not mean ready.
- UI strings use t() and receive zh-CN translations. No user files, credentials or real upstream resources are mutated in tests.
- Before any commit run all repository gates in their documented order; do not create intermediate commits without these gates.

## Review Focus

1. SSH alias/API host mismatch or remote changes must never select another project's host or credentials (Tasks 1–2).
2. Issue #1 and MR !1 must remain independent across caches, task parsing and persistence (Tasks 2, 5).
3. Older GitLab enums, CE fields and incomplete checks must yield honest unknown states, not false merge eligibility (Tasks 2–3).
4. Partial pages, throttling and stale in-flight reads must preserve exact continuation and avoid request storms (Task 2).
5. Re-enable/restart and partial approval polls must not replay retained approvals or consume failed occurrences (Task 4).

## Task 1: Provider identity, remote parsing and self-managed discovery

- [x] Spec compliance review passed (including fixes/re-review).
- [x] Code quality review approved (including fixes/re-review).

**Files:** Modify `packages/contract/src/projects.ts`, `packages/contract/src/health.ts` (shared types/CLI enum only), `packages/cezar/src/git-remotes.ts`, `packages/cezar/src/server/forge/index.ts`, `packages/cezar/src/server/forge/types.ts`, `packages/cezar/src/workspace/projects.ts`; create `packages/cezar/src/server/forge/gitlab-hosts.ts`. Tests: existing git-remotes, forge/index, workspace/projects and health-forge tests, plus `forge/gitlab-hosts.test.ts`.

**Interfaces:** Add `namespace: string` and `projectPath: string` to ParsedRemote; keep owner/repo semantics unchanged. Define `GitlabRepoRef = { host: string; projectPath: string }`. `readGitlabHosts(): Promise<ReadonlyMap<string, { host: string; webOrigin: string }>>` reads metadata only, caches with bounded lifetime and preserves the SSH alias mapping. Keep `forgeKindOfRemote` and `resolveForge` synchronous against known-host metadata; asynchronous project discovery warms metadata before classification. Cold unknown hosts remain plain Git and are reclassified after warming without blocking boot.

- [x] Add regression tests for nested groups and unchanged GitHub owner/repo:

```ts
expect(parseRemote('git@gitlab.com:group/sub/project.git')).toMatchObject({
  host: 'gitlab.com', owner: 'sub', repo: 'project',
  namespace: 'group/sub', projectPath: 'group/sub/project',
});
expect(parseRemote('git@github.com:acme/project.git')).toMatchObject({
  owner: 'acme', repo: 'project', projectPath: 'acme/project',
});
```

- [x] Run `npm test -- packages/cezar/src/git-remotes.test.ts packages/cezar/src/server/forge/index.test.ts`; record the new assertion failing before implementation.
- [x] Implement full-path parsing and audit every ParsedRemote construction/owner consumer named in the spec, including parseOwnerName and both handle resolvers. Keep those GitHub-specific. Extend the project provider enum without adding forge to health.
- [x] Test metadata discovery using temporary glab config fixtures: two hosts, SSH aliases, port/protocol mappings, absent CLI/config, unreadable/malformed config and changes after warming. Do not print fixture credentials. Test unknown host remains unknown and no network process runs for classification. Confirm actual glab config path/key handling with local help/source before writing the reader.
- [x] Re-run parser/host/registry/health tests. Keep existing GitHub fork/base/push assertions and health omission assertions passing. Use existing driver factory tests to pin the resolver seam; actual GitLab factory follows Task 2.

## Task 2: Bounded reads, pagination, item identity and provider delegation

- [x] Spec compliance review passed (including fixes/re-review).
- [x] Code quality review approved (including fixes/re-review).

**Files:** Create `packages/cezar/src/server/forge/gitlab.ts`, `gitlab-api.ts`, `gitlab-read.ts`, `gitlab-normalize.ts`, `operations.ts` and corresponding tests. Modify `forge/types.ts`, `forge/github.ts`, `server/github.ts`, `server/server.ts`, `packages/contract/src/github.ts` only for demonstrated additive signals.

**Interfaces:** `gitlabApi<T>(root: string, ref: GitlabRepoRef, path: string, schema: z.ZodType<T>, options?: { method?: 'GET' | 'POST' | 'PUT'; fields?: Record<string, string | number | boolean>; refresh?: boolean }): Promise<T>` executes glab with an explicit hostname and encoded project identity. Define `createGitlabDriver(root: string, ref: GitlabRepoRef): ForgeDriver`. Extend ForgeDriver with `list(opts?): Promise<GithubData>`, `comments(kind, number, refresh?): Promise<ForgeCommentsData>`, `checks(numbers): Promise<GithubChecksData>`, `refStatuses(input: { prs?: number[]; issues?: number[] }): Promise<GithubRefStatusData>`, using existing contract-inferred wire types. `operations.ts` resolves the project driver for the existing route-facing operations. Preserve GithubPrNotFoundError/404 behavior at the changes route.

**Numeric budgets:** Four concurrent glab requests per instance; 15-second read-operation deadline shared by nested reads; each subprocess bounded by remaining deadline; 4 MiB maximum response per subprocess, 8 MiB cumulative per operation; ten pages/1,000 items maximum per list kind; twenty upstream requests per checks/ref-status batch (including pagination); four concurrent detail hydrations within that cap. Detail/merge-state and comment operations also cap at twenty requests. Respect Retry-After cooldown rather than retrying inside the same operation. Enforce shared operation budgets, not a fresh deadline per page. Exhaustion returns the established explicit unavailable/unknown/truncation response; never label failed items not-found.

- [x] Write fixture tests using a command-runner injection for list fields, missing head_pipeline, namespace URL encoding, host arguments and kind-separated references. The initial list must perform no per-MR pipeline hydration. A requested MR checks read must use detail data and match its head.

```ts
// Response fixture: issue IID 1 is closed; MR IID 1 is opened.
expect(result).toMatchObject({
  available: true, issues: { 1: 'completed' }, prs: { 1: 'open' },
});
expect(list.prs[0]?.checks).toBeNull();
```

- [x] Run `npm test -- packages/cezar/src/server/forge/gitlab-read.test.ts` and confirm red.
- [x] Implement a bounded subprocess runner and list/filter reads; parse every boundary with Zod, explicitly set state/scope filters, use user_notes_count for counts. Implement notes, search, recent creations and capped diffs; preserve binary/large-patch omission and head SHA. Single-operation unavailable paths must not throw through the HTTP route.
- [x] Encode opaque versioned GitLab continuation tokens with host/project/kind/filter scope, page size and within-page position. Test a limit of 15 on a 20-row page resumes at row 16, malformed tokens, changing filters, cross-host tokens, missing last-page totals, partial failures and explicit truncation. Follow validated same-origin continuations only; no unrestricted --paginate.
- [x] Normalize issue closed states, conflict versus potential/checking states and unreadable CI exactly as the spec. Keep GitHub GraphQL implementations unchanged. Audit cache keys and mutation invalidation for provider/project/kind/IID and remote changes.
- [x] Delegate existing list/comments/checks/ref-status/changes routes through operations.ts and driver methods. Test both providers at route level, plus unsupported hosts and absent glab. Record upstream call counts for cold/cache-hit/partial-failure and assert budgets/cooldown with fake time.
- [x] Run `npm test -- packages/cezar/src/server/forge packages/cezar/src/server/health-forge.test.ts` plus existing affected route tests.

## Task 3: MR write operations, merge-state and workflow nodes

- [x] Spec compliance review passed (including fixes/re-review).
- [x] Code quality review approved (including fixes/re-review).

**Files:** Create `packages/cezar/src/server/forge/gitlab-write.ts`, `gitlab-merge.ts` and tests. Modify `forge/types.ts`, `forge/github.ts`, `forge/operations.ts`, `server/pr.ts`, `server/server.ts`, `workflows/run.ts` and their existing tests.

**Interfaces:** Keep existing createPR, prStatus, prMergeState, mergePR signatures. Add driver `updatePR(number, input: { ready?: boolean; addLabels?: string[]; reviewers?: string[] }): Promise<{ ok: true } | { ok: false; error: string }>`, and `comment(kind: 'issue' | 'pr', number: number, body: string)` with the same result. This matches existing updatePr and workflow node inputs; title/body/draft changes are not invented as replacement fields. GitLab must resolve reviewer usernames and add labels without dropping existing labels. `normalizeGitlabMergeState(raw: unknown, project: unknown, approval: unknown, checks: unknown): ForgePrMergeState` validates provider inputs and follows the mapping table.

- [x] Write failing tests for no worktree, autosave refusal/failure, push failure, fork target/source, duplicate MR retries, stale expectedHeadSha, unapproved/unknown policy, CI unreadable, concurrent merge and override rejection. Use one same-named branch on two different forks to prove duplicate lookup includes project identities.
- [x] Run `npm test -- packages/cezar/src/server/forge/gitlab-write.test.ts packages/cezar/src/server/forge/gitlab-merge.test.ts`; record red.
- [x] Implement glab-backed writes with explicit source/target identities and existing autosave/push rules. Use actual project merge/squash policy; do not advertise rebase merely because GitLab has a rebase endpoint. Return existing method choices only where semantically executable; unrepresentable policy returns an explanatory unavailable action until an additive contract is justified.
- [x] Implement independent merge normalization; distinguish CE versus EE rule availability and approval snapshot versus policy proof. Fresh merge preflight and expected SHA must both pass. Invalidate matching status/check/diff caches on writes; never auto-retry an uncertain mutation without checking the resulting resource.
- [x] Route task creation and all five github.* workflow nodes through the provider operations, including continued/recovered runs and wait-ci deadlines. Preserve persisted node names and existing GitHub error/response semantics.
- [x] Run targeted write/merge/workflow and route delegation tests with both drivers. No fixture execution may create an actual MR, comment, push or merge upstream.

## Task 4: Automation capabilities, approval snapshots and MR-head checkout

- [x] Spec compliance review passed (including fixes/re-review).
- [x] Code quality review approved (including fixes/re-review).

**Files:** Modify `packages/contract/src/automations.ts`, `packages/cezar/src/automations/types.ts`, `scheduler.ts`, `pr-head.ts`, `task-template.ts`, `store.ts` only where new persisted state requires it, and automation route/CLI entry points. Create `automations/gitlab-poller.ts` and tests; preserve github-poller.ts behavior.

**Interfaces:** Add `pull_request.approval_observed` to the authoritative event contract and reuse its inferred type in storage. Capability metadata reports supported events and a reason per unsupported review event. GitLab poller produces the scheduler's existing normalized candidate/result shape. Approval identity is instance + target project + MR IID + approver ID + approved_at; preserve persisted receipts and their idempotency rules.

- [ ] Add failing tests for three rejected GitLab review triggers at create/update/enable/check/execute boundaries and saved-definition loading. Github existing review events still pass.
- [ ] Add snapshot tests: enable sees retained approvals and launches none; the same snapshot after restart launches none; a new timestamp produces one occurrence; removed/reappearing same timestamp produces none; missing timestamps yield unsupported; errors do not clear baselines; re-enable creates no backlog. CE fixture contains no EE rule fields.
- [ ] Run `npm test -- packages/cezar/src/automations/gitlab-poller.test.ts` and confirm red.
- [ ] Implement the provider poller with bounded candidate discovery, individual approval snapshot reads and persistent enable baseline; do not reuse GitHub timeline reconstruction or install webhooks. Preserve event high-watermark and tie-breaker separately from API continuation.
- [ ] Route MR-head metadata through the provider and validate source project, branch and SHA before checkout. Test forks, missing heads, unavailable API and remote changes without running real network Git commands.
- [ ] Run `npm test -- packages/cezar/src/automations` and affected automation API/CLI tests. Verify no changes to GitHub scheduling, enable/restart behavior or max-record bounds.

## Task 5: Project-aware UI, task references, tooling and dashboard

- [x] Spec compliance review passed (including fixes/re-review).
- [x] Code quality review approved (including fixes/re-review).

**Files:** Modify `packages/cezar/src/runs/task-refs.ts` and tests; `packages/web/src/components/{nav-items,app-shell-container,command-palette}.tsx` (nav-items uses .ts); `packages/web/src/routes/repo-git/repo-branches.tsx`, `routes/task-git/run-git-step.tsx`, forge list/detail/merge and automations views under `routes/github/` and `routes/automations/`; `packages/web/src/lib/i18n/zh-CN.json`; `packages/cezar/src/core/backend-detect.ts`; `packages/cezar/src/workspace/dashboard-forge.ts` and associated tests. Identify exact existing component files with rg before edits; retain route paths.

**Interfaces:** Use contract provider identity from project state, never a handwritten github literal or workspace health forge. Keep extractTaskRefs(task: string): TaskRefs and add explicit GitLab MR/issue URL and MR/!number parsing without changing ambiguous GitHub reference behavior. Keep CLI checks distinct from per-project API readiness.

- [ ] Write failing tests for GitLab sidebar/palette/repository view, simultaneous GitHub/GitLab/plain-Git projects, missing glab hints with Git actions still visible, override action absent, unsupported automation choices disabled with reasons and approval-snapshot help text.

```ts
expect(extractTaskRefs('Review https://lab.example/g/sub/p/-/merge_requests/1 and issue https://lab.example/g/sub/p/-/issues/1'))
  .toMatchObject({ prNumber: 1, issueNumber: 1 });
```

- [ ] Run the affected component tests and `npm test -- packages/cezar/src/runs/task-refs.test.ts`; confirm failures are the requested behavior, not missing test scaffolding.
- [ ] Replace github-only gates with provider-aware checks, show GitLab/MR/Closed wording, keep GitHub wording and existing URLs compatible. Add translations for each new key. Distinguish unknown CI/conflicts from successful state and hide GitLab override controls.
- [ ] Add glab installation/version checks without project credentials in health; keep health forge omission tests. Connect dashboard identities/recent creations to full namespaces and provider labels.
- [ ] Run affected component/registry/dashboard/task-ref tests. Confirm round-trip persistence and reload of same-IID issue/MR references, and two self-managed hosts with distinct identities.

## Task 6: Documentation, integration review and repository gates

- [x] Spec compliance review passed (including fixes/re-review).
- [x] Code quality review approved (including fixes/re-review).

**Files:** Update `docs/reference.md` and relevant existing setup/feature documentation to describe glab authentication, self-managed hosts, missing-CLI degradation and automation limits. Add dry-run GitLab fixtures alongside existing forge fixtures and extend existing web smoke coverage without introducing networked unit tests.

- [ ] Inventory all direct gh imports/calls in platform routes, workflows and automation. Verify each is either deliberately GitHub-only or reached after provider routing; repeat for owner/repo placeholder and cache-key consumers. Review source/target remotes and both continued/new-run construction paths.
- [ ] Add a dry-run smoke case for GitLab lists, item detail, visible checks, MR changes and disabled merge/override/review automation states. Exercise mixed-provider navigation without real platform writes.
- [ ] Run in order: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`. Resolve failures caused by this change; report unrelated baseline/environment failures precisely. Run `npm run test:e2e` separately and report skipped distinctly from passed.
- [ ] Review the final diff against the approved spec and all five Review Focus classes. Preserve user-owned files and do not commit logs or fixture credentials. Only after all required gates pass, create an explicitly staged feature commit; no merge/deploy is part of this task.

## Plan self-review and delivery status

Coverage: provider resolution and parser compatibility (Task 1), bounded reads/batches/pagination/identity (Task 2), writes/merge/workflow routing (Task 3), honest automation capabilities and checkout (Task 4), project UI/reference/tooling/dashboard parity (Task 5), documentation/dry-run/full gates (Task 6). Numeric upstream budgets are specified in Task 2. Health remains workspace-scoped. No GitLab implementation or runtime verification is claimed by this plan.

The user selected subagent-driven execution with review checkmarks. Tasks 1–6 have passed independent spec and quality review after fixes. Source remains uncommitted pending full repository gates; on the Windows dev host the test gates (`npm test`, `test:unit`, `test:package`) fail for pre-existing environmental reasons (file-mode 0o600 vs Windows ACL, `EPERM` temp-dir cleanup, `/bin/sh`/`spawn EINVAL`, 5s default timeouts under parallel load) — none trace to this change. Targeted test reports and detailed rulings are retained in the plan-scoped SDD ledger.

## Whole-review corrections (2026-10-17)

The previous completion/checkmarks describe task-level reviews only. The later independent whole review found eight issues; overall approval is pending the corrections below.

Global constraints remain unchanged: preserve GitHub behavior, no forge field in workspace health, no real upstream mutations for verification, no webhook/audit subsystem, bounded GitLab requests, full instance/project/kind identity, and ordinary Git features without a forge CLI.

1. Reproduce each issue with a failing regression; fix the complete review wave while preserving current uncommitted work.
2. Run covering tests and typechecks, then hand a snapshot-based fix diff to an independent reviewer.
3. Mark each item only after its finding is verified addressed; report repository gate failures individually.

- [x] Scheduled execution validates capabilities and the poller honors selected event types.
- [ ] Partial approval polls cannot consume unseen approvals or establish a partial baseline; bounded polling makes progress.
- [ ] MR/Issue creation and issue label/unlabel triggers use actual provider events.
- [x] GitLab MR-head checkout honors dry-run before invoking platform commands.
- [x] Dashboard cache identity preserves canonical GitLab instance ports.
- [x] MR-head checkout preserves existing Git transport/SSH configuration and explicit fork identity.
- [x] Receipt retry resolves and passes the correct GitLab identity.
- [x] Missing glab retains Commit/Push actions and installation/login guidance.

Review evidence: `.superpowers/sdd/2026-10-16-gitlab-forge-parity/review-fix-report.md` and the subsequent scoped re-review report. No correction is approved merely because its implementation test passes.
