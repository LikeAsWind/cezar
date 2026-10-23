import { expect, it } from 'vitest';
import { UNATTENDED_TEMPLATE } from './templates/unattended.ts';
import { advance, graphIssues, type WorkflowGraph } from './graph.ts';

it('lets design settle answered and minor questions before requesting adjudication', () => {
  const design = UNATTENDED_TEMPLATE.nodes.find(node => node.id === 'design');
  expect(design).toMatchObject({ type: 'agent' });
  if (design?.type !== 'agent') throw new Error('missing design');
  expect(design.prompt).toContain('恢复时复用已有设计、已完成的 builder check 及反馈');
  expect(design.prompt).toContain('影响方案成立的关键假设，不留给实现者确认');
  expect(design.prompt).toContain('必要问题已解决、关键前提有证据支持');
  expect(design.prompt).toContain('实现阶段可承担编码细节、测试落地与运行验证');
  expect(design.prompt).not.toContain('two consecutive reviews');
});

it('uses the original brainstorming builder check without an outer review loop', () => {
  expect(UNATTENDED_TEMPLATE.nodes.some(node => ['builder', 'design-retry'].includes(node.id))).toBe(false);
  const design = UNATTENDED_TEMPLATE.nodes.find(node => node.id === 'design');
  if (design?.type !== 'agent') throw new Error('missing design');
  expect(design.prompt).toContain('完成 builder check');
  expect(design.prompt).toContain('builder check');
  const graph = UNATTENDED_TEMPLATE as WorkflowGraph;
  expect(graphIssues(graph)).toEqual([]);
  const loops = new Map<string, number>();
  expect(advance(graph, 'design', 'ready', loops)).toMatchObject({ kind: 'node', node: { id: 'plan' } });
  expect(loops.size).toBe(0);
});

it('packages existing blocker evidence without another model invocation', () => {
  expect(UNATTENDED_TEMPLATE.nodes.find(node => node.id === 'blocked-report'))
    .toMatchObject({ type: 'check', command: 'cezar workflow-action blocked' });
  expect(UNATTENDED_TEMPLATE.edges).toContainEqual({ from: 'blocked-report.pass', to: 'notify-blocked' });
});
