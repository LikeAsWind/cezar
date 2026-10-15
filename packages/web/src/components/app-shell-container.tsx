import { memo, useMemo, type ReactNode } from 'react'
import { useLocale } from '@/lib/i18n'
import { useLocation } from 'react-router'

import { useHealth, useProjectRuns, useProjects, useSkillsUpdate, useStarCount, useTodos, useWorkspaceConfig } from '@/api/queries'
import type { HealthResponse, SkillsUpdateState } from '@open-mercato/cezar-api-client'
import { AppShell, type RepoChip } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette'
import { ListViewProvider } from '@/components/list-view'
import { HostUsageWidget } from '@/components/host-usage-widget'
import { ProviderBannerContainer } from '@/components/provider-banner-container'
import { TaskQuickListContainer } from '@/components/task-quick-list'
import { ToolsMenu } from '@/components/tools-menu'
import { useDocumentTitle } from '@/lib/use-document-title'
import { useActiveProjectId } from '@/lib/project-router'
import { unreadDoneCount } from '@/lib/read-state'
import { runTitle } from '@/lib/task-groups'
import { pageTitleContext } from '@/routes'

/**
 * Derive the sidebar's repo chip from `/api/health`.
 *
 * Null — the chip renders nothing — whenever there is nothing true to say: health hasn't
 * answered yet, or cezar is running outside a git repository (`repo: null`), which is a
 * supported way to run it. An empty chip is honest; "loading…" or a guessed folder name is not.
 *
 * The name is the repo root's basename: `/home/me/Projects/cezar` → `cezar`. Both separators,
 * because the server sends whatever path git gave it, and a trailing one is stripped first so
 * `/repo/` doesn't chip as an empty string.
 */
export function repoChipOf(health: HealthResponse | undefined): RepoChip | null {
  const repo = health?.repo
  if (!repo) return null
  const name = repo.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  if (!name) return null
  return { name, branch: repo.branch }
}

/** Only a checked, still-actionable result earns chrome. An update failure may retain a proven
 * available scope, so keep that signal; all unknown/transient/degraded states stay quiet. */
export function skillsUpdateMarkerOf(state: SkillsUpdateState | undefined): boolean {
  return state?.available === true && (state.status === 'available' || state.status === 'error')
}

/** Workspace chrome stays global; project identity and requests follow the URL registry entry. */
export const AppShellContainer = memo(function AppShellContainer({ children }: { children: ReactNode }) {
  const locale = useLocale()
  const { pathname } = useLocation()
  const projectId = useActiveProjectId()
  const health = useHealth()
  const workspaceConfig = useWorkspaceConfig()
  const branding = workspaceConfig.data?.branding
  const customBranding = branding !== undefined && (
    branding.name !== 'cezar' || branding.logoUrl !== null
  )
  const starCount = useStarCount(!customBranding && workspaceConfig.data !== undefined)
  // The global inbox is opt-in (#471). With the capability off there is no Inbox nav item to
  // badge and the endpoint can only answer [], so the query parks rather than polls.
  const inboxAvailable = health.data?.capabilities.followups === true
  // The server capability also accounts for CEZ_AUTOMATIONS=0.
  const automationsAvailable = health.data?.capabilities.automations === true
  const todos = useTodos(inboxAvailable && projectId !== null, projectId)
  // One query in the shell feeds every rendering of the active project's navigation (desktop,
  // mobile drawer). Routes reuse this TanStack Query cache entry.
  const skillsUpdate = useSkillsUpdate(projectId ?? '', projectId !== null)
  const skillsUpdateAvailable = skillsUpdateMarkerOf(skillsUpdate.data)
  const registry = useProjects().data
  const titleContext = pageTitleContext(pathname)
  const activeProject = registry?.projects.find((project) => project.id === projectId) ?? null
  const projectAvailable = activeProject !== null && activeProject.status !== 'missing'
  const runs = useProjectRuns(projectId ?? '', projectAvailable, unreadDoneCount)
  const titleRunId = titleContext.taskId
  const titleLabel = useProjectRuns(
    projectId ?? '',
    projectAvailable && titleRunId !== null,
    useMemo(
      () => (list) => {
        const run = titleRunId ? list.find((item) => item.id === titleRunId) : undefined
        return run ? runTitle(run) : undefined
      },
      [titleRunId, locale],
    ),
  ).data
  const projectName = activeProject?.name ?? null
  const pageLabel = titleLabel ?? titleContext.pageLabel

  useDocumentTitle({ projectName, pageLabel, brandName: workspaceConfig.data?.branding.name, brandLogoUrl: workspaceConfig.data?.branding.logoUrl })

  const banner = useMemo(() => <ProviderBannerContainer />, [])
  const taskQuickList = useMemo(() => projectAvailable ? <TaskQuickListContainer key={projectId} /> : null, [projectId, projectAvailable])
  // The sidebar glance. Created here, not inside `AppShell`, because the shell stays presentational
  // and QueryClient-free: the widget's own wrapper evaluates the viewport and transport gates and
  // mounts nothing below `md` or in remote, so neither the CSS-hidden column nor a hosted cockpit
  // ever pays for a sample it cannot show.
  const hostWidget = useMemo(() => <HostUsageWidget />, [])
  const toolsMenu = useMemo(() => <ToolsMenu health={health.data} />, [health.data])

  return (
    // The Active/Archived filter is shared by the quick-list below and the Tasks table (Step 3.4),
    // which renders in `children`. The provider goes here because this is the lowest node that has
    // both of them under it — the spec requires the two sets of tabs to be one filter.
    <ListViewProvider>
      <AppShell
        projects={registry?.projects ?? []}
        brandName={workspaceConfig.data?.branding.name ?? 'cezar'}
        brandLogoUrl={workspaceConfig.data?.branding.logoUrl ?? null}
        version={health.data?.version ?? null}
        latestVersion={health.data?.latestVersion ?? null}
        // The ⭐ ask's count. Same honesty rule as the chips above: `available: false` — offline,
        // a rate-limited IP, or promos silenced with `CEZ_NO_BANNER=1` — is `null` here, and
        // AppShell renders no chip for it rather than a button that cannot count.
        starCount={!customBranding && starCount.data?.available ? (starCount.data.count ?? null) : null}
        // `?? null` rather than `?? 0`: no badge while the inbox is unknown, and no badge when it
        // is known to be empty — AppShell renders neither for a falsy count.
        inboxCount={todos.data?.length ?? null}
        // Same `?? null` honesty: no badge while the list is unknown; a loaded list with none
        // unread is 0, which AppShell also renders as no badge.
        unreadCount={runs.data ?? null}
        skillsUpdateAvailable={skillsUpdateAvailable}
        // Forge and tracker identity belong to the selected registry entry, not global health.
        forgeAvailable={activeProject?.forge === 'github'}
        // Hidden unless health reports the opt-in inbox (#471) — same honesty rule as above:
        // the nav must not offer an Inbox this server will never fill.
        inboxAvailable={inboxAvailable}
        // Hidden unless health reports the opt-in automations capability (#801).
        automationsAvailable={automationsAvailable}
        tracker={activeProject?.tracker}
        banner={banner}
        singleProject={health.data?.capabilities.singleProject === true}
        taskQuickList={taskQuickList}
        hostWidget={hostWidget}
        toolsMenu={toolsMenu}
      >
        {children}
      </AppShell>
      {/* Global chrome, not a route: ⌘K must work on every URL. Mounted here (not in AppShell)
          because it needs the query client and router this container already assumes. */}
      <CommandPalette />
    </ListViewProvider>
  )
})
