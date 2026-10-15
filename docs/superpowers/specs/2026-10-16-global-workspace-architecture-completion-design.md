# Global Workspace Architecture Completion

## Status

Approved design for completing the global-workspace migration introduced by
`2026-10-14-global-workspace-project-ui-design.md`. This fork does not preserve
compatibility with boot-project or unscoped project APIs.

## Goal

Finish the global-workspace architecture as one coherent system: workspace data is
global, project data always names a registered project, overview pages summarize the
existing product rather than duplicating detail screens, and every changed page uses
the same layout and interaction vocabulary.

## Non-goals

- No compatibility proxy for unscoped project APIs.
- No boot project, default project, remembered implicit project, or automatic first-row selection.
- No new backend data source, polling loop, configuration key, or database.
- No duplication of project detail features on overview pages.
- No unrelated redesign of existing task, Git, tracker, automation, skill, or workflow screens.

## Scope model

The application has exactly two scopes.

### Workspace scope

- `/` — workspace overview.
- `/tasks` — tasks across registered projects.
- `/projects` — project registry and project management.
- `/settings/global/*` — workspace configuration.
- Workspace HTTP APIs remain directly under `/api/v1`.

### Project scope

- Every project page is under `/p/:projectId/*`.
- Every project HTTP API is under `/api/v1/p/:projectId/*`.
- A project ID is always explicit and must name a registered project.
- `/p/default`, `/api/v1/p/default/*`, and unscoped project APIs do not exist.
- Zero projects and multiple projects are normal states; neither permits guessing a project.

## Explicit API addressing

Project API helpers require `projectId: string` in their public signatures. Project query
keys include the real project ID. A missing project ID fails before a request is sent.
Workspace helpers never consult project scope.

The three cockpit CLIs share one project-context resolver:

```ts
interface CliProjectContext {
  apiUrl: string
  projectId: string
  apiBase: string
}

function resolveCliProjectContext(
  env: { CEZ_API_URL?: string; CEZ_PROJECT_ID?: string },
  command: string,
): CliProjectContext
```

`cez runs`, `cez task`, and `cez automation` use this resolver. Missing `CEZ_API_URL` or
`CEZ_PROJECT_ID` produces one consistent actionable error, exits with status 2, and sends
no request.

All generated project resource URLs use shared builders. A run image URL includes the
project ID:

```text
/api/v1/p/<projectId>/runs/<runId>/images/<filename>
```

Each segment is encoded independently. Hand-written project API URL concatenation is not
allowed outside the shared scope utilities.

## Shared page architecture

Changed overview and management pages use shared layout primitives rather than copying
Tailwind class strings:

- `PageFrame` owns the full-height page structure.
- `PageHeader` owns desktop and mobile titles, description, and page actions.
- `PageContent` owns responsive page padding and safe-area spacing.
- `MetricGrid` owns responsive metric layout.
- `OverviewSection` owns a heading, optional description/action, and section spacing.
- `OverviewLinkCard` is the standard whole-card navigation affordance.
- `EmptySection` renders an empty state inside its parent page instead of replacing the page.

The primitives preserve the established visual language: sticky `h-14` desktop headers,
left-aligned content, theme tokens, standard card surfaces, and compact desktop density.
Mobile pages always expose a visible current-page title.

## Workspace overview

The workspace home remains useful with zero, one, or many projects. It contains:

1. Cross-project task metrics: needs attention, running, completed, failed.
2. Machine resources and workspace concurrency/memory configuration.
3. A project summary collection.
4. A zero-project empty section when the registry is empty.

The page always explains that the workspace is not bound to the directory that launched
Cezar. An empty registry does not hide metrics, machine resources, or workspace settings.

Each project summary combines existing registry and dashboard data into this view model:

```ts
interface WorkspaceProjectSummary {
  projectId: string
  name: string
  root: string
  status: 'ok' | 'missing' | 'not-git'
  branch?: string
  forge?: string
  tags?: readonly string[]
  running: number | null
  needsAttention: number | null
  failed: number | null
  latestActivity?: string
}
```

Unavailable derived metrics render as an em dash. The view model combines already-fetched
registry, dashboard overview, and runs-index data; it introduces no request or polling loop.

## Project overview

The project overview is a control panel, not a second copy of every project feature. It
contains six summary areas:

1. Project identity and health: name, root, branch, registry status, tags, forge.
2. Tasks and worktrees: current task metrics, worktree count, and a link to Tasks & Worktrees.
3. Git and GitHub: repository/forge status and a link to Git / GitHub.
4. Tracker: configured, unavailable, or not connected, with a link when the capability exists.
5. Automations: feature availability and configured/running summary from existing data.
6. Skills and workflows: counts or availability from existing project queries and links to details.

The overview view model is assembled from existing project-scoped hooks. It must not introduce
a new aggregate backend endpoint. Every summary has one job and one detail link. Editing remains
on the owning detail/settings page.

The project shell owns the sole “Back to global workspace” action. Project pages do not duplicate it.

## Project management ownership

The current settings-owned project section is separated by responsibility:

- `ProjectsRegistry` owns registered project rows, status, register, update, open, and remove actions.
- `ProjectStorageSettings` owns the default browse and checkout directories.
- `RegisterProjectDialog` remains the single registration flow used by `/projects?register=1`.
- `ProjectRowActions` owns secondary row actions.

`/projects` renders `ProjectsRegistry`. `/settings/global/projects` renders
`ProjectStorageSettings` and links to `/projects`; it does not duplicate the full registry.

## Interaction vocabulary

- `Button` represents explicit actions.
- `Button asChild` represents button-like navigation.
- `OverviewLinkCard` represents a whole-card overview destination.
- Menu/list primitives represent selector rows; they use shared menu-item styling rather than
  pretending every row is a standalone page button.
- `StatusBadge` communicates status and is never clickable.
- A page has at most one primary action.
- Mobile interactive targets are at least 44 by 44 CSS pixels.
- Compact desktop navigation may use 36-pixel height with a visible focus ring.

## Visual rules

- All color comes from theme and semantic status tokens.
- Ordinary content uses the standard `rounded-lg border bg-card shadow-xs` surface.
- True numeric metrics may use shared `metricSurface` and `metricAccents`.
- Dashboard-only page composition, centered max-width wrappers, and large landing headers do not
  move into ordinary overview or management pages.
- Paths use the established monospace text style; explanatory text uses the body typography.
- Empty states stay inside the section whose data is empty unless the entire route is invalid.

These rules replace the contradictory instruction that both prohibited and required
`metricSurface` on ordinary pages.

## Legacy removal

The implementation and documentation remove all remaining references that imply support for:

- `bootProject` or a repository-bound `serve` process.
- `/p/default` or `/api/v1/p/default/*`.
- unscoped project routes such as `/api/v1/runs`.
- optional `CEZ_PROJECT_ID` for project CLI commands.
- automatic routing to the first, recent, or launch-directory project.
- three-way unscoped/scoped/default route parity.

Old flat browser URLs that cannot identify a project render project selection. They never guess.
New UI links and bookmarklets always carry the real project ID.

`AGENTS.md`, `CLAUDE.md`, `BACKWARD_COMPATIBILITY.md`, `docs/reference.md`, README examples,
tests, and source comments must describe the same explicit-scope architecture.

## Error states

- Missing CLI project ID: actionable stderr, exit 2, zero network requests.
- Unknown project ID: 404.
- Registered project with missing root: 409 and the existing repair/remove actions.
- Project registry unavailable: retryable full-route state; no project provider mounts.
- Zero projects: complete workspace overview plus a project-section registration action.
- Capability disabled or integration unconfigured: explicit local status, not a blank section.

## Testing

Every behavior change follows red-green TDD. Coverage includes:

- CLI resolver and all three CLI commands with missing and valid project IDs.
- Project API URL builders, including encoded segments.
- Absence of unscoped and `default` project routes.
- Project query/cache isolation by real project ID.
- Workspace overview with zero, one, and multiple projects.
- Workspace project summary composition without additional requests.
- Project overview content, capability states, and detail destinations.
- Exactly one “Back to global workspace” action.
- Registry/settings responsibility split and `/projects?register=1`.
- Mobile visible page titles, 44-pixel targets, and no horizontal overflow.
- Translation coverage for all new user-facing text.

Final verification runs the complete typecheck, full test suite, production build, route/contract
parity tests, and real-browser checks at mobile, tablet, and desktop widths. A fresh design review
and two-axis code review must find no unresolved issue from the original ten-item audit.

## Acceptance criteria

1. Every project operation names a real project in its URL, types, cache key, events, and generated assets.
2. No source, test, or maintained documentation promises boot/default/unscoped project behavior.
3. Workspace and project overview pages summarize the existing product using existing data only.
4. Zero-project workspace mode remains informative and fully navigable.
5. Project management and project storage settings have distinct, non-duplicated responsibilities.
6. Changed pages use shared page and interaction primitives across desktop and mobile.
7. Existing project detail functionality remains reachable and behaviorally unchanged.
8. Full automated and rendered-page verification passes before completion is claimed.
