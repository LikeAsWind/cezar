import { t } from '@/lib/i18n'
import { trackerKindSchema, type TrackerKind } from '@open-mercato/cezar-api-client'

/** Presentation only: credential values and adapter construction belong on the server. */
export const TRACKER_PROVIDERS = {
  jira: { get label() { return t('Jira') }, scopeLabel: 'Jira projects' },
  linear: { get label() { return t('Linear') }, scopeLabel: 'Linear teams' },
} as const satisfies Record<TrackerKind, {
  label: string
  scopeLabel: string
}>

export const trackerProviders = trackerKindSchema.options.map(kind => ({ kind, ...TRACKER_PROVIDERS[kind] }))
