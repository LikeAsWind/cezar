import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { ProjectsRoute } from '@/routes/projects'

const projects = {
  projects: [{
    id: 'cezar',
    name: 'cezar',
    root: '/home/u/cezar',
    addedAt: '2026-07-20T09:00:00.000Z',
    lastOpenedAt: '2026-07-20T09:00:00.000Z',
    source: 'local',
    status: 'ok',
  }],
  projectsDir: '~/cezar/projects',
}

const config = {
  branding: { name: 'cezar', logoUrl: null },
  agentDefaults: {},
  browseRoot: '~/',
  projectsDir: '~/cezar/projects',
  skillsAutoUpdate: null,
  effectiveSkillsAutoUpdate: true,
  composerDefaults: {
    autonomous: null,
    worktree: null,
    inheritedAutonomous: 'source-dependent',
    inheritedWorktree: false,
  },
  resources: {
    maxParallel: 2,
    maxMonitoringSessions: 2,
    idleTimeoutMinutes: 15,
    monitoringWakeIntervalMinutes: null,
    autoResumeOnUsageLimit: true,
    memoryLimitMb: null,
    worktreeRetentionDefault: 10,
  },
}

function renderProjects(path = '/projects', failures: { projects?: boolean; config?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/v1/projects' && failures.projects) {
      return new Response(JSON.stringify({ error: 'project registry unavailable' }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/api/v1/workspace/config' && failures.config) {
      return new Response(JSON.stringify({ error: 'workspace configuration unavailable' }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    const payload = url === '/api/v1/projects' ? projects : url === '/api/v1/workspace/config' ? config : { path: '/home/u', parent: null, dirs: [], truncated: false }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ProjectsRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Projects registry page', () => {
  it('shows project management without workspace storage defaults', async () => {
    renderProjects()

    await waitFor(() => expect(document.querySelector('[data-slot="project-row"]')).not.toBeNull())
    expect(document.querySelector('[data-route="projects"] [data-slot="projects-browse-root"]')).toBeNull()
    expect(document.querySelector('[data-route="projects"] [data-slot="projects-checkout-root"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'cezar' }).getAttribute('href')).toBe('/p/cezar/')
    expect(screen.getByRole('button', { name: 'Register project' })).toBeTruthy()
  })

  it('has a single projects query owner across the registry and registration dialog', async () => {
    const client = renderProjects()

    await waitFor(() => expect(document.querySelector('[data-slot="project-row"]')).not.toBeNull())
    expect(client.getQueryCache().find({ queryKey: workspaceQueryKeys.projects })?.getObserversCount()).toBe(1)
  })

  it('opens the registration dialog from the register query deep link', async () => {
    renderProjects('/projects?register=1')

    await waitFor(() => expect(document.querySelector('[data-slot="add-project-dialog"]')).not.toBeNull())
  })

  it.each([
    ['projects', { projects: true }, 'project registry unavailable'],
    ['workspace config', { config: true }, 'workspace configuration unavailable'],
  ] as const)('keeps register=1 usable when the %s query fails', async (_name, failures, error) => {
    renderProjects('/projects?register=1', failures)

    await waitFor(() => expect(document.querySelector('[data-slot="centered-state"]')?.textContent).toContain(error))
    expect(document.querySelector('[data-slot="add-project-dialog"]')).not.toBeNull()
  }, 15_000)

  it.each([
    ['projects', { projects: true }, 'project registry unavailable'],
    ['workspace config', { config: true }, 'workspace configuration unavailable'],
  ] as const)('opens registration from the action when the %s query fails', async (_name, failures, error) => {
    renderProjects('/projects', failures)

    await waitFor(() => expect(document.querySelector('[data-slot="centered-state"]')?.textContent).toContain(error))
    expect(document.querySelector('[data-slot="add-project-dialog"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Register project' }))
    await waitFor(() => expect(document.querySelector('[data-slot="add-project-dialog"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="centered-state"]')?.textContent).toContain(error)
  }, 15_000)
})
