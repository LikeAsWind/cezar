import type {
  ApiRun,
  AutomationsResponse,
  ProjectListEntry,
  RepoResponse,
  Skill,
  TrackerAssociationResponse,
  TrackerConnectionResponse,
  WorktreesResponse,
  WorkflowsResponse,
} from '@open-mercato/cezar-api-client'
import { describe, expect, it } from 'vitest'

import { buildProjectOverviewModel } from './project-overview-model'

const project: ProjectListEntry = {
  id: 'alpha',
  name: 'Alpha',
  root: 'C:/projects/alpha',
  addedAt: '',
  lastOpenedAt: '',
  source: 'local',
  status: 'ok',
  branch: 'main',
  forge: 'github',
  repoUrl: 'https://github.com/acme/alpha',
  tracker: 'linear',
  tags: ['storefront', 'api'],
}

const repo: RepoResponse = {
  info: { root: project.root, branch: 'main', remote: 'https://github.com/acme/alpha' },
  status: [],
  log: [],
  branches: ['main'],
  baseBranch: 'main',
}

const skills: Skill[] = [
  { name: 'review', body: '', path: '/skills/review.md', source: 'team' },
  { name: 'ship', body: '', path: '/skills/ship.md', source: 'team' },
]

const workflows: WorkflowsResponse = {
  workflows: [
    { name: 'Review', description: '', steps: [], source: 'file' },
  ],
  issues: [],
}

function run(status: ApiRun['status']): Pick<ApiRun, 'status'> {
  return { status }
}

function automations(available = true): AutomationsResponse {
  return {
    available,
    scheduler: { state: 'scheduled' },
    timeZone: 'UTC',
    stats: { runs: 0, failed: 0, agentSeconds: 0 },
    automations: [],
  }
}

describe('buildProjectOverviewModel', () => {
  it('summarizes identity, tasks, repository, skills, and workflows from existing data', () => {
    const model = buildProjectOverviewModel({
      project,
      runs: [run('running'), run('review'), run('failed'), run('done')],
      worktrees: { worktrees: [], totalBytes: 0, keep: 4 },
      repo,
      trackerAssociation: { association: null },
      trackerConnection: { connection: null, demo: false },
      automations: automations(),
      automationsEnabled: true,
      skills,
      workflows,
    })

    expect(model.identity).toMatchObject({
      status: 'ready', name: 'Alpha', root: project.root, branch: 'main',
      registryStatus: 'ok', tags: ['storefront', 'api'], forge: 'github',
    })
    expect(model.tasks).toMatchObject({ status: 'ready', running: 1, needsAttention: 1, failed: 1, worktrees: 0, to: '/p/alpha/tasks' })
    expect(model.git).toMatchObject({ status: 'ready', forgeStatus: 'ready', branch: 'main', to: '/p/alpha/git' })
    expect(model.tracker.status).toBe('unconfigured')
    expect(model.automations).toMatchObject({ status: 'ready', configured: 0, running: 0, to: '/p/alpha/automations' })
    expect(model.skillsAndWorkflows).toMatchObject({
      status: 'ready', skills: 2, workflows: 1, skillsTo: '/p/alpha/skills', workflowsTo: '/p/alpha/workflows',
    })
  })

  it('distinguishes an unconfigured tracker from a disconnected configured tracker', () => {
    const unconfigured = buildProjectOverviewModel({
      project: { ...project, tracker: undefined },
      trackerAssociation: { association: null },
      trackerConnection: { connection: null, demo: false },
    })
    const disconnected = buildProjectOverviewModel({
      project,
      trackerAssociation: {
        association: {
          kind: 'linear', externalId: 'team-1', externalName: 'Team', connectionId: '11111111-1111-4111-8111-111111111111', source: { id: 'team-1', webUrl: 'https://linear.app/acme/team/TEAM' },
        },
      },
      trackerConnection: { connection: null, demo: false },
    })

    expect(unconfigured.tracker).toMatchObject({ status: 'unconfigured', to: '/p/alpha/tracker' })
    expect(disconnected.tracker.status).toBe('unavailable')
  })

  it('marks automation capability as disabled without needing automation data', () => {
    const model = buildProjectOverviewModel({ project, automationsEnabled: false })

    expect(model.automations).toMatchObject({ status: 'disabled', configured: null, running: null })
  })

  it('counts currently running automation launches from the latest run state', () => {
    const response = automations()
    response.automations = [{ lastRun: { runId: 'run-1', status: 'running', ts: '' } } as unknown as AutomationsResponse['automations'][number]]
    const model = buildProjectOverviewModel({ project, automations: response, automationsEnabled: true })

    expect(model.automations).toMatchObject({ status: 'ready', configured: 1, running: 1 })
  })

  it('uses explicit unavailable states for missing metrics and unavailable integrations', () => {
    const model = buildProjectOverviewModel({
      project,
      repo: { info: null, status: [], log: [], branches: [], baseBranch: null },
      automationsEnabled: true,
      automations: automations(false),
    })

    expect(model.tasks).toMatchObject({ status: 'unavailable', running: null, worktrees: null })
    expect(model.git).toMatchObject({ status: 'unavailable' })
    expect(model.automations).toMatchObject({ status: 'unavailable', configured: null })
    expect(model.skillsAndWorkflows).toMatchObject({ status: 'unavailable', skills: null, workflows: null })
  })

  it('summarizes non-Git projects without inventing branch or forge data', () => {
    const model = buildProjectOverviewModel({
      project: { ...project, status: 'not-git', branch: undefined, forge: undefined, repoUrl: undefined },
      repo: { info: null, status: [], log: [], branches: [], baseBranch: null },
    })

    expect(model.identity).toMatchObject({ status: 'ready', registryStatus: 'not-git', branch: null, forge: null })
    expect(model.git).toMatchObject({ status: 'unconfigured', forgeStatus: 'unconfigured', branch: null })
  })

  it('keeps counts derived from the supplied arrays', () => {
    const model = buildProjectOverviewModel({
      project,
      runs: [run('queued'), run('waiting'), run('running'), run('review'), run('failed'), run('cancelled')],
      worktrees: { worktrees: [{ runId: '1', title: 'One', status: 'done', branch: null, sizeBytes: 1, finishedAt: null, reclaimable: true }], totalBytes: 1, keep: 4 },
    })

    expect(model.tasks).toMatchObject({ running: 1, needsAttention: 1, failed: 1, worktrees: 1 })
  })
})
