import type { ProjectsResponse, WorkspaceLastLocation } from '@open-mercato/cezar-api-client'
import { describe, expect, it } from 'vitest'

import { recentProjectLocation, locationToSave, sameLastLocation } from './last-location'

const REGISTRY: ProjectsResponse = {
  projectsDir: '/work',
  projects: [
    {
      id: 'boot',
      name: 'Boot',
      root: '/work/boot',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'ok',
    },
    {
      id: 'other',
      name: 'Other',
      root: '/work/other',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'not-git',
    },
    {
      id: 'gone',
      name: 'Gone',
      root: '/work/gone',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'missing',
    },
  ],
}

/** A registry containing a single project. */
const UNREGISTERED_BOOT: ProjectsResponse = {
  projectsDir: '/work',
  projects: [
    {
      id: 'scratch',
      name: 'scratch',
      root: '/tmp/scratch',
      addedAt: '',
      lastOpenedAt: '',
      source: 'local',
      status: 'ok',
    },
  ],
}

describe('locationToSave', () => {
  it('normalizes a registered project URL including query and hash', () => {
    expect(
      locationToSave(
        {
          pathname: '/p/boot/tasks/run-1/changes',
          search: '?file=src%2Findex.ts',
          hash: '#L12',
        },
        REGISTRY,
      ),
    ).toEqual({
      projectId: 'boot',
      pathname: '/p/boot/tasks/run-1/changes',
      search: '?file=src%2Findex.ts',
      hash: '#L12',
    })
  })

  it('omits empty query and hash components', () => {
    expect(locationToSave({ pathname: '/p/boot/', search: '', hash: '' }, REGISTRY)).toEqual({
      projectId: 'boot',
      pathname: '/p/boot/',
    })
  })

  it('treats a registered not-git project as usable', () => {
    expect(locationToSave({ pathname: '/p/other/git', search: '', hash: '' }, REGISTRY)).toEqual({
      projectId: 'other',
      pathname: '/p/other/git',
    })
  })

  it.each([
    ['an unscoped path', { pathname: '/tasks/run-1', search: '', hash: '' }],
    ['an unknown project', { pathname: '/p/unknown/', search: '', hash: '' }],
    ['a missing project', { pathname: '/p/gone/', search: '', hash: '' }],
    ['an overlong path', { pathname: `/p/boot/${'x'.repeat(2041)}`, search: '', hash: '' }],
    ['a malformed encoded project', { pathname: '/p/%/', search: '', hash: '' }],
  ])('rejects %s', (_case, location) => {
    expect(locationToSave(location, REGISTRY)).toBeNull()
  })

  it('waits for the project registry before saving', () => {
    expect(locationToSave({ pathname: '/p/boot/', search: '', hash: '' }, undefined)).toBeNull()
  })

  it('saves a single registered project', () => {
    expect(locationToSave({ pathname: '/p/scratch/tasks', search: '', hash: '' }, UNREGISTERED_BOOT)).toEqual({
      projectId: 'scratch',
      pathname: '/p/scratch/tasks',
    })
  })
})

describe('recentProjectLocation', () => {
  const saved: WorkspaceLastLocation = {
    projectId: 'other',
    pathname: '/p/other/tasks/run-1/changes',
    search: '?file=x',
    hash: '#L2',
  }

  it('returns a valid registered location as a hint', () => {
    expect(recentProjectLocation(saved, REGISTRY)).toEqual(saved)
  })

  it('restores a registered not-git project', () => {
    expect(recentProjectLocation({ projectId: 'other', pathname: '/p/other/' }, REGISTRY)).toEqual({ projectId: 'other', pathname: '/p/other/' })
  })

  it.each([
    ['a non-object value', 'nope'],
    ['a missing field', { projectId: 'boot' }],
    ['an extra field', { projectId: 'boot', pathname: '/p/boot/', extra: true }],
    ['an unscoped path', { projectId: 'boot', pathname: '/tasks/run-1' }],
    ['a project/path mismatch', { projectId: 'boot', pathname: '/p/other/' }],
    ['an unknown project', { projectId: 'unknown', pathname: '/p/unknown/' }],
    ['a missing project', { projectId: 'gone', pathname: '/p/gone/' }],
    ['a search without ?', { projectId: 'boot', pathname: '/p/boot/', search: 'tab=runs' }],
    ['a hash without #', { projectId: 'boot', pathname: '/p/boot/', hash: 'L2' }],
  ])('rejects %s', (_case, value) => {
    expect(recentProjectLocation(value, REGISTRY)).toBeNull()
  })

  it('offers no hint while the registry is unavailable', () => {
    expect(recentProjectLocation(saved, undefined)).toBeNull()
  })
})

describe('sameLastLocation', () => {
  it('treats absent and empty optional components as equal', () => {
    const left: WorkspaceLastLocation = { projectId: 'boot', pathname: '/p/boot/' }
    const right: WorkspaceLastLocation = {
      projectId: 'boot',
      pathname: '/p/boot/',
      search: '',
      hash: '',
    }

    expect(sameLastLocation(left, right)).toBe(true)
  })

  it('detects a changed project, path, query, or hash', () => {
    const current: WorkspaceLastLocation = { projectId: 'boot', pathname: '/p/boot/', search: '?tab=runs' }

    expect(sameLastLocation(current, { ...current })).toBe(true)
    expect(sameLastLocation(undefined, current)).toBe(false)
    expect(sameLastLocation(current, { ...current, projectId: 'other' })).toBe(false)
    expect(sameLastLocation(current, { ...current, pathname: '/p/boot/git' })).toBe(false)
    expect(sameLastLocation(current, { ...current, search: '?tab=git' })).toBe(false)
    expect(sameLastLocation(current, { ...current, hash: '#L2' })).toBe(false)
  })
})
