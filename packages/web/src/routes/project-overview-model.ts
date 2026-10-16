import type {
  ApiRun,
  AutomationsResponse,
  Capabilities,
  ProjectListEntry,
  RepoResponse,
  Skill,
  TrackerAssociationResponse,
  TrackerConnectionResponse,
  WorktreesResponse,
  WorkflowsResponse,
} from '@open-mercato/cezar-api-client'

export type OverviewStatus = 'ready' | 'unconfigured' | 'unavailable' | 'disabled'

export type ProjectOverviewInput = {
  project: ProjectListEntry
  runs?: readonly Pick<ApiRun, 'status'>[]
  worktrees?: WorktreesResponse
  repo?: RepoResponse
  trackerAssociation?: TrackerAssociationResponse
  trackerConnection?: TrackerConnectionResponse
  automations?: Pick<AutomationsResponse, 'available' | 'automations'>
  automationsEnabled?: Capabilities['automations']
  skills?: readonly Skill[]
  workflows?: WorkflowsResponse
}

export type ProjectOverviewModel = {
  identity: { status: OverviewStatus; name: string; root: string; branch: string | null; registryStatus: ProjectListEntry['status']; registryStatusLabel: string; tags: readonly string[]; forge: ProjectListEntry['forge'] | null; to: string }
  tasks: { status: OverviewStatus; running: number | null; needsAttention: number | null; failed: number | null; worktrees: number | null; to: string }
  git: { status: OverviewStatus; forgeStatus: OverviewStatus; branch: string | null; to: string }
  tracker: { status: OverviewStatus; summary: { key: string; values: Record<string, string | number> }; to: string }
  automations: { status: OverviewStatus; configured: number | null; running: number | null; summary: { key: string; values: Record<string, string | number> }; to: string }
  skillsAndWorkflows: { status: OverviewStatus; skills: number | null; workflows: number | null; skillsSummary: { key: string; values: Record<string, string | number> }; workflowsSummary: { key: string; values: Record<string, string | number> }; skillsTo: string; workflowsTo: string }
}

function projectPath(projectId: string, path: string): string {
  return `/p/${encodeURIComponent(projectId)}${path}`
}

export function buildProjectOverviewModel(input: ProjectOverviewInput): ProjectOverviewModel {
  const { project } = input
  const runs = input.runs
  const worktrees = input.worktrees?.worktrees
  const repoInfo = input.repo?.info
  const association = input.trackerAssociation?.association
  const connection = input.trackerConnection
  const connected = association !== null && association !== undefined
    && (!association.connectionId || connection?.demo === true || connection?.connection?.id === association.connectionId)
  const trackerStatus: OverviewStatus = association === null
    ? 'unconfigured'
    : association === undefined
      ? 'unavailable'
      : connected ? 'ready' : 'unavailable'

  const automationsStatus: OverviewStatus = input.automationsEnabled === false
    ? 'disabled'
    : input.automationsEnabled !== true || !input.automations
      ? 'unavailable'
      : input.automations.available ? 'ready' : 'unavailable'
  const automations = automationsStatus === 'ready' ? input.automations?.automations : undefined
  const trackerSummaryKey = trackerStatus === 'unconfigured' ? 'Not connected' : trackerStatus === 'ready' ? 'Ready' : 'Unavailable'
  const automationSummary: ProjectOverviewModel['automations']['summary'] = automationsStatus === 'disabled'
    ? { key: 'Automations are disabled', values: {} }
    : automationsStatus === 'ready'
      ? { key: '{0} configured · {1} running', values: { 0: automations?.length ?? 0, 1: automations?.filter((item) => item.lastRun?.status === 'running').length ?? 0 } }
      : { key: 'Unavailable', values: {} }
  const skillsSummary: ProjectOverviewModel['skillsAndWorkflows']['skillsSummary'] = input.skills === undefined
    ? { key: 'Unavailable', values: {} }
    : { key: '{0} skills', values: { 0: input.skills.length } }
  const workflowsSummary: ProjectOverviewModel['skillsAndWorkflows']['workflowsSummary'] = input.workflows === undefined
    ? { key: 'Unavailable', values: {} }
    : { key: '{0} workflows', values: { 0: input.workflows.workflows.length } }

  return {
    identity: {
      status: project.status === 'missing' ? 'unavailable' : 'ready',
      name: project.name || project.id,
      root: project.root,
      branch: project.branch ?? null,
      registryStatus: project.status,
      registryStatusLabel: project.status === 'ok' ? 'Available' : project.status === 'missing' ? 'Missing' : 'Not a Git repository',
      tags: project.tags ?? [],
      forge: project.forge ?? null,
      to: projectPath(project.id, '/settings'),
    },
    tasks: {
      status: runs === undefined || worktrees === undefined ? 'unavailable' : 'ready',
      running: runs?.filter((run) => run.status === 'running').length ?? null,
      needsAttention: runs?.filter((run) => run.status === 'review').length ?? null,
      failed: runs?.filter((run) => run.status === 'failed').length ?? null,
      worktrees: worktrees?.length ?? null,
      to: projectPath(project.id, '/tasks'),
    },
    git: {
      status: project.status === 'not-git' ? 'unconfigured' : repoInfo ? 'ready' : 'unavailable',
      forgeStatus: project.forge === undefined
        ? 'unconfigured'
        : repoInfo?.remote ? 'ready' : repoInfo ? 'unavailable' : 'unavailable',
      branch: repoInfo?.branch ?? project.branch ?? null,
      to: projectPath(project.id, '/git'),
    },
    tracker: { status: trackerStatus, summary: { key: trackerSummaryKey, values: {} }, to: projectPath(project.id, '/tracker') },
    automations: {
      status: automationsStatus,
      configured: automations?.length ?? null,
      running: automations?.filter((automation) => automation.lastRun?.status === 'running').length ?? null,
      summary: automationSummary,
      to: projectPath(project.id, '/automations'),
    },
    skillsAndWorkflows: {
      status: input.skills === undefined || input.workflows === undefined ? 'unavailable' : 'ready',
      skills: input.skills?.length ?? null,
      workflows: input.workflows?.workflows.length ?? null,
      skillsSummary,
      workflowsSummary,
      skillsTo: projectPath(project.id, '/skills'),
      workflowsTo: projectPath(project.id, '/workflows'),
    },
  }
}
