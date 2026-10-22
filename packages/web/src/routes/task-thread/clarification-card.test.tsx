import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router'
import { ClarificationCard } from './clarification-card'
import type { WorkflowClarification } from '@open-mercato/cezar-api-client'
const base: WorkflowClarification = { q: 'Q-001', origin: 'design', originName: '设计与需求消歧', round: 1, question: '归还异常是否向上抛出？', status: 'pending' }
afterEach(cleanup)
function show(value: WorkflowClarification) { return render(<MemoryRouter initialEntries={['/tasks/run1']}><Routes><Route path="/tasks/:id" element={<ClarificationCard value={value} />} /></Routes></MemoryRouter>) }
it('shows a pending question and links to its originating graph node', () => {
 show(base)
 expect(screen.getByText(base.question)).toBeTruthy()
 expect(screen.getByRole('status').textContent).toContain('Awaiting adjudication')
 expect(screen.getByRole('link', { name: 'View originating node' }).getAttribute('href')).toContain('/tasks/run1/graph?node=design')
})
it('shows explicit answer fields without inventing a summary and preserves full evidence', () => {
 const answer = '回答：记录错误后保留请求结果。\n依据：工单要求成功率不下降。\n适用范围与不确定性：仅限本次归还路径。'
 show({ ...base, status: 'answered', answer })
 expect(screen.getByRole('status').textContent).toContain('Adjudication answered')
 const toggle = screen.getByText('Full answer and evidence')
 fireEvent.click(toggle)
 expect(toggle.closest('details')?.open).toBe(true)
 expect(screen.getAllByText('记录错误后保留请求结果。').length).toBeGreaterThan(0)
 expect(screen.getByText(/仅限本次归还路径/)).toBeTruthy()
})
it('keeps unstructured answers intact and distinguishes missing authority from execution failure', () => {
 const view = show({ ...base, status: 'blocked', answer: '需要负责人确认产品行为。' })
 expect(screen.getByRole('status').textContent).toContain('Human confirmation required')
 expect(screen.getAllByText('需要负责人确认产品行为。').length).toBeGreaterThan(0)
 view.unmount()
 show({ ...base, status: 'failed', answer: 'CLI timed out' })
 expect(screen.getByRole('status').textContent).toContain('Adjudication failed')
 expect(screen.queryByText('Decision recorded; the originating node will continue.')).toBeNull()
})
