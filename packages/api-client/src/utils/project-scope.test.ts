import { afterEach, describe, expect, it } from 'vitest'

import {
  API_PREFIX,
  apiPath,
  getApiBaseUrl,
  getApiScope,
  projectApiBase,
  projectApiPath,
  queryScope,
  requireProjectScope,
  resolveApiUrl,
  runAssetPath,
  setApiBaseUrl,
  setApiScope,
} from './project-scope.ts'

afterEach(() => {
  setApiScope(null)
  setApiBaseUrl('')
})

describe('explicit project paths', () => {
  it('encodes the project id and normalizes a project-relative path', () => {
    expect(projectApiPath('api tools', '/runs')).toBe('/api/v1/p/api%20tools/runs')
    expect(projectApiPath('alpha', 'runs')).toBe('/api/v1/p/alpha/runs')
    expect(projectApiPath('alpha', '')).toBe('/api/v1/p/alpha')
    expect(() => projectApiPath('', '/runs')).toThrow('projectId is required')
  })

  it('encodes each run asset path segment', () => {
    expect(runAssetPath('api tools', 'run/1', 'a b.png')).toBe(
      '/api/v1/p/api%20tools/runs/run%2F1/images/a%20b.png',
    )
  })

  it('uses the explicit owner and configured origin regardless of active project scope', () => {
    setApiScope('other')
    setApiBaseUrl('https://cezar.example.com/gateway')
    expect(projectApiPath('alpha', '/runs')).toBe('https://cezar.example.com/gateway/api/v1/p/alpha/runs')
    expect(runAssetPath('alpha', 'run-1', 'shot.png')).toBe(
      'https://cezar.example.com/gateway/api/v1/p/alpha/runs/run-1/images/shot.png',
    )
  })
})

describe('apiPath — unscoped', () => {
  // Callers name a route; this module owns the version. Nothing in the app should be able to
  // produce an unversioned `/api/...` request — the service no longer answers on one.
  it.each([
    ['/runs', '/api/v1/runs'],
    ['/runs/run-1/files?path=shot.png&raw=1', '/api/v1/runs/run-1/files?path=shot.png&raw=1'],
    ['/runs/run-1/events', '/api/v1/runs/run-1/events'],
    ['/health', '/api/v1/health'],
    ['/workspace/events', '/api/v1/workspace/events'],
    ['/github?limit=5&refresh=1', '/api/v1/github?limit=5&refresh=1'],
  ])('versions %s', (route, expected) => {
    expect(apiPath(route)).toBe(expected)
  })

  it('reports the unscoped state as null — queryScope throws, never returns a default', () => {
    expect(getApiScope()).toBeNull()
    expect(() => queryScope()).toThrow('projectId is required')
    expect(apiPath('/runs')).toBe('/api/v1/runs')
  })

  it('keeps the version in exactly one place', () => {
    // The point of the constant: a v2 is one edit here, not sixty at the call sites.
    expect(API_PREFIX).toBe('/api/v1')
    expect(apiPath('/runs').startsWith(API_PREFIX)).toBe(true)
    expect(projectApiBase('cezar').startsWith(API_PREFIX)).toBe(true)
  })
})

describe('apiPath — scoped', () => {
  it('keeps workspace paths independent of the active project', () => {
    setApiScope('cezar')
    expect(apiPath('/runs')).toBe('/api/v1/runs')
    expect(apiPath('/runs/run-1/files?path=x.png&raw=1')).toBe(
      '/api/v1/runs/run-1/files?path=x.png&raw=1',
    )
    expect(apiPath('/runs/run-1/events')).toBe('/api/v1/runs/run-1/events')
    expect(queryScope()).toBe('cezar')
  })

  it('URL-encodes the project id', () => {
    // Registered slugs are tame, but the id rides into a URL — encode like every path segment.
    setApiScope('a b/c')
    expect(projectApiPath('a b/c', '/runs')).toBe('/api/v1/p/a%20b%2Fc/runs')
    expect(projectApiBase('a b/c')).toBe('/api/v1/p/a%20b%2Fc')
  })

  it('leaves workspace-level routes unscoped — they are single-mount, scoping would 404', () => {
    setApiScope('cezar')
    expect(apiPath('/health')).toBe('/api/v1/health')
    expect(apiPath('/models?runner=codex')).toBe('/api/v1/models?runner=codex')
    expect(apiPath('/projects')).toBe('/api/v1/projects')
    expect(apiPath('/workspace/events')).toBe('/api/v1/workspace/events')
    expect(apiPath('/providers/status')).toBe('/api/v1/providers/status')
    expect(apiPath('/fs/browse')).toBe('/api/v1/fs/browse')
  })

  it('never guesses scope from a route name', () => {
    setApiScope('cezar')
    // Workspace addressing does not infer a project from any route spelling.
    expect(apiPath('/healthcheck')).toBe('/api/v1/healthcheck')
  })

  it('treats the empty string as unscoped — there is no project ""', () => {
    setApiScope('')
    expect(getApiScope()).toBeNull()
    expect(apiPath('/runs')).toBe('/api/v1/runs')
  })
})

describe('projectApiBase', () => {
  it('builds the scoped base for a named project', () => {
    expect(projectApiBase('alpha')).toBe('/api/v1/p/alpha')
    expect(projectApiBase('cezar')).toBe('/api/v1/p/cezar')
  })

  it('throws on an empty id — there is no boot project to fall back to', () => {
    expect(() => projectApiBase('')).toThrow('projectId is required')
  })

  it('composes with a configured service base', () => {
    setApiBaseUrl('https://cezar.example.com')
    expect(projectApiBase('cezar')).toBe('https://cezar.example.com/api/v1/p/cezar')
  })
})

describe('requireProjectScope', () => {
  it('returns the active project when one is mounted', () => {
    setApiScope('cezar')
    expect(requireProjectScope()).toBe('cezar')
  })

  it('throws when no project is active — a project call must fail before fetching', () => {
    expect(() => requireProjectScope()).toThrow('projectId is required')
  })
})

describe('resolveApiUrl — URLs the server minted', () => {
  it('upgrades a URL stored before the API was versioned', () => {
    // Run transcripts keep absolute image URLs forever, so the cockpit renders paths written by
    // versions that predate `/api/v1`. Without this rewrite every historical screenshot 404s.
    expect(resolveApiUrl('/api/runs/r1/images/shot.png')).toBe('/api/v1/runs/r1/images/shot.png')
  })

  it('leaves an already-versioned URL alone', () => {
    expect(resolveApiUrl('/api/v1/runs/r1/images/shot.png')).toBe('/api/v1/runs/r1/images/shot.png')
  })

  it('re-scopes a stored unscoped URL onto the active project', () => {
    setApiScope('cezar')
    expect(resolveApiUrl('/api/runs/r1/images/shot.png')).toBe(
      '/api/v1/p/cezar/runs/r1/images/shot.png',
    )
  })

  it('keeps a URL that already names its own project', () => {
    setApiScope('cezar')
    expect(resolveApiUrl('/api/p/other/runs/r1/images/shot.png')).toBe(
      '/api/v1/p/other/runs/r1/images/shot.png',
    )
    expect(resolveApiUrl('/api/v1/p/other/runs/r1/images/shot.png')).toBe(
      '/api/v1/p/other/runs/r1/images/shot.png',
    )
  })

  it('does not touch what is not a cockpit API URL', () => {
    setApiScope('cezar')
    expect(resolveApiUrl('/raw/assets/icon.svg')).toBe('/raw/assets/icon.svg')
    expect(resolveApiUrl('https://github.com/o/r/pull/7')).toBe('https://github.com/o/r/pull/7')
    expect(resolveApiUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(resolveApiUrl('blob:http://localhost:4321/abc-123')).toBe('blob:http://localhost:4321/abc-123')
  })

  it('upgrades an ABSOLUTE URL stored before the API was versioned, keeping its origin', () => {
    // A transcript can carry a fully-qualified URL just as easily as a root-relative one, and the
    // unversioned spelling 404s either way — so the origin is preserved and only the path moves.
    expect(resolveApiUrl('http://127.0.0.1:4321/api/runs/r1/images/shot.png')).toBe(
      'http://127.0.0.1:4321/api/v1/runs/r1/images/shot.png',
    )
  })

  it('scopes an absolute stored URL onto the active project too', () => {
    setApiScope('cezar')
    expect(resolveApiUrl('http://127.0.0.1:4321/api/runs/r1/images/shot.png')).toBe(
      'http://127.0.0.1:4321/api/v1/p/cezar/runs/r1/images/shot.png',
    )
  })

  it('leaves an absolute URL that already names its own project alone', () => {
    setApiScope('cezar')
    expect(resolveApiUrl('http://127.0.0.1:4321/api/v1/p/other/runs/r1/images/shot.png')).toBe(
      'http://127.0.0.1:4321/api/v1/p/other/runs/r1/images/shot.png',
    )
  })

  it('never re-bases an absolute URL onto the configured base', () => {
    // The origin in the stored URL wins: rewriting someone else's host is not this function's job.
    setApiBaseUrl('https://cezar.example.com')
    expect(resolveApiUrl('http://127.0.0.1:4321/api/runs/r1/images/a.png')).toBe(
      'http://127.0.0.1:4321/api/v1/runs/r1/images/a.png',
    )
  })
})

describe('setApiBaseUrl — the service on another origin', () => {
  it('defaults to same-origin, which is the cockpit\'s own case', () => {
    expect(getApiBaseUrl()).toBe('')
    expect(apiPath('/runs')).toBe('/api/v1/runs')
  })

  it('prefixes every route once the base is set', () => {
    setApiBaseUrl('https://cezar.example.com')
    expect(apiPath('/runs')).toBe('https://cezar.example.com/api/v1/runs')
    expect(projectApiBase('cezar')).toBe('https://cezar.example.com/api/v1/p/cezar')
  })

  it('composes with the project scope', () => {
    setApiBaseUrl('https://cezar.example.com')
    setApiScope('cezar')
    expect(apiPath('/runs')).toBe('https://cezar.example.com/api/v1/runs')
    expect(projectApiBase('cezar')).toBe('https://cezar.example.com/api/v1/p/cezar')
  })

  it('tolerates a trailing slash — it would otherwise double against the route', () => {
    setApiBaseUrl('https://cezar.example.com/')
    expect(apiPath('/runs')).toBe('https://cezar.example.com/api/v1/runs')
  })

  it('works with a path prefix, for a service behind a reverse proxy', () => {
    setApiBaseUrl('/cezar')
    expect(apiPath('/runs')).toBe('/cezar/api/v1/runs')
  })

  it('re-bases a stored transcript URL rather than double-prefixing one', () => {
    setApiBaseUrl('https://cezar.example.com')
    // Written by a server that had no base — still has to resolve against this one.
    expect(resolveApiUrl('/api/runs/r1/images/a.png')).toBe(
      'https://cezar.example.com/api/v1/runs/r1/images/a.png',
    )
    // Already based: must not gain a second copy of the origin.
    expect(resolveApiUrl('https://cezar.example.com/api/v1/runs/r1/images/a.png')).toBe(
      'https://cezar.example.com/api/v1/runs/r1/images/a.png',
    )
  })

  it('leaves a foreign absolute URL alone', () => {
    setApiBaseUrl('https://cezar.example.com')
    expect(resolveApiUrl('https://github.com/o/r/pull/7')).toBe('https://github.com/o/r/pull/7')
  })
})
