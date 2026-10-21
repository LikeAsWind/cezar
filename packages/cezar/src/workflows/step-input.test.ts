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
    const launch = { cwd: '/worktree', userPrompt: 'Actual launch' };
    const onEvent = vi.fn(), options = { onUiEvent: vi.fn(), autoEndAfterFirstTurn: false };
    startSessionWithInput(store, run.id, 'design', runner, launch, onEvent, options);
    expect(runner.startSession).toHaveBeenCalledWith(launch, onEvent, options);
    store.recordStepInput(run.id, 'design', { cwd: '/worktree', userPrompt: 'x'.repeat(100_000) + secret });
    store.flush();
    expect(store.getRun(run.id)?.steps[0]?.input?.truncatedFields).toContain('userPrompt');
    expect((await readFile(join(root, 'runs.json'), 'utf8'))).not.toContain(secret);
  } finally { store.flush(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
