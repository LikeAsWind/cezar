import { t, useLocale } from '@/lib/i18n'
import {
  Activity,
  CheckCheck,
  CircleAlert,
  CircleHelp,
  CpuIcon,
  GaugeIcon,
} from 'lucide-react'
import { Link } from 'react-router'

import { useDashboardOverview } from '@/api/dashboard-overview'
import { useHostUsage } from '@/api/host-usage'
import { useProjects, useRunsIndex, useWorkspaceConfig } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { OverviewLinkCard } from '@/components/overview-link-card'
import { OverviewSection, PageContent, PageFrame, PageHeader } from '@/components/page-frame'
import { effectiveHostView, formatCpuCores, formatMemPair } from '@/lib/host-effective'
import { readStoredLastLocation, recentProjectLocation } from '@/lib/last-location'
import { cn } from '@/lib/utils'
import { metricAccents, metricSurface, MetricContent } from './dashboard/presentation'
import { buildWorkspaceProjectSummaries } from './workspace-overview-model'

export function WorkspaceHomeRoute() {
  useLocale()

  const projects = useProjects()
  const overview = useDashboardOverview({}, true)
  const runsIndex = useRunsIndex()
  const host = useHostUsage()
  const config = useWorkspaceConfig()

  const registered = projects.data?.projects ?? []
  const summaries = buildWorkspaceProjectSummaries({
    projects: registered,
    dashboardProjects: overview.data?.projects,
    runs: runsIndex.data?.runs,
  })
  const recent = recentProjectLocation(readStoredLastLocation(), projects.data)
  const recentProject = registered.find((project) => project.id === recent?.projectId)
  const metrics = overview.data?.metrics
  const hostView = host === undefined ? null : effectiveHostView(host)

  return (
    <PageFrame data-route="workspace-home">
      <PageHeader
        title={t('Workspace')}
        description={t('This home is not bound to the directory that started Cezar.')}
        actions={(
          <>
            {recent && recentProject ? (
              <Button asChild variant="outline" size="sm">
                <Link to={`${recent.pathname}${recent.search ?? ''}${recent.hash ?? ''}`}>
                  {t('Recent project: {0}', { 0: recentProject.name || recentProject.id })}
                </Link>
              </Button>
            ) : null}
            <Button asChild size="sm">
              <Link to="/projects?register=1">{t('Register project')}</Link>
            </Button>
          </>
        )}
      />

      <PageContent>
        <section aria-label={t('Workspace metrics')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(
            [
              { key: 'needsYou', label: t('Needs attention'), value: metrics?.needsYou, tint: metricAccents.violet, Icon: CircleHelp },
              { key: 'running', label: t('Running'), value: metrics?.running, tint: metricAccents.info, Icon: Activity },
              { key: 'completed', label: t('Completed'), value: metrics?.completed, tint: metricAccents.success, Icon: CheckCheck },
              { key: 'failed', label: t('Failed'), value: metrics?.failed, tint: metricAccents.danger, Icon: CircleAlert },
            ] as const
          ).map(({ key, label, value, tint, Icon }) => (
            <div key={key} className={cn(metricSurface, value === undefined ? metricAccents.neutral : tint)}>
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
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-xs">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <CpuIcon className="size-4 text-soft-foreground" aria-hidden="true" />
              {t('Machine')}
            </h2>
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
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <GaugeIcon className="size-4 text-soft-foreground" aria-hidden="true" />
              {t('Workspace configuration')}
            </h2>
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

        <OverviewSection
          title={t('Projects')}
          description={t('Every project in one place. Open a project from the sidebar, or start a task in one.')}
        >
          {!projects.data ? (
            <p className="text-sm text-muted-foreground">{t('Loading projects…')}</p>
          ) : summaries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center">
              <p className="text-sm font-medium">{t('No projects registered')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('Register a project to see its status and tasks here.')}</p>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {summaries.map((project) => (
                <li key={project.projectId}>
                  <OverviewLinkCard
                    to={`/p/${encodeURIComponent(project.projectId)}/`}
                    title={project.name || project.projectId}
                    description={project.root}
                    status={(
                      <span className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        project.status === 'ok' && 'bg-success/10 text-success',
                        project.status === 'missing' && 'bg-destructive/10 text-destructive',
                        project.status === 'not-git' && 'bg-muted text-muted-foreground',
                      )}>
                        {project.status === 'ok'
                          ? t('Available')
                          : project.status === 'missing'
                            ? t('Missing')
                            : t('Not a Git repository')}
                      </span>
                    )}
                    metadata={(
                      <span className="block whitespace-normal">
                        <span className="block truncate">{t('Branch: {0}', { 0: project.branch ?? '—' })}</span>
                        <span className="block truncate">
                          {t('{0} running · {1} needs attention · {2} failed', {
                            0: project.running ?? '—',
                            1: project.needsAttention ?? '—',
                            2: project.failed ?? '—',
                          })}
                        </span>
                        {project.latestActivity ? (
                          <span className="block truncate">
                            {t('Latest activity: {0}', { 0: new Date(project.latestActivity).toLocaleString() })}
                          </span>
                        ) : null}
                      </span>
                    )}
                  />
                </li>
              ))}
            </ul>
          )}
        </OverviewSection>
      </PageContent>
    </PageFrame>
  )
}
