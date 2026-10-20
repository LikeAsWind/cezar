import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { prepareUnattendedProbe, unattendedToolchainEnv } from './unattended-probe.ts';
import { ensureBundleSnapshot } from '../superpowers-update.ts';
import { assertProbeSupport, PROBE_TIMEOUT_MS } from '../core/probe-policy.ts';
import type { AgentEvent, AgentRunSpec } from '../core/agent-runner.ts';
import { unattendedWorkflows } from './superpowers-bundle.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { artifactPaths } from '../../scripts/workflow/artifacts.mjs';

const captures = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));
vi.mock('../core/runner-factory.ts', () => ({ createRunner: () => ({
  backend: 'claude', interrupt: async () => {}, startSession: (spec: AgentRunSpec, event?: (event: AgentEvent) => void) => {
    captures.specs.push(spec);
    const text = `CEZ:VERDICT ${spec.probePolicy ? 'blocked' : 'reported'}`;
    return { open: false, interrupt() {}, end() {}, sendMessage: () => false,
      result: new Promise(resolve => setTimeout(() => { event?.({ type: 'text', text }); event?.({ type: 'turn-end' }); resolve({ text, tokensUsed: 0, toolCalls: [] }); }, 0)) };
  },
}) }));

it('passes the trusted single toolchain to implementation without leaking arbitrary host environment or choosing between modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-agent-toolchain-'));
  try {
    const { realpath } = await import('node:fs/promises');
    const data = join(root, '.ai/cezar'); await mkdir(join(data, 'runs'), { recursive: true });
    const javaHome = join(root, 'jdk8');
    const record = { schemaVersion: 1, runId: 'run', root: await realpath(root), plan: JSON.stringify({ toolchains: [{ execution: { javaHome, pathEntries: [] } }] }) };
    await writeFile(join(data, 'runs/run.unattended.json'), JSON.stringify(record));
    const env = await unattendedToolchainEnv(data, 'run', root, { JAVA_HOME: 'wrong', PATH: 'existing-path', CEZ_TASK_ID: 'run' });
    expect(env.JAVA_HOME).toBe(javaHome);
    expect(env.PATH).toContain(join(javaHome, 'bin'));
    expect(Object.keys(env).sort()).toEqual(['CEZ_TASK_ID', 'JAVA_HOME', 'PATH']);
    record.plan = JSON.stringify({ toolchains: [{ execution: { javaHome } }, { execution: { javaHome: join(root, 'jdk11') } }] });
    await writeFile(join(data, 'runs/run.unattended.json'), JSON.stringify(record));
    expect(await unattendedToolchainEnv(data, 'run', root, { PATH: 'unchanged' })).toEqual({ PATH: 'unchanged' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('initializes before launch, supplies the eight-minute limit, and refuses unsupported backends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-probe-launch-'));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    git('init');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
    git('worktree', 'add', 'task', '-b', 'probe-test');
    const cwd = join(root, 'task'), dataDir = join(root, '.ai/cezar');
    const snapshot = await ensureBundleSnapshot();
    await mkdir(join(dataDir, 'runs'), { recursive: true });
    await writeFile(join(dataDir, 'runs', 'probe-run.superpowers.json'), JSON.stringify({ schemaVersion: 1, ref: snapshot.ref }));
    const launch = await prepareUnattendedProbe(dataDir, 'probe-run', cwd, 'claude');
    expect(launch.policy).toEqual({ root: cwd, runId: 'probe-run' });
    expect(launch.timeoutMs).toBe(PROBE_TIMEOUT_MS);
    expect(launch.timeoutMs).toBe(480_000);
    expect(launch.instructions).toContain('probe-policy.mjs');
    expect(launch.instructions).toContain('No compile/test');
    const { readFile } = await import('node:fs/promises');
    expect(JSON.parse(await readFile(artifactPaths(cwd, 'probe-run').file('run.json'), 'utf8')).runId).toBe('probe-run');
    await expect(prepareUnattendedProbe(dataDir, 'probe-run', cwd, 'codex')).rejects.toThrow('cannot enforce');
    expect(() => assertProbeSupport('opencode', { root: cwd, runId: 'probe-run' })).toThrow('cannot enforce');
    expect(() => assertProbeSupport('codex', undefined)).not.toThrow();
    await expect(prepareUnattendedProbe(dataDir, 'another-run', cwd, 'claude')).rejects.toThrow();
    // A copied host-action template needs no vendor snapshot to initialize discovery.
    const hostLaunch = await prepareUnattendedProbe(dataDir, 'host-only', cwd, 'claude', true);
    expect(hostLaunch.instructions).toContain('Host initialized');
    expect(JSON.parse(await readFile(artifactPaths(cwd, 'host-only').file('run.json'), 'utf8')).runId).toBe('host-only');

    // Real RunManager Continue path must carry the boundary and timeout to the runner.
    const store = RunStore.open(join(cwd, '.ai/cezar'));
    const manager = new RunManager(store, cwd);
    try {
      const workflow = unattendedWorkflows(snapshot.root)[0]!;
      const run = store.createRun({ title: 'Probe recovery', workflow: workflow.name, task: 'Locate relevant Java files', steps: workflow.steps.map(step => ({ id: step.id, name: step.id, kind: step.command ? 'check' : 'agent' })) });
      // Remove the manually initialized identity; the host must create this run's own context.
      await rm(join(cwd, 'docs/superpowers'), { recursive: true });
      store.updateRun(run.id, { status: 'failed', worktree: false, workflowDef: workflow, graphState: { cursor: 'probe', taken: [], loops: {} } });
      await mkdir(join(cwd, '.ai/cezar/runs'), { recursive: true });
      await writeFile(join(cwd, '.ai/cezar/runs', `${run.id}.superpowers.json`), JSON.stringify({ schemaVersion: 1, ref: snapshot.ref }));
      vi.spyOn(manager as unknown as { agentEnvForStep: () => Promise<{ env: Record<string, string>; profileId: string }> }, 'agentEnvForStep').mockResolvedValue({ env: {}, profileId: 'fixture' });
      captures.specs = [];
      expect(manager.continueRun(run.id, { text: 'Resume discovery only.' })).toEqual({ ok: true });
      await expect.poll(() => captures.specs.length > 0, { timeout: 15_000 }).toBe(true);
      expect(captures.specs[0]?.probePolicy).toEqual({ root: cwd, runId: run.id });
      expect(captures.specs[0]?.timeoutMs).toBe(480_000);
      expect(captures.specs[0]?.mcpServers).toBeUndefined();
      expect(captures.specs[0]?.userPrompt).toContain('Host initialized');
      await expect.poll(() => store.getRun(run.id)?.status, { timeout: 15_000 }).toBe('failed');
      expect(captures.specs.filter(spec => spec.probePolicy)).toHaveLength(1);
    } finally { manager.dispose(); store.flush(); }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 60_000);
