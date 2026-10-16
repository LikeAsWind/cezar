import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'

import { Button } from '@/components/ui/button'
import { PageContent, PageFrame, PageHeader, OverviewSection } from './page-frame'
import { OverviewLinkCard } from './overview-link-card'

afterEach(cleanup)

it.each(['', 'w-[390px]'])('keeps one visible page title and actions group at %s', (className) => {
  const { container } = render(
    <PageFrame className={className}>
      <PageHeader title="Workspace" description="All registered projects" actions={<Button>Create task</Button>} />
      <PageContent><p>Projects</p></PageContent>
    </PageFrame>,
  )

  const title = screen.getByRole('heading', { level: 1, name: 'Workspace' })
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  expect(title.closest('[hidden], [aria-hidden="true"], .hidden')).toBeNull()
  expect(title.className).not.toContain('md:block')
  expect(document.getElementById(title.getAttribute('aria-describedby')!)).toBe(screen.getByText('All registered projects'))
  expect(screen.getAllByRole('group')).toHaveLength(1)
  expect(within(screen.getByRole('group', { name: 'Workspace' })).getByRole('button', { name: 'Create task' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Create task' })).toHaveLength(1)
  const header = title.closest('header')!
  expect(header.className).toContain('md:h-14')
  expect(header.className).toContain('sticky top-0')
  expect(header.className).toContain('md:px-5')
  expect(screen.getByRole('group').className).toContain('[&_button]:min-h-11')
  expect(screen.getByRole('group').className).toContain('[&_button]:min-w-11')
  expect(container.firstElementChild!.className).toContain('min-h-full')
  const content = screen.getByText('Projects').parentElement!
  expect(content.className).toContain('p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5')
})

it('omits absent descriptions and actions without dangling associations', () => {
  render(<PageFrame><PageHeader title="Projects" /><PageContent>Empty</PageContent></PageFrame>)
  expect(screen.getByRole('heading', { level: 1 }).hasAttribute('aria-describedby')).toBe(false)
  expect(screen.queryByRole('group')).toBeNull()
})

it('labels overview sections and keeps their action beside a secondary heading', () => {
  render(
    <OverviewSection title="Recent tasks" description="Latest project activity" action={<Button variant="outline">View tasks</Button>}>
      <p>No recent tasks</p>
    </OverviewSection>,
  )
  const section = screen.getByRole('region', { name: 'Recent tasks' })
  expect(within(section).getByRole('heading', { level: 2, name: 'Recent tasks' })).toBeTruthy()
  expect(document.getElementById(section.getAttribute('aria-describedby')!)).toBe(screen.getByText('Latest project activity'))
  expect(within(section).getByRole('button', { name: 'View tasks' })).toBeTruthy()
  expect(within(section).getByText('No recent tasks')).toBeTruthy()
})

function CurrentLocation() {
  return <output>{useLocation().pathname}</output>
}

it('makes the complete overview card one focusable navigation link with status and metadata', () => {
  render(
    <MemoryRouter>
      <OverviewLinkCard to="/p/alpha" title="Alpha" description="Project overview"
        status={<span>Available</span>} metadata={<span>/repos/alpha</span>} icon={<span aria-hidden="true">A</span>} />
      <CurrentLocation />
    </MemoryRouter>,
  )
  const link = screen.getByRole('link', { name: 'Alpha' })
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(link.getAttribute('href')).toBe('/p/alpha')
  expect(within(link).getByText('Available')).toBeTruthy()
  expect(within(link).getByText('/repos/alpha')).toBeTruthy()
  expect(document.getElementById(link.getAttribute('aria-describedby')!)).toBe(screen.getByText('Project overview'))
  expect(link.querySelector('a, button, input, select, textarea, [tabindex]')).toBeNull()
  expect(link.className).toContain('focus-visible:ring-[3px]')
  expect(link.className).toContain('focus-visible:ring-ring/50')
  expect(link.className).toContain('min-h-11')
  expect(link.className).toContain('min-w-11')
  expect(link.className).toContain('bg-card')
  link.focus()
  expect(document.activeElement).toBe(link)
  fireEvent.click(screen.getByText('/repos/alpha'))
  expect(screen.getByRole('status').textContent).toBe('/p/alpha')
})

it('renders overview cards without optional slots or dangling descriptions', () => {
  render(<MemoryRouter><OverviewLinkCard to="/projects" title="Projects" /></MemoryRouter>)
  const link = screen.getByRole('link', { name: 'Projects' })
  expect(link.hasAttribute('aria-describedby')).toBe(false)
  expect(link.textContent).toBe('Projects')
})
