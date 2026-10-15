import { t, useLocale } from '@/lib/i18n'
import {
  Activity,
  CheckCheck,
  CircleAlert,
  CircleHelp,
  CpuIcon,
  GaugeIcon,
  LayoutDashboardIcon,
} from 'lucide-react'
import { Link } from 'react-router'

import { useDashboardOverview } from '@/api/dashboard-overview'
import { useHostUsage } from '@/api/host-usage'
import { useProjects, useWorkspaceConfig } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { effectiveHostView, formatCpuCores, formatMemPair } from '@/lib/host-effective'
import { readStoredLastLocation, recentProjectLocation } from '@/lib/last-location'

/**
 * The fixed global workspace home — the one page outside every `/p/:projectId`.
 *
 * It is a dashboard over data that already exists at the workspace level: the cross-project
 * outcome metrics (`useDashboardOverview`), the machine's resource usage (`useHostUsage`), the
 * workspace configuration (`useWorkspaceConfig`) and the project registry (`useProjects`). No
 * second polling loop — the overview and host-usage hooks already own their freshness.
 *
 * Every project action is an explicit `/p/:projectId/` link. This page renders outside every
 * project scope, so the scope-aware `Link` (which would prefix the active project) is never used;
 * a remembered recent project is offered only as an explicit link too.
 *
 * It wears the same page frame as every other global page (tasks, projects, settings): the sticky
 * `h-14` header with a `text-base` title beside its description, and `rounded-lg border bg-card`
 * cards. The Dashboard's `metricSurface` hairline tiles and centered `max-w-[…]` layout stay on
 * the Dashboard — this is a cockpit page, not a landing page.
 */
export function WorkspaceHomeRoute() {
  useLocale()

  const projects = useProjects()
  const overview = useDashboardOverview({}, true)
  const host = useHostUsage()
  const config = useWorkspaceConfig()

  const recent = recentProjectLocation(readStoredLastLocation(), projects.data)
  const recentProject = projects.data?.projects.find((project) => project.id === recent?.projectId)
  const registered = projects.data?.projects ?? []

  // Zero-project: the one state that is not a dashboard, because there is nothing to summarize.
  // Gated on the registry having answered — an empty cache (still loading) is not "no projects".
  if (projects.data !== undefined && registered.length === 0) {
    return (
      <div data-route="workspace-home" className="flex min-h-full flex-col">
        <CenteredState
          icon={<LayoutDashboardIcon />}
          tone="primary"
          title={t('Workspace')}
          subtitle={t('No projects registered')}
          backdrop
          actions={
            <Button asChild>
              <Link to="/projects?register=1">{t('Register project')}</Link>
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            {t('This home is not bound to the directory that started Cezar.')}
          </p>
        </CenteredState>
      </div>
    )
  }

  const metrics = overview.data?.metrics
  const hostView = host === undefined ? null : effectiveHostView(host)

  return (
    <div data-route="workspace-home" className="flex min-h-full flex-col">
      {/* The shared global-page header. Below `md` it is hidden and the shell's top bar owns the
          title, exactly like the other global pages. */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">{t('Workspace')}</h1>
        <p className="text-[13px] text-soft-foreground">
          {t('Every project in one place. Open a project from the sidebar, or start a task in one.')}
        </p>
        {recent && recentProject ? (
          <Link
            to={`${recent.pathname}${recent.search ?? ''}${recent.hash ?? ''}`}
            className="ml-auto text-sm text-primary underline"
          >
            {t('Recent project: {0}', { 0: recentProject.name || recentProject.id })}
          </Link>
        ) : null}
      </header>

      <div className="flex flex-1 flex-col gap-4 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        <section aria-label={t('Workspace metrics')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(
            [
              { key: 'needsYou', label: t('Needs attention'), value: metrics?.needsYou, Icon: CircleHelp },
              { key: 'running', label: t('Running'), value: metrics?.running, Icon: Activity },
              { key: 'completed', label: t('Completed'), value: metrics?.completed, Icon: CheckCheck },
              { key: 'failed', label: t('Failed'), value: metrics?.failed, Icon: CircleAlert },
            ] as const
          ).map(({ key, label, value, Icon }) => (
            <div key={key} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4 shadow-xs">
              <span className="flex items-center justify-between gap-2 text-[13px] font-medium text-muted-foreground">
                {label}
                <Icon className="size-4 text-soft-foreground" aria-hidden="true" />
              </span>
              <span className="mt-1 text-2xl font-semibold tabular-nums">
                {value === undefined ? '—' : value}
              </span>
              <span className="text-xs text-soft-foreground">{t('Across every project')}</span>
            </div>
          ))}
        </section>

        <section aria-label={t('Workspace resources')} className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-xs">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CpuIcon className="size-4 text-soft-foreground" aria-hidden="true" />
              {t('Machine')}
            </div>
            {hostView === null ? (
              <p className="text-sm text-muted-foreground">{t('Sampling…')}</p>
            ) : (
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>
                  {t('CPU')}{' '}
                  <span className="font-mono tabular-nums text-foreground">
                    {hostView.cpuPct === undefined ? '—' : `${Math.round(hostView.cpuPct)}%`}
                  </span>{' '}
                  · {formatCpuCores(hostView.cpuCores)}
                </p>
                <p>
                  {t('Memory')}{' '}
                  <span className="font-mono tabular-nums text-foreground">
                    {formatMemPair(hostView.memUsedBytes, hostView.memTotalBytes)}
                  </span>
                </p>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-xs">
            <div className="flex items-center gap-2 text-sm font-medium">
              <GaugeIcon className="size-4 text-soft-foreground" aria-hidden="true" />
              {t('Workspace configuration')}
            </div>
            {config.data === undefined ? (
              <p className="text-sm text-muted-foreground">{t('Loading…')}</p>
            ) : (
              <div className="space-y-1 text-sm text-muted-foreground">
                <p className="text-foreground">{config.data.branding.name}</p>
                <p>
                  {t('Max parallel')}{' '}
                  <span className="font-mono tabular-nums text-foreground">{config.data.resources.maxParallel}</span>
                </p>
                <p>
                  {t('Memory limit')}{' '}
                  <span className="font-mono tabular-nums text-foreground">
                    {config.data.resources.memoryLimitMb ?? t('Unlimited')}
                  </span>
                </p>
              </div>
            )}
          </div>
        </section>

        <section aria-label={t('Projects')} className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">{t('Projects')}</h2>
            <Button asChild variant="outline" size="sm">
              <Link to="/projects?register=1">{t('Register project')}</Link>
            </Button>
          </div>
          {!projects.data ? (
            <p className="text-sm text-muted-foreground">{t('Loading projects…')}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {registered.map((project) => (
                <li key={project.id}>
                  <Link
                    to={`/p/${encodeURIComponent(project.id)}/`}
                    className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 shadow-xs transition-colors hover:bg-card-2"
                  >
                    <span className="text-sm font-medium text-foreground">
                      {t('Open {0}', { 0: project.name || project.id })}
                    </span>
                    <span
                      className="truncate font-mono text-[11px] text-soft-foreground"
                      title={project.root}
                    >
                      {project.root}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
