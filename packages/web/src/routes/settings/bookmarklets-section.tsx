import { t, useLocale } from '@/lib/i18n'
import { TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'

import { useHealth, useLaunchKey, useProjects, useSkills } from '@/api/queries'
import type { Skill } from '@open-mercato/cezar-api-client'
import { BookmarkletRow } from '@/components/bookmarklet-row'
import { CenteredState } from '@/components/centered-state'
import { Input } from '@/components/ui/input'
import { bookmarkletUrl } from '@/lib/bookmarklet'
import { useActiveProjectId } from '@/lib/project-router'
import { orderSkills } from '@/lib/skills'

/** Settings → Bookmarklets (spec 011): the legacy generic and per-skill launchers promoted
 *  to a first-class, discoverable Settings subpage. */
export function BookmarkletsSection() {
  useLocale()

  const skillsQuery = useSkills()

  // Without this the in-flight catalog renders as the panel's empty state, which tells the
  // user "(no skills yet)" — a claim that is simply false while the fetch is still running.
  if (skillsQuery.isPending) {
    return (
      <p data-slot="bookmarklets-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">{t('Loading bookmarklets…')}</p>
    )
  }
  if (skillsQuery.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title={t('Could not load bookmarklets')}
        subtitle={skillsQuery.error.message}
      />
    )
  }

  return (
    <div className="flex min-h-full flex-1 overflow-y-auto px-4 py-5 md:px-7">
      <BookmarkletPanel skills={orderSkills(skillsQuery.data ?? [])} />
    </div>
  )
}

/**
 * The bookmarklet generator panel (spec 011, ported from the legacy cockpit): draggable
 * `javascript:` links against the protected `/new?skill=&key=` contract (`lib/bookmarklet`).
 * A failed key fetch degrades exactly like legacy — the links still generate, auto-start
 * just will not arm.
 *
 * Project-scoped since the multi-project spec (step 3.6): the pane lives under each project's
 * settings, and the links it makes carry that project's URL prefix AND that project's launch
 * key. Both fall out of the surrounding scope machinery — nothing here picks a project.
 *
 * Exported so the former Settings → Skills deep link remains compatible while the same
 * generator also has its own Settings subpage.
 */
export function BookmarkletPanel({ skills }: { skills: readonly Skill[] }) {
  useLocale()

  // The project the URL names, from the `/p/<id>` prefix. Outside a project route there is no
  // project to target, so the generator renders nothing (and issues no request) — the hooks that
  // read the project scope below are never mounted without one.
  const projectId = useActiveProjectId()
  if (projectId === null) return null
  return <BookmarkletPanelInner projectId={projectId} skills={skills} />
}

function BookmarkletPanelInner({ projectId, skills }: { projectId: string; skills: readonly Skill[] }) {
  const launchKey = useLaunchKey()
  const health = useHealth()
  const projects = useProjects()
  const [auto, setAuto] = useState(false)
  const [filter, setFilter] = useState('')
  // THIS project's own launch key: `useLaunchKey` goes through the scoped API client, so under
  // `/p/<id>/settings` it reads `/api/p/<id>/launch-key` — that repo's `.ai/cezar/launch-key`,
  // which is the only secret the target cockpit scope will accept (multi-project spec, 3.6).
  const key = launchKey.data?.key ?? ''
  // Bake THIS cockpit's origin into the bookmarklets so a click opens the very instance that
  // generated them — no localhost port-scan (GitHub's CSP blocks that fetch). See bookmarklet.ts.
  const origin = window.location.origin
  // The project name stamped into the bookmark's visible label, so a person with several
  // projects (or several cockpits) open can tell their bookmarks apart in the bar (#422). The
  // REGISTRY answers per project; `/api/health` is workspace-level and never names a project's
  // repo, so it is only the fallback for the registry-unavailable case.
  const repoName =
    projects.data?.projects.find((project) => project.id === projectId)?.name ??
    null
  const needle = filter.trim().toLowerCase()
  const shown = skills.filter((skill) => skill.name.toLowerCase().includes(needle))

  return (
    <div data-slot="bookmarklet-panel" className="mx-auto w-full max-w-2xl">
      <h2 className="text-base font-semibold">{t('Run from GitHub')}</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{t('Drag a button below to your browser\'s bookmarks bar. On any GitHub PR or issue, click it to open this cockpit directly. The cockpit must be running:')}{' '}<span className="font-mono">npx cezar</span>.
      </p>

      <label className="mt-4 flex items-center gap-2 text-[13px] font-medium">
        <input
          type="checkbox"
          data-slot="bm-auto"
          checked={auto}
          onChange={(event) => setAuto(event.target.checked)}
          className="size-3.5"
        />{t('One-click launch (auto-submit)')}{' '}
        <span className="font-normal text-soft-foreground">{t('— re-drag the buttons after changing this')}</span>
      </label>

      <div data-slot="bm-generic" className="mt-4">
        {/* Generic launcher: no skill, auto forced off — it only prefills the form. */}
        <BookmarkletRow
          label={repoName ? t('cezar ({0}): this PR/issue', { 0: repoName }) : t('cezar: this PR/issue')}
          url={bookmarkletUrl('', false, key, origin, projectId)}
          hint={t('prefills the form — nothing starts by itself')}
        />
      </div>

      <Input
        data-slot="bm-filter"
        placeholder={t('Filter skills…')}
        aria-label={t('Filter bookmarklet skills')}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className="mt-5 h-8 text-[13px]"
      />
      <div data-slot="bm-list" className="mt-3 flex flex-col gap-2">
        {shown.length > 0 ? (
          shown.map((skill) => (
            <BookmarkletRow
              key={skill.path}
              label={repoName ? `/${skill.name} (${repoName})` : `/${skill.name}`}
              url={bookmarkletUrl(skill.name, auto, key, origin, projectId)}
              hint={skill.source}
            />
          ))
        ) : (
          <p className="text-xs text-soft-foreground">
            {skills.length > 0
              ? t('(no skills match)')
              : t('(no skills yet — the generic launcher above still works)')}
          </p>
        )}
      </div>
    </div>
  )
}
