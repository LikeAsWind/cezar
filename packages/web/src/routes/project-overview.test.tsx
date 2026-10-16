import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { AppShell } from '@/components/app-shell'
import { ThemeProvider } from '@/components/theme-provider'
import type { ProjectListEntry, RepoResponse } from '@open-mercato/cezar-api-client'

import { ProjectOverviewRoute } from './project-overview'

const data = vi.hoisted(() => ({
  project: {
    id: 'alpha', name: 'Alpha', root: 'C:/projects/alpha', status: 'ok', branch: 'main',
    addedAt: '', lastOpenedAt: '', source: 'local', forge: 'github', repoUrl: 'https://github.com/acme/alpha', tracker: 'linear', tags: ['web'],
  } as ProjectListEntry,
  runs: [
    { status: 'running' }, { status: 'review' }, { status: 'failed' },
  ],
  worktrees: { worktrees: [], totalBytes: 0, keep: 4 },
  repo: { info: { root: 'C:/projects/alpha', branch: 'main', remote: 'https://github.com/acme/alpha' }, status: [], log: [], branches: ['main'], baseBranch: 'main' } as RepoResponse,
  trackerAssociation: { association: null },
  trackerConnection: { connection: null, demo: false },
  health: { data: { capabilities: { automations: true } }, isError: false },
  automations: { available: true, automations: [], scheduler: { state: 'idle' }, stats: { runs: 0, failed: 0, agentSeconds: 0 }, timeZone: 'UTC' },
  skills: [{ name: 'review', body: '', path: '/skills/review.md', source: 'team' }],
  workflows: { workflows: [{ name: 'Review', steps: [] }], issues: [] },
}))

const mocks = vi.hoisted(() => ({ automationsQuery: vi.fn() }))

vi.mock('@/api/queries', () => ({
  useProjects: () => ({ data: { projects: [data.project] } }),
  useProjectRuns: () => ({ data: data.runs }),
  useWorktrees: () => ({ data: data.worktrees }),
  useRepo: () => ({ data: data.repo }),
  useTrackerAssociation: () => ({ data: data.trackerAssociation }),
  useTrackerConnection: () => ({ data: data.trackerConnection }),
  useHealth: () => data.health,
  useSkills: () => ({ data: data.skills }),
  useWorkflows: () => ({ data: data.workflows }),
}))

vi.mock('./automations/use-automations', () => ({
  useAutomationsGate: () => ({ known: data.health.data !== undefined, off: data.health.data?.capabilities.automations !== true }),
  useAutomationsQuery: (enabled: boolean) => {
    mocks.automationsQuery(enabled)
    return { data: enabled ? data.automations : undefined }
  },
}))

afterEach(() => {
  cleanup()
  mocks.automationsQuery.mockClear()
})

function renderOverview() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/p/alpha/']}>
        <ProjectScopeProvider projectId="alpha">
            <AppShell projects={[data.project]}>
            <ProjectOverviewRoute />
          </AppShell>
        </ProjectScopeProvider>
      </MemoryRouter>
    </ThemeProvider>,
  )
}

describe('ProjectOverviewRoute', () => {
  it('renders all six project summaries with links scoped to the active project', () => {
    renderOverview()

    expect(screen.getByRole('heading', { name: 'Project identity' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Tasks & Worktrees' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Git / GitHub' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Tracker' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Automations' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Skills & workflows' })).toBeTruthy()

    const destinations = ['/p/alpha/tasks', '/p/alpha/git', '/p/alpha/tracker', '/p/alpha/automations', '/p/alpha/skills', '/p/alpha/workflows']
    for (const destination of destinations) expect(document.querySelector(`a[href="${destination}"]`), destination).toBeTruthy()
    expect(screen.getAllByText('C:/projects/alpha')).toHaveLength(2)

    // Four per-project status metrics (runs: running, review, failed). The card still links in.
    const tile = (slot: string) => document.querySelector(`[data-slot="${slot}"]`) as HTMLElement
    expect(tile('task-metric-needs-attention')?.textContent).toContain('1')
    expect(tile('task-metric-running')?.textContent).toContain('1')
    expect(tile('task-metric-completed')?.textContent).toContain('0')
    expect(tile('task-metric-failed')?.textContent).toContain('1')
  })

  it('names unavailable integrations and does not query disabled automation details', () => {
    data.health = { data: { capabilities: { automations: false } }, isError: false }
    data.repo = { info: null, status: [], log: [], branches: [], baseBranch: null }

    renderOverview()

    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.getByText('Automations are disabled')).toBeTruthy()
    expect(mocks.automationsQuery).toHaveBeenCalledWith(false)
  })

  it('lets the project shell own the only back-to-workspace link', () => {
    renderOverview()

    const links = screen.getAllByRole('link', { name: 'Back to global workspace' })
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('/')
  })
})
