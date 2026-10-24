import type { GraphNode, WorkflowGraph } from './graph.ts';
import { workflowActionOf } from './workflow-actions.ts';

export const environmentNodes: GraphNode[] = [
  { id: 'environment-check', type: 'check', name: '校验探测环境产物', command: 'cezar workflow-action environment' },
  { id: 'probe-retry', type: 'loop', name: '环境产物补全次数', max: 1 },
  { id: 'probe-repair', type: 'agent', name: '补全探测环境产物', skill: 'cezar:project-probe',
    session: { continue: 'probe' }, verdicts: ['ready', 'blocked'],
    prompt: '宿主环境交接校验失败：\n{{nodes.environment-check.output}}\n\n复用已有证据，仅补全映射的探测产物，重点修正 environment.json。不猜测工具路径，不修改业务代码，不运行构建、测试或安装。修正后返回 ready，无法补全则 blocked。' },
];
export const environmentEdges = [
  { from: 'environment-check.pass', to: 'baseline' },
  { from: 'environment-check.fail', to: 'probe-retry' },
  { from: 'probe-retry.repeat', to: 'probe-repair' },
  { from: 'probe-retry.exhausted', to: 'blocked-report' },
  { from: 'probe-repair.ready', to: 'environment-check' },
  { from: 'probe-repair.blocked', to: 'blocked-report' },
  { from: 'probe-repair.failed', to: 'blocked-report' },
];

/** Execution-only compatibility for pinned graphs: never overwrite their stored definition. */
export function withEnvironmentRecovery(graph: WorkflowGraph, baselineId?: string): WorkflowGraph {
  if (graph.nodes.some(node => node.type === 'check' && workflowActionOf(node.command) === 'environment')) return graph;
  const probe = graph.nodes.find(node => node.type === 'agent' && node.skill === 'cezar:project-probe');
  const baseline = graph.nodes.find(node => node.type === 'check' && (baselineId ? node.id === baselineId : workflowActionOf(node.command) === 'baseline' || node.id === 'baseline'));
  const blocked = probe && graph.edges.find(edge => edge.from === `${probe.id}.blocked`)?.to;
  if (!probe || !baseline || !blocked || !graph.edges.some(edge => edge.from === `${probe.id}.ready` && edge.to === baseline.id)) return graph;
  if (environmentNodes.some(added => graph.nodes.some(node => node.id === added.id))) throw new Error('Environment recovery node ids conflict with the pinned workflow');
  const nodes = structuredClone(environmentNodes).map(node => node.type === 'agent' ? { ...node,
    ...(probe.type === 'agent' && probe.runner ? { runner: probe.runner } : {}),
    ...(probe.type === 'agent' && probe.model ? { model: probe.model } : {}),
    session: { continue: probe.id } } : node);
  const edges = environmentEdges.map(edge => ({ ...edge, to: edge.to === 'baseline' ? baseline.id : edge.to === 'blocked-report' ? blocked : edge.to }));
  return { ...graph, nodes: [...graph.nodes, ...nodes],
    edges: [...graph.edges.map(edge => edge.from === `${probe.id}.ready` && edge.to === baseline.id ? { ...edge, to: 'environment-check' } : edge), ...edges] };
}
