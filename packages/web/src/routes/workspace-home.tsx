import { t, useLocale } from '@/lib/i18n'
import { LayoutDashboardIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'
import { useProjects } from '@/api/queries'
import { readStoredLastLocation, recentProjectLocation } from '@/lib/last-location'
import { Link } from 'react-router'

/** Fixed global home; a remembered project is offered only as an explicit link. */
export function WorkspaceHomeRoute() {
  useLocale()
  const projects = useProjects()
  const recent = recentProjectLocation(readStoredLastLocation(), projects.data)
  const recentProject = projects.data?.projects.find((project) => project.id === recent?.projectId)

  return (
    <div data-route="workspace-home" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LayoutDashboardIcon />}
        tone="primary"
        title={t('Workspace')}
        subtitle={t('Every project in one place. Open a project from the sidebar, or start a task in one.')}
        backdrop
      >
        {recent && recentProject ? (
          <Link to={`${recent.pathname}${recent.search ?? ''}${recent.hash ?? ''}`} className="text-sm text-primary underline">
            {t('Recent project: {0}', { 0: recentProject.name || recentProject.id })}
          </Link>
        ) : null}
      </CenteredState>
    </div>
  )
}
