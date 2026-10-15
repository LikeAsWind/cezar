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

function mount(projects = true) {
  const client = createQueryClient()
  client.setQueryData(workspaceQueryKeys.projects, {
    projectsDir: '/work',
    projects: projects ? [{
      id: 'alpha', name: 'Alpha', root: '/work/alpha', source: 'local', status: 'ok',
      addedAt: '', lastOpenedAt: '',
    }] : [],
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}><WorkspaceHomeRoute /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('WorkspaceHomeRoute', () => {
  it('renders a global home with no projects', () => {
    mount(false)
    expect(screen.getByRole('heading', { name: 'Workspace' })).not.toBeNull()
  })

  it('offers the last project as an explicit link', () => {
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify({
      projectId: 'alpha', pathname: '/p/alpha/tasks/one', search: '?tab=events', hash: '#tool',
    }))
    mount()
    expect(screen.getByRole('link', { name: 'Recent project: Alpha' }).getAttribute('href'))
      .toBe('/p/alpha/tasks/one?tab=events#tool')
    expect(screen.getByRole('heading', { name: 'Workspace' })).not.toBeNull()
  })

  it('hides a remembered project that is no longer registered', () => {
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify({
      projectId: 'alpha', pathname: '/p/alpha/',
    }))
    mount(false)
    expect(screen.queryByRole('link', { name: /Recent project/ })).toBeNull()
  })
})
