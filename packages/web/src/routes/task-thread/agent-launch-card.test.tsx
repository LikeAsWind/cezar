import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AgentLaunchCard } from './agent-launch-card'

afterEach(cleanup)

it('shows supplied prompts, tool configuration and parameters without claiming hidden backend prompts', () => {
  const { container } = render(<AgentLaunchCard input={{ capturedAt: '2026-10-21T00:00:00Z', cwd: '/repo', backend: 'claude', nodeName: '设计与需求消歧', stepId: 'design', skill: 'superpowers:brainstorming', systemPrompt: 'Actual system', userPrompt: 'Actual user', allowedTools: ['Read'], timeoutMs: 5400000, resume: true }} />)
  expect(container.querySelector('[data-slot="agent-launch"]')?.hasAttribute('open')).toBe(false)
  expect(screen.getByText('Actual system')).toBeTruthy()
  expect(screen.getByText('Actual user')).toBeTruthy()
  expect(container.textContent).toContain('设计与需求消歧')
  expect(container.textContent).toContain('superpowers:brainstorming')
  expect(container.textContent).toContain('design')
  expect(container.textContent).toContain('Read')
  expect(container.textContent).toContain('5400000')
})
