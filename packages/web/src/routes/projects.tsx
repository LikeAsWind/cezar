import { useSearchParams } from 'react-router'

import { t, useLocale } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { PageContent, PageFrame, PageHeader } from '@/components/page-frame'
import { ProjectsRegistry } from '@/routes/settings/projects-section'

export function ProjectsRoute() {
  useLocale()

  const [searchParams, setSearchParams] = useSearchParams()
  const open = searchParams.get('register') === '1'

  const setOpen = (nextOpen: boolean) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (nextOpen) next.set('register', '1')
      else next.delete('register')
      return next
    })
  }

  return (
    <PageFrame data-route="projects">
      <PageHeader
        title={t('Projects')}
        description={t('Manage registered projects, status and project settings.')}
        actions={<Button onClick={() => setOpen(true)}>{t('Register project')}</Button>}
      />
      <PageContent className="p-0">
        <ProjectsRegistry registerDialogOpen={open} onRegisterDialogOpenChange={setOpen} />
      </PageContent>
    </PageFrame>
  )
}
