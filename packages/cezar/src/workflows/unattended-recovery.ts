import { isExecutableNode, type WorkflowGraph } from './graph.ts';
import type { RunRecord } from '../runs/store.ts';
import { workflowActionOf } from './workflow-actions.ts';
import { unattendedStage } from './unattended-roles.ts';

/** Recover a graph location without replenishing any loop budget. */
export function unattendedRecoveryPoint(graph: WorkflowGraph, state: RunRecord['graphState']): string | undefined {
  const action = (id: string) => {
    const node = graph.nodes.find(candidate => candidate.id === id);
    return node?.type === 'check' ? workflowActionOf(node.command) ?? id : id;
  };
  const executable = (id?: string) => graph.nodes.some(node => node.id === id && isExecutableNode(node) && !['blocked', 'blocked-report'].includes(action(node.id)));
  const role = (id: string) => unattendedStage(graph, id);
  const stageNode = (stage: string) => graph.nodes.find(node => role(node.id) === stage)?.id;
  const checkNode = (operation: string) => graph.nodes.find(node => node.type === 'check' && action(node.id) === operation)?.id;
  const repeatsInto = (id: string, stage: string) => graph.edges.some(edge => edge.from === `${id}.repeat` && role(edge.to) === stage);
  if (executable(state?.cursor)) return state!.cursor;
  const taken = state?.taken ?? [];
  for (let index = taken.length - 1; index >= 0; index--) {
    const [from, target] = taken[index]!.split('->');
    const failedNode = from!.split('.')[0]!;
    const failed = graph.nodes.find(node => node.id === failedNode);
    if (/\.(?:failed|fail)->/.test(taken[index]!) && (failed?.type === 'github.draft-pr' || failed?.type === 'github.pr-update' || failedNode === 'notify-wecom')) return executable(failedNode) ? failedNode : undefined;
    if (!target || !['blocked', 'blocked-report'].includes(action(target))) continue;
    const node = from!.split('.')[0]!;
    if (action(node) === 'scope' || node === 'validation-scope') {
      const planner = taken.slice(0, index).reverse().find(edge => {
        const [source, to] = edge.split('->');
        return to === node && ['fast-plan', 'plan'].includes(role(source!.split('.')[0]!));
      })?.split('.')[0];
      return executable(planner) ? planner : undefined;
    }
    if (role(node) === 'adjudicator' || repeatsInto(node, 'adjudicator') || node === 'clarification-round') {
      const caller = taken.slice(0, index).reverse().find(edge => /^[\w-]+\.question->/.test(edge))?.split('.')[0];
      return executable(caller) ? caller : undefined;
    }
    if (['review', 'deliver'].includes(role(node)) || action(node) === 'seal' || repeatsInto(node, 'fix') || node === 'final-retry') {
      const verify = checkNode('verify');
      return executable(verify) ? verify : undefined;
    }
    if (repeatsInto(node, 'design') || node === 'design-retry' || node === 'upgrade') {
      const design = stageNode('design');
      return executable(design) ? design : undefined;
    }
    return executable(node) ? node : undefined;
  }
  return undefined;
}
