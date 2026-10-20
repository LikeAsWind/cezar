import { expect, it } from 'vitest';
import { unattendedWorkflows } from './superpowers-bundle.ts';
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
