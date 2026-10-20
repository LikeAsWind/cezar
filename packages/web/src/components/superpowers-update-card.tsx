import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { activateSuperpowersUpdate, checkSuperpowersUpdate, rollbackSuperpowersUpdate, setSuperpowersAutoCheck, stageSuperpowersUpdate } from '@/api/client'
import { useSuperpowersUpdate, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { t, useLocale } from '@/lib/i18n'
import type { SuperpowersUpdateState } from '@open-mercato/cezar-api-client'

export function SuperpowersUpdateCard() {
  useLocale()
  const query = useSuperpowersUpdate()
  const client = useQueryClient()
  const state = query.data
  const [reviewedDigest, setReviewedDigest] = useState<string | null>(null)
  const action = useMutation({
    mutationFn: (run: () => Promise<SuperpowersUpdateState>) => run(),
    onSuccess: (result) => {
      client.setQueryData(workspaceQueryKeys.superpowersUpdate, result)
      setReviewedDigest(null)
      void client.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'project' && (q.queryKey[2] === 'skills' || q.queryKey[2] === 'workflows') })
    },
    onError: () => { void client.invalidateQueries({ queryKey: workspaceQueryKeys.superpowersUpdate }) },
  })
  const pending = action.isPending
  const supported = state?.latest && state.latest.version.split('.')[0] === state.current.version.split('.')[0]
  return <section data-slot="superpowers-update-card" className="rounded-lg border p-4 space-y-3">
    <h2 className="font-semibold">Superpowers</h2>
    {state && <>
      <p>{t('Current version')}: {state.current.version} · {t('Latest version')}: {state.latest?.version ?? '—'}</p>
      <p className="text-sm text-muted-foreground">{t('Last checked')}: {state.checkedAt ?? '—'}</p>
      <label className="flex items-center gap-2"><Switch checked={state.autoCheck} disabled={pending} onCheckedChange={(enabled) => action.mutate(() => setSuperpowersAutoCheck(enabled))} />{t('Automatically check Superpowers updates')}</label>
      {state.reason && <p role="status">{state.reason}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={() => action.mutate(checkSuperpowersUpdate)}>{t('Check for updates')}</Button>
        {state.latest && state.latest.version !== state.current.version && <Button size="sm" disabled={pending || !supported} onClick={() => action.mutate(() => stageSuperpowersUpdate(state.latest!.version))}>{t('Download and inspect')}</Button>}
        {state.previous && <Button size="sm" disabled={pending} onClick={() => action.mutate(rollbackSuperpowersUpdate)}>{t('Restore previous Superpowers version')}</Button>}
      </div>
      {state.latest && !supported && <p>{t('This major version requires adaptation.')}</p>}
      {state.staged && <div className="space-y-2">
        <p className="font-medium">{t('Candidate version')}: {state.staged.bundle.version}</p>
        <a className="text-primary underline" href={`https://github.com/obra/superpowers/compare/${state.current.commit}...${state.staged.bundle.commit}`} target="_blank" rel="noopener noreferrer">{t('Review upstream changes')}</a>
        <p className="text-sm text-muted-foreground">{t('This comparison covers upstream changes. Local custom skills are preserved.')}</p>
        {(['added', 'changed', 'removed'] as const).map((kind) => <div key={kind}><span>{t(kind === 'added' ? 'Added' : kind === 'changed' ? 'Changed' : 'Removed')}</span><ul className="list-disc pl-5">{state.staged![kind].map((name) => <li key={name}>{name}</li>)}</ul></div>)}
        <ul>{state.staged.checks.map((check) => <li key={check}>{check}</li>)}</ul>
        <p className="font-semibold text-amber-700 dark:text-amber-400">{t('Structural checks do not prove behavioral compatibility. Review the changes.')}</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={reviewedDigest === state.staged.bundle.digest} disabled={pending} onChange={(event) => setReviewedDigest(event.target.checked ? state.staged!.bundle.digest : null)} />{t('I have reviewed these changes')}</label>
        <Button size="sm" disabled={pending || reviewedDigest !== state.staged.bundle.digest} onClick={() => action.mutate(() => activateSuperpowersUpdate(state.staged!.bundle.digest))}>{t('Activate reviewed version')}</Button>
      </div>}
    </>}
    {(action.error || query.error) && <p role="alert" className="text-destructive">{(action.error || query.error)?.message}</p>}
  </section>
}
