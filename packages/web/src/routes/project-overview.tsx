import { Link as GlobalLink } from 'react-router'

import { useProjectScope } from '@/api/project-scope-context'
import { useProjects } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { t, useLocale } from '@/lib/i18n'
import { Link } from '@/lib/project-router'

export function ProjectOverviewRoute() {
  useLocale()

  const { projectId } = useProjectScope()
  const projects = useProjects()
  const project = projects.data?.projects.find((entry) => entry.id === projectId)

  return (
    <div data-route="project-overview" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">{t('Project overview')}</h1>
        <div className="flex-1" />
        <Button asChild variant="outline" size="sm">
          <GlobalLink to="/">{t('Back to global workspace')}</GlobalLink>
        </Button>
      </header>
      <section className="flex flex-col items-start gap-4 p-5">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{project?.name || projectId}</h2>
          <p className="break-all font-mono text-xs text-muted-foreground">{project?.root}</p>
        </div>
        <Button asChild>
          <Link to="/tasks">{t('Tasks & Worktrees')}</Link>
        </Button>
      </section>
    </div>
  )
}
