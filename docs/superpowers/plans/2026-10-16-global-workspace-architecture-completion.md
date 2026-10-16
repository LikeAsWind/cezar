# Global Workspace Architecture Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the global-workspace migration so every project operation is explicitly scoped, overview pages summarize existing data, and changed pages share one responsive UI architecture.

**Architecture:** Workspace and project scopes remain separate at the router, API-client, query-key, CLI, and UI layers. Shared scope utilities make an omitted project impossible, shared overview view models compose existing queries without new endpoints, and shared page primitives own layout and responsive behavior.

**Tech Stack:** TypeScript ESM, Node 20+, Hono, Zod, React 19, React Router, TanStack Query, Tailwind v4, shadcn/ui, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-16-global-workspace-architecture-completion-design.md`

## Global Constraints

- Project APIs exist only below `/api/v1/p/:projectId`; no boot project, `default` alias, or unscoped project route remains.
- Workspace APIs remain below `/api/v1` without a project prefix.
- Reuse existing data and hooks; add no endpoint, polling loop, database, or required configuration.
- All user-facing text uses `t()` and adds a zh-CN entry in the same change.
- All color uses theme/status tokens.
- Mobile interactive targets are at least 44 by 44 CSS pixels.
- Preserve every existing project detail feature and route.
- Write and observe a failing regression test before each production behavior change.

---

## File Structure

### New focused modules

- `packages/cezar/src/cli-project-context.ts` — validates `CEZ_API_URL` and `CEZ_PROJECT_ID` and returns the only supported project API base.
- `packages/cezar/src/cli-project-context.test.ts` — resolver behavior and actionable failures.
- `packages/web/src/components/page-frame.tsx` — shared `PageFrame`, `PageHeader`, `PageContent`, and `OverviewSection` layout primitives.
- `packages/web/src/components/page-frame.test.tsx` — mobile/desktop heading and action semantics.
- `packages/web/src/components/overview-link-card.tsx` — standard whole-card navigation affordance.
- `packages/web/src/routes/workspace-overview-model.ts` — pure combination of project registry and existing dashboard/run summaries.
- `packages/web/src/routes/workspace-overview-model.test.ts` — zero/missing/multiple summary inputs.
- `packages/web/src/routes/project-overview-model.ts` — pure project overview view model assembled from existing query results.
- `packages/web/src/routes/project-overview-model.test.ts` — capability and unavailable-state mapping.

### Existing modules with changed ownership

- `packages/api-client/src/utils/project-scope.ts` — explicit project URL/path builders only.
- `packages/cezar/src/dispatch/task-cli.ts`, `packages/cezar/src/automations/automation-cli.ts`, `packages/cezar/src/runs/runs-cli.ts` — consume the shared CLI resolver.
- `packages/cezar/src/workflows/run.ts` — produce project-scoped run asset URLs.
- `packages/cezar/src/server/server.ts` and route tests — remove `default` alias handling and pin the explicit route inventory.
- `packages/web/src/routes/workspace-home.tsx` — complete workspace overview using the shared model/frame.
- `packages/web/src/routes/project-overview.tsx` — complete project control-panel overview.
- `packages/web/src/routes/settings/projects-section.tsx` — retain storage settings and extract registry content.
- `packages/web/src/routes/projects.tsx` — own project registry page composition.
- `packages/web/src/components/workspace-switcher.tsx` — use the shared menu/item interaction vocabulary.
- `AGENTS.md`, `CLAUDE.md`, `BACKWARD_COMPATIBILITY.md`, `docs/reference.md`, README variants — describe only the explicit-scope architecture.

---

### Task 1: Make project scope mandatory in all CLI clients

**Files:**
- Create: `packages/cezar/src/cli-project-context.ts`
- Create: `packages/cezar/src/cli-project-context.test.ts`
- Modify: `packages/cezar/src/runs/runs-cli.ts`
- Modify: `packages/cezar/src/runs/runs-cli.test.ts`
- Modify: `packages/cezar/src/dispatch/task-cli.ts`
- Modify: `packages/cezar/src/dispatch/task-cli.test.ts`
- Modify: `packages/cezar/src/automations/automation-cli.ts`
- Modify: `packages/cezar/src/automations/automation-cli.test.ts`

**Interfaces:**
- Consumes: `missingCockpitMessage` and environment objects containing optional `CEZ_API_URL`/`CEZ_PROJECT_ID`.
- Produces: `resolveCliProjectContext(env, command): { apiUrl: string; projectId: string; apiBase: string }` and `CliProjectContextError`.

- [x] **Step 1: Write resolver tests that define the mandatory scope**

```ts
it('refuses a project command without CEZ_PROJECT_ID', () => {
  expect(() => resolveCliProjectContext({ CEZ_API_URL: 'http://127.0.0.1:4321' }, 'cez runs'))
    .toThrow('CEZ_PROJECT_ID')
})

it('builds one encoded explicit project base', () => {
  expect(resolveCliProjectContext({
    CEZ_API_URL: 'http://127.0.0.1:4321/',
    CEZ_PROJECT_ID: 'api tools',
  }, 'cez runs')).toEqual({
    apiUrl: 'http://127.0.0.1:4321',
    projectId: 'api tools',
    apiBase: 'http://127.0.0.1:4321/api/v1/p/api%20tools',
  })
})
```

- [x] **Step 2: Run the resolver tests and verify RED**

Run: `npx vitest run packages/cezar/src/cli-project-context.test.ts`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the shared resolver**

```ts
export class CliProjectContextError extends Error {}

export function resolveCliProjectContext(
  env: { CEZ_API_URL?: string; CEZ_PROJECT_ID?: string },
  command: string,
) {
  const apiUrl = env.CEZ_API_URL?.replace(/\/+$/, '')
  if (!apiUrl) throw new CliProjectContextError(`${command}: CEZ_API_URL is required`)
  const projectId = env.CEZ_PROJECT_ID?.trim()
  if (!projectId) {
    throw new CliProjectContextError(
      `${command}: CEZ_PROJECT_ID is required; run \`cezar projects\` and select a project id`,
    )
  }
  return {
    apiUrl,
    projectId,
    apiBase: `${apiUrl}/api/v1/p/${encodeURIComponent(projectId)}`,
  }
}
```

- [x] **Step 4: Add failing command tests proving no request is sent without a project**

For each CLI, call its exported command with `CEZ_API_URL` but no `CEZ_PROJECT_ID`, assert exit `2`, assert stderr contains `CEZ_PROJECT_ID`, and assert the injected `fetch` spy has zero calls.

- [x] **Step 5: Run the three CLI suites and verify RED**

Run: `npx vitest run packages/cezar/src/runs/runs-cli.test.ts packages/cezar/src/dispatch/task-cli.test.ts packages/cezar/src/automations/automation-cli.test.ts`

Expected: FAIL because each command still falls back to `/api/v1`.

- [x] **Step 6: Replace the three local URL builders with the resolver**

Catch `CliProjectContextError` at each command boundary, print its message, return `2`, and make every request relative to `apiBase`.

- [x] **Step 7: Run all four CLI/resolver suites and verify GREEN**

Run: `npx vitest run packages/cezar/src/cli-project-context.test.ts packages/cezar/src/runs/runs-cli.test.ts packages/cezar/src/dispatch/task-cli.test.ts packages/cezar/src/automations/automation-cli.test.ts`

Expected: PASS.

- [x] **Step 8: Commit the CLI scope unit**

```bash
git add packages/cezar/src/cli-project-context.ts packages/cezar/src/cli-project-context.test.ts packages/cezar/src/runs/runs-cli.ts packages/cezar/src/runs/runs-cli.test.ts packages/cezar/src/dispatch/task-cli.ts packages/cezar/src/dispatch/task-cli.test.ts packages/cezar/src/automations/automation-cli.ts packages/cezar/src/automations/automation-cli.test.ts
git commit -m "refactor: require explicit project scope in cockpit CLIs"
```

### Task 2: Remove the final default aliases and scope generated assets

**Files:**
- Modify: `packages/api-client/src/utils/project-scope.ts`
- Modify: `packages/api-client/src/utils/project-scope.test.ts`
- Modify: `packages/cezar/src/server/server.ts`
- Modify: `packages/cezar/src/server/route-parity.test.ts`
- Modify: `packages/cezar/src/server/versioned-surface.test.ts`
- Modify: `packages/cezar/src/server/bc-route-inventory.test.ts`
- Modify: `packages/cezar/src/workflows/run.ts`
- Modify: the focused `packages/cezar/src/workflows/*.test.ts` suite that already asserts generated image descriptors.

**Interfaces:**
- Consumes: real `projectId`, `runId`, and filename.
- Produces: `projectApiPath(projectId, path)` and `runAssetPath(projectId, runId, filename)` with encoded segments.

- [x] **Step 1: Add failing path-builder tests**

```ts
expect(projectApiPath('api tools', '/runs')).toBe('/api/v1/p/api%20tools/runs')
expect(runAssetPath('api tools', 'run/1', 'a b.png'))
  .toBe('/api/v1/p/api%20tools/runs/run%2F1/images/a%20b.png')
```

- [x] **Step 2: Run project-scope tests and verify RED**

Run: `npx vitest run packages/api-client/src/utils/project-scope.test.ts`

Expected: FAIL because `runAssetPath` is absent and path encoding is not centralized.

- [x] **Step 3: Implement the explicit builders and remove default-sentinel exports**

Keep workspace `apiPath()` separate. `projectApiPath` rejects an empty project ID and appends a normalized project-relative path.

- [x] **Step 4: Add failing server tests for removed aliases**

Assert representative unscoped project URLs and `/api/v1/p/default/runs` return 404, while `/api/v1/p/<real>/runs` continues to answer.

- [x] **Step 5: Run route suites and verify RED for the remaining default alias**

Run: `npx vitest run packages/cezar/src/server/route-parity.test.ts packages/cezar/src/server/versioned-surface.test.ts packages/cezar/src/server/bc-route-inventory.test.ts`

- [x] **Step 6: Delete `default` resolution from project middleware and inventories**

The normal project slug validator remains the only resolver. Do not replace the alias with a redirect or registry lookup.

- [x] **Step 7: Add a failing generated-image test**

Construct the existing run/workflow fixture with `projectId: 'alpha'` and assert its returned descriptor URL is `/api/v1/p/alpha/runs/<id>/images/<name>`.

- [x] **Step 8: Thread the owning project ID into `runAssetPath`**

Use the project identity already carried by the run manager/session. Do not read process cwd or registry order.

- [x] **Step 9: Run builder, server, and workflow suites and verify GREEN**

Run: `npx vitest run packages/api-client/src/utils/project-scope.test.ts packages/cezar/src/server/route-parity.test.ts packages/cezar/src/server/versioned-surface.test.ts packages/cezar/src/server/bc-route-inventory.test.ts packages/cezar/src/workflows`

- [x] **Step 10: Commit the explicit API surface**

```bash
git add packages/api-client/src/utils/project-scope.ts packages/api-client/src/utils/project-scope.test.ts packages/cezar/src/server/server.ts packages/cezar/src/server/route-parity.test.ts packages/cezar/src/server/versioned-surface.test.ts packages/cezar/src/server/bc-route-inventory.test.ts packages/cezar/src/workflows/run.ts packages/cezar/src/workflows
git commit -m "refactor: finish explicit project API addressing"
```

### Task 3: Establish shared page and overview interaction primitives

**Files:**
- Create: `packages/web/src/components/page-frame.tsx`
- Create: `packages/web/src/components/page-frame.test.tsx`
- Create: `packages/web/src/components/overview-link-card.tsx`
- Modify: `packages/web/src/components/workspace-switcher.tsx`
- Modify: `packages/web/src/components/workspace-switcher.test.tsx`

**Interfaces:**
- Produces: `PageFrame`, `PageHeader`, `PageContent`, `OverviewSection`, and `OverviewLinkCard`.
- Consumes: existing `Button`, router `Link`, `cn`, theme tokens, and translated strings supplied by callers.

- [x] **Step 1: Write failing page-frame tests**

Render a frame at default and mobile test classes and assert one accessible `h1`, a visible mobile title element, a description association, and a single actions region.

- [x] **Step 2: Run the new component suite and verify RED**

Run: `npx vitest run packages/web/src/components/page-frame.test.tsx`

Expected: FAIL because the components do not exist.

- [x] **Step 3: Implement the page primitives using the repository frame classes**

`PageHeader` renders a compact mobile bar and the sticky desktop `h-14` header from one title/description prop set. `PageContent` owns `p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5`.

- [x] **Step 4: Write failing `OverviewLinkCard` behavior tests**

Assert one link owns the full card, it exposes a visible focus ring, accepts status/metadata slots, and uses no nested interactive element.

- [x] **Step 5: Implement `OverviewLinkCard` and migrate switcher item styling**

Keep Radix/menu semantics for switcher rows. Extract one shared item class/variant instead of converting menu options into nested standalone buttons.

- [x] **Step 6: Run component tests and verify GREEN**

Run: `npx vitest run packages/web/src/components/page-frame.test.tsx packages/web/src/components/workspace-switcher.test.tsx`

- [x] **Step 7: Commit the shared UI vocabulary**

```bash
git add packages/web/src/components/page-frame.tsx packages/web/src/components/page-frame.test.tsx packages/web/src/components/overview-link-card.tsx packages/web/src/components/workspace-switcher.tsx packages/web/src/components/workspace-switcher.test.tsx
git commit -m "refactor: add shared overview page primitives"
```

### Task 4: Complete the workspace overview

**Files:**
- Create: `packages/web/src/routes/workspace-overview-model.ts`
- Create: `packages/web/src/routes/workspace-overview-model.test.ts`
- Modify: `packages/web/src/routes/workspace-home.tsx`
- Modify: `packages/web/src/routes/workspace-home.test.tsx`
- Modify: `packages/web/src/lib/i18n/zh-CN.json`

**Interfaces:**
- Consumes: project registry entries, dashboard project/task metrics, and existing run-index timestamps.
- Produces: `buildWorkspaceProjectSummaries(input): WorkspaceProjectSummary[]`.

- [x] **Step 1: Write pure view-model tests**

Cover an empty registry, missing per-project metrics, a missing-root project, tags/branch/forge preservation, counts by project ID, and latest activity selection.

- [x] **Step 2: Run the model suite and verify RED**

Run: `npx vitest run packages/web/src/routes/workspace-overview-model.test.ts`

- [x] **Step 3: Implement the pure summary builder**

The function performs only deterministic joins and sorting. It does not import React, query hooks, timers, or clients.

- [x] **Step 4: Add failing route tests for zero-project completeness and rich cards**

Assert zero projects still renders metrics, Machine, Workspace configuration, the explanatory workspace sentence, and a registration action. With one project, assert branch/status/task counts and one explicit `/p/<id>/` link.

- [x] **Step 5: Run the route suite and verify RED**

Run: `npx vitest run packages/web/src/routes/workspace-home.test.tsx`

Expected: FAIL because zero projects still replace the page and project cards contain only name/path.

- [x] **Step 6: Rebuild the page with shared primitives and the summary model**

Remove the early return. Keep metric tiles as true numeric `metricSurface` elements; use ordinary cards for resources and project summaries. Use a 44-pixel mobile registration action.

- [x] **Step 7: Add all new translation keys and run i18n coverage**

Run: `npx vitest run packages/web/src/lib/i18n-coverage.test.ts packages/web/src/routes/workspace-home.test.tsx packages/web/src/routes/workspace-overview-model.test.ts`

- [x] **Step 8: Commit the workspace overview**

```bash
git add packages/web/src/routes/workspace-overview-model.ts packages/web/src/routes/workspace-overview-model.test.ts packages/web/src/routes/workspace-home.tsx packages/web/src/routes/workspace-home.test.tsx packages/web/src/lib/i18n/zh-CN.json
git commit -m "feat: complete the workspace overview"
```

### Task 5: Build the project overview control panel

**Files:**
- Create: `packages/web/src/routes/project-overview-model.ts`
- Create: `packages/web/src/routes/project-overview-model.test.ts`
- Modify: `packages/web/src/routes/project-overview.tsx`
- Create: `packages/web/src/routes/project-overview.test.tsx`
- Modify: `packages/web/src/lib/i18n/zh-CN.json`

**Interfaces:**
- Consumes: active project registry entry and existing project-scoped runs, worktrees, repository/forge, tracker, automation, skills, workflows, and capability results.
- Produces: a serializable `ProjectOverviewModel` whose sections contain status, concise metadata, and one existing route destination.

- [x] **Step 1: Write view-model tests for every section**

Cover connected/unconfigured/unavailable integrations, disabled capabilities, non-Git projects, missing metrics, and counts derived from existing arrays.

- [x] **Step 2: Run the model suite and verify RED**

Run: `npx vitest run packages/web/src/routes/project-overview-model.test.ts`

- [x] **Step 3: Implement the pure project overview builder**

Use discriminated section status values (`ready`, `unconfigured`, `unavailable`, `disabled`) so the component does not reproduce integration-specific condition trees.

- [x] **Step 4: Add failing route tests for content and navigation**

Assert the six required areas render, their links remain inside `/p/<id>`, unavailable states are named, and exactly one “Back to global workspace” link exists in the composed shell.

- [x] **Step 5: Run the project overview/shell suites and verify RED**

Run: `npx vitest run packages/web/src/routes/project-overview.test.tsx packages/web/src/components/app-shell.test.tsx`

- [x] **Step 6: Implement the overview with `PageFrame`, `OverviewSection`, and `OverviewLinkCard`**

Remove the route-local Back button. Query only through existing enabled project hooks; disabled capabilities must not issue their detail request.

- [x] **Step 7: Run project overview, shell, query, and translation suites and verify GREEN**

Run: `npx vitest run packages/web/src/routes/project-overview-model.test.ts packages/web/src/routes/project-overview.test.tsx packages/web/src/components/app-shell.test.tsx packages/web/src/api/queries.test.tsx packages/web/src/lib/i18n-coverage.test.ts`

- [x] **Step 8: Commit the project control panel**

```bash
git add packages/web/src/routes/project-overview-model.ts packages/web/src/routes/project-overview-model.test.ts packages/web/src/routes/project-overview.tsx packages/web/src/routes/project-overview.test.tsx packages/web/src/lib/i18n/zh-CN.json
git commit -m "feat: complete the project overview"
```

### Task 6: Separate project management from project storage settings

**Files:**
- Modify: `packages/web/src/routes/settings/projects-section.tsx`
- Modify: `packages/web/src/routes/settings/projects-section.test.tsx`
- Modify: `packages/web/src/routes/projects.tsx`
- Create: `packages/web/src/routes/projects.test.tsx`
- Modify: `packages/web/src/routes/settings/settings.test.tsx`
- Modify: `packages/web/src/lib/i18n/zh-CN.json`

**Interfaces:**
- Produces: `ProjectsRegistry`, `ProjectStorageSettings`, and the existing single registration dialog contract.
- Consumes: existing project mutations, workspace configuration mutations, and `register=1` query state.

- [x] **Step 1: Add failing ownership tests**

Assert `/projects` renders registry controls but not default browse/checkout settings. Assert global project settings render those storage settings and a link to `/projects`, but not the complete registry table.

- [x] **Step 2: Run project/settings suites and verify RED**

Run: `npx vitest run packages/web/src/routes/projects.test.tsx packages/web/src/routes/settings/projects-section.test.tsx packages/web/src/routes/settings/settings.test.tsx`

- [x] **Step 3: Extract focused content components without duplicating query ownership**

Keep the current mutation hooks in the component that owns each operation. Pass data/action props to row and dialog presentation components rather than mounting the same query twice.

- [x] **Step 4: Compose `/projects` with the shared page frame**

Use one primary Register project action and preserve `/projects?register=1` deep linking. Row opening uses `OverviewLinkCard` or `Button asChild`; secondary edit/remove operations live in `ProjectRowActions`.

- [x] **Step 5: Run project/settings/i18n suites and verify GREEN**

Run: `npx vitest run packages/web/src/routes/projects.test.tsx packages/web/src/routes/settings/projects-section.test.tsx packages/web/src/routes/settings/settings.test.tsx packages/web/src/lib/i18n-coverage.test.ts`

- [x] **Step 6: Commit the ownership split**

```bash
git add packages/web/src/routes/settings/projects-section.tsx packages/web/src/routes/settings/projects-section.test.tsx packages/web/src/routes/projects.tsx packages/web/src/routes/projects.test.tsx packages/web/src/routes/settings/settings.test.tsx packages/web/src/lib/i18n/zh-CN.json
git commit -m "refactor: separate project registry and storage settings"
```

### Task 7: Migrate remaining pages to the shared frame and pin responsive behavior

**Files:**
- Modify: `packages/web/src/routes/global-tasks.tsx`
- Modify: `packages/web/src/routes/projects.tsx`
- Modify: `packages/web/src/routes/workspace-home.tsx`
- Modify: `packages/web/src/routes/project-overview.tsx`
- Modify: `packages/web/src/routes.test.tsx`
- Modify: `packages/web/src/design-guardian.test.ts`

**Interfaces:**
- Consumes: shared page primitives from Task 3.
- Produces: consistent accessible headings and responsive page actions on all changed global/overview pages.

- [x] **Step 1: Add failing structural tests**

Assert one `h1` per route, one page action region, shared frame data slots, no duplicated sticky-header class blocks, and mobile action variants with a 44-pixel minimum height.

- [x] **Step 2: Run route/design guardian tests and verify RED**

Run: `npx vitest run packages/web/src/routes.test.tsx packages/web/src/design-guardian.test.ts`

- [x] **Step 3: Replace remaining copied frames with shared primitives**

Do not change route data or actions while migrating layout. Keep page-specific content in each route.

- [x] **Step 4: Run route, shell, guardian, and changed-page tests and verify GREEN**

Run: `npx vitest run packages/web/src/routes.test.tsx packages/web/src/design-guardian.test.ts packages/web/src/components/app-shell.test.tsx packages/web/src/routes/workspace-home.test.tsx packages/web/src/routes/project-overview.test.tsx packages/web/src/routes/projects.test.tsx`

- [x] **Step 5: Commit the frame migration**

```bash
git add packages/web/src/routes/global-tasks.tsx packages/web/src/routes/projects.tsx packages/web/src/routes/workspace-home.tsx packages/web/src/routes/project-overview.tsx packages/web/src/routes.test.tsx packages/web/src/design-guardian.test.ts
git commit -m "refactor: unify workspace and overview page frames"
```

### Task 8: Rewrite the maintained architecture contract and remove stale semantics

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `BACKWARD_COMPATIBILITY.md`
- Modify: `docs/reference.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.zh-TW.md`
- Modify: source comments/tests returned by the legacy scan.

**Interfaces:**
- Consumes: completed explicit-scope behavior from Tasks 1–7.
- Produces: one maintained description of the workspace/project architecture.

- [x] **Step 1: Capture the legacy-semantic scan as the task checklist**

Run:

```bash
rg -n "bootProject|boot project|/p/default|api/v1/p/default|optional CEZ_PROJECT_ID|unscoped.*project|project the cockpit was started in|three-way.*parity" AGENTS.md CLAUDE.md BACKWARD_COMPATIBILITY.md docs README.md README.zh-CN.md README.zh-TW.md packages --glob '!packages/cezar/web/dist/**'
```

Classify every result as a maintained statement to rewrite, a historical changelog/spec that stays, or a test deliberately asserting absence.

- [x] **Step 2: Rewrite maintained documentation and source comments**

Document mandatory `CEZ_PROJECT_ID`, explicit project API examples, the two scopes, zero-project behavior, shared page rules, and the clarified numeric-metric exception for `metricSurface`.

- [x] **Step 3: Run documentation and contract guard tests**

Run: `npx vitest run packages/cezar/src/server/bc-route-inventory.test.ts packages/cezar/src/server/versioned-surface.test.ts packages/web/src/design-guardian.test.ts packages/web/src/lib/i18n-coverage.test.ts`

- [x] **Step 4: Repeat the scan and inspect every remaining hit**

Expected: only historical documents/changelog entries and negative tests remain. Maintained instructions and executable source contain no old promise.

- [x] **Step 5: Commit the architecture contract**

```bash
git add AGENTS.md CLAUDE.md BACKWARD_COMPATIBILITY.md docs/reference.md README.md README.zh-CN.md README.zh-TW.md
# Add only the exact source/test files identified and changed by Steps 1-4.
git commit -m "docs: finalize explicit workspace project architecture"
```

### Task 9: Full verification and fresh UI/code review

**Files:**
- Modify only files required to fix regressions discovered by the verification commands, with a failing regression test before each fix.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: verified implementation and a fresh ten-finding closure report.

- [x] **Step 1: Run the full automated suite**

Run: `npm test`

Expected: all test files pass with zero failures.

- [x] **Step 2: Run all workspace typechecks**

Run: `npm run typecheck`

Expected: exit 0 for contract, client, server, and web.

- [x] **Step 3: Build the production artifacts**

Run: `npm run build`

Expected: server, web, and package checks exit 0.

- [x] **Step 4: Run the final legacy/API scan**

Verify there are no executable unscoped project URL constructors, `default` project sentinels, optional CLI project fallbacks, or maintained documentation promises.

- [x] **Step 5: Run real-browser responsive review**

Start the local cockpit and inspect `/`, `/projects`, `/tasks`, `/settings/global/projects`, and one complete `/p/:projectId/` route at 375, 768, and 1440 pixels. Verify visible page identity, no horizontal overflow, 44-pixel mobile actions, correct single primary action, error/empty states, keyboard focus, and no console errors.

- [x] **Step 6: Re-run design review**

Review the rendered changed pages against the approved spec. Record each original finding as resolved or still open with screenshot evidence.

- [x] **Step 7: Re-run two-axis code review**

Review the final branch diff against repository standards and this spec. Resolve every P0/P1 regression before proceeding.

- [x] **Step 8: Verify the final diff is surgical and clean**

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Expected: only intentional files, no whitespace errors, and the pre-existing untracked `.superpowers/` and `packages/cezar/.ai/` remain untouched.

- [x] **Step 9: Commit any review-driven regression fixes separately**

Use one focused commit per independently testable regression. Do not combine unrelated review cleanup.
