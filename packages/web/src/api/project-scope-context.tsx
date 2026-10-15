import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react'

import { getApiScope, projectApiBase, setApiScope } from '@open-mercato/cezar-api-client'

/**
 * The React face of the project scope: components read `{projectId, apiBase}` from context; the
 * module-level client seam (project-scope.ts) is kept in sync by the provider. The provider is
 * mounted only under a valid `/p/:projectId` route, so `projectId: null` means "global workspace,
 * no project" — and a provider asked to bind NO project is a caller bug it refuses to mount.
 */
export interface ProjectScope {
  /** The registered project id the URL names, or null in the global workspace. */
  projectId: string | null
  /** `/api/v1/p/<id>` inside a project, null in the global workspace. */
  apiBase: string | null
}

const GLOBAL_SCOPE: ProjectScope = { projectId: null, apiBase: null }

export const ProjectScopeContext = createContext<ProjectScope>(GLOBAL_SCOPE)

/** The active scope. Outside a provider this is the global workspace, not an error. */
export function useProjectScope(): ProjectScope {
  return useContext(ProjectScopeContext)
}

/**
 * Bind a project scope to this subtree and keep the module-level API scope in sync.
 *
 * `projectId` is required — there is no boot project to default to, and a project-scoped subtree
 * rendered without one would send every request to `null` (and throw in the client) instead of a
 * real project.
 */
export function ProjectScopeProvider({
  projectId,
  children,
}: {
  projectId: string
  children: ReactNode
}) {
  if (!projectId) throw new Error('ProjectScopeProvider requires projectId')

  // Written DURING render (not just in the effect): the children's very first render computes
  // query keys, and an effect would run after it. Idempotent and derived solely from props, so
  // re-renders (StrictMode's double-invoke included) converge on the same value.
  if (getApiScope() !== projectId) setApiScope(projectId)

  useLayoutEffect(() => {
    setApiScope(projectId)
  }, [projectId])

  // Unmount only: leaving a project route clears the module scope, so the global workspace's
  // requests go out unscoped rather than carrying the departed project.
  useLayoutEffect(() => () => setApiScope(null), [])

  const value = useMemo<ProjectScope>(
    () => ({ projectId, apiBase: projectApiBase(projectId) }),
    [projectId],
  )
  return <ProjectScopeContext.Provider value={value}>{children}</ProjectScopeContext.Provider>
}
