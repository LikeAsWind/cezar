import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { getLocale, setLocale, t, useLocale } from '@/lib/i18n'
import { LocaleProvider } from './locale-provider'
import { LanguageSection } from '@/routes/settings/language-section'
import { NAV_ITEMS } from './nav-items'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); setLocale('en') })

function Sample() {
  useLocale()
  return <><nav>{NAV_ITEMS.map(item => <a key={item.to} href={item.to}>{item.label}</a>)}</nav><input aria-label="draft" defaultValue="Settings" /><LanguageSection /></>
}

function mount(locale?: string, fail = false) {
  const client = createQueryClient()
  client.setQueryData(workspaceQueryKeys.uiState, { locale })
  let saved = { locale }
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (fail) return new Response(JSON.stringify({ error: 'Save failed' }), { status: 500 })
      saved = { ...saved, ...JSON.parse(String(init.body)) }
    }
    return new Response(JSON.stringify(saved), { headers: { 'content-type': 'application/json' } })
  })
  render(<QueryClientProvider client={client}><LocaleProvider><Sample /></LocaleProvider></QueryClientProvider>)
  return { client, saved: () => saved }
}

it('defaults to Chinese and changes all subscribed UI without losing a draft', async () => {
  const app = mount()
  await screen.findByText('任务')
  expect(screen.getByRole('link', { name: '工作流' }).getAttribute('href')).toBe('/workflows')
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'my draft' } })
  fireEvent.change(screen.getByRole('combobox', { name: '界面语言' }), { target: { value: 'en' } })
  await screen.findByText('Tasks')
  expect(screen.getByRole('link', { name: 'Workflows' }).getAttribute('href')).toBe('/workflows')
  await waitFor(() => expect(app.saved().locale).toBe('en'))
  expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('my draft')
  expect(document.documentElement.lang).toBe('en')
  expect(localStorage.getItem('cez-locale')).toBe('en')
})

it('uses the workspace preference instead of a stale browser mirror', async () => {
  setLocale('zh-CN')
  mount('en')
  await screen.findByText('Tasks')
  expect(getLocale()).toBe('en')
})

it('restores the saved preference when persistence fails', async () => {
  mount('en', true)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Interface language' }), { target: { value: 'zh-CN' } })
  await waitFor(() => expect(getLocale()).toBe('en'))
  expect(localStorage.getItem('cez-locale')).toBe('en')
})

it('persists the latest choice when a previous save is still in flight', async () => {
  mount('zh-CN')
  await screen.findByText('任务')
  let stored = 'zh-CN'
  let firstFinished = false
  let finishFirst: (() => void) | undefined
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const choice = JSON.parse(String(init.body)).locale as string
      if (choice === 'en') await new Promise<void>(resolve => { finishFirst = resolve })
      stored = choice
      if (choice === 'en') firstFinished = true
    }
    return new Response(JSON.stringify({ locale: stored }), { headers: { 'content-type': 'application/json' } })
  })
  fireEvent.change(screen.getByRole('combobox', { name: '界面语言' }), { target: { value: 'en' } })
  await waitFor(() => expect(finishFirst).toBeDefined())
  fireEvent.change(screen.getByRole('combobox', { name: 'Interface language' }), { target: { value: 'zh-CN' } })
  // Flush the second save while the first is blocked, then let the first finish late.
  await new Promise(resolve => setTimeout(resolve, 0))
  finishFirst!()
  await waitFor(() => expect(firstFinished).toBe(true))
  await waitFor(() => expect(stored).toBe('zh-CN'))
  expect(getLocale()).toBe('zh-CN')
}, 10000)
