import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { WorkspaceSwitcher } from './workspace-switcher'

const alpha: ProjectListEntry = {
  id: 'alpha', name: 'Alpha', root: '/repos/alpha', source: 'local', status: 'ok',
  addedAt: '2026-10-14T00:00:00.000Z', lastOpenedAt: '2026-10-14T00:00:00.000Z',
}
const beta: ProjectListEntry = { ...alpha, id: 'beta', name: 'Beta', root: '/repos/beta', status: 'missing' }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderSwitcher(activeProjectId: string | null = null) {
  const onSelectProject = vi.fn()
  const onSelectGlobal = vi.fn()
  const onRegister = vi.fn()
  render(<WorkspaceSwitcher projects={[alpha, beta]} activeProjectId={activeProjectId}
    onSelectProject={onSelectProject} onSelectGlobal={onSelectGlobal} onRegister={onRegister} />)
  return { onSelectProject, onSelectGlobal, onRegister }
}

it('starts globally and selects the first project by keyboard', async () => {
  const { onSelectProject } = renderSwitcher()
  fireEvent.click(screen.getByRole('button', { name: /Global workspace/ }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox')))
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' })
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' })
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
  expect(onSelectProject).toHaveBeenCalledWith('alpha')
})

it('filters project names while keeping global and registration actions', async () => {
  const { onSelectProject } = renderSwitcher()
  fireEvent.click(screen.getByRole('button', { name: /Global workspace/ }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bEtA' } })
  expect(screen.queryByRole('option', { name: /Alpha/ })).toBeNull()
  expect(screen.getByText('Directory unavailable')).toBeTruthy()
  expect(screen.getByRole('option', { name: 'Global workspace' })).toBeTruthy()
  fireEvent.click(screen.getByRole('option', { name: /Beta/ }))
  expect(onSelectProject).toHaveBeenCalledWith('beta')
})

it('supports ArrowUp and restores trigger focus on Escape', async () => {
  renderSwitcher('alpha')
  const trigger = screen.getByRole('button', { name: /Alpha/ })
  fireEvent.click(trigger)
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' })
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' })
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowUp' })
  expect(screen.getByRole('option', { name: 'Global workspace' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(screen.queryByRole('searchbox')).toBeNull()
})

it('returns globally and exposes registration without a selected project', async () => {
  const { onSelectGlobal, onRegister } = renderSwitcher('alpha')
  fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
  fireEvent.click(screen.getByRole('option', { name: 'Global workspace' }))
  expect(onSelectGlobal).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
  fireEvent.click(screen.getByRole('option', { name: 'Register project' }))
  expect(onRegister).toHaveBeenCalledOnce()
})

it('keeps an unknown URL project distinct from the global workspace', () => {
  renderSwitcher('removed')
  expect(screen.getByRole('button', { name: /removed/ }).textContent).toContain('Project')
})

it('wraps ArrowUp from the search field to the registration action', () => {
  const { onRegister } = renderSwitcher()
  fireEvent.click(screen.getByRole('button', { name: /Global workspace/ }))
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowUp' })
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
  expect(onRegister).toHaveBeenCalledOnce()
})

it('keeps menu rows single interactive targets with mobile sizing and a visible focus ring', () => {
  renderSwitcher()
  fireEvent.click(screen.getByRole('button', { name: /Global workspace/ }))
  for (const option of screen.getAllByRole('option')) {
    expect(option.tagName).toBe('BUTTON')
    expect(option.querySelector('button, a, input, [tabindex]')).toBeNull()
    expect(option.className).toContain('min-h-11')
    expect(option.className).toContain('min-w-11')
    expect(option.className).toContain('md:min-h-9')
    expect(option.className).toContain('focus-visible:ring-[3px]')
    expect(option.className).toContain('focus-visible:ring-ring/50')
  }
  expect(screen.getByRole('searchbox').className).toContain('h-11')
  expect(screen.getByRole('searchbox').className).toContain('md:h-9')
})

// The project folder glyph is a location label, not a status — it must not borrow the `success`
// (green) token reserved for ok/available/done outcomes. Global keeps its violet accent.
it('does not paint the project folder glyph as a status success', () => {
  renderSwitcher('alpha')
  const trigger = screen.getByRole('button', { name: /Alpha/ })
  const icon = trigger.querySelector('svg') as SVGElement
  const classes = icon.getAttribute('class') ?? ''
  expect(classes).toContain('text-foreground')
  expect(classes).not.toContain('text-success')
})
