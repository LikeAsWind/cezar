import { expect, it } from 'vitest';
import { unattendedWorkflows } from './superpowers-bundle.ts';
import { UNATTENDED_TEMPLATE } from './templates/unattended.ts';
import { workflowGraphFileSchema, graphToSteps } from './graph.ts';
import { workflowGraphNodeSchema, workflowStepDefSchema } from '@open-mercato/cezar-contract';
import { unattendedRecoveryPoint } from './unattended-recovery.ts';

const graph = unattendedWorkflows()[0]!.graph!;
it('returns from an unanswered adjudication to the real caller', () => {
  expect(unattendedRecoveryPoint(graph, { loops: { 'clarification-round': 3 }, taken: ['plan.question->clarification-round', 'clarification-round.repeat->adjudicator', 'adjudicator.blocked->blocked-report', 'blocked-report.recorded->stopped'] })).toBe('plan');
});
it('reverifies changes after review or seal blocks and retains a crashed node', () => {
  expect(unattendedRecoveryPoint(graph, { loops: {}, taken: ['review.blocked->blocked-report'] })).toBe('verify');
  expect(unattendedRecoveryPoint(graph, { loops: {}, taken: ['seal.fail->blocked-report'] })).toBe('verify');
  expect(unattendedRecoveryPoint(graph, { cursor: 'execute-standard', loops: {}, taken: [] })).toBe('execute-standard');
});
it('does not invent a recovery point for completed or unrelated histories', () => {
  expect(unattendedRecoveryPoint(graph, { loops: {}, taken: ['seal.pass->done'] })).toBeUndefined();
  expect(unattendedRecoveryPoint(graph, { cursor: 'unknown', loops: {}, taken: [] })).toBeUndefined();
});


it('bounds both deep executors to ninety minutes without changing other stages', () => {
  const graph = workflowGraphFileSchema.parse(UNATTENDED_TEMPLATE);
  for (const id of ['execute-deep', 'execute-deep-native']) {
    const node = graph.nodes.find(node => node.id === id);
    expect(node).toHaveProperty('timeoutMs', 90 * 60_000);
    expect(workflowGraphNodeSchema.parse(node)).toHaveProperty('timeoutMs', 90 * 60_000);
    expect(workflowStepDefSchema.parse(graphToSteps(graph).find(step => step.id === id))).toHaveProperty('timeoutMs', 90 * 60_000);
    if (node?.type !== 'agent') throw Error('missing executor');
    expect(node.prompt).toContain('Preserve the full build/test output');
    expect(node.prompt).toContain('Before rerunning');
  }
  expect(graph.nodes.find(node => node.id === 'design')).not.toHaveProperty('timeoutMs');
});
