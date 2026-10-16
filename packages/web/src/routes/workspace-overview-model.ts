import type { DashboardOverview, ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

type DashboardProjectMetrics = Pick<DashboardOverview['projects'][number], 'projectId' | 'running' | 'needsYou' | 'failed'>
type RunTimestamps = Pick<RunIndexEntry, 'projectId' | 'createdAt' | 'startedAt' | 'finishedAt'>

export type WorkspaceProjectSummary = {
  projectId: string
  name: string
  root: string
  status: ProjectListEntry['status']
  branch?: string
  forge?: ProjectListEntry['forge']
  tags?: string[]
  running: number | null
  needsAttention: number | null
  failed: number | null
  latestActivity?: string
}

export function buildWorkspaceProjectSummaries(input: {
  projects: readonly ProjectListEntry[]
  dashboardProjects?: readonly DashboardProjectMetrics[]
  runs?: readonly RunTimestamps[]
}): WorkspaceProjectSummary[] {
  const metricsByProject = new Map(input.dashboardProjects?.map((metrics) => [metrics.projectId, metrics]))
  const latestByProject = new Map<string, { timestamp: number; value: string }>()

  for (const run of input.runs ?? []) {
    for (const value of [run.createdAt, run.startedAt, run.finishedAt]) {
      if (value === undefined) continue
      const timestamp = Date.parse(value)
      if (!Number.isFinite(timestamp)) continue
      const current = latestByProject.get(run.projectId)
      if (!current || timestamp > current.timestamp || (timestamp === current.timestamp && value < current.value)) {
        latestByProject.set(run.projectId, { timestamp, value })
      }
    }
  }

  return input.projects
    .map((project): WorkspaceProjectSummary => {
      const metrics = metricsByProject.get(project.id)
      const latestActivity = latestByProject.get(project.id)?.value
      return {
        projectId: project.id,
        name: project.name,
        root: project.root,
        status: project.status,
        ...(project.branch === undefined ? {} : { branch: project.branch }),
        ...(project.forge === undefined ? {} : { forge: project.forge }),
        ...(project.tags === undefined ? {} : { tags: project.tags }),
        running: metrics?.running ?? null,
        needsAttention: metrics?.needsYou ?? null,
        failed: metrics?.failed ?? null,
        ...(latestActivity === undefined ? {} : { latestActivity }),
      }
    })
    .sort((a, b) => {
      const activityA = latestByProject.get(a.projectId)?.timestamp ?? Number.NEGATIVE_INFINITY
      const activityB = latestByProject.get(b.projectId)?.timestamp ?? Number.NEGATIVE_INFINITY
      return activityB - activityA || a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId)
    })
}
