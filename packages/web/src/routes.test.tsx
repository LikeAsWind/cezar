import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getApiScope } from '@open-mercato/cezar-api-client'

import { createQueryClient } from './api/query-client'
import { queryKeys, workspaceQueryKeys } from './api/queries'
import type { ProjectsResponse, WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { AppearanceProvider } from './components/appearance-provider'
import { ListViewProvider } from './components/list-view'
import { ThemeProvider } from './components/theme-provider'
import { LAST_LOCATION_STORAGE_KEY } from './lib/last-location'
import { AppRoutes, pageTitleContext } from './routes'
import { resetDraft } from './routes/new-task-draft'

// The `/` overview fetches `/api/v1/runs` on mount. A never-answering fetch keeps every route
// honestly in its loading state — this file is about the URL map, not about data.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  // The /new draft store is a module singleton by design — isolate it per test.
  resetDraft()
  // The remembered location is per-browser (localStorage), so it outlives a render otherwise.
  localStorage.clear()
})

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** Seed the location this browser was last on — where the cockpit now remembers it. */
function rememberLocation(lastLocation: unknown): void {
  localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(lastLocation))
}

/** An explicit registered project; the service has no implicit launch project. */
const BOOT = 'boot'

/** Routes read capability flags from the global health cache. */
const HEALTH = {
  version: '0.0.0-test',
  repoRoot: '/home/u/cezar',
  repo: null,
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, followups: true, singleProject: false, automations: false },
  projects: [{ id: BOOT, name: 'cezar' }],
}

const REGISTRY: ProjectsResponse = {
  projects: [
    {
      id: BOOT,
      name: 'cezar',
      root: '/home/u/cezar',
      addedAt: '',
      lastOpenedAt: '',
      source: 'local',
      status: 'ok',
    },
    {
      id: 'other',
      name: 'other-repo',
      root: '/home/u/other',
      addedAt: '',
      lastOpenedAt: '',
      source: 'local',
      status: 'ok',
    },
  ],
  projectsDir: '~/cezar/projects',
}

/** The address bar, readable from assertions: MemoryRouter keeps its location internal, so the
 *  probe publishes it — that is how the tests prove params and query survive the redirects. */
function LocationProbe() {
  const location = useLocation()
  return (
    <div
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
      data-hash={location.hash}
    />
  )
}

function ProjectNavigationProbe() {
  const navigate = useNavigate()
  return (
    <>
      <button onClick={() => navigate('/p/other/tasks')}>Switch project</button>
      <button onClick={() => navigate('/p/other/new')}>Switch composer</button>
      <button onClick={() => navigate('/')}>Workspace home</button>
    </>
  )
}

/** Render real routes with global query fixtures; null seeds exercise pending/error states. */
function renderAt(
  entry: string,
  {
    seed = true,
    health = HEALTH,
    registry = REGISTRY,
    uiState = {},
  }: {
    seed?: boolean
    health?: typeof HEALTH | null
    registry?: ProjectsResponse | null
    uiState?: WorkspaceUiState | Record<string, unknown> | null
  } = {},
) {
  const client = createQueryClient()
  if (seed) {
    // Health and registry belong to the global workspace.
    if (health !== null) client.setQueryData(queryKeys.health, health)
    if (registry !== null) client.setQueryData(workspaceQueryKeys.projects, registry)
    if (uiState !== null) client.setQueryData(workspaceQueryKeys.uiState, uiState)
  }
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <AppearanceProvider>
          <MemoryRouter initialEntries={[entry]}>
            <ListViewProvider>
              <AppRoutes />
              <LocationProbe />
              <ProjectNavigationProbe />
            </ListViewProvider>
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
  return client
}

function routeName(): string | null {
  return document.querySelector('[data-route]')?.getAttribute('data-route') ?? null
}

function currentPathname(): string | null {
  return screen.getByTestId('location').getAttribute('data-pathname')
}

function currentSearch(): string | null {
  return screen.getByTestId('location').getAttribute('data-search')
}

function currentHash(): string | null {
  return screen.getByTestId('location').getAttribute('data-hash')
}

describe('pageTitleContext', () => {
  it.each([
    ['/', 'Workspace'],
    ['/projects', 'Projects'],
    ['/p/cezar/', 'Overview'],
    ['/p/cezar/tasks', 'Tasks'],
    ['/new', 'New task'],
    ['/p/cezar/compare/group-1', 'Compare'],
    ['/p/cezar/git', 'Git'],
    ['/p/cezar/git/commits/abc123', 'Git'],
    ['/p/cezar/github/issues/543', 'GitHub'],
    ['/p/cezar/skills', 'Skills'],
    ['/p/cezar/inbox', 'Inbox'],
    ['/p/cezar/workflows/quick-task', 'Workflows'],
    ['/p/cezar/settings/agents', 'Settings'],
    ['/settings/global/projects', 'Settings'],
  ])('labels %s as %s', (pathname, pageLabel) => {
    expect(pageTitleContext(pathname)).toEqual({ pageLabel, taskId: null })
  })

  it.each([
    '/p/cezar/tasks/run-1',
    '/p/cezar/tasks/run-1/changes',
    '/p/cezar/tasks/run-1/files',
    '/p/cezar/tasks/run-1/commits/abc123',
  ])('returns the task lookup key for %s', (pathname) => {
    expect(pageTitleContext(pathname)).toEqual({ pageLabel: null, taskId: 'run-1' })
  })

  it('does not invent a label for an unknown route', () => {
    expect(pageTitleContext('/p/cezar/not-a-route')).toEqual({ pageLabel: null, taskId: null })
  })
})

/** The URL contract from the spec's "Routing — every surface is a URL" section, now under the
 *  `/p/:projectId` prefix (multi-project spec, step 3.2). These paths are pasteable links;
 *  changing one breaks a teammate's bookmark, so the map is asserted URL-by-URL. */
const ROUTE_CASES: Array<[url: string, route: string, title: string]> = [
  ['/', 'project-overview', 'Project overview'],
  ['/tasks', 'tasks', 'Tasks'],
  // The real full-screen composer (R4 Step 1.1): the hero title is the page heading.
  ['/new', 'new', 'What should the agent work on?'],
  // The real thread view (Step R3.1): with fetch never answering it is honestly loading.
  ['/tasks/abc123', 'task-thread', 'Loading task…'],
  // The real R5 tab routes: with fetch never answering they are honestly loading.
  ['/tasks/abc123/changes', 'task-changes', 'Loading changes…'],
  ['/tasks/abc123/files', 'task-files', 'Loading files…'],
  // The real compare view (Step R3 2.3): with fetch never answering it is honestly loading.
  ['/compare/grp-1', 'compare', 'Loading variants…'],
  // The real repo view (R5 Step 1.7): with fetch never answering it is honestly loading —
  // and every segment is its own URL, commit deep links included.
  ['/git', 'repo-git', 'Loading repository…'],
  ['/git/commits', 'repo-git', 'Loading repository…'],
  ['/git/commits/abc1234', 'repo-git', 'Loading repository…'],
  ['/git/branches', 'repo-git', 'Loading repository…'],
  // The real GitHub tab (R6 Step 1.1): with fetch never answering every github URL is
  // honestly loading — lists and item deep links included.
  ['/github', 'github', 'Loading GitHub…'],
  ['/github/prs', 'github', 'Loading GitHub…'],
  ['/github/issues/42', 'github', 'Loading GitHub…'],
  ['/github/prs/7', 'github', 'Loading GitHub…'],
  ['/inbox', 'inbox', 'Inbox'],
  // The real workflow builder (R6 Step 1.6): with fetch never answering both the list URL
  // and a named deep link are honestly loading.
  ['/workflows', 'workflows', 'Loading workflows…'],
  ['/workflows/ship-it', 'workflows', 'Loading workflows…'],
  ['/skills', 'skills', 'Skills'],
  // Project settings only (step 3.5) — appearance/notifications/resources/projects moved to
  // the unscoped `/settings/global/*` area, covered in its own describe below.
  ['/settings', 'settings', 'Settings'],
  ['/settings/agents', 'settings-agents', 'Agents'],
  ['/settings/instructions', 'settings-instructions', 'Instructions'],
  ['/settings/tasks', 'settings-tasks', 'Tasks'],
  ['/settings/agent-config', 'settings-agent-config', 'Agent config'],
  ['/settings/worktrees', 'settings-worktrees', 'Worktrees'],
  ['/settings/bookmarklets', 'settings-bookmarklets', 'Bookmarklets'],
]

describe('scoped route map (/p/:projectId)', () => {
  // Error assertions wait for data, not Vite's cold transforms of the lazy route modules.
  beforeAll(async () => {
    await Promise.all([
      import('./routes/task-thread/task-thread'),
      import('./routes/task-git/task-changes'),
      import('./routes/compare-variants'),
    ])
  }, 30_000)

  it.each([
    ['boot', 'cezar', '/home/u/cezar'],
    ['other', 'other-repo', '/home/u/other'],
  ])('opens an independent project overview for %s', (id, name, root) => {
    renderAt(`/p/${id}/`)
    expect(screen.getByRole('heading', { name: 'Project overview', level: 1 })).not.toBeNull()
    expect(screen.getByRole('heading', { name, level: 2 })).not.toBeNull()
    expect(screen.getByText(root)).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Tasks & Worktrees' }).getAttribute('href')).toBe(`/p/${id}/tasks`)
    expect(screen.getByRole('link', { name: 'Back to global workspace' }).getAttribute('href')).toBe('/')
    expect(screen.queryByLabelText('Search tasks')).toBeNull()
  })

  for (const [url, route, title] of ROUTE_CASES) {
    it(`/p/${BOOT}${url} → ${route}`, () => {
      renderAt(`/p/${BOOT}${url}`)
      expect(routeName()).toBe(route)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title)
    })
  }

  // The tab lives in the path, so /tasks/:id/changes must not fall back to the thread.
  it('a task tab deep link renders the tab, not the thread', () => {
    renderAt(`/p/${BOOT}/tasks/abc123/changes`)
    expect(document.querySelector('[data-route="task-thread"]')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Loading task…' })).toBeNull()
  })

  // MCP lives inside Agent config; keyboard remains hidden and unrouted.
  const unknown = [
    '/nope-404',
    '/settings/nope',
    '/settings/mcp',
    '/settings/keyboard',
    '/tasks/abc123/nope',
    '/compare',
  ]
  for (const url of unknown) {
    it(`/p/${BOOT}${url} → the 404 route`, () => {
      renderAt(`/p/${BOOT}${url}`)
      expect(routeName()).toBe('not-found')
    })
  }

  // Step 4.1: the 404 is a CenteredState with a way home, not a bare stub — and its way home
  // stays inside the active project (the scope-aware Link).
  it('the 404 renders a CenteredState with a back-to-tasks action scoped to the project', () => {
    renderAt(`/p/${BOOT}/definitely-not-a-route`)
    expect(routeName()).toBe('not-found')
    expect(document.querySelector('[data-route="not-found"] [data-slot="centered-state"]')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Page not found')
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe(`/p/${BOOT}/tasks`)
  })

  it.each([
    ['tasks/nope', '/api/v1/p/boot/runs/nope', 'Task not found'],
    ['tasks/nope/changes', '/api/v1/p/boot/runs/nope', 'Task not found'],
    ['compare/nope', '/api/v1/p/boot/groups/nope', 'No such variant group'],
  ])('returns from a missing %s to the project task list', async (path, endpoint, heading) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === endpoint) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      }
      return new Promise<never>(() => {})
    }))
    renderAt(`/p/boot/${path}`)
    await screen.findByRole('heading', { name: heading })
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe('/p/boot/tasks')
  })

  // The area rule (nav links, tab links…) — spot-checked through the Settings shell, whose
  // section links are plain flat `to`s routed through the scope-aware Link.
  it('navigation links generated inside a project carry its prefix', () => {
    renderAt(`/p/${BOOT}/settings`)
    const link = document.querySelector('[data-slot="settings-index"] a[data-section="agents"]')
    expect(link?.getAttribute('href')).toBe(`/p/${BOOT}/settings/agents`)
  })

  it('remounts the same page and loads its new scope when the project param changes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/p/boot/runs' || path === '/api/v1/p/other/runs') {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      return new Promise<never>(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = createQueryClient()
    client.setQueryData(queryKeys.health, HEALTH)
    client.setQueryData(workspaceQueryKeys.projects, REGISTRY)
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <AppearanceProvider>
            <MemoryRouter initialEntries={[`/p/${BOOT}/tasks`]}>
              <ListViewProvider>
                <AppRoutes />
                <ProjectNavigationProbe />
              </ListViewProvider>
            </MemoryRouter>
          </AppearanceProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    )

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/v1/p/boot/runs')).toBe(true),
    )
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'stale filter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }))

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/v1/p/other/runs')).toBe(true),
    )
    expect((screen.getByLabelText('Search tasks') as HTMLInputElement).value).toBe('')
  })
})

/**
 * Global settings (step 3.5) — the one area OUTSIDE `/p/:projectId`. Two things must hold: the
 * URLs render without any project scope, and the sections that MOVED there keep their old
 * project-scoped URLs alive as redirects, so pre-split bookmarks still land.
 */
describe('the global settings area (/settings/global)', () => {
  // These assertions cover routing and the capability gate, not Vite's cold module transform.
  // Await the real lazy module before starting RTL's 1s DOM deadline; keep production lazy.
  beforeAll(async () => {
    await import('./routes/automations/automations-route')
  }, 30_000)

  const GLOBAL_CASES: Array<[string, string, string]> = [
    ['/settings/global', 'settings-global', 'Global settings'],
    ['/settings/global/appearance', 'settings-global-appearance', 'Appearance'],
    ['/settings/global/notifications', 'settings-global-notifications', 'Notifications'],
    ['/settings/global/resources', 'settings-global-resources', 'Resources'],
    ['/settings/global/skills', 'settings-global-skills', 'Skills'],
    ['/settings/global/projects', 'settings-global-projects', 'Projects'],
  ]
  for (const [url, route, title] of GLOBAL_CASES) {
    it(`${url} → ${route}, unscoped`, () => {
      renderAt(url)
      expect(routeName()).toBe(route)
      // Never redirected into a project: the pathname is the one that was asked for.
      expect(currentPathname()).toBe(url)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title)
    })
  }

  // A bookmarked deep link into any of the four `/automations*` routes still resolves — the route
  // map is unchanged — but on a cockpit started with CEZ_AUTOMATIONS=0 the view says the feature
  // is off instead of rendering an editor whose every request would 409.
  for (const path of ['automations', 'automations/new', 'automations/a-1', 'automations/a-1/log']) {
    it(`/${path} renders the disabled state while the capability is off`, async () => {
      renderAt(`/p/${BOOT}/${path}`)
      expect(currentPathname()).toBe(`/p/${BOOT}/${path}`)
      expect(routeName()).toBe('automations')
      expect(await screen.findByText('Automations are off', {}, { timeout: 5_000 })).not.toBeNull()
      expect(await screen.findByText(/CEZ_AUTOMATIONS=0/, {}, { timeout: 5_000 })).not.toBeNull()
    })
  }

  // The window before health answers is the one that bites: `/automations/new` used to paint a
  // full creation form optimistically, so a cold deep link on a gated server offered a submit
  // that POSTs into a 409. No mode renders until the capability is known.
  it('holds every /automations mode on a loading state until health answers', () => {
    renderAt(`/p/${BOOT}/automations/new`, { health: null })
    expect(routeName()).toBe('automations')
    expect(screen.getByText('Loading automations…')).not.toBeNull()
    expect(document.querySelector('#automation-name')).toBeNull()
    expect(screen.queryByText('Automations are off')).toBeNull()
  })

  it('omits the Projects route when single-project mode is active', () => {
    renderAt('/settings/global/projects', {
      health: { ...HEALTH, capabilities: { ...HEALTH.capabilities, singleProject: true } },
    })
    expect(routeName()).not.toBe('settings-global-projects')
    expect(screen.queryByRole('heading', { level: 1, name: 'Projects' })).toBeNull()
  })

  // Prompt templates folded into Instructions (spec 2026-10-11-branch-naming-instructions):
  // BACKWARD_COMPATIBILITY.md calls dropping a moved section's redirect a break.
  it(`/p/${BOOT}/settings/prompt-templates lands on the Instructions anchor`, () => {
    renderAt(`/p/${BOOT}/settings/prompt-templates`)
    expect(currentPathname()).toBe(`/p/${BOOT}/settings/instructions`)
    expect(currentHash()).toBe('#prompt-templates')
    expect(routeName()).toBe('settings-instructions')
  })

  it('the legacy flat /settings/prompt-templates lands there too', () => {
    renderAt('/settings/prompt-templates', { registry: SINGLE_PROJECT })
    expect(currentPathname()).toBe(`/p/${BOOT}/settings/instructions`)
    expect(currentHash()).toBe('#prompt-templates')
  })

  // A moved section's old URL, in both spellings a bookmark can have it.
  for (const id of ['appearance', 'notifications', 'resources']) {
    it(`/p/${BOOT}/settings/${id} redirects to the global twin`, () => {
      renderAt(`/p/${BOOT}/settings/${id}`)
      expect(currentPathname()).toBe(`/settings/global/${id}`)
      expect(routeName()).toBe(`settings-global-${id}`)
    })

    it(`the legacy flat /settings/${id} lands on the global twin too`, () => {
      renderAt(`/settings/${id}`, { registry: SINGLE_PROJECT })
      expect(currentPathname()).toBe(`/settings/global/${id}`)
    })

    it(`/settings/${id} carries query AND hash through BOTH redirect hops`, () => {
      // The legacy flat URL takes two hops — `LegacyPathRedirect` into the sole project, then
      // the moved-section redirect out to the global twin. `settingsSectionPath` returns a bare
      // pathname, so the second hop is exactly where a bookmark's `?…#…` used to disappear.
      renderAt(`/settings/${id}?tab=x&y=a%2Fb#anchor`, { registry: SINGLE_PROJECT })
      expect(currentPathname()).toBe(`/settings/global/${id}`)
      expect(currentSearch()).toBe('?tab=x&y=a%2Fb')
      expect(currentHash()).toBe('#anchor')
    })

    it(`/p/${BOOT}/settings/${id} carries query AND hash on the single hop`, () => {
      renderAt(`/p/${BOOT}/settings/${id}?tab=x#anchor`)
      expect(currentPathname()).toBe(`/settings/global/${id}`)
      expect(currentSearch()).toBe('?tab=x')
      expect(currentHash()).toBe('#anchor')
    })
  }
})

const SINGLE_PROJECT: ProjectsResponse = { ...REGISTRY, projects: [REGISTRY.projects[0]!] }

describe('global workspace routes', () => {
  it.each(['/', '/?shared=1#section'])('renders the fixed workspace home at %s', (entry) => {
    rememberLocation({ projectId: 'other', pathname: '/p/other/tasks/run-1' })
    renderAt(entry)
    expect(screen.getByRole('heading', { name: 'Workspace' })).not.toBeNull()
    expect(currentPathname()).toBe('/')
    expect(getApiScope()).toBeNull()
  })

  it('renders home before the registry answers', () => {
    renderAt('/', { seed: false })
    expect(routeName()).toBe('workspace-home')
    expect(currentPathname()).toBe('/')
  })

  it('renders global tasks outside project scope', () => {
    renderAt('/tasks')
    expect(routeName()).toBe('global-tasks')
    expect(currentPathname()).toBe('/tasks')
    expect(getApiScope()).toBeNull()
  })

  it('renders project management outside project scope', () => {
    renderAt('/projects')
    expect(screen.getByRole('heading', { name: 'Projects', level: 1 })).not.toBeNull()
    expect(currentPathname()).toBe('/projects')
    expect(getApiScope()).toBeNull()
  })

  it('does not expose project management in single-project mode', () => {
    renderAt('/projects', {
      health: { ...HEALTH, capabilities: { ...HEALTH.capabilities, singleProject: true } },
    })
    expect(routeName()).toBe('not-found')
    expect(currentPathname()).toBe('/projects')
    expect(screen.queryByRole('heading', { name: 'Projects', level: 1 })).toBeNull()
    expect(getApiScope()).toBeNull()
  })

  it('remounts the composer with the arriving project draft', () => {
    renderAt('/p/boot/new')
    fireEvent.change(screen.getByLabelText('Describe a task for the agent'), {
      target: { value: 'alpha draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Switch composer' }))
    expect(currentPathname()).toBe('/p/other/new')
    expect((screen.getByLabelText('Describe a task for the agent') as HTMLTextAreaElement).value).toBe('')
    expect(getApiScope()).toBe('other')
  })

  it('unmounts project scope when returning home', () => {
    renderAt('/p/boot/tasks')
    expect(getApiScope()).toBe('boot')
    fireEvent.click(screen.getByRole('button', { name: 'Workspace home' }))
    expect(currentPathname()).toBe('/')
    expect(routeName()).toBe('workspace-home')
    expect(getApiScope()).toBeNull()
    expect(screen.queryByLabelText('Search tasks')).toBeNull()
  })
})

describe('legacy project URLs', () => {
  for (const [url, route] of ROUTE_CASES.filter(([url]) => url !== '/' && url !== '/tasks')) {
    it(`${url} resolves when there is exactly one candidate`, () => {
      renderAt(url, { registry: SINGLE_PROJECT })
      expect(routeName()).toBe(route)
      expect(currentPathname()).toBe(`/p/${BOOT}${url}`)
    })
  }

  it.each([
    ['zero projects', { ...REGISTRY, projects: [] }],
    ['multiple projects', REGISTRY],
    ['only missing projects', { ...REGISTRY, projects: REGISTRY.projects.map((p) => ({ ...p, status: 'missing' as const })) }],
  ])('asks for a selection with %s', (_label, registry) => {
    renderAt('/new?ref=task#anchor', { registry })
    expect(currentPathname()).toBe('/new')
    expect(screen.getByRole('heading', { name: 'Select a project' })).not.toBeNull()
    expect(getApiScope()).toBeNull()
    expect(screen.queryByLabelText('Describe a task for the agent')).toBeNull()
  })

  it('preserves a query and hash byte-for-byte across the redirect', () => {
    renderAt('/skills?skill=om-code-review&x=a%2Fb#usage', { registry: SINGLE_PROJECT })
    expect(currentPathname()).toBe('/p/boot/skills')
    expect(currentSearch()).toBe('?skill=om-code-review&x=a%2Fb')
    expect(currentHash()).toBe('#usage')
  })

  it('does not guess from health when the registry fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/v1/projects')) {
        return new Response(JSON.stringify({ error: 'down' }), { status: 404 })
      }
      return new Promise<never>(() => {})
    }))
    renderAt('/new', { registry: null })
    await screen.findByRole('button', { name: 'Retry' })
    expect(currentPathname()).toBe('/new')
    expect(getApiScope()).toBeNull()
  })

  it('waits while the registry is pending', () => {
    renderAt('/tasks/abc123', { seed: false })
    expect(routeName()).toBe('scope-resolving')
    expect(currentPathname()).toBe('/tasks/abc123')
  })

  it('an unknown legacy path still ends at the scoped 404', () => {
    renderAt('/definitely-not-a-route', { registry: SINGLE_PROJECT })
    expect(routeName()).toBe('not-found')
    expect(currentPathname()).toBe('/p/boot/definitely-not-a-route')
  })

  it('a bare /p names no project and resolves only an unambiguous project', () => {
    renderAt('/p', { registry: SINGLE_PROJECT })
    expect(routeName()).toBe('project-overview')
    expect(currentPathname()).toBe('/p/boot/')
  })

  it('preserves old skill redirects through both hops', () => {
    renderAt('/settings/skills?skill=om-code-review#usage', { registry: SINGLE_PROJECT })
    expect(currentPathname()).toBe('/p/boot/skills')
    expect(currentSearch()).toBe('?skill=om-code-review')
    expect(currentHash()).toBe('#usage')
  })

  it('keeps the old bookmarklet pseudo-skill link', () => {
    renderAt('/settings/skills?skill=__bm#saved', { registry: SINGLE_PROJECT })
    expect(currentPathname()).toBe('/p/boot/settings/bookmarklets')
    expect(currentSearch()).toBe('')
    expect(currentHash()).toBe('#saved')
  })
})

describe('the /p/default compatibility alias', () => {
  it('excludes missing directories from compatibility candidates', () => {
    renderAt('/p/default/skills', {
      registry: { ...REGISTRY, projects: [REGISTRY.projects[0]!, { ...REGISTRY.projects[1]!, status: 'missing' }] },
    })
    expect(currentPathname()).toBe('/p/boot/skills')
    expect(getApiScope()).toBe('boot')
  })

  it.each([
    ['/p/default/tasks/x?tab=a%2Fb#tool', '/p/boot/tasks/x', '?tab=a%2Fb', '#tool'],
    ['/p/default', '/p/boot/', '', ''],
  ])('normalizes %s only with one candidate', (entry, pathname, search, hash) => {
    renderAt(entry, { registry: SINGLE_PROJECT })
    expect(currentPathname()).toBe(pathname)
    expect(currentSearch()).toBe(search)
    expect(currentHash()).toBe(hash)
    expect(getApiScope()).toBe('boot')
  })

  it.each([REGISTRY, { ...REGISTRY, projects: [] }])('asks for a project when ambiguous', (registry) => {
    renderAt('/p/default/tasks/x', { registry })
    expect(currentPathname()).toBe('/p/default/tasks/x')
    expect(screen.getByRole('heading', { name: 'Select a project' })).not.toBeNull()
    expect(getApiScope()).toBeNull()
  })
})

describe('project availability', () => {
  it('keeps a missing project visible without mounting its page', () => {
    renderAt('/p/boot/new', {
      registry: { ...REGISTRY, projects: [{ ...REGISTRY.projects[0]!, status: 'missing' }] },
    })
    expect(currentPathname()).toBe('/p/boot/new')
    expect(screen.getByRole('heading', { name: 'Directory unavailable' })).not.toBeNull()
    expect(screen.getByText('/home/u/cezar')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Manage projects' }).getAttribute('href')).toBe('/projects')
    expect(screen.getByRole('button', { name: 'Remove binding' })).not.toBeNull()
    expect(getApiScope()).toBeNull()
    expect(screen.queryByLabelText('Describe a task for the agent')).toBeNull()
  })

  it('unmounts a project removed from the registry without redirecting', async () => {
    const client = renderAt('/p/boot/new')
    await act(async () => {
      client.setQueryData(workspaceQueryKeys.projects, { ...REGISTRY, projects: [REGISTRY.projects[1]!] })
    })
    expect(currentPathname()).toBe('/p/boot/new')
    await waitFor(() => expect(routeName()).toBe('unknown-project'))
    expect(getApiScope()).toBeNull()
  })

  it('retries registry errors before mounting a project page', async () => {
    let available = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/v1/projects')) {
        return new Response(JSON.stringify(available ? REGISTRY : { error: 'down' }), {
          status: available ? 200 : 404,
        })
      }
      return new Promise<never>(() => {})
    }))
    renderAt('/p/boot/new', { registry: null })
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(currentPathname()).toBe('/p/boot/new')
    expect(getApiScope()).toBeNull()
    expect(screen.queryByLabelText('Describe a task for the agent')).toBeNull()
    available = true
    fireEvent.click(retry)
    await screen.findByLabelText('Describe a task for the agent')
    expect(getApiScope()).toBe('boot')
  })
})

/** A deep link to a project this server never registered: the cockpit twin of the API's 404 —
 *  name the problem, list what IS registered, link out. */
describe('unknown project ids', () => {
  it('renders the not-registered screen with the registry list', () => {
    renderAt('/p/nope/tasks/x')
    expect(routeName()).toBe('unknown-project')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('nope')
    const links = Array.from(
      document.querySelectorAll('[data-slot="registered-projects"] a'),
    ).map((a) => a.getAttribute('href'))
    expect(links).toEqual([`/p/${BOOT}/`, '/p/other/'])
  })

  it('stays honestly resolving while the registry is still loading', () => {
    renderAt('/p/nope/tasks/x', { seed: false })
    expect(routeName()).toBe('scope-resolving')
  })
})

/** The bookmarklet contract (spec 011), protected by BACKWARD_COMPATIBILITY.md:
 *  `/new?skill=&ref=&auto=1&key=`. Since R4 Step 1.3 `auto=1` arms the real unattended start
 *  (the full matrix lives in routes/new-task.test.tsx); this file keeps the URL contract —
 *  through the legacy redirect, exactly as a saved bookmarklet arrives. */
describe('/new query params', () => {
  const textarea = () =>
    screen.getByLabelText('Describe a task for the agent') as HTMLTextAreaElement

  it('prefills the composer from a non-auto deep link', () => {
    renderAt('/new?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1', { registry: SINGLE_PROJECT })
    expect(routeName()).toBe('new')
    expect(textarea().value).toBe('https://github.com/o/r/pull/1')
  })

  it('an armed auto=1 link shows the starting surface, never the composer mid-flight', () => {
    // fetch never answers here, so the key check is honestly in flight: no composer to type
    // into, no run POSTed, and the key nowhere in the DOM.
    renderAt('/new?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1&auto=1&key=s3cret', { registry: SINGLE_PROJECT })
    expect(routeName()).toBe('new')
    expect(document.querySelector('[data-slot="auto-starting"]')).not.toBeNull()
    expect(screen.queryByLabelText('Describe a task for the agent')).toBeNull()
    expect(document.body.textContent).not.toContain('s3cret')
  })

  it('renders an empty composer without params', () => {
    renderAt('/new', { registry: SINGLE_PROJECT })
    expect(routeName()).toBe('new')
    expect(textarea().value).toBe('')
  })

  it('never prints the launch key anywhere on the page', () => {
    renderAt('/new?key=s3cret', { registry: SINGLE_PROJECT })
    expect(routeName()).toBe('new')
    expect(document.body.textContent).not.toContain('s3cret')
    expect(textarea().value).toBe('')
  })
})
