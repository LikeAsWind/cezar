import type { AgentRunner } from '../core/agent-runner.ts';
import type { RunStore } from '../runs/store.ts';

/** Capture the exact launch spec at the shared boundary, including Continue. */
export function startSessionWithInput(store: RunStore, runId: string, stepId: string, runner: AgentRunner, ...args: Parameters<AgentRunner['startSession']>) {
  const [spec] = args;
  store.recordStepInput(runId, stepId, {
    cwd: spec.cwd,
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.userPrompt !== undefined ? { userPrompt: spec.userPrompt } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.resume !== undefined ? { resume: spec.resume } : {}),
  });
  return runner.startSession(...args);
}
