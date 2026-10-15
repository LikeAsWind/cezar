import { t, useLocale } from '@/lib/i18n'
import { FolderSearchIcon } from 'lucide-react'
import { Link, useNavigate } from 'react-router'

import type { ProjectsResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { useProjectRemoval } from '@/routes/settings/remove-project'

/** Unknown project ids and ambiguous legacy links never choose another project implicitly. */
export function UnknownProjectRoute({
  projectId,
  registry,
}: {
  projectId?: string
  registry?: ProjectsResponse
}) {
  useLocale()

  // Without a registry (the read failed) there is nothing true to list — the list is simply
  // absent, and the heading still says what went wrong.
  const projects = registry?.projects ?? []

  return (
    <div data-route="unknown-project" className="flex min-h-full flex-col">
      <CenteredState
        icon={<FolderSearchIcon />}
        tone="neutral"
        title={projectId === undefined ? t('Select a project') : t('“{0}” isn’t registered here', { 0: projectId })}
        subtitle={
          projectId === undefined
            ? t('Choose a registered project to open this page.')
            : projects.length === 0
            ? t('This workspace doesn’t serve a project by that id. The link may come from another machine’s workspace.')
            : t('This workspace doesn’t serve a project by that id. The link may come from another machine’s workspace — these are the projects this one can open:')
        }
        actions={
          <>
            <Button asChild><Link to="/">{t('Back to global workspace')}</Link></Button>
            <Button asChild variant="outline"><Link to="/projects">{t('Manage projects')}</Link></Button>
          </>
        }
      >
        {projects.length === 0 ? null : (
          <ul data-slot="registered-projects" className="mx-auto flex w-full max-w-xs flex-col gap-1.5 text-left">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  to={`/p/${encodeURIComponent(project.id)}/`}
                  className="flex items-baseline gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-xs transition-colors hover:bg-card-2"
                >
                  {project.name || project.id}
                  <span className="font-mono text-[11px] font-normal text-soft-foreground">/p/{project.id}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CenteredState>
    </div>
  )
}

export function MissingProjectRoute({ project }: { project: ProjectsResponse['projects'][number] }) {
  useLocale()

  const navigate = useNavigate()
  const remove = useProjectRemoval()

  return (
    <CenteredState
      icon={<FolderSearchIcon />}
      title={t('Directory unavailable')}
      subtitle={project.name || project.id}
      actions={
        <>
          <Button asChild><Link to="/">{t('Back to global workspace')}</Link></Button>
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={() => remove.confirm(project, () => navigate('/'))}
          >{t('Remove binding')}</Button>
          <Button asChild variant="outline"><Link to="/projects">{t('Manage projects')}</Link></Button>
        </>
      }
    >
      <p className="break-all font-mono text-sm text-muted-foreground">{project.root}</p>
    </CenteredState>
  )
}
