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
function project(id: string) {
  return {
    id,
    name: id,
    root: `/work/${id}`,
    source: 'local' as const,
    status: 'ok' as const,
    addedAt: '',
    lastOpenedAt: '',
  }
}

const alpha = project('alpha')
const beta = project('beta')

function mount(projects = [alpha]) {
  const client = createQueryClient()
  client.setQueryData(workspaceQueryKeys.projects, {
    projectsDir: '/work',
    projects,
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
  })

  it('shows each project without making one current implicitly', () => {
    mount([alpha, beta])
    expect(screen.getByRole('link', { name: /Open alpha/ }).getAttribute('href')).toBe('/p/alpha/')
    expect(screen.getByRole('link', { name: /Open beta/ }).getAttribute('href')).toBe('/p/beta/')
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
