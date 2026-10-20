import { describe, expect, it } from 'vitest'

import { GLOBAL_NAV_ITEMS, NAV_ITEMS, activeNavItem, activeNavPath, projectNavItems, visibleNavItems, forgeProviderIcon } from './nav-items'

describe('workspace and project navigation', () => {
  it('keeps the global doors independent from project capabilities', () => {
    expect(GLOBAL_NAV_ITEMS.map((item) => [item.to, item.label])).toEqual([
      ['/', 'Workspace'], ['/tasks', 'All tasks'], ['/projects', 'Projects'], ['/settings/global', 'Global settings'],
    ])
  })

  it('provides project overview, task and settings destinations with capability gates', () => {
    const items = projectNavItems({ tracker: 'linear', automations: true })
    expect(items.map((item) => [item.to, item.label])).toEqual([
      ['/', 'Overview'], ['/tasks', 'Tasks & Worktrees'], ['/git', 'Git / GitHub'],
      ['/tracker', 'Linear'], ['/automations', 'Automations'], ['/skills', 'Skills'],
      ['/workflows', 'Workflows'], ['/settings', 'Project settings'],
    ])
    expect(projectNavItems({ forge: true, inbox: true }).map((item) => item.to)).toContain('/github')
    expect(projectNavItems({ forge: true, inbox: true }).map((item) => item.to)).toContain('/inbox')
  })
})

/** Which nav item owns a URL. This is the rule that decides what the user sees lit up, and it
 *  is not a plain equality check — items own areas, and the Settings area nests. */
describe('activeNavPath', () => {
  const cases: Array<[pathname: string, active: string | null]> = [
    // The project overview has its own route; Tasks owns task and comparison surfaces.
    ['/', null],
    ['/tasks', '/tasks'],
    ['/tasks/abc123', '/tasks'],
    ['/tasks/abc123/changes', '/tasks'],
    ['/tasks/abc123/files', '/tasks'],
    ['/compare/grp-1', '/tasks'],

    ['/inbox', '/inbox'],
    ['/git', '/git'],
    ['/github', '/github'],
    ['/github/issues/42', '/github'],
    ['/github/prs/7', '/github'],
    ['/tracker', '/tracker'],
    ['/tracker/OPS-7', '/tracker'],
    ['/workflows', '/workflows'],
    ['/workflows/ship-it', '/workflows'],

    // Skills is its own top-level surface now (was /settings/skills).
    ['/skills', '/skills'],

    // The nested Settings area: deeper routes fall to the Settings item.
    ['/settings', '/settings'],
    ['/settings/appearance', '/settings'],
    ['/settings/agents', '/settings'],

    // Full-screen surfaces with no nav home — nothing may light up.
    ['/new', null],
    ['/nope-404', null],
  ]

  for (const [pathname, active] of cases) {
    it(`${pathname} → ${active ?? 'no active item'}`, () => {
      expect(activeNavPath(pathname)).toBe(active)
    })
  }

  // A `startsWith` implementation passes every case above and still fails these two.
  it('does not let /git claim the /github area', () => {
    expect(activeNavPath('/github')).toBe('/github')
  })

  it('does not let the root item claim every route', () => {
    expect(activeNavPath('/git')).toBe('/git')
  })
})

describe('activeNavItem', () => {
  it('returns the item, so the mobile bar can title itself', () => {
    expect(activeNavItem('/tasks/abc123')?.label).toBe('Tasks')
    expect(activeNavItem('/skills')?.label).toBe('Skills')
  })

  it('returns null off-nav', () => {
    expect(activeNavItem('/new')).toBeNull()
  })
})

describe('NAV_ITEMS', () => {
  it('is the nav from the spec, in mockup order', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'GitHub',
      'Tracker',
      'Automations',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  // Every item must be reachable by its own URL, or a click would navigate somewhere that
  // does not light the item the user just clicked.
  it('each item is the active item for its own `to`', () => {
    for (const item of NAV_ITEMS) {
      expect(activeNavPath(item.to)).toBe(item.to)
    }
  })
})

/** The gates: the GitHub item exists exactly while health reports the forge driver (R6 Step 1.1),
 *  the Inbox item exactly while it reports the opt-in `capabilities.followups` (#471), and the
 *  Automations item exactly while it reports a forge AND the opt-in `capabilities.automations`
 *  (#801). Each gate owns ONLY its own items, and all default to absent while health is
 *  unknown. */
describe('visibleNavItems', () => {
  const labelsOf = (opts?: Parameters<typeof visibleNavItems>[0]) =>
    visibleNavItems(opts).map((item) => item.label)

  it('with everything available, the full nav renders', () => {
    expect(labelsOf({ forge: true, inbox: true, automations: true, tracker: 'jira' })).toEqual([
      'Tasks', 'Inbox', 'Git', 'GitHub', 'Jira', 'Automations', 'Skills', 'Workflows', 'Settings',
    ])
  })

  it('shows the saved provider label and hides an unassociated tracker', () => {
    expect(labelsOf({ tracker: 'jira' })).toContain('Jira')
    expect(labelsOf({ tracker: 'linear' })).toContain('Linear')
    expect(labelsOf()).not.toContain('Tracker')
  })

  it('labels the forge item GitLab and the Git section Git / GitLab for a GitLab project', () => {
    expect(labelsOf({ forge: true, forgeKind: 'gitlab' })).toContain('GitLab')
    expect(labelsOf({ forge: true, forgeKind: 'gitlab' })).not.toContain('GitHub')
    expect(projectNavItems({ forge: true, forgeKind: 'gitlab' }).map((item) => [item.to, item.label]))
      .toContainEqual(['/git', 'Git / GitLab'])
  })

  it('swaps the forge item icon with the provider', () => {
    expect(forgeProviderIcon('gitlab').name).toBe('GitlabIcon')
    expect(forgeProviderIcon('github').name).toBe('GithubIcon')
    expect(forgeProviderIcon(undefined).name).toBe('GithubIcon')
    const gitlabForgeItem = visibleNavItems({ forge: true, forgeKind: 'gitlab' }).find((item) => item.to === '/github')
    expect(gitlabForgeItem?.icon.name).toBe('GitlabIcon')
  })

  it('keeps the GitHub labels when no forge kind is named (existing default)', () => {
    expect(labelsOf({ forge: true })).toContain('GitHub')
    expect(projectNavItems({ forge: true }).map((item) => [item.to, item.label]))
      .toContainEqual(['/git', 'Git / GitHub'])
  })

  it('without a forge, only the GitHub item drops out — a schedule needs no remote', () => {
    expect(labelsOf({ forge: false, inbox: true, automations: true })).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'Automations',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  it('without the inbox, exactly the Inbox item drops out (#471)', () => {
    expect(labelsOf({ forge: true, inbox: false, automations: true })).toEqual([
      'Tasks',
      'Git',
      'GitHub',
      'Automations',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  it('opted out of automations, exactly the Automations item drops out', () => {
    expect(labelsOf({ forge: true, inbox: true, automations: false })).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'GitHub',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  // The two gates on that one item are ANDed: a forge alone does not resurrect it, which is the
  // whole point of #801 — every project with a GitHub remote used to see the tab.
  it('a forge alone does not bring Automations back', () => {
    expect(labelsOf({ forge: true, inbox: false })).not.toContain('Automations')
  })

  it('drops all three when nothing is available', () => {
    expect(labelsOf({ forge: false, inbox: false, automations: false })).toEqual([
      'Tasks',
      'Git',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  it('defaults to absent — the nav claims nothing before health answers', () => {
    expect(labelsOf()).toEqual(labelsOf({ forge: false, inbox: false, automations: false }))
  })

  it('never invents an item — the result is always a subset of NAV_ITEMS, in order', () => {
    for (const forge of [true, false]) {
      for (const inbox of [true, false]) {
        for (const automations of [true, false]) {
          const items = visibleNavItems({ forge, inbox, automations })
          expect(NAV_ITEMS.filter((i) => items.includes(i))).toEqual(items)
        }
      }
    }
  })
})
