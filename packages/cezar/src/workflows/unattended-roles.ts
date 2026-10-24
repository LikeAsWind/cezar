import type { WorkflowGraph } from './graph.ts';

/** Roles follow a node's declared skill and verdicts, not its editor-assigned id. */
export function unattendedStage(graph: WorkflowGraph | undefined, nodeId: string): string {
  const node = graph?.nodes.find(candidate => candidate.id === nodeId);
  if (node?.type !== 'agent' || !node.skill) return nodeId;
  const stages: Record<string, string> = {
    'cezar:project-probe': 'probe', 'cezar:adjudicator': 'adjudicator',
    'superpowers:brainstorming': 'design', 'superpowers:writing-plans': 'plan',
    'superpowers:executing-plans': 'execute-native', 'superpowers:subagent-driven-development': 'execute-sdd',
    'superpowers:systematic-debugging': 'fix', 'superpowers:verification-before-completion': 'deliver', 'superpowers:code-reviewer': 'review',
  };
  return node.skill === 'superpowers:writing-plans' && node.verdicts?.includes('fast') ? 'fast-plan' : stages[node.skill] ?? nodeId;
}

export function unattendedArtifactStage(graph: WorkflowGraph, nodeId: string): string {
  const role = unattendedStage(graph, nodeId);
  if (role === 'execute-sdd') return 'execute-deep';
  if (role !== 'execute-native') return role;
  const node = graph.nodes.find(candidate => candidate.id === nodeId);
  if (node?.type === 'agent' && node.verdicts?.includes('standard')) return 'execute-fast';
  if (node?.type === 'agent' && node.verdicts?.includes('deep')) return 'execute-standard';
  return 'execute-deep-native';
}
