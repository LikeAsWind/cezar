import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowRuntime, WorkflowAgentInput, WorkflowAgentLaunch } from './workflow-runtime.ts';
import type { WorkflowGraph } from './graph.ts';
import { adjudicationTurnInput, clarificationForEvent, guardUnattendedCheck, guardUnattendedVerdict, managedAction } from './unattended-guards.ts';
import { unattendedRecoveryPoint } from './unattended-recovery.ts';
import { prepareUnattendedProbe, unattendedToolchainEnv, artifactInstructions, unattendedContext, unattendedUserUpdates } from './unattended-probe.ts';
import { withEnvironmentRecovery } from './unattended-environment.ts';
import { bindWorkflowActions, workflowActionOf } from './workflow-actions.ts';
import { verdictInstruction } from './graph.ts';
import { unattendedStage, unattendedArtifactStage } from './unattended-roles.ts';

const builderRecovery = '\n\nbuilder check 恢复：先复用与当前设计一致的完整检查结果。只有 TaskOutput 明确确认旧任务编号不存在或已失效，且没有可复用结果时，才按已加载 brainstorming 的 builder check 要求，使用原检查提示词启动一个全新上下文的通用子代理检查当前设计；最多重新启动一次。仍在运行、等待超时或接口失败不属于编号失效，不重复启动。收取新检查的完整结果并处理反馈后再继续；再次失败则明确报告阻塞。仅重做检查，不重跑探测、基线或重复起草设计。';

export function unattendedRuntime(dataDir: string, runId: string, pinnedGraph: WorkflowGraph): WorkflowRuntime {
  const baseline = pinnedGraph.nodes.find(node => node.type === 'check' && managedAction(dataDir, runId, node.command) === 'baseline');
  const graph = structuredClone(withEnvironmentRecovery(pinnedGraph, baseline?.id));
  bindWorkflowActions(graph.nodes);
  const isJudge = (id: string) => graph.nodes.some(node => node.id === id && node.type === 'agent' && node.skill === 'cezar:adjudicator');
  const executionStrategy = graph.nodes.some(node => node.type === 'check' && (workflowActionOf(node.command) === 'execution' || node.id === 'execution-route'));
  const hostActions = graph.nodes.some(node => node.type === 'check' && workflowActionOf(node.command) === 'verify');
  const environmentCheck = graph.nodes.find(node => node.type === 'check' && workflowActionOf(node.command) === 'environment');
  const repairLoop = environmentCheck && graph.nodes.find(node => node.type === 'loop' && graph.edges.some(edge => edge.from === `${environmentCheck.id}.fail` && edge.to === node.id));
  const repairNode = repairLoop && graph.nodes.find(node => node.type === 'agent' && graph.edges.some(edge => edge.from === `${repairLoop.id}.repeat` && edge.to === node.id));
  const stageFor = (id: string) => unattendedArtifactStage(graph, id);
  return {
    needsTaskTitle: true,
    preserveSummary: true,
    executionGraph: () => graph,
    recoveryPoint: state => {
      const cursor = unattendedRecoveryPoint(graph, state);
      const blocker = state?.taken?.filter(taken => graph.edges.some(edge => `${edge.from}->${edge.to}` === taken
        && graph.nodes.some(node => node.id === edge.to && node.type === 'check' && workflowActionOf(node.command) === 'blocked'))).at(-1);
      if (environmentCheck && blocker && !state?.cursor && graph.edges.some(edge => `${edge.from}->${edge.to}` === blocker && (edge.from === `${repairLoop?.id}.exhausted` || edge.from === `${repairNode?.id}.blocked` || edge.from === `${repairNode?.id}.failed`))) return environmentCheck.id;
      return environmentCheck && cursor === baseline?.id ? environmentCheck.id : cursor;
    },
    recoveryLoops: loops => repairLoop && existsSync(join(dataDir, 'runs', runId, 'probe-environment-repair.json'))
      ? { ...loops, [repairLoop.id]: Math.max(loops[repairLoop.id] ?? 0, 1) } : loops,
    returningCaller: (id, taken) => {
      const [from, to] = taken.at(-1)?.split('->') ?? [];
      return to === id && Boolean(from && isJudge(from.split('.')[0]!));
    },
    parksCaller: (_step, verdict) => verdict === 'question',
    failureContext: output => `\n\n本节点上次检查失败证据（按当前节点职责处理）：\n${output}`,
    resumeInstructions: (id, verdicts) => ({ suffix: unattendedStage(graph, id) === 'design' ? builderRecovery : '',
      continuation: `Use the queued user continuation already supplied in this session; do not create a duplicate resume-message file. Continue this node, not a standalone follow-up. ${verdicts?.length ? verdictInstruction(verdicts) : ''}` }),
    prepareAgent: async (input: WorkflowAgentInput): Promise<WorkflowAgentLaunch> => {
      const { cwd, step, backend, run, events, treeBlocks, attachmentText, returningCaller, resuming, verdicts } = input;
      if (step.skill === 'cezar:project-probe') {
        const probe = await prepareUnattendedProbe(dataDir, runId, cwd, backend, hostActions, run?.titleSummary?.trim() || run?.task || run?.title || 'task');
        return { prompt: [probe.instructions,
          ...(step.id === repairNode?.id ? [input.prompt] : []), ...treeBlocks,
          ...(input.checkFailure ? [`上次检查失败证据（仅用于探测，不在本阶段修复）：\n${input.checkFailure}`] : []),
          ...(attachmentText ? [attachmentText] : []), ...unattendedUserUpdates(run, events)].join('\n\n'),
          env: input.env, spec: { timeoutMs: probe.timeoutMs, probePolicy: probe.policy }, suppressMcp: true };
      }
      const env = await unattendedToolchainEnv(dataDir, runId, cwd, input.env);
      const judge = isJudge(step.id);
      const delta = resuming && (judge || returningCaller);
      let prompt = input.prompt;
      if (delta) {
        const previous = run?.steps.find(record => record.id === step.id)?.input?.capturedAt;
        const updates = unattendedUserUpdates({ queuedMessages: run?.queuedMessages?.filter(message => !previous || message.createdAt > previous) }, events.filter(event => !previous || event.ts > previous));
        prompt = [...treeBlocks, await adjudicationTurnInput(dataDir, runId, graph, step.id, !judge),
          ...(!judge && verdicts?.length ? [verdictInstruction(verdicts)] : []),
          ...(updates.length ? [`本轮用户补充：\n${updates.join('\n\n')}`] : []), ...(attachmentText ? [attachmentText] : [])].join('\n\n');
      } else {
        prompt += `\n\n${artifactInstructions(cwd, runId, stageFor(step.id), dataDir, stageFor)}`;
        prompt += `\n\n${judge ? await adjudicationTurnInput(dataDir, runId, graph, step.id, false, true)
          : await unattendedContext(cwd, runId, run, stageFor(step.id), dataDir, resuming, unattendedUserUpdates(run, events), step.id)}`;
        if (judge) prompt += `\n\n${unattendedUserUpdates(run, events).join('\n\n')}`;
      }
      return { prompt, env, omitSystemPrompt: delta && backend === 'codex' };
    },
    prepareContinuation: async (cwd, run, events, prompt, env) => ({
      env: await unattendedToolchainEnv(dataDir, runId, cwd, env),
      prompt: prompt + `\n\n${artifactInstructions(cwd, runId, run.graphState?.cursor ? stageFor(run.graphState.cursor) : undefined, dataDir, stageFor)}\n\n${await unattendedContext(cwd, runId, run, run.graphState?.cursor ? stageFor(run.graphState.cursor) : undefined, dataDir, false, unattendedUserUpdates(run, events), run.graphState?.cursor)}`,
    }),
    validateVerdict: (cwd, id, verdict, response) => guardUnattendedVerdict(dataDir, runId, cwd, id, verdict, executionStrategy, graph, response),
    clarification: (id, phase, verdict) => (phase === 'start' ? isJudge(id) : phase === 'failure' ? isJudge(id) : verdict === 'question' || isJudge(id))
      ? clarificationForEvent(dataDir, runId, graph, phase === 'start') : Promise.resolve(undefined),
    check: (cwd, command, phase) => guardUnattendedCheck(dataDir, runId, cwd, command, phase),
  };
}
