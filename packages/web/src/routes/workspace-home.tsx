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
import { Card } from '@/components/ui/card'
import { effectiveHostView, formatCpuCores, formatMemPair } from '@/lib/host-effective'
import { readStoredLastLocation, recentProjectLocation } from '@/lib/last-location'
import { cn } from '@/lib/utils'
import { metricAccents, metricSurface, MetricContent } from './dashboard/presentation'

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
            <Link to="/projects?register=1" className="text-sm text-primary underline">
              {t('Register project')}
            </Link>
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
    <div
      data-route="workspace-home"
      className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:px-8 md:py-7"
    >
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t('Workspace')}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Every project in one place. Open a project from the sidebar, or start a task in one.')}
          </p>
        </div>
        {recent && recentProject ? (
          <Link
            to={`${recent.pathname}${recent.search ?? ''}${recent.hash ?? ''}`}
            className="text-sm text-primary underline"
          >
            {t('Recent project: {0}', { 0: recentProject.name || recentProject.id })}
          </Link>
        ) : null}
      </header>

      <section aria-label={t('Workspace metrics')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(
          [
            { key: 'needsYou', label: t('Needs attention'), value: metrics?.needsYou, tint: metricAccents.violet, Icon: CircleHelp },
            { key: 'running', label: t('Running'), value: metrics?.running, tint: metricAccents.info, Icon: Activity },
            { key: 'completed', label: t('Completed'), value: metrics?.completed, tint: metricAccents.success, Icon: CheckCheck },
            { key: 'failed', label: t('Failed'), value: metrics?.failed, tint: metricAccents.danger, Icon: CircleAlert },
          ] as const
        ).map(({ key, label, value, tint, Icon }) => (
          <div
            key={key}
            className={cn(metricSurface, value === undefined ? metricAccents.neutral : tint)}
          >
            <MetricContent
              label={label}
              value={value === undefined ? '—' : value}
              icon={<Icon className="size-4" />}
            >
              {t('Across every project')}
            </MetricContent>
          </div>
        ))}
      </section>

      <section aria-label={t('Workspace resources')} className="grid gap-3 md:grid-cols-2">
        <Card className="gap-4 py-4">
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
        </Card>
        <Card className="gap-4 py-4">
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
        </Card>
      </section>

      <section aria-label={t('Projects')} className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t('Projects')}</h2>
          <Link to="/projects?register=1" className="text-sm text-primary underline">
            {t('Register project')}
          </Link>
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
  )
}
