import { requireProjectScope } from '@open-mercato/cezar-api-client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getWecomSettings, saveWecomSettings, testWecomSettings } from '@/api/wecom'
import { WeComWebhookSettings } from '@/components/wecom-webhook-settings'
import { t, useLocale } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { CenteredState } from '@/components/centered-state'
import { WebhookIcon } from 'lucide-react'

export function WeComNotificationsSection() {
  useLocale()
  const projectId = requireProjectScope()
  const key = ['project', projectId, 'notifications', 'wecom'] as const
  const client = useQueryClient()
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => getWecomSettings(projectId, signal) })
  if (query.isPending) return (
    <div role="status" aria-label={t('Loading WeCom settings…')} className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 md:p-6">
      {[0, 1, 2, 3].map(row => <div key={row} aria-hidden="true" className="space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-3/4" /><Skeleton className={row === 0 ? 'h-5 w-9' : 'h-9 w-full'} /></div>)}
    </div>
  )
  if (query.isError) return <CenteredState icon={<WebhookIcon />} tone="danger" heading="h2" title={t('Could not load WeCom settings.')} subtitle={t('Check the project connection and try again.')} actions={<Button variant="outline" onClick={() => void query.refetch()}>{t('Retry')}</Button>} />
  return <WeComWebhookSettings key={JSON.stringify(query.data)} value={query.data}
    onSave={async input => { client.setQueryData(key, await saveWecomSettings(projectId, input)) }}
    onTest={async input => { if (!(await testWecomSettings(projectId, input)).sent) throw new Error('Message not sent') }} />
}
