import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NodeInput } from './node-input'

afterEach(cleanup)

it('shows recorded context instead of reconstructing historical input from a template', () => {
  render(<NodeInput node={{ id: 'design', type: 'agent', prompt: 'template {{task}}' }} input={{ cwd: '/worktree', capturedAt: '2026-10-21T04:00:00.000Z', userPrompt: 'Actual shared map: src/Counter.java', systemPrompt: 'Original skill' }} />)
  expect(screen.getByText('Actual shared map: src/Counter.java')).toBeTruthy()
  expect(screen.getByText('Original skill')).toBeTruthy()
  expect(screen.queryByText('template {{task}}')).toBeNull()
})

it('labels older node templates as configuration, not recorded actual input', () => {
  render(<NodeInput node={{ id: 'design', type: 'agent', prompt: 'template {{task}}' }} />)
  expect(screen.getByText('template {{task}}')).toBeTruthy()
  expect(screen.getByText(/No recorded launch input/)).toBeTruthy()
})
