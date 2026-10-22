import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { AgentRunner } from '../core/agent-runner.ts';
import { startSessionWithInput } from './step-input.ts';

it('persists the latest real input with secrets redacted before truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-step-input-'));
  const store = RunStore.open(root);
  try {
    const run = store.createRun({ title: 'input', task: 'task', workflow: 'test', steps: [{ id: 'design', name: 'Design', kind: 'agent' }] });
    store.updateRun(run.id, { workflowDef: { name: 'test', source: 'file', steps: [{ id: 'design', name: '设计与需求消歧', skill: 'superpowers:brainstorming' }] } });
    const secret = 'private-profile-token-for-test';
    store.registerRunSecrets(run.id, [secret]);
    store.recordStepInput(run.id, 'design', { cwd: '/worktree', userPrompt: `Shared map src/Counter.java ${secret}`, systemPrompt: 'Original skill' });
    store.flush();
    const saved = RunStore.open(root).getRun(run.id)?.steps[0]?.input;
    expect(saved?.userPrompt).toContain('src/Counter.java');
    expect(saved?.userPrompt).not.toContain(secret);
    expect(saved?.systemPrompt).toBe('Original skill');
    expect(saved?.capturedAt).toBeTruthy();
    const runner: AgentRunner = { backend: 'claude', run: vi.fn(), interrupt: vi.fn(), startSession: vi.fn() };
    const launch = { cwd: '/worktree', userPrompt: `Actual launch ${secret}`, systemPrompt: 'Host system prompt', allowedTools: ['Read', 'Bash'], timeoutMs: 5400000, env: { PRIVATE_TOKEN: secret } };
    const onEvent = vi.fn(), options = { onUiEvent: vi.fn(), autoEndAfterFirstTurn: false };
    startSessionWithInput(store, run.id, 'design', runner, launch, onEvent, options);
    expect(runner.startSession).toHaveBeenCalledWith(launch, onEvent, options);
    startSessionWithInput(store, run.id, 'design', runner, { ...launch, resume: true }, onEvent, options);
    const launches = store.readEvents(run.id).filter(event => event.type === 'agent-launch');
    expect(launches).toHaveLength(2);
    expect(launches[0]?.input).toMatchObject({ systemPrompt: 'Host system prompt', allowedTools: ['Read', 'Bash'], timeoutMs: 5400000, backend: 'claude', nodeName: '设计与需求消歧', skill: 'superpowers:brainstorming', stepId: 'design' });
    expect(JSON.stringify(launches)).not.toContain(secret);
    expect(JSON.stringify(launches)).not.toContain('PRIVATE_TOKEN');
    expect(RunStore.open(root).readEvents(run.id).filter(event => event.type === 'agent-launch')).toHaveLength(2);
    store.recordStepInput(run.id, 'design', { cwd: '/worktree', userPrompt: 'x'.repeat(100_000) + secret });
    store.flush();
    expect(store.getRun(run.id)?.steps[0]?.input?.truncatedFields).toContain('userPrompt');
    expect((await readFile(join(root, 'runs.json'), 'utf8'))).not.toContain(secret);
  } finally { store.flush(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
