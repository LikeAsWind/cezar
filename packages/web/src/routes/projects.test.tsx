import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
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

function renderProjects(path = '/projects') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url === '/api/v1/projects' ? projects : config
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <ProjectsRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
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

  it('opens the registration dialog from the register query deep link', async () => {
    renderProjects('/projects?register=1')

    await waitFor(() => expect(document.querySelector('[data-slot="add-project-dialog"]')).not.toBeNull())
  })
})
