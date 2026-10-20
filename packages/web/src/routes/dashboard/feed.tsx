import { t, useLocale, getLocale } from '@/lib/i18n'
import { DisclosureChevron, disclosureSummary, widgetHeading } from './presentation'
import { ExportRows } from './export-rows'
import { useContext, useLayoutEffect, useMemo, useRef } from 'react'
import type { DashboardFeed, DashboardFeedRow } from '@open-mercato/cezar-api-client'
import { useDashboardFeed } from '@/api/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { SegmentedControl } from '@/components/facet-filter'
import { shortAge } from '@/lib/format'
import { TaskRow, Coverage } from './rows'
import { DashboardEntryContext, readPanel, savePanel, useStagedRows } from './state'
function sourceLabel(key: string) {
  const isGithub = key.startsWith('github:')
  const isGitlab = key.startsWith('gitlab:')
  if (!isGithub && !isGitlab) return key === 'tasks' ? t('Task results') : key
  const prefix = isGithub ? 'github:' : 'gitlab:'
  const parts = key.slice(prefix.length).split(':')
  const kind = parts.pop() === 'pr' ? t('Pull requests') : t('Issues')
  const name = parts
    .join(':')
    .replace(/^project:/, t('Project '))
    .replace(/^github.com\//, '')
    .replace(/^gitlab.com\//, '')
  return `${name} · ${kind}`
}
const feedKey = (row: DashboardFeedRow) => row.key
export function Feed({
  filter,
  setFilter,
  count,
  more,
}: {
  filter: DashboardFeed['filter']
  setFilter: (value: DashboardFeed['filter']) => void
  count: number
  more: () => void
}) {
  useLocale()

  const query = useDashboardFeed(filter, true)
  const staged = useStagedRows(
    query.data?.rows, feedKey, `feed:${filter}`, 0,
    (row) => row.kind === 'task-result',
  )
  // Detached GitHub rows disappear immediately; task results retain reconciliation labels.
  const rows = staged.rows
  const updates = staged.updates
  const entry = useContext(DashboardEntryContext)
  const list = useRef<HTMLDivElement>(null)
  const scrollKey = `feed:${filter}`
  const restore = useMemo(() => ({
    scroll: readPanel(entry, scrollKey)?.scroll ?? 0,
    done: false,
  }), [entry, scrollKey])
  useLayoutEffect(() => {
    if (!list.current || restore.done) return
    list.current.scrollTop = restore.scroll
    // Cached rows may arrive after mounting; retry once the list can reach its position.
    restore.done = Math.abs(list.current.scrollTop - restore.scroll) < 1 ||
      (!!query.data && !query.isPending && !query.isFetching)
  }, [restore, rows.length, count, query.data, query.isPending, query.isFetching])
  const heading = useRef<HTMLHeadingElement>(null)
  const github = query.data?.sources.filter((s) => s.key.startsWith('github:') || s.key.startsWith('gitlab:')) ?? []
  const gitlab = github.filter((s) => s.key.startsWith('gitlab:'))
  // Which provider's word the chrome uses. The heading + summary speak GitHub only when every
  // configured forge is GitHub; any GitLab source (or a mix) gets the provider-neutral wording.
  const forgeWord = (githubWord: string, forgeWord: string) => gitlab.length ? forgeWord : githubWord
  const fetched = github.flatMap((s) => (s.fetchedAt ? [s.fetchedAt] : [])).sort()[0]
  const githubFailed = query.githubError
  const unconfigured = github.filter((s) => s.reason === 'No GitHub remote' || s.reason === 'No GitLab remote')
  const loading = github.some((s) => s.reason === 'Still loading GitHub' || s.reason === 'Still loading GitLab')
  const noGithub = github.length > 0 && unconfigured.length === github.length && !githubFailed
  const errors = github.filter(
    (s) =>
      s.state !== 'ready' &&
      s.reason !== 'No GitHub remote' &&
      s.reason !== 'No GitLab remote' &&
      s.reason !== 'Still loading GitHub' &&
      s.reason !== 'Still loading GitLab',
  )
  const tasksOnly = noGithub && filter === 'all'
  return (
    <Card
      data-export-context={`Results source: ${filter}; Last 7 days; loaded ${Math.min(count, rows.length)} rows`}
      className="min-w-0 gap-0 overflow-hidden py-0"
    >
      <div className="space-y-2 border-b px-4 pt-2.5 pb-2">
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
          <h2 ref={heading} tabIndex={-1} className={widgetHeading}>
            {tasksOnly ? t('Recent results') : t(forgeWord('Recent results & GitHub', 'Recent results & forge'))}
          </h2>
          <span className="font-mono text-[11px] text-soft-foreground">{t('Last 7 days')}</span>
        </div>
        {!tasksOnly && (
          <SegmentedControl
            slot="dashboard-feed"
            label={t('Results source')}
            value={filter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'tasks', label: 'Tasks' },
              { value: 'github', label: t(forgeWord('GitHub', 'Forge')) },
            ]}
            onChange={setFilter}
          />
        )}
        {tasksOnly && (
          <p className="text-xs text-muted-foreground">{t(forgeWord('Task results · No GitHub repositories configured', 'Task results · No forge repositories configured'))}</p>
        )}
        {filter !== 'tasks' && !tasksOnly && (
          <details
            className="text-xs text-muted-foreground"
            open={errors.length || githubFailed ? true : undefined}
          >
            <summary className={`${disclosureSummary} py-1.5`}>
              <DisclosureChevron />
              {errors.length || githubFailed
                ? t(forgeWord('GitHub needs attention', 'Forge needs attention'))
                : loading
                  ? t(forgeWord('Checking GitHub…', 'Checking forge…'))
                  : noGithub
                    ? t(forgeWord('GitHub not configured', 'Forge not configured'))
                    : fetched
                      ? t(forgeWord('GitHub checked {0} ago', 'Forge checked {0} ago'), { 0: shortAge(fetched) })
                      : t(forgeWord('GitHub source', 'Forge source'))}
            </summary>
            <div className="flex flex-wrap items-center justify-between gap-x-3">
              <p>
                {errors.length || githubFailed
                  ? fetched
                    ? t(forgeWord('Could not refresh GitHub. Showing results from {0}.', 'Could not refresh the forge. Showing results from {0}.'), { 0: new Date(fetched).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) })
                    : t(forgeWord('Could not load one or more GitHub sources.', 'Could not load one or more forge sources.'))
                  : loading
                    ? t('Checking repository sources. Available results remain visible.')
                    : noGithub
                      ? t(forgeWord('No GitHub repositories configured. Select Tasks to see task results.', 'No forge repositories configured. Select Tasks to see task results.'))
                      : fetched
                        ? t(forgeWord('GitHub checked {0} ago', 'Forge checked {0} ago'), { 0: shortAge(fetched) })
                        : t(forgeWord('GitHub snapshot', 'Forge snapshot'))}
              </p>
              {!noGithub && (
                <Button
                  variant="ghost"
                  className="min-h-11 px-0"
                  disabled={query.githubFetching}
                  onClick={() => {
                    void query.refetch()
                  }}
                >
                  {query.githubFetching
                    ? t('Refreshing…')
                    : errors.length || githubFailed
                      ? t(forgeWord('Retry GitHub', 'Retry forge'))
                      : t(forgeWord('Refresh GitHub', 'Refresh forge'))}
                </Button>
              )}
            </div>
          </details>
        )}
      </div>
      <div
        role="region"
        aria-label={t('Recent results list')}
        ref={list}
        onWheel={() => { restore.done = true }}
        onTouchStart={() => { restore.done = true }}
        onKeyDown={() => { restore.done = true }}
        onScroll={(event) => {
          if (entry && restore.done)
            savePanel(entry, scrollKey, { count, scroll: event.currentTarget.scrollTop })
        }}
        tabIndex={0}
        className="max-h-80 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {query.isError && (
          <p role="alert" className="p-4 text-sm">{t('Could not load results.')}{' '}
            <Button
              className="min-h-11"
              onClick={() => {
                void query.retryFailed()
              }}
            >{t('Retry')}</Button>
          </p>
        )}
        {query.isPending && <p className="p-4 text-sm">{t('Loading results…')}</p>}
        {updates > 0 && (
          <Button
            variant="ghost"
            className="m-2 min-h-11"
            onClick={() => {
              staged.show()
              heading.current?.focus()
            }}
          >
            {updates}{' '}{t('updates — Show')}</Button>
        )}
        {rows.slice(0, count).map(({ row, removed }) =>
          row.kind === 'task-result' ? (
            <TaskRow
              key={row.key}
              row={row.run}
              kicker={
                removed
                  ? t('Outside current results')
                  : `Latest result: ${row.run.status === 'failed' ? 'Failed' : 'Completed'}`
              }
            />
          ) : (
            <div key={row.key} className="border-b px-4 py-3 transition-colors hover:bg-muted/30">
              <ExportRows
                rows={[
                  {
                    section: 'github',
                    entity: `${row.repo}#${row.number}`,
                    metric: row.itemKind,
                    value: row.title,
                    asOf: row.at,
                    note: row.url,
                  },
                ]}
              />
              <a
                className="block break-words text-sm font-medium hover:underline no-hover:min-h-11"
                href={row.url}
                target="_blank"
                rel="noreferrer"
              >
                {row.title}
              </a>
              <p className="mt-1 text-xs text-muted-foreground">
                {row.repo} · {row.itemKind === 'pr' ? (row.provider === 'gitlab' ? t('MR') : t('PR')) : t('Issue')}{' '}
                {row.provider === 'gitlab' ? `!${row.number}` : `#${row.number}`}{' '}{t('created ·')}{' '}
                {shortAge(row.at)}
              </p>
            </div>
          ),
        )}
        {query.data &&
          !query.data.rows.length &&
          !rows.length &&
          !query.isFetching &&
          !query.isError &&
          !errors.length &&
          !loading &&
          query.data.coverage.projects.every((p) => p.state === 'complete') && (
            <p className="px-4 py-8 text-sm text-muted-foreground">{t('No results in the last 7 days')}</p>
          )}
        {count < rows.length && (
          <Button variant="ghost" className="m-2 min-h-11" onClick={more}>{t('Show')}{' '}{Math.min(20, rows.length - count)}{' '}{t('more results')}</Button>
        )}
        {query.data?.truncated && <p className="p-4 text-xs">{t('Showing the latest 60 results')}</p>}
        {query.data && (
          <Coverage
            coverage={query.data.coverage}
            retry={() => {
              void query.retryTasks()
            }}
          />
        )}
        {!tasksOnly && query.data?.sources.some((s) => s.state !== 'ready' || s.truncated) && (
          <details className="p-4 text-xs">
            <summary className={`${disclosureSummary} min-h-11`}>
              <DisclosureChevron />{t('Source details')}</summary>
            {query.data.sources.map((s) => (
              <p className="break-words py-1" key={s.key}>
                {sourceLabel(s.key)}:{' '}
                {s.reason === 'No GitHub remote' || s.reason === 'No GitLab remote'
                  ? t('Not configured')
                  : s.reason === 'Still loading GitHub' || s.reason === 'Still loading GitLab'
                    ? t('Checking…')
                    : (s.reason ?? (s.state === 'ready' ? t('Up to date') : s.state))}
                {s.truncated ? t(' · capped') : ''}
                {s.fetchedAt ? t(' · checked {0}', { 0: shortAge(s.fetchedAt) }) : ''}
              </p>
            ))}
          </details>
        )}
      </div>
    </Card>
  )
}
