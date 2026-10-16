import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDownIcon, FolderGit2Icon, GlobeIcon } from 'lucide-react'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { t, useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { interactiveItemClasses } from './overview-link-card'

export function WorkspaceSwitcher({ projects, activeProjectId, onSelectGlobal, onSelectProject, onRegister }: {
  projects: readonly ProjectListEntry[]
  activeProjectId: string | null
  onSelectGlobal: () => void
  onSelectProject: (projectId: string) => void
  onRegister: () => void
}) {
  useLocale()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(-1)
  const selectedRow = useRef<HTMLButtonElement>(null)
  const listId = useId()
  useEffect(() => {
    selectedRow.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  const active = projects.find((project) => project.id === activeProjectId)
  const global = activeProjectId === null
  const rows = [
    { id: 'global', name: t('Global workspace'), select: onSelectGlobal },
    ...projects.filter((project) => project.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
      .map((project) => ({ id: `project:${project.id}`, name: project.name, project, select: () => onSelectProject(project.id) })),
    { id: 'register', name: t('Register project'), select: onRegister },
  ]
  const choose = (index: number) => {
    rows[index]?.select()
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); setSearch(''); setSelected(-1) }}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-auto min-h-11 w-full justify-start gap-2 px-2.5 py-2 text-left">
          {global ? <GlobeIcon className="size-4 shrink-0 text-violet" /> : <FolderGit2Icon className="size-4 shrink-0 text-foreground" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold">{global ? t('Global workspace') : `${t('Project')}: ${active?.name ?? activeProjectId}`}</span>
            <span className={cn('block truncate text-[10.5px] text-muted-foreground', !global && 'font-mono')}>
              {global ? t('No project selected') : (active?.root ?? t('Project is not registered'))}
            </span>
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1.5">
        <input type="search" role="searchbox" aria-label={t('Search projects')} value={search}
          aria-controls={listId} aria-activedescendant={selected < 0 ? undefined : `${listId}-${selected}`}
          className="mb-1.5 h-11 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9"
          onChange={(event) => { setSearch(event.target.value); setSelected(-1) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setSelected((index) => index < 0
                ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
            } else if (event.key === 'Enter' && selected >= 0) {
              event.preventDefault()
              choose(selected)
            }
          }} />
        <div id={listId} role="listbox" aria-label={t('Workspaces')} className="max-h-80 overflow-y-auto">
          {rows.map((row, index) => (
            <button key={row.id} id={`${listId}-${index}`} ref={selected === index ? selectedRow : undefined} type="button" role="option" tabIndex={-1}
              aria-selected={selected === index} onClick={() => choose(index)}
              onMouseMove={() => setSelected(index)}
              className={cn('block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted', interactiveItemClasses, selected === index && 'bg-muted')}>
              <span className="block truncate font-medium">{row.name}</span>
              {'project' in row && row.project ? <>
                <span className="block truncate font-mono text-[10.5px] text-muted-foreground" title={row.project.root}>{row.project.root}</span>
                {row.project.status === 'missing' ? <span className="block text-xs text-muted-foreground">{t('Directory unavailable')}</span> : null}
              </> : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
