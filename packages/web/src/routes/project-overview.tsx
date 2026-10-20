import { useProjectScope } from '@/api/project-scope-context'
import {
  useProjectRuns,
  useProjects,
  useRepo,
  useSkills,
  useTrackerAssociation,
  useTrackerConnection,
  useWorkflows,
  useWorktrees,
} from '@/api/queries'
import { Activity, CheckCheck, CircleAlert, CircleHelp } from 'lucide-react'
import { OverviewLinkCard } from '@/components/overview-link-card'
import { OverviewSection, PageContent, PageFrame, PageHeader } from '@/components/page-frame'
import { t, useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { metricAccents, metricSurface, MetricContent } from './dashboard/presentation'
import { useAutomationsGate, useAutomationsQuery } from './automations/use-automations'
import { buildProjectOverviewModel, type OverviewStatus } from './project-overview-model'

const statusLabels: Record<OverviewStatus, string> = {
  ready: 'Ready',
  unconfigured: 'Not configured',
  unavailable: 'Unavailable',
  disabled: 'Disabled',
}

function Status({ status }: { status: OverviewStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
      status === 'ready' ? 'bg-success/10 text-success'
        : status === 'unavailable' ? 'bg-destructive/10 text-destructive'
          : 'bg-muted text-muted-foreground'
    }`}>
      {t(statusLabels[status])}
    </span>
  )
}

export function ProjectOverviewRoute() {
  useLocale()

  const { projectId } = useProjectScope()
  const projects = useProjects()
  const project = projects.data?.projects.find((entry) => entry.id === projectId)
  const projectAvailable = project !== undefined && project.status !== 'missing'
  const runs = useProjectRuns(projectId ?? '', projectId !== null && projectAvailable)
  const worktrees = useWorktrees()
  const repo = useRepo()
  const trackerAssociation = useTrackerAssociation()
  const trackerConnection = useTrackerConnection()
  const skills = useSkills(projectId !== null && projectAvailable, projectId)
  const workflows = useWorkflows({ enabled: projectId !== null && projectAvailable })
  const automationGate = useAutomationsGate()
  const automations = useAutomationsQuery(automationGate.known && !automationGate.off && projectId !== null && projectAvailable)

  if (!projects.data) {
    return (
      <PageFrame data-route="project-overview">
        <PageHeader title={t('Project overview')} />
        <PageContent><p className="text-sm text-muted-foreground">{t('Loading projects…')}</p></PageContent>
      </PageFrame>
    )
  }

  if (!project) {
    return (
      <PageFrame data-route="project-overview">
        <PageHeader title={t('Project overview')} />
        <PageContent><p className="text-sm text-muted-foreground">{t('Project is not registered')}</p></PageContent>
      </PageFrame>
    )
  }

  const model = buildProjectOverviewModel({
    project,
    runs: runs.data,
    worktrees: worktrees.data,
    repo: repo.data,
    trackerAssociation: trackerAssociation.data,
    trackerConnection: trackerConnection.data,
    automations: automations.data,
    automationsEnabled: automationGate.known ? !automationGate.off : undefined,
    skills: skills.data,
    workflows: workflows.data,
  })

  return (
    <PageFrame data-route="project-overview">
      <PageHeader title={t('Project overview')} />
      <PageContent>
        <h2 className="text-sm font-semibold">{project.name || project.id}</h2>

        {/* Per-project status metrics — the same needs-you / running / completed / failed rungs
            as the workspace home, scoped to THIS project, and (like that home) the first row. */}
        <section aria-label={t('Project metrics')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(
            [
              { slot: 'task-metric-needs-attention', label: t('Needs attention'), value: model.tasks.needsAttention, tint: metricAccents.violet, Icon: CircleHelp },
              { slot: 'task-metric-running', label: t('Running'), value: model.tasks.running, tint: metricAccents.info, Icon: Activity },
              { slot: 'task-metric-completed', label: t('Completed'), value: model.tasks.completed, tint: metricAccents.success, Icon: CheckCheck },
              { slot: 'task-metric-failed', label: t('Failed'), value: model.tasks.failed, tint: metricAccents.danger, Icon: CircleAlert },
            ] as const
          ).map(({ slot, label, value, tint, Icon }) => (
            <div key={slot} data-slot={slot} className={cn(metricSurface, value === null ? metricAccents.neutral : tint)}>
              <MetricContent label={label} value={value === null ? '—' : value} icon={<Icon className="size-4" />}>
                {t('In this project')}
              </MetricContent>
            </div>
          ))}
        </section>

        <div className="grid gap-5 lg:grid-cols-2">
          <OverviewSection title={t('Project identity')}>
            <OverviewLinkCard
              to={model.identity.to}
              title={model.identity.name}
              description={model.identity.root}
              status={<Status status={model.identity.status} />}
              metadata={(
                <span className="block space-y-1 whitespace-normal">
                  <span className="block">{t('Registry status: {0}', { 0: t(model.identity.registryStatusLabel) })}</span>
                  <span className="block">{t('Branch: {0}', { 0: model.identity.branch ?? '—' })}</span>
                  <span className="block">{t('Forge: {0}', { 0: model.identity.forge ?? t('Not configured') })}</span>
                  {model.identity.tags.length > 0 ? <span className="block">{t('Tags: {0}', { 0: model.identity.tags.join(', ') })}</span> : null}
                </span>
              )}
            />
          </OverviewSection>

          <OverviewSection title={t('Tasks & Worktrees')}>
            <OverviewLinkCard
              to={model.tasks.to}
              title={t('Tasks & Worktrees')}
              status={<Status status={model.tasks.status} />}
              metadata={(
                <span className="block whitespace-normal">
                  <span className="block">{t('{0} worktrees', { 0: model.tasks.worktrees ?? '—' })}</span>
                </span>
              )}
            />
          </OverviewSection>

          <OverviewSection title={t('Git / {0}', { 0: model.identity.forge === 'gitlab' ? t('GitLab') : t('GitHub') })}>
            <OverviewLinkCard
              to={model.git.to}
              title={t('Repository')}
              status={<Status status={model.git.status} />}
              metadata={(
                <span className="block space-y-1 whitespace-normal">
                  <span className="block">{t('Branch: {0}', { 0: model.git.branch ?? '—' })}</span>
                  <span className="block">{t('Forge status: {0}', { 0: t(statusLabels[model.git.forgeStatus]) })}</span>
                </span>
              )}
            />
          </OverviewSection>

          <OverviewSection title={t('Tracker')}>
            <OverviewLinkCard
              to={model.tracker.to}
              title={t('Tracker')}
              status={<Status status={model.tracker.status} />}
              metadata={t(model.tracker.summary.key, model.tracker.summary.values)}
            />
          </OverviewSection>

          <OverviewSection title={t('Automations')}>
            <OverviewLinkCard
              to={model.automations.to}
              title={t('Automations')}
              status={<Status status={model.automations.status} />}
              metadata={t(model.automations.summary.key, model.automations.summary.values)}
            />
          </OverviewSection>

          <OverviewSection title={t('Skills & workflows')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <OverviewLinkCard
                to={model.skillsAndWorkflows.skillsTo}
                title={t('Skills')}
                status={<Status status={model.skillsAndWorkflows.status} />}
                metadata={t(model.skillsAndWorkflows.skillsSummary.key, model.skillsAndWorkflows.skillsSummary.values)}
              />
              <OverviewLinkCard
                to={model.skillsAndWorkflows.workflowsTo}
                title={t('Workflows')}
                status={<Status status={model.skillsAndWorkflows.status} />}
                metadata={t(model.skillsAndWorkflows.workflowsSummary.key, model.skillsAndWorkflows.workflowsSummary.values)}
              />
            </div>
          </OverviewSection>
        </div>
      </PageContent>
    </PageFrame>
  )
}
