import { describe, expect, it } from 'vitest'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'

import { buildWorkspaceProjectSummaries } from './workspace-overview-model'

function project(id: string, extra: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    id,
    name: id,
    root: `/work/${id}`,
    addedAt: '',
    lastOpenedAt: '',
    source: 'local' as const,
    status: 'ok' as const,
    ...extra,
  }
}

describe('buildWorkspaceProjectSummaries', () => {
  it('returns no summaries for an empty registry', () => {
    expect(buildWorkspaceProjectSummaries({ projects: [] })).toEqual([])
  })

  it('keeps derived metrics null when a project has no dashboard row', () => {
    expect(buildWorkspaceProjectSummaries({ projects: [project('alpha')] })).toEqual([
      expect.objectContaining({ running: null, needsAttention: null, failed: null }),
    ])
  })

  it('preserves a missing project status from the registry', () => {
    const [summary] = buildWorkspaceProjectSummaries({
      projects: [project('gone', { status: 'missing' })],
    })

    expect(summary).toMatchObject({ projectId: 'gone', status: 'missing' })
  })

  it('preserves branch, forge, and tags from the registry', () => {
    const [summary] = buildWorkspaceProjectSummaries({
      projects: [project('alpha', { branch: 'main', forge: 'github', tags: ['web', 'design'] })],
    })

    expect(summary).toMatchObject({ branch: 'main', forge: 'github', tags: ['web', 'design'] })
  })

  it('joins dashboard counts by project id', () => {
    const summaries = buildWorkspaceProjectSummaries({
      projects: [project('alpha'), project('beta')],
      dashboardProjects: [
        { projectId: 'beta', running: 2, needsYou: 3, failed: 4 },
        { projectId: 'alpha', running: 5, needsYou: 6, failed: 7 },
      ],
    })

    expect(summaries.find(({ projectId }) => projectId === 'alpha')).toMatchObject({
      running: 5,
      needsAttention: 6,
      failed: 7,
    })
    expect(summaries.find(({ projectId }) => projectId === 'beta')).toMatchObject({
      running: 2,
      needsAttention: 3,
      failed: 4,
    })
  })

  it('selects the latest valid run timestamp and sorts newest projects first', () => {
    const summaries = buildWorkspaceProjectSummaries({
      projects: [project('alpha'), project('beta'), project('quiet')],
      runs: [
        { projectId: 'alpha', createdAt: '2026-10-01T00:00:00Z', startedAt: '2026-10-03T00:00:00Z' },
        { projectId: 'alpha', createdAt: 'invalid', finishedAt: '2026-10-02T00:00:00Z' },
        { projectId: 'beta', createdAt: '2026-10-04T00:00:00Z', startedAt: '2026-10-02T00:00:00Z' },
      ],
    })

    expect(summaries.map(({ projectId }) => projectId)).toEqual(['beta', 'alpha', 'quiet'])
    expect(summaries[0]?.latestActivity).toBe('2026-10-04T00:00:00Z')
    expect(summaries[1]?.latestActivity).toBe('2026-10-03T00:00:00Z')
    expect(summaries[2]?.latestActivity).toBeUndefined()
  })
})
