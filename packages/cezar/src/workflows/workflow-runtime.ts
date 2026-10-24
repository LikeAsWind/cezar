import type { AgentRunSpec, RunnerId } from '../core/agent-runner.ts';
import type { RunEvent, RunRecord } from '../runs/store.ts';
import type { WorkflowClarification } from '@open-mercato/cezar-contract';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import type { WorkflowStepDef } from './types.ts';
import { isUnattendedGraph } from './unattended-guards.ts';
import { unattendedRuntime } from './unattended-runtime.ts';

export interface WorkflowAgentInput {
  cwd: string;
  step: WorkflowStepDef;
  backend: RunnerId;
  run: RunRecord | undefined;
  events: RunEvent[];
  prompt: string;
  env: Record<string, string>;
  treeBlocks: string[];
  attachmentText?: string;
  checkFailure?: string | null;
  resuming: boolean;
  returningCaller: boolean;
  verdicts?: readonly string[];
}

export interface WorkflowAgentLaunch {
  prompt: string;
  env: Record<string, string>;
  spec?: Pick<AgentRunSpec, 'timeoutMs' | 'probePolicy'>;
  suppressMcp?: boolean;
  omitSystemPrompt?: boolean;
}

/** Workflow policy supplies data and validation; only the engine launches graph nodes. */
export interface WorkflowRuntime {
  readonly needsTaskTitle: boolean;
  readonly preserveSummary: boolean;
  executionGraph(): WorkflowGraph;
  recoveryPoint(state: RunRecord['graphState']): string | undefined;
  recoveryLoops(loops: Record<string, number>): Record<string, number>;
  returningCaller(nodeId: string, taken: string[]): boolean;
  parksCaller(step: WorkflowStepDef, verdict: string | null): boolean;
  failureContext(output: string): string;
  resumeInstructions(nodeId: string, verdicts: readonly string[] | undefined): { suffix: string; continuation: string };
  prepareAgent(input: WorkflowAgentInput): Promise<WorkflowAgentLaunch>;
  prepareContinuation(cwd: string, run: RunRecord, events: RunEvent[], prompt: string, env: Record<string, string>): Promise<WorkflowAgentLaunch>;
  validateVerdict(cwd: string, nodeId: string, verdict: string, response: string): Promise<void>;
  clarification(nodeId: string, phase: 'start' | 'verdict' | 'failure', verdict?: string): Promise<WorkflowClarification | undefined>;
  check(cwd: string, command: string, phase: 'before' | 'after'): Promise<void>;
}

export function workflowRuntimeFor(dataDir: string, runId: string, graph?: WorkflowGraph): WorkflowRuntime | undefined {
  return graph && isUnattendedGraph(dataDir, runId, graph) ? unattendedRuntime(dataDir, runId, graph) : undefined;
}

/** Project the executed graph for the task viewer without changing the pinned record. */
export function workflowExecutionView(dataDir: string, run: RunRecord): RunRecord {
  const definition = run.workflowDef;
  if (!definition?.graph) return run;
  const runtime = workflowRuntimeFor(dataDir, run.id, definition.graph);
  if (!runtime) return run;
  const graph = runtime.executionGraph();
  const added = graph.nodes.filter(node => !definition.graph!.nodes.some(pinned => pinned.id === node.id));
  if (!added.some(node => run.steps.some(step => step.id === node.id))) return run;
  return { ...run, workflowDef: { ...definition, graph, steps: graphToSteps(graph) } };
}
