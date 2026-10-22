import type { AgentRunner } from '../core/agent-runner.ts';
import type { RunStore } from '../runs/store.ts';

/** Capture the exact launch spec at the shared boundary, including Continue. */
export function startSessionWithInput(store: RunStore, runId: string, stepId: string, runner: AgentRunner, ...args: Parameters<AgentRunner['startSession']>) {
  const [spec] = args;
  const run = store.getRun(runId);
  const node = run?.workflowDef?.graph?.nodes.find(node => node.id === stepId);
  const step = run?.workflowDef?.steps.find(step => step.id === stepId);
  const nodeName = node?.name ?? step?.name ?? run?.steps.find(step => step.id === stepId)?.name;
  const skill = node?.type === 'agent' ? node.skill : step?.skill;
  const input = store.recordStepInput(runId, stepId, {
    cwd: spec.cwd,
    stepId,
    ...(nodeName !== undefined ? { nodeName } : {}),
    ...(skill !== undefined ? { skill } : {}),
    backend: runner.backend === 'claude-cli' ? 'claude' : runner.backend,
    ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.allowedTools !== undefined ? { allowedTools: spec.allowedTools } : {}),
    ...(spec.bashAllowlist !== undefined ? { bashAllowlist: spec.bashAllowlist } : {}),
    ...(spec.additionalDirectories !== undefined ? { additionalDirectories: spec.additionalDirectories } : {}),
    ...(spec.mcpServers ? { mcpServerNames: spec.mcpServers.map(server => server.name) } : {}),
    probeRestricted: spec.probePolicy !== undefined,
    imageCount: spec.images?.length ?? 0,
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.userPrompt !== undefined ? { userPrompt: spec.userPrompt } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.resume !== undefined ? { resume: spec.resume } : {}),
  });
  store.appendEvent(runId, { type: 'agent-launch', stepId, input });
  return runner.startSession(...args);
}
