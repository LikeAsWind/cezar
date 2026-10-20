import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AutomationEvent, AutomationProviderCapabilities } from '@open-mercato/cezar-api-client'

import { DEFAULT_FILTERS, type DraftFilters } from './editor-draft'
import { EditorGithubFields } from './editor-github-fields'

afterEach(cleanup)

function Harness({ events: initial = ['issue.opened'], providerCapabilities }: { events?: AutomationEvent[]; providerCapabilities?: AutomationProviderCapabilities }) {
  const [state, setState] = useState<{ events: AutomationEvent[]; intervalSeconds: number; filters: DraftFilters }>({
    events: initial,
    intervalSeconds: 300,
    filters: { ...DEFAULT_FILTERS },
  })
  return (
    <>
      <EditorGithubFields {...state} providerCapabilities={providerCapabilities} onChange={(patch) => setState((current) => ({ ...current, ...patch }))} />
      <output data-testid="events">{state.events.join(',')}</output>
    </>
  )
}

describe('EditorGithubFields', () => {
  it('offers the seven events as a multi-select, kept in contract order', () => {
    render(<Harness />)
    const chips = screen.getAllByRole('button', { pressed: true })
    expect(chips.map((chip) => chip.textContent)).toEqual(['issue.opened'])
    fireEvent.click(screen.getByRole('button', { name: 'pull_request.opened' }))
    expect(screen.getByTestId('events').textContent).toBe('pull_request.opened,issue.opened')
    fireEvent.click(screen.getByRole('button', { name: 'issue.opened' }))
    expect(screen.getByTestId('events').textContent).toBe('pull_request.opened')
    expect(screen.queryByRole('button', { name: 'release.published' })).toBeNull()
  })

  it('shows the poll line from the filters', () => {
    render(<Harness />)
    expect(screen.getByText('· last 7 days · maximum 25 records')).not.toBeNull()
  })

  it('flags changed labels as required for a label event and opens the filters', () => {
    render(<Harness events={['issue.labeled']} />)
    expect(screen.getByText('· changed labels required')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    const input = screen.getByLabelText('Changed labels (required)')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(input, { target: { value: 'bug' } })
    expect(screen.queryByText('· changed labels required')).toBeNull()
    fireEvent.change(screen.getByLabelText('Lookback days (1–90)'), { target: { value: '120' } })
    expect(screen.getByText('· last 90 days · maximum 25 records')).not.toBeNull()
  })

  it('disables the GitLab-unsupported review triggers with the server reason and surfaces the approval help', () => {
    const gitlab: AutomationProviderCapabilities = {
      provider: 'gitlab',
      supportedEvents: ['pull_request.approval_observed'],
      unsupportedEvents: [
        { event: 'pull_request.reviewed', reason: 'GitHub review semantics are unsupported on GitLab; use pull_request.approval_observed for retained individual approvals' },
        { event: 'pull_request.opened', reason: 'GitLab opened/labeled/review events are not yet supported by the poller; use pull_request.approval_observed for retained individual approvals' },
      ],
      approvalObservation: { supported: true, reason: 'Detects individual approvals retained at a successful poll, not all approval rules.' },
    }
    render(<Harness providerCapabilities={gitlab} />)
    // The three review triggers and the opened/labeled family are disabled with their reason.
    const reviewed = screen.getByRole('button', { name: 'pull_request.reviewed' }) as HTMLButtonElement
    expect(reviewed.disabled).toBe(true)
    expect(reviewed.getAttribute('title')).toContain('unsupported on GitLab')
    expect((screen.getByRole('button', { name: 'pull_request.opened' }) as HTMLButtonElement).disabled).toBe(true)
    // The approval snapshot trigger is offered and enabled, and its help text is shown.
    expect((screen.getByRole('button', { name: 'pull_request.approval_observed' }) as HTMLButtonElement).disabled).toBe(false)
    expect(document.querySelector('[data-slot="editor-github-approval-help"]')?.textContent)
      .toContain('Detects individual approvals')
  })

  it('does not offer the approval trigger or help text for a GitHub provider', () => {
    const github: AutomationProviderCapabilities = {
      provider: 'github',
      supportedEvents: ['pull_request.opened'],
      unsupportedEvents: [],
    }
    render(<Harness providerCapabilities={github} />)
    expect(screen.queryByRole('button', { name: 'pull_request.approval_observed' })).toBeNull()
    expect(document.querySelector('[data-slot="editor-github-approval-help"]')).toBeNull()
  })

  it('clicking the approval snapshot chip persists it for GitLab, and GitHub review events still persist for GitHub', () => {
    const gitlab: AutomationProviderCapabilities = {
      provider: 'gitlab',
      supportedEvents: ['pull_request.approval_observed'],
      unsupportedEvents: [
        { event: 'pull_request.reviewed', reason: 'unsupported on GitLab' },
        { event: 'pull_request.opened', reason: 'unsupported on GitLab' },
      ],
      approvalObservation: { supported: true, reason: 'Detects individual approvals.' },
    }
    render(<Harness providerCapabilities={gitlab} />)
    fireEvent.click(screen.getByRole('button', { name: 'pull_request.approval_observed' }))
    expect(screen.getByTestId('events').textContent).toContain('pull_request.approval_observed')

    const github: AutomationProviderCapabilities = {
      provider: 'github',
      supportedEvents: ['pull_request.opened', 'pull_request.reviewed'],
      unsupportedEvents: [{ event: 'pull_request.approval_observed', reason: 'unsupported on GitHub' }],
    }
    cleanup()
    render(<Harness providerCapabilities={github} />)
    fireEvent.click(screen.getByRole('button', { name: 'pull_request.reviewed' }))
    expect(screen.getByTestId('events').textContent).toContain('pull_request.reviewed')
  })
})
