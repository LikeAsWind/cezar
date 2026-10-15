import { t, useLocale } from '@/lib/i18n'

import { ProjectsSection } from '@/routes/settings/projects-section'

/** Global entry to the existing project registry surface. */
export function ProjectsRoute() {
  useLocale()

  return (
    <div data-route="projects" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">{t('Projects')}</h1>
        <p className="text-[13px] text-soft-foreground">{t('The workspace registry and where GitHub checkouts land.')}</p>
      </header>
      <ProjectsSection />
    </div>
  )
}
