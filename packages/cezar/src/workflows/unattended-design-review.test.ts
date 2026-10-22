import { expect, it } from 'vitest';
import { UNATTENDED_TEMPLATE } from './templates/unattended.ts';
import { advance, graphIssues, type WorkflowGraph } from './graph.ts';

it('lets design settle answered and minor questions before requesting adjudication', () => {
  const design = UNATTENDED_TEMPLATE.nodes.find(node => node.id === 'design');
  expect(design).toMatchObject({ type: 'agent' });
  if (design?.type !== 'agent') throw new Error('missing design');
  expect(design.prompt).toContain('恢复时复用已完成的 builder check');
  expect(design.prompt).toContain('必要问题解决并完成 builder check');
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
  expect(UNATTENDED_TEMPLATE.edges).toContainEqual({ from: 'blocked-report.pass', to: 'stopped' });
});
