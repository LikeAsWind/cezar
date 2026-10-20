import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SuperpowersUpdateCard } from './superpowers-update-card'
import type { SuperpowersUpdateState } from '@open-mercato/cezar-api-client'

const api = vi.hoisted(() => ({ getSuperpowersUpdate: vi.fn(), activateSuperpowersUpdate: vi.fn(), checkSuperpowersUpdate: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), ...api }))
const state: SuperpowersUpdateState = {
  status: 'ready', current: { version: '7.0.0', commit: 'a'.repeat(40), digest: 'b'.repeat(64) },
  previous: null, latest: null, checkedAt: null, autoCheck: false,
  staged: { bundle: { version: '7.0.1', commit: 'c'.repeat(40), digest: 'd'.repeat(64) }, added: ['new-skill'], changed: [], removed: [], checks: ['manifest validated'] },
}
afterEach(() => { cleanup(); vi.resetAllMocks() })
function mount() {
  api.getSuperpowersUpdate.mockResolvedValue(state)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><SuperpowersUpdateCard /></QueryClientProvider>)
}
describe('Superpowers update review', () => {
  it('requires explicit review of the staged digest before activation', async () => {
    api.activateSuperpowersUpdate.mockResolvedValue({ ...state, staged: null })
    mount()
    const activate = await screen.findByRole('button', { name: 'Activate reviewed version' })
    expect(activate.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('link', { name: 'Review upstream changes' }).getAttribute('href')).toBe(`https://github.com/obra/superpowers/compare/${'a'.repeat(40)}...${'c'.repeat(40)}`)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have reviewed these changes' }))
    fireEvent.click(activate)
    await waitFor(() => expect(api.activateSuperpowersUpdate).toHaveBeenCalledWith('d'.repeat(64)))
  })
  it('retains the active version and disabled automatic checks when a check fails', async () => {
    api.checkSuperpowersUpdate.mockRejectedValue(new Error('Upstream unavailable'))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Upstream unavailable')
    expect(screen.getByText(/Current version: 7.0.0/)).toBeTruthy()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })
})
