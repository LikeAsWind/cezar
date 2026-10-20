import { isExecutableNode, type WorkflowGraph } from './graph.ts';
import type { RunRecord } from '../runs/store.ts';

/** Recover a graph location without replenishing any loop budget. */
export function unattendedRecoveryPoint(graph: WorkflowGraph, state: RunRecord['graphState']): string | undefined {
  const executable = (id?: string) => graph.nodes.some(node => node.id === id && isExecutableNode(node) && node.id !== 'blocked-report');
  if (executable(state?.cursor)) return state!.cursor;
  const taken = state?.taken ?? [];
  for (let index = taken.length - 1; index >= 0; index--) {
    const [from, target] = taken[index]!.split('->');
    if (target !== 'blocked-report') continue;
    const node = from!.split('.')[0]!;
    if (node === 'adjudicator' || node === 'clarification-round') {
      const caller = taken.slice(0, index).reverse().find(edge => /^[\w-]+\.question->clarification-round$/.test(edge))?.split('.')[0];
      return executable(caller) ? caller : undefined;
    }
    if (['review', 'deliver', 'seal', 'final-retry'].includes(node)) return executable('verify') ? 'verify' : undefined;
    if (['design-retry', 'upgrade'].includes(node)) return executable('design') ? 'design' : undefined;
    return executable(node) ? node : undefined;
  }
  return undefined;
}
