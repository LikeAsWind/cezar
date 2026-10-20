import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { GraphNode } from './graph.ts';
import type { RunnerId } from '../core/agent-runner.ts';

it('reuses only the returning caller session and falls back across backends or accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-unattended-session-')), store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  try {
    const run = store.createRun({ title: 'Clarification', workflow: 'unattended', task: 'Implement', steps: [{ id: 'design', name: 'Design', kind: 'agent' }, { id: 'review', name: 'Review', kind: 'agent' }] });
    store.updateStep(run.id, 'design', { sessionId: 'design-context', backend: 'claude' });
    store.updateStep(run.id, 'review', { sessionId: 'independent-review', backend: 'claude' });
    type AgentNode = Extract<GraphNode, { type: 'agent' }>;
    const resume = (manager as unknown as { graphResumeSession: (runId: string, node: AgentNode, backend: RunnerId, emit: (event: unknown) => void, returningCaller?: boolean) => string | undefined }).graphResumeSession.bind(manager);
    const design: AgentNode = { id: 'design', type: 'agent', prompt: 'Clarify' };
    expect(resume(run.id, design, 'claude', () => {}, true)).toBe('design-context');
    expect(resume(run.id, design, 'claude', () => {}, false)).toBeUndefined();
    expect(resume(run.id, { id: 'review', type: 'agent', prompt: 'Review independently' }, 'claude', () => {}, false)).toBeUndefined();
    expect(resume(run.id, design, 'codex', () => {}, true)).toBeUndefined();
    expect(resume(run.id, design, 'junie', () => {}, true)).toBeUndefined();
    store.updateRun(run.id, { agentProfile: 'another-account' });
    expect(resume(run.id, design, 'claude', () => {}, true)).toBeUndefined();
  } finally { manager.dispose(); store.flush(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
