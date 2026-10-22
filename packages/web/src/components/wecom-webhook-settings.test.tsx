import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WeComWebhookSettings } from './wecom-webhook-settings'

const config = { configured: true, enabled: true, mentionedUserIds: [], mentionedMobiles: [] }
afterEach(cleanup)
it('keeps the stored webhook secret out of the form and saves user IDs and mobiles separately', async () => {
  const save = vi.fn(async () => {})
  render(<WeComWebhookSettings value={config} onSave={save} onTest={vi.fn()} />)
  expect((screen.getByLabelText('Webhook URL') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Webhook URL') as HTMLInputElement).type).toBe('password')
  fireEvent.change(screen.getByLabelText('Mention member user IDs'), { target: { value: 'member1, member2, member1' } })
  fireEvent.change(screen.getByLabelText('Mention mobile numbers'), { target: { value: '13800138000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true, mentionedUserIds: ['member1', 'member2'], mentionedMobiles: ['13800138000'] }))
})
it('rejects non-WeCom webhook URLs before saving or sending', async () => {
  const save = vi.fn(), test = vi.fn()
  render(<WeComWebhookSettings value={config} onSave={save} onTest={test} />)
  fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://example.com/?key=secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(save).not.toHaveBeenCalled()
  expect(test).not.toHaveBeenCalled()
})
it('sends a test only after an explicit click and prevents an empty initial webhook', async () => {
  const test = vi.fn(async () => {})
  render(<WeComWebhookSettings value={{ ...config, configured: false }} onSave={vi.fn()} onTest={test} />)
  expect(test).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key'
  fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: url } })
  fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
  await waitFor(() => expect(test).toHaveBeenCalledWith({ enabled: true, webhookUrl: url, mentionedUserIds: [], mentionedMobiles: [] }))
})

it('does not render a webhook URL leaked through a transport error', async () => {
  const test = vi.fn(async () => { throw new Error('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private-key') })
  render(<WeComWebhookSettings value={config} onSave={vi.fn()} onTest={test} />)
  fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(document.body.textContent).not.toContain('private-key')
})
