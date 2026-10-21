import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunManager } from './run.ts';
import { RunStore } from '../runs/store.ts';
import { workflowActionCommand } from './workflow-actions.ts';
import { newArtifactPaths } from '../../scripts/workflow/artifacts.mjs';

it.each(['cezar workflow-action execution', workflowActionCommand('execution')])('executes the host action without Bash or PATH: %s', async command => {
  const root = await mkdtemp(join(tmpdir(), 'cezar host check '));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  try {
    const run = store.createRun({ title: 'Native host check', task: 'Choose execution', workflow: 'test', steps: [{ id: 'execution-route', name: 'Route', kind: 'check' }] });
    const paths = newArtifactPaths(root, run.id);
    await mkdir(join(paths.directory, 'probe'), { recursive: true });
    await mkdir(join(paths.directory, 'logs'), { recursive: true });
    await writeFile(paths.file('run.json'), JSON.stringify({ runId: run.id, root: await realpath(root), artifactPrefix: paths.prefix }));
    await writeFile(paths.file('execution-input.json'), JSON.stringify({ schemaVersion: 1, tasksIndependent: false, subagents: { available: null, tool: null, evidence: 'Not observed' } }));
    const harness = manager as unknown as {
      checkStepEnv(): Promise<NodeJS.ProcessEnv>;
      runCheckStep(id: string, state: { cwd: string; cancelled: boolean }, step: { id: string; command: string }, emit: () => void): Promise<{ ok: boolean; output: string; exitCode: number }>;
    };
    vi.spyOn(harness, 'checkStepEnv').mockResolvedValue({ ...process.env, PATH: '', CEZ_RUN_ID: run.id });
    const result = await harness.runCheckStep(run.id, { cwd: root, cancelled: false }, { id: 'execution-route', command }, () => {});
    expect(result, result.output).toMatchObject({ ok: true, exitCode: 0, output: 'native' });
    expect(store.getRun(run.id)?.steps[0]?.input?.command).toBe(command);
    expect(JSON.parse(await readFile(paths.file('execution.json'), 'utf8')).mode).toBe('native');
  } finally {
    manager.dispose(); store.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
