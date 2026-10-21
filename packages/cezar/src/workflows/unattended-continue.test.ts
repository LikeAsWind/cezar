import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { ensureBundleSnapshot } from '../superpowers-update.ts';
import { graphToSteps } from './graph.ts';
import type { WorkflowDef } from './types.ts';
import { unattendedWorkflows } from './superpowers-bundle.ts';
import * as guards from './unattended-guards.ts';
import { RunManager } from './run.ts';
import { newArtifactPaths } from '../../scripts/workflow/artifacts.mjs';

const gitState = vi.hoisted(() => ({ missing: false, creationFails: false, recordedPath: '' }));
vi.mock('../server/git.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/git.ts')>();
  return { ...actual, getRepoInfo: (...args: Parameters<typeof actual.getRepoInfo>) => gitState.missing ? Promise.resolve(null) : actual.getRepoInfo(...args) };
});
vi.mock('../git-worktree.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../git-worktree.ts')>();
  return { ...actual,
    createWorktree: (...args: Parameters<typeof actual.createWorktree>) => gitState.creationFails ? Promise.reject(new Error('Git unavailable during recovery')) : gitState.recordedPath ? Promise.resolve({ path: gitState.recordedPath, branch: args[3]!.branch!, baseBranch: args[2] }) : actual.createWorktree(...args),
  };
});

const captures = vi.hoisted(() => ({ prompts: [] as string[], specs: [] as AgentRunSpec[], onLaunch: undefined as ((spec: AgentRunSpec) => void) | undefined }));
vi.mock('../core/runner-factory.ts', () => ({ createRunner: () => ({
  backend: 'claude', startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
    const prompt = spec.userPrompt ?? ''; captures.prompts.push(prompt); captures.specs.push(spec);
    captures.onLaunch?.(spec);
    const text = `CEZ:VERDICT ${prompt.includes('REVIEW') ? 'approve' : 'ready'}`;
    return { open: false, interrupt() {}, end() {}, sendMessage: () => false,
      result: new Promise<AgentRunResult>(resolve => setTimeout(() => {
        onEvent?.({ type: 'session', sessionId: `session-${captures.prompts.length}` }); onEvent?.({ type: 'text', text });
        onEvent?.({ type: 'turn-end' });
        resolve({ text, tokensUsed: 0, toolCalls: [] });
      }, 0)),
    };
  }, interrupt: async () => {},
}) }));

it.each([{ name: 'in place', isolated: false, fail: false }, { name: 'isolated despite missing repo detection', isolated: true, fail: false }, { name: 'isolated with unavailable Git', isolated: true, fail: true }])('Continue preserves worktree and verification guarantees: $name', async ({ isolated, fail }) => {
  const root = await mkdtemp(join(tmpdir(), 'cez-unattended-continue-')), data = join(root, '.ai/cezar');
  let manager: RunManager | undefined;
  const store = RunStore.open(data);
  try {
    captures.prompts.length = 0;
    captures.specs.length = 0;
    captures.onLaunch = undefined;
    const snapshot = await ensureBundleSnapshot();
    const bundled = unattendedWorkflows(snapshot.root)[0]!;
    const verify = bundled.graph!.nodes.find(node => node.id === 'verify')!;
    const seal = bundled.graph!.nodes.find(node => node.id === 'seal')!;
    const graph: NonNullable<WorkflowDef['graph']> = { nodes: [{ id: 'start', type: 'start' }, { id: 'design', type: 'agent', prompt: 'DESIGN', timeoutMs: 90 * 60_000, verdicts: ['ready'] }, verify,
      { id: 'review', type: 'agent', prompt: 'REVIEW', verdicts: ['approve'] }, { id: 'deliver', type: 'agent', prompt: 'DELIVER', verdicts: ['ready'] }, seal,
      { id: 'done', type: 'end', status: 'success' }], edges: [{ from: 'start.next', to: 'design' }, { from: 'design.ready', to: 'verify' }, { from: 'verify.pass', to: 'review' }, { from: 'review.approve', to: 'deliver' }, { from: 'deliver.ready', to: 'seal' }, { from: 'seal.pass', to: 'done' }] };
    const workflow: WorkflowDef = { name: 'managed-resume-test', source: 'file', steps: graphToSteps(graph), graph };
    const run = store.createRun({ title: 'Resume', workflow: workflow.name, task: 'Implement filter', steps: workflow.steps.map(step => ({ id: step.id, name: step.id, kind: step.command ? 'check' : 'agent' })) });
    let cwd = root;
    if (isolated) {
      cwd = join(root, '.ai/cezar/worktrees', run.id); await mkdir(cwd, { recursive: true });
      store.updateRun(run.id, { worktreePath: cwd, branch: `cez/${run.id.slice(0, 8)}`, baseBranch: 'recorded-base' });
      gitState.recordedPath = cwd;
      gitState.missing = true;
      gitState.creationFails = fail;
    }
    store.updateRun(run.id, { status: 'failed', worktree: isolated ? undefined : false, workflowDef: workflow, graphState: { cursor: 'design', loops: { 'clarification-round': 3, 'final-retry': 1 }, taken: [] } });
    await mkdir(join(data, 'runs'), { recursive: true });
    await writeFile(join(data, 'runs', `${run.id}.superpowers.json`), JSON.stringify({ schemaVersion: 1, ref: snapshot.ref }));
    const paths = newArtifactPaths(cwd, run.id); await mkdir(join(paths.directory, 'specs'), { recursive: true }); await mkdir(join(paths.directory, 'plans'), { recursive: true });
    await mkdir(join(paths.directory, 'probe'), { recursive: true });
    await mkdir(join(paths.directory, 'logs'), { recursive: true });
    await writeFile(paths.file('run.json'), JSON.stringify({ runId: run.id, root: await realpath(cwd), artifactPrefix: paths.prefix }));
    await writeFile(paths.file('context-map.jsonl'), JSON.stringify({ schemaVersion: 1, stage: 'probe', path: 'src/ExistingCounter.java', summary: 'Existing fixture counter', relevance: 'Continue existing work', symbols: ['recordFailure'], dependsOn: [], confidence: 'high' }) + '\n');
    for (const name of ['design.md', 'ledger.md']) await writeFile(paths.file(name), '# Existing evidence');
    await writeFile(paths.file('validation-plan.json'), '{}');
    const baseline = bundled.graph!.nodes.find(node => node.id === 'baseline');
    if (baseline?.type !== 'check') throw Error('missing baseline');
    await guards.guardUnattendedCheck(data, run.id, cwd, baseline.command, 'after');
    manager = new RunManager(store, root);
    expect(store.getRun(run.id)?.workflowDef?.graph).toBeDefined();
    expect(guards.isUnattendedGraph(data, run.id, graph)).toBe(true);
    const checks: string[] = [];
    vi.spyOn(manager as unknown as { runCheckStep: (...args: unknown[]) => Promise<{ ok: boolean; output: string; exitCode: number }> }, 'runCheckStep').mockImplementation(async (...args) => {
      const step = args[2] as { id: string }; checks.push(step.id);
      if (step.id === 'verify') await writeFile(paths.file('verified.json'), JSON.stringify({ runId: run.id, diffHash: 'example' }));
      return { ok: true, output: 'passed', exitCode: 0 };
    });
    const pinPath = join(data, 'runs', `${run.id}.superpowers.json`);
    await rename(pinPath, `${pinPath}.test-backup`);
    expect(guards.isUnattendedGraph(data, run.id, graph)).toBe(true); // Host actions do not require a vendor pin.
    await rename(`${pinPath}.test-backup`, pinPath);
    store.updateStep(run.id, 'design', { sessionId: 'old-design-account-session', backend: 'claude', profileId: 'old-implicit-account' });
    vi.spyOn(manager as unknown as { agentEnvForStep: (...args: unknown[]) => Promise<{ env: Record<string, string>; profileId: string }> }, 'agentEnvForStep').mockResolvedValue({ env: {}, profileId: 'new-implicit-account' });
    captures.onLaunch = spec => {
      const current = store.getRun(run.id), step = current?.steps.find(step => step.id === current.currentStepId);
      expect(step?.sessionId).toBe(spec.sessionId);
      expect(step?.profileId).toBe('new-implicit-account');
    };
    expect(manager.continueRun(run.id, { text: 'Use exact matching.' })).toEqual({ ok: true });
    await expect.poll(() => ['done', 'review', 'failed'].includes(store.getRun(run.id)?.status ?? ''), { timeout: 20_000 }).toBe(true);
    if (fail) {
      expect(store.getRun(run.id)?.error).toContain('worktree creation failed');
      expect(captures.specs).toHaveLength(0);
      expect(store.getRun(run.id)?.worktreePath).toBe(cwd);
      expect(await readFile(paths.file('validation-plan.json'), 'utf8')).toBe('{}');
      return;
    }
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).not.toBe('failed');
    expect(store.getRun(run.id)?.graphState?.taken).toContain('seal.pass->done');
    expect(captures.specs[0]?.resume).toBe(false);
    expect(captures.specs[0]?.timeoutMs).toBe(90 * 60_000);
    expect(captures.specs[0]?.userPrompt).toContain('src/ExistingCounter.java');
    expect(captures.specs[0]?.userPrompt).toContain('recordFailure');
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'design')?.input?.userPrompt).toBe(captures.specs[0]?.userPrompt);
    expect(await realpath(captures.specs[0]!.cwd)).toBe(await realpath(cwd));
    expect(captures.specs[0]?.sessionId).not.toBe('old-design-account-session');
    expect(checks).toEqual(['verify', 'seal']);
    expect(captures.prompts.some(prompt => prompt.includes('DESIGN'))).toBe(true);
    expect(captures.prompts.some(prompt => prompt.includes('REVIEW'))).toBe(true);
    expect(store.getRun(run.id)?.graphState?.loops).toEqual({ 'clarification-round': 3, 'final-retry': 1 });
    expect(store.getRun(run.id)?.steps.some(step => step.id.startsWith('continue-'))).toBe(false);
    await expect(readFile(paths.file('resume-message.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(captures.specs[0]?.userPrompt).toContain('Use exact matching.');
  } finally { gitState.missing = false; gitState.creationFails = false; gitState.recordedPath = ''; captures.onLaunch = undefined; manager?.dispose(); store.flush(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 60_000);
