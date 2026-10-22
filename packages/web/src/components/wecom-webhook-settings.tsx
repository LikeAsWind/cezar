import { useId, useState } from 'react'
import { wecomWebhookSettingsInputSchema, type WecomWebhookSettings as Settings, type WecomWebhookSettingsInput } from '@open-mercato/cezar-contract'
import { t, useLocale } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsField } from '@/routes/settings/settings-field'

/** Shared form; its owner supplies persistence and server-side delivery, never browser webhook fetches. */
export function WeComWebhookSettings({ value, onSave, onTest }: {
  value: Settings
  onSave: (input: WecomWebhookSettingsInput) => Promise<void>
  onTest: (input: WecomWebhookSettingsInput) => Promise<void>
}) {
  useLocale()
  const id = useId()
  const [enabled, setEnabled] = useState(value.enabled)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [users, setUsers] = useState(value.mentionedUserIds.join(', '))
  const [mobiles, setMobiles] = useState(value.mentionedMobiles.join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const list = (text: string) => [...new Set(text.split(/[,，;；\s]+/).filter(Boolean))]
  async function submit(test: boolean) {
    setError('')
    setStatus('')
    const parsed = wecomWebhookSettingsInputSchema.safeParse({
      enabled, ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
      mentionedUserIds: list(users), mentionedMobiles: list(mobiles),
    })
    if (!parsed.success || (test || enabled) && !value.configured && !webhookUrl.trim()) {
      setError(t('Enter a valid WeCom webhook and member user IDs or mobile numbers.'))
      return
    }
    setBusy(true)
    try {
      await (test ? onTest : onSave)(parsed.data)
      if (!test) setWebhookUrl('')
      setStatus(t(test ? 'Test message submitted. Confirm receipt and mentions in the group.' : 'Saved'))
    } catch {
      // Transport errors can contain request URLs. Keep credentials out of the rendered error.
      setError(t(test ? 'Test message failed. Check the robot configuration.' : 'Could not save WeCom settings.'))
    } finally { setBusy(false) }
  }
  return (
    <section data-slot="wecom-webhook-settings" className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-7">
        <SettingsField title={t('Enable WeCom notifications')} hint={t('Workflow notification nodes can send task summaries, MR links, blockers and other updates to this project’s WeCom group. Add notification nodes at the stages that need them. To mention members, enter their WeCom user IDs or bound mobile numbers, not display names.')}>
          <Switch aria-label={t('Enable WeCom notifications')} checked={enabled} disabled={busy} onCheckedChange={setEnabled} />
        </SettingsField>
        <SettingsField title={t('Webhook URL')} hint={t(value.configured ? 'Webhook saved; leave blank to keep it' : 'Paste the robot webhook URL')}>
          <Input id={`${id}-webhook`} aria-label={t('Webhook URL')} type="password" autoComplete="new-password" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder={t(value.configured ? 'Webhook saved; leave blank to keep it' : 'Paste the robot webhook URL')} />
        </SettingsField>
        <SettingsField title={t('Mention member user IDs')} hint={t('Separate multiple members with commas. Leave both fields empty for no mentions.')}>
          <Input id={`${id}-users`} aria-label={t('Mention member user IDs')} value={users} onChange={e => setUsers(e.target.value)} />
        </SettingsField>
        <SettingsField title={t('Mention mobile numbers')} hint={t('Use the mobile number bound to the WeCom member account.')}>
          <Input id={`${id}-mobiles`} aria-label={t('Mention mobile numbers')} value={mobiles} onChange={e => setMobiles(e.target.value)} />
        </SettingsField>
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button type="button" disabled={busy} onClick={() => void submit(false)}>{t('Save')}</Button>
          <Button type="button" disabled={busy} variant="outline" onClick={() => void submit(true)}>{t('Send test message')}</Button>
        </div>
      </fieldset>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      {status ? <p role="status" className="text-sm text-muted-foreground">{status}</p> : null}
    </section>
  )
}
