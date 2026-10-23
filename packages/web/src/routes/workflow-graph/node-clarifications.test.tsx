import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunEvent, WorkflowClarification, WorkflowGraphNode } from '@open-mercato/cezar-api-client'
import { NodeClarifications } from './node-clarifications'

const stream = vi.hoisted(() => ({ events: [] as RunEvent[] }))
vi.mock('@/api/run-events', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/run-events')>(),
  useRunEvents: (id?: string) => id === 'run1' ? stream.events : [],
}))
afterEach(() => { cleanup(); stream.events = [] })

const design: WorkflowGraphNode = { id: 'design', name: 'Design', type: 'agent', skill: 'design' }
const adjudicator: WorkflowGraphNode = { id: 'adjudicator', type: 'agent', skill: 'cezar:adjudicator' }
const question: WorkflowClarification = { origin: 'design', originName: 'Design', q: 'Q-001', round: 1, question: 'Which behavior is approved?', status: 'pending' }
const event = (seq: number, clarification: WorkflowClarification): RunEvent => ({ seq, ts: '2026-10-23T00:00:00Z', type: 'workflow-clarification', clarification })

it('shows only questions from the selected originating node, including live answers', () => {
  stream.events = [event(1, question), event(2, { ...question, origin: 'review', question: 'Review-only question' })]
  const view = render(<MemoryRouter><NodeClarifications runId="run1" node={design} /></MemoryRouter>)
  expect(screen.getByText(question.question)).toBeTruthy()
  expect(screen.queryByText('Review-only question')).toBeNull()
  stream.events = [...stream.events, event(3, { ...question, status: 'answering' })]
  view.rerender(<MemoryRouter><NodeClarifications runId="run1" node={design} /></MemoryRouter>)
  expect(screen.getByRole('status').textContent).toContain('Adjudicator is answering')
  expect(screen.getByText('The answer will appear here when adjudication finishes.')).toBeTruthy()
  stream.events = [...stream.events, event(4, { ...question, status: 'answered', answer: 'Use the approved design.' })]
  view.rerender(<MemoryRouter><NodeClarifications runId="run1" node={design} /></MemoryRouter>)
  expect(screen.getAllByRole('article')).toHaveLength(1)
  expect(screen.getByRole('status').textContent).toContain('Adjudication answered')
  expect(screen.getAllByText('Use the approved design.').length).toBeGreaterThan(0)
})

it('replays all origins and separate rounds in the adjudicator panel', () => {
  stream.events = [event(1, { ...question, status: 'answered', answer: 'First decision' }), event(2, { ...question, origin: 'review', question: 'Review-only question' }), event(3, { ...question, round: 2, question: 'Follow-up question' })]
  render(<MemoryRouter><NodeClarifications runId="run1" node={adjudicator} /></MemoryRouter>)
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(screen.getByText('Review-only question')).toBeTruthy()
  expect(screen.getByText('Follow-up question')).toBeTruthy()
})
