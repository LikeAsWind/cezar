import { t, useLocale } from '@/lib/i18n'
import { lazy, memo, Suspense } from 'react'
import { FolderSearchIcon } from 'lucide-react'
import {
  Link,
  matchPath,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router'

import { useHealth, useProjects } from './api/queries'
import { ProjectScopeProvider } from './api/project-scope-context'
import { Button } from './components/ui/button'
import { Navigate as ScopedNavigate, resolveLegacyProjectId, stripProjectPrefix } from './lib/project-router'
import { AutomationsLoading } from './routes/automations/automations-loading'
import { CompareLoading } from './routes/compare-loading'
import { GithubLoading } from './routes/github/github-loading'
import { InboxRoute } from './routes/inbox'
import { NewTaskRoute } from './routes/new-task'
import { NotFoundRoute } from './routes/not-found'
import { RepoGitLoading } from './routes/repo-git/repo-git-loading'
import { SkillsLoading } from './routes/skills-loading'
import { MissingProjectRoute, UnknownProjectRoute } from './routes/unknown-project'
import { WorkspaceHomeRoute } from './routes/workspace-home'
import { WorkflowsLoading } from './routes/workflows/workflows-loading'
import { GitTabLoading } from './routes/task-git/git-tab-loading'
import { ThreadLoading } from './routes/task-thread/thread-loading'
import { visibleSettingsSections, type SettingsSectionId } from './routes/settings/registry'
import {
  SettingsIndexRoute,
  SettingsSectionRoute,
  settingsSectionPath,
} from './routes/settings/settings-shell'
import { TasksOverviewRoute } from './routes/tasks-overview'
import { GlobalTasksRoute } from './routes/global-tasks'
import { ProjectsRoute } from './routes/projects'
import { ProjectOverviewRoute } from './routes/project-overview'
import { CenteredState } from './components/centered-state'

// Dashboard charts, drag controls and exports are paid for only on this route.
const DashboardRoute = lazy(() =>
  import('./routes/dashboard').then((m) => ({ default: m.DashboardRoute })),
)

/** Lazy ON PURPOSE: the thread view carries the markdown stack (Streamdown + remark/rehype,
 *  ~140 KB gz) — as a static import it would sit in the main bundle every visitor pays for
 *  before any route renders. The Suspense fallback is the same loading state the route itself
 *  shows while fetching, so the split is invisible to the user. */
const TaskThreadRoute = lazy(() =>
  import('./routes/task-thread/task-thread').then((m) => ({ default: m.TaskThreadRoute })),
)

/** Lazy for the same reason: the compare view renders Progress excerpts through Streamdown and
 *  full diffs through the Shiki singleton — thread-chunk weight the home screen must not pay. */
const CompareVariantsRoute = lazy(() =>
  import('./routes/compare-variants').then((m) => ({ default: m.CompareVariantsRoute })),
)

/** Lazy because both tabs render the shared run header, which lives in the thread chunk
 *  (markdown stack and all) — a static import here would pull that into the main bundle. */
const TaskChangesRoute = lazy(() =>
  import('./routes/task-git/task-changes').then((m) => ({ default: m.TaskChangesRoute })),
)
const TaskFilesRoute = lazy(() =>
  import('./routes/task-git/task-files').then((m) => ({ default: m.TaskFilesRoute })),
)
const TaskCommitsRoute = lazy(() =>
  import('./routes/task-git/task-commits').then((m) => ({ default: m.TaskCommitsRoute })),
)
const TaskNotesRoute = lazy(() =>
  import('./routes/task-thread/task-notes').then((m) => ({ default: m.TaskNotesRoute })),
)

/** Lazy because the repo view renders through the `<Diff>` facade and the Shiki singleton —
 *  the same heavy chunk the task git tabs ride; the home screen must not pay for it. */
const RepoGitRoute = lazy(() =>
  import('./routes/repo-git/repo-git').then((m) => ({ default: m.RepoGitRoute })),
)

/** Lazy because the GitHub detail pane renders issue/PR bodies through the same markdown
 *  stack the thread carries — thread-chunk weight the home screen must not pay. */
const GithubRoute = lazy(() =>
  import('./routes/github/github').then((m) => ({ default: m.GithubRoute })),
)
const TrackerRoute = lazy(() =>
  import('./routes/tracker/tracker').then((m) => ({ default: m.TrackerRoute })),
)

/** The live workflow graph of a task (same spec, phase 3) — the editor's chunk, loaded lazily. */
const TaskGraphRoute = lazy(() =>
  import('./routes/workflow-graph/task-graph').then((m) => ({ default: m.TaskGraphRoute })),
)

/** The workflow node editor (spec 2026-09-30-workflow-node-editor) — the Workflows surface. Lazy
 *  so React Flow stays out of the main bundle. */
const WorkflowGraphRoute = lazy(() =>
  import('./routes/workflow-graph/workflow-graph').then((m) => ({ default: m.WorkflowGraphRoute })),
)

/** Lazy because the skill detail renders the skill body through the same markdown stack the
 *  thread carries — thread-chunk weight the home screen must not pay (it used to ride the main
 *  bundle as a static Settings section). */
const SkillsRoute = lazy(() => import('./routes/skills').then((m) => ({ default: m.SkillsRoute })))

/** Lazy because the surface carries the editor (templates, schedule/GitHub fields, a next-five-
 *  runs preview), the week/day calendars, and the log — ~3k lines nothing outside this route
 *  imports, and now that automations are on by default, every visitor would otherwise pay for
 *  it before ever opening `/automations`. */
const AutomationsRoute = lazy(() =>
  import('./routes/automations/automations-route').then((m) => ({ default: m.AutomationsRoute })),
)

/** `/settings/skills` moved to the top-level `/skills` (out of the Settings shell). Redirect —
 *  preserving the `?skill=` selection and any hash — so pasted links and saved bookmarklets
 *  still land. The scoped Navigate keeps the redirect inside the active project. */
function SettingsSkillsRedirect() {
  useLocale()

  const location = useLocation()
  const legacySkill = new URLSearchParams(location.search).get('skill')
  if (legacySkill === '__bm') {
    return <ScopedNavigate to={{ pathname: '/settings/bookmarklets', hash: location.hash }} replace />
  }
  return (
    <ScopedNavigate
      to={{ pathname: '/skills', search: location.search, hash: location.hash }}
      replace
    />
  )
}

/** A settings section that MOVED from the project area to the global one. Its own hop, not an
 *  inline `<Navigate>`, because `settingsSectionPath` returns a bare pathname: only a component
 *  can read `useLocation` and carry the query and hash across. Legacy flat URLs reach here on a
 *  SECOND hop (`LegacyPathRedirect` first), and dropping either half there would silently undo
 *  what that hop just preserved. Plain Navigate — the target is outside every project. */
function MovedSettingsSectionRedirect({ sectionId }: { sectionId: SettingsSectionId }) {
  useLocale()

  const location = useLocation()
  return (
    <Navigate
      to={{
        pathname: settingsSectionPath('global', sectionId),
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  )
}

/** What renders while a project's registry row is still being resolved. Deliberately quiet: the
 *  answer arrives in one local round trip, and any real screen here would flash the WRONG screen
 *  (spec, "URL scheme"). */
function ScopeResolving() {
  useLocale()

  return (
    <div data-route="scope-resolving" className="flex min-h-full flex-col">
      <p className="px-4 py-6 text-center text-xs text-soft-foreground">{t('Loading…')}</p>
    </div>
  )
}

function ProjectRegistryError({ retry }: { retry: () => void }) {
  return (
    <CenteredState
      icon={<FolderSearchIcon />}
      title={t('Could not load projects')}
      actions={
        <>
          <Button onClick={retry}>{t('Retry')}</Button>
          <Button asChild variant="outline"><Link to="/">{t('Back to global workspace')}</Link></Button>
        </>
      }
    />
  )
}

/** Only a registered, available project may mount project queries and page state. */
function ProjectScopeRoute() {
  useLocale()

  const { projectId = '' } = useParams()
  const location = useLocation()
  const projects = useProjects()

  if (!projects.data) {
    if (projects.isError) return <ProjectRegistryError retry={() => void projects.refetch()} />
    return <ScopeResolving />
  }

  if (projectId === 'default') {
    const resolved = resolveLegacyProjectId(projects.data)
    if (resolved === null) return <UnknownProjectRoute registry={projects.data} />
    const rest = stripProjectPrefix(location.pathname)
    return <Navigate to={`/p/${encodeURIComponent(resolved)}${rest}${location.search}${location.hash}`} replace />
  }

  const project = projects.data.projects.find((entry) => entry.id === projectId)
  if (!project) return <UnknownProjectRoute projectId={projectId} registry={projects.data} />
  if (project.status === 'missing') return <MissingProjectRoute project={project} />

  return (
    <ProjectScopeProvider projectId={projectId}>
      {/* React Router keeps the matched child mounted when only this parent param changes.
          Project-local queries and mount-time state must instead start from the project the URL
          now names. Key the child boundary (not the provider, whose unmount resets API scope). */}
      <Outlet key={projectId} />
    </ProjectScopeProvider>
  )
}

/**
 * The composer, remounted per project (multi-project spec, step 3.4).
 *
 * A `/p/:projectId` param change alone re-renders the SAME `NewTaskRoute` instance — React
 * Router matches the same route element either way. That is fine for the queries (their keys
 * carry the scope) but wrong for the composer's mount-time state: the draft is read once from
 * the departing project's storage key, and the write-back effect would then persist it under
 * the arriving project's key — exactly the draft leak the per-project keys exist to prevent.
 * Keying on the project makes the swap a real unmount/mount, so the draft, the pickers and the
 * deep-link capture all start from the project the URL now names.
 */
function NewTaskProjectRoute() {
  useLocale()

  const { projectId = '' } = useParams()
  return <NewTaskRoute key={projectId} />
}

/** Old flat URLs resolve only through the registry's one-available-project compatibility rule. */
function LegacyPathRedirect() {
  useLocale()

  const location = useLocation()
  const projects = useProjects()

  if (!projects.data) {
    if (projects.isError) return <ProjectRegistryError retry={() => void projects.refetch()} />
    return <ScopeResolving />
  }

  const projectId = resolveLegacyProjectId(projects.data)
  if (projectId === null) return <UnknownProjectRoute registry={projects.data} />

  // A bare `/p` (or `/p/`) names no project — send it to the project's home rather than
  // minting a nonsense `/p/<id>/p` path.
  const path = location.pathname === '/p' || location.pathname === '/p/' ? '/' : location.pathname
  return (
    <Navigate
      to={`/p/${encodeURIComponent(projectId)}${path}${location.search}${location.hash}`}
      replace
    />
  )
}

export interface PageTitleContext {
  pageLabel: string | null
  taskId: string | null
}

const PAGE_TITLE_ROUTES = [
  { pattern: '/', get pageLabel() { return t('Workspace') } },
  // The global page. It is not project-scoped, so it never carries a `/p/` prefix to strip —
  // but it goes through the same table, because the browser title is one mechanism.
  { pattern: '/tasks', get pageLabel() { return t('All tasks') } },
  { pattern: '/projects', get pageLabel() { return t('Projects') } },
  { pattern: '/dashboard', get pageLabel() { return t('Dashboard') } },
  { pattern: '/new', get pageLabel() { return t('New task') } },
  { pattern: '/compare/:groupId', get pageLabel() { return t('Compare') } },
  { pattern: '/git/*', get pageLabel() { return t('Git') } },
  { pattern: '/github/*', get pageLabel() { return t('GitHub') } },
  { pattern: '/tracker/*', get pageLabel() { return t('Tracker') } },
  { pattern: '/automations/*', get pageLabel() { return t('Automations') } },
  { pattern: '/skills', get pageLabel() { return t('Skills') } },
  { pattern: '/inbox', get pageLabel() { return t('Inbox') } },
  { pattern: '/workflows/*', get pageLabel() { return t('Workflows') } },
  { pattern: '/settings/*', get pageLabel() { return t('Settings') } },
] as const

/** Browser-title context from the project-relative route map; raw ids are lookup keys only. */
export function pageTitleContext(pathname: string): PageTitleContext {
  const projectPath = stripProjectPrefix(pathname)
  if (pathname !== projectPath) {
    if (projectPath === '/') return { pageLabel: t('Overview'), taskId: null }
    if (projectPath === '/tasks') return { pageLabel: t('Tasks'), taskId: null }
  }
  const task = matchPath({ path: '/tasks/:id/*', end: true }, projectPath)
  if (task) return { pageLabel: null, taskId: task.params.id ?? null }

  const route = PAGE_TITLE_ROUTES.find(({ pattern }) =>
    matchPath({ path: pattern, end: true }, projectPath),
  )
  return { pageLabel: route?.pageLabel ?? null, taskId: null }
}

/** The route map from the spec's "Routing — every surface is a URL" section.
 *
 *  Real URLs, not hash routes: the Hono server serves the built index.html for
 *  every non-/api GET (src/server/static-ui.ts `resolveGetRequest`), so each of
 *  these cold-loads and survives a refresh — `/p/…` paths included.
 *
 *  Every path lives under `/p/:projectId/` (multi-project spec, step 3.2) via the one
 *  `ProjectScopeRoute` layout above; the flat spellings below are relative to that prefix and
 *  stay stable — they are what teammates paste, and the legacy flat URLs redirect onto them.
 */
export const AppRoutes = memo(function AppRoutes() {
  useLocale()

  const capabilities = useHealth().data?.capabilities
  return (
    <Routes>
      {/* The fixed global workspace home — `/` is never a redirect (task 5, step 3). */}
      <Route index element={<WorkspaceHomeRoute />} />

      <Route path="/p/:projectId" element={<ProjectScopeRoute />}>
        <Route index element={<ProjectOverviewRoute />} />
        <Route path="tasks" element={<TasksOverviewRoute />} />
        <Route path="new" element={<NewTaskProjectRoute />} />

        <Route
          path="tasks/:id"
          element={
            <Suspense fallback={<ThreadLoading />}>
              <TaskThreadRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/changes"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskChangesRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/files"
          element={
            <Suspense fallback={<GitTabLoading tab="files" />}>
              <TaskFilesRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/graph"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskGraphRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/commits"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskCommitsRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/notes"
          element={
            <Suspense fallback={<GitTabLoading tab="notes" />}>
              <TaskNotesRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/commits/:sha"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskCommitsRoute />
            </Suspense>
          }
        />
        <Route
          path="compare/:groupId"
          element={
            <Suspense fallback={<CompareLoading />}>
              <CompareVariantsRoute />
            </Suspense>
          }
        />

        {/* The repo view (R5 Step 1.7): each segment is a URL — /git (working-tree changes),
            /git/commits (+ /:sha for one commit's diff), /git/branches. */}
        <Route
          path="git"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="changes" />
            </Suspense>
          }
        />
        <Route
          path="git/commits"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="commits" />
            </Suspense>
          }
        />
        <Route
          path="git/commits/:sha"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="commits" />
            </Suspense>
          }
        />
        <Route
          path="git/branches"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="branches" />
            </Suspense>
          }
        />
        {/* The repository file browser (#1279). Two routes, because a file path contains slashes:
            the bare tab, and the splat that carries the selected file so `/git/files/a/b.ts` is the
            file's own address. */}
        <Route
          path="git/files"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="files" />
            </Suspense>
          }
        />
        <Route
          path="git/files/*"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="files" />
            </Suspense>
          }
        />
        {/* The GitHub tab (R6 Step 1.1): issues and PRs are separate list URLs, each item a
            deep link. The nav item is forge-gated in the shell; the routes stay reachable so a
            pasted link renders the honest unavailable explainer instead of a 404. The bare
            `/github` is the one URL that restores the last-selected tab (#417) — `/github/prs`
            and the `:n` deep links are always exactly what they say. */}
        <Route
          path="github"
          element={
            <Suspense fallback={<GithubLoading />}>
              {/* `GithubRoute` itself, with `index`, rather than a wrapper component: React
                  reconciles by element type, so any other type here would unmount the route on
                  the hop to `github/issues/:n` and reset its search text — losing the very
                  cross-state hit the user clicked (#730). The `prs` pair below already renders
                  one type across its two paths, which is why it never had that bug. */}
              <GithubRoute view="issues" index />
            </Suspense>
          }
        />
        <Route
          path="tracker"
          element={<Suspense fallback={<ScopeResolving />}><TrackerRoute /></Suspense>}
        />
        <Route
          path="tracker/:id"
          element={<Suspense fallback={<ScopeResolving />}><TrackerRoute /></Suspense>}
        />
        <Route
          path="github/prs"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="prs" />
            </Suspense>
          }
        />
        <Route
          path="github/issues/:n"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="issues" />
            </Suspense>
          }
        />
        <Route
          path="github/prs/:n"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="prs" />
            </Suspense>
          }
        />
        <Route
          path="github/prs/:n/changes"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="prs" changes />
            </Suspense>
          }
        />
        <Route
          path="automations"
          element={
            <Suspense fallback={<AutomationsLoading />}>
              <AutomationsRoute />
            </Suspense>
          }
        />
        <Route
          path="automations/new"
          element={
            <Suspense fallback={<AutomationsLoading />}>
              <AutomationsRoute mode="new" />
            </Suspense>
          }
        />
        <Route
          path="automations/:automationId"
          element={
            <Suspense fallback={<AutomationsLoading />}>
              <AutomationsRoute mode="edit" />
            </Suspense>
          }
        />
        <Route
          path="automations/:automationId/log"
          element={
            <Suspense fallback={<AutomationsLoading />}>
              <AutomationsRoute mode="log" />
            </Suspense>
          }
        />

        {/* The skills catalog (R6 Step 1.4) — its own top-level surface, no settings sub-nav.
            `/settings/skills` redirects here (below) so pasted links keep working. */}
        <Route
          path="skills"
          element={
            <Suspense fallback={<SkillsLoading />}>
              <SkillsRoute />
            </Suspense>
          }
        />

        {/* The follow-up inbox (R6 Step 1.2): light — no markdown stack — so it rides the main
            bundle like the overview does. */}
        <Route path="inbox" element={<InboxRoute />} />

        {/* The workflow node editor (spec 2026-09-30-workflow-node-editor): /workflows opens a new
            canvas, /workflows/:name deep-links a saved workflow (v1 files open as graphs). */}
        <Route
          path="workflows"
          element={
            <Suspense fallback={<WorkflowsLoading />}>
              <WorkflowGraphRoute />
            </Suspense>
          }
        />
        <Route
          path="workflows/:name"
          element={
            <Suspense fallback={<WorkflowsLoading />}>
              <WorkflowGraphRoute />
            </Suspense>
          }
        />
        {/* The editor's preview address while it was built beside the old builder. */}
        <Route path="workflows-new/*" element={<ScopedNavigate to="/workflows" replace />} />

        {/* Settings (R6 Step 1.3): registry-driven — the section list, nav and routes all come
            from routes/settings/registry.tsx. Hidden sections are NOT routed, so their URLs are
            honest 404s until the section ships (notifications unhides in Step 1.7).

            Only the PROJECT-scoped sections live here (multi-project spec, step 3.5); the
            global ones are the top-level `/settings/global/*` block below. */}
        <Route path="settings" element={<SettingsIndexRoute scope="project" capabilities={capabilities} />} />
        <Route path="settings/skills" element={<SettingsSkillsRedirect />} />
        {/* Prompt templates folded into Settings → Instructions; old links land on the list. */}
        <Route
          path="settings/prompt-templates"
          element={<ScopedNavigate to={{ pathname: '/settings/instructions', hash: '#prompt-templates' }} replace />}
        />
        {visibleSettingsSections('project', capabilities).map((section) => (
          <Route
            key={section.id}
            path={`settings/${section.id}`}
            element={<SettingsSectionRoute section={section} scope="project" capabilities={capabilities} />}
          />
        ))}
        {/* A section that MOVED out of the project area keeps its old URL working: every
            pre-3.5 bookmark and every legacy flat `/settings/appearance` (which the redirect
            below turns into `/p/<boot>/settings/appearance`) lands on the global twin instead
            of a 404 — query and hash intact across both hops. */}
        {visibleSettingsSections('global', capabilities).map((section) => (
          <Route
            key={section.id}
            path={`settings/${section.id}`}
            element={<MovedSettingsSectionRedirect sectionId={section.id} />}
          />
        ))}

        <Route path="*" element={<NotFoundRoute />} />
      </Route>

      {/* The global Tasks page — the second cockpit area outside `/p/:projectId`, and outside it
          for the same reason global settings are: "every project's tasks" scoped to one project
          is a contradiction. Its data is the workspace-level run index, which is never
          scope-prefixed.

          EXACTLY `/tasks`, never `/tasks/*`: `/tasks/:id` is a legacy flat task link and must
          resolve through the legacy project-selection rule (`LegacyPathRedirect` below owns it).
          React Router ranks this static segment above that `*`, so the two never compete. */}
      <Route path="/tasks" element={<GlobalTasksRoute />} />
      <Route
        path="/projects"
        element={visibleSettingsSections('global', capabilities).some((section) => section.id === 'projects')
          ? <ProjectsRoute />
          : <NotFoundRoute />}
      />
      <Route path="/dashboard" element={<Suspense fallback={<div role="status" className="p-6 text-sm text-muted-foreground">{t('Loading dashboard…')}</div>}><DashboardRoute /></Suspense>} />

      {/* Global settings (multi-project spec, step 3.5) — the one cockpit area that is NOT
          under `/p/:projectId`, because nothing here belongs to a project: appearance and
          notifications are the user's, resources are the machine's, and the Projects pane IS
          the registry. No `ProjectScopeProvider` above it, so its sections must read/write the
          workspace routes (`/api/workspace/*`), which are never scope-prefixed.

          Static segments outrank the `*` legacy redirect below in React Router's ranking, so
          these win regardless of order — listed here for readability. */}
      <Route path="/settings/global" element={<SettingsIndexRoute scope="global" capabilities={capabilities} />} />
      {visibleSettingsSections('global', capabilities).map((section) => (
        <Route
          key={section.id}
          path={settingsSectionPath('global', section.id)}
          element={<SettingsSectionRoute section={section} scope="global" capabilities={capabilities} />}
        />
      ))}

      {/* Everything else IS a legacy flat URL, resolved through the one-unambiguous-project rule.
          The workspace home (`/`), global tasks, the dashboard and global settings are matched by
          the static segments above, so `/` never reaches this redirect. */}
      <Route path="*" element={<LegacyPathRedirect />} />
    </Routes>
  )
})
