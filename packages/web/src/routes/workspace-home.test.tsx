import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { LAST_LOCATION_STORAGE_KEY } from '@/lib/last-location'
import { WorkspaceHomeRoute } from './workspace-home'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** A registered project, as `GET /api/v1/projects` answers it. */
function project(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    root: `/work/${id}`,
    source: 'local' as const,
    status: 'ok' as const,
    addedAt: '',
    lastOpenedAt: '',
    ...extra,
  }
}

const alpha = project('alpha')

function mount(
  projects = [alpha],
  dashboardProjects: Array<{ projectId: string; running: number; needsYou: number; completed: number; failed: number; timedTasks: number; medianCycleHours: number | null }> = [],
) {
  const client = createQueryClient()
  client.setQueryData(workspaceQueryKeys.projects, {
    projectsDir: '/work',
    projects,
  })
  client.setQueryData([...workspaceQueryKeys.dashboard, 'overview', {}], {
    snapshotId: 'snapshot',
    asOf: '2026-10-16T00:00:00Z',
    windowStart: '2026-10-09T00:00:00Z',
    period: '7d',
    coverage: { projects: [] },
    metrics: { running: 2, needsYou: 3, completed: 4, failed: 5, timedTasks: 0, medianCycleHours: null },
    projects: dashboardProjects,
    page: { rows: [], total: 0, nextOffset: null },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}><WorkspaceHomeRoute /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('WorkspaceHomeRoute', () => {
  it('renders a useful zero-project workspace', () => {
    mount([])
    expect(screen.getByText('No projects registered')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Register project' }).getAttribute('href')).toBe('/projects?register=1')
    expect(screen.getByText('This home is not bound to the directory that started Cezar.')).not.toBeNull()
    expect(screen.getByRole('region', { name: 'Workspace metrics' })).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Machine' })).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Workspace configuration' })).not.toBeNull()
  })

  it('shows branch, status, and task counts with one explicit project link', () => {
    mount([project('alpha', { branch: 'main', status: 'not-git' })], [
      { projectId: 'alpha', running: 2, needsYou: 1, completed: 8, failed: 3, timedTasks: 0, medianCycleHours: null },
    ])
    const link = screen.getByRole('link', { name: /alpha/ })
    expect(link.getAttribute('href')).toBe('/p/alpha/')
    expect(screen.getAllByRole('link', { name: /alpha/ })).toHaveLength(1)
    expect(screen.getByText('Branch: main')).not.toBeNull()
    expect(screen.getByText('Not a Git repository')).not.toBeNull()
    expect(screen.getByText('2 running · 1 needs attention · 3 failed')).not.toBeNull()
  })

  it('renders a global home with no projects', () => {
    mount([])
    expect(screen.getByRole('heading', { name: 'Workspace' })).not.toBeNull()
  })

  it('offers the last project as an explicit link', () => {
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify({
      projectId: 'alpha', pathname: '/p/alpha/tasks/one', search: '?tab=events', hash: '#tool',
    }))
    mount()
    expect(screen.getByRole('link', { name: 'Recent project: alpha' }).getAttribute('href'))
      .toBe('/p/alpha/tasks/one?tab=events#tool')
    expect(screen.getByRole('heading', { name: 'Workspace' })).not.toBeNull()
  })

  it('hides a remembered project that is no longer registered', () => {
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify({
      projectId: 'alpha', pathname: '/p/alpha/',
    }))
    mount([])
    expect(screen.queryByRole('link', { name: /Recent project/ })).toBeNull()
  })
})
