import { cleanup, render } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider, useProjectScope } from './project-scope-context'
import { apiPath, getApiScope, queryScope, setApiScope } from '@open-mercato/cezar-api-client'

afterEach(() => {
  cleanup()
  setApiScope(null)
})

/** Reads everything a scoped child would: the context AND the module seam. */
function Probe() {
  const scope = useProjectScope()
  return (
    <output data-testid="probe">
      {scope.projectId === null
        ? '-'
        : `${scope.projectId}|${scope.apiBase}|${queryScope()}|${apiPath('/runs')}`}
    </output>
  )
}

describe('ProjectScopeProvider', () => {
  it('answers null outside any provider — the global workspace', () => {
    const view = render(<Probe />)
    expect(view.getByTestId('probe').textContent).toBe('-')
  })

  it('refuses to queryScope outside a provider — there is no default project', () => {
    expect(() => queryScope()).toThrow('projectId is required')
  })

  it('scopes both the context and the module seam before the children render', () => {
    const view = render(
      <ProjectScopeProvider projectId="cezar">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(view.getByTestId('probe').textContent).toBe(
      'cezar|/api/v1/p/cezar|cezar|/api/v1/p/cezar/runs',
    )
    expect(getApiScope()).toBe('cezar')
  })

  it('follows a projectId change and resets to null on unmount', () => {
    const view = render(
      <ProjectScopeProvider projectId="a">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(getApiScope()).toBe('a')

    view.rerender(
      <ProjectScopeProvider projectId="b">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(view.getByTestId('probe').textContent).toBe('b|/api/v1/p/b|b|/api/v1/p/b/runs')

    view.unmount()
    expect(getApiScope()).toBeNull()
  })

  it('never dips back to null while remounting children across a projectId change', () => {
    const seen: (string | null)[] = []
    function MountProbe() {
      useEffect(() => {
        seen.push(getApiScope())
      }, [])
      return null
    }

    const view = render(
      <ProjectScopeProvider projectId="a">
        <MountProbe key="a" />
      </ProjectScopeProvider>,
    )
    view.rerender(
      <ProjectScopeProvider projectId="b">
        <MountProbe key="b" />
      </ProjectScopeProvider>,
    )
    expect(seen).toEqual(['a', 'b'])
  })

  it('never dips back to null through StrictMode’s remount of a fresh subtree', () => {
    const seen: (string | null)[] = []
    function MountProbe() {
      useEffect(() => {
        seen.push(getApiScope())
      }, [])
      return null
    }

    render(
      <StrictMode>
        <ProjectScopeProvider projectId="a">
          <MountProbe />
        </ProjectScopeProvider>
      </StrictMode>,
    )
    expect(seen).toEqual(['a', 'a'])
  })

  it('refuses to mount without a project id — there is no boot project to default to', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      render(
        <ProjectScopeProvider projectId={'' as string}>
          <Probe />
        </ProjectScopeProvider>,
      ),
    ).toThrow('ProjectScopeProvider requires projectId')
    spy.mockRestore()
  })
})
