import { runFilePath } from '../runs/files.ts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { prepareUnattendedProbe, unattendedToolchainEnv } from './unattended-probe.ts';
import { ensureBundleSnapshot } from '../superpowers-update.ts';
import { assertProbeSupport, PROBE_TIMEOUT_MS } from '../core/probe-policy.ts';
import type { AgentEvent, AgentRunSpec } from '../core/agent-runner.ts';
import { unattendedWorkflows } from './superpowers-bundle.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { artifactPaths } from '../../scripts/workflow/artifacts.mjs';

const captures = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], onLaunch: undefined as ((spec: AgentRunSpec) => string) | undefined }));
vi.mock('../core/runner-factory.ts', () => ({ createRunner: () => ({
  backend: 'claude', interrupt: async () => {}, startSession: (spec: AgentRunSpec, event?: (event: AgentEvent) => void) => {
    captures.specs.push(spec);
    const text = captures.onLaunch?.(spec) ?? `CEZ:VERDICT ${spec.probePolicy ? 'blocked' : 'reported'}`;
    return { open: false, interrupt() {}, end() {}, sendMessage: () => false,
      result: new Promise(resolve => setTimeout(() => { event?.({ type: 'text', text }); event?.({ type: 'turn-end' }); resolve({ text, tokensUsed: 0, toolCalls: [] }); }, 0)) };
  },
}) }));

it('waits for the existing title result before probe initialization even without branch naming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-probe-name-race-'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root, { branchNameWaitMs: 1000 });
  try {
    const run = store.createRun({ title: '中文原始需求', workflow: 'probe', task: '中文原始需求', steps: [] });
    const naming = manager as unknown as {
      pendingBranchNames: Map<string, Promise<string | undefined>>;
      awaitGeneratedBranch: (id: string, branch: string | undefined, note: (message: string) => void, requireTitle: boolean) => Promise<string | undefined>;
    };
    naming.pendingBranchNames.set(run.id, new Promise(resolve => setTimeout(() => {
      store.updateRun(run.id, { titleSummary: 'adding audience package fallback' });
      resolve(undefined);
    }, 20)));
    await naming.awaitGeneratedBranch(run.id, undefined, () => {}, true);
    expect(store.getRun(run.id)?.titleSummary).toBe('adding audience package fallback');
  } finally { manager.dispose(); store.flush(); await rm(root, { recursive: true, force: true }); }
});

it('passes the trusted single toolchain to implementation without leaking arbitrary host environment or choosing between modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-agent-toolchain-'));
  try {
    const { realpath } = await import('node:fs/promises');
    const data = join(root, '.ai/cezar'); await mkdir(join(data, 'runs', 'run'), { recursive: true });
    const javaHome = join(root, 'jdk8');
    const record = { schemaVersion: 1, runId: 'run', root: await realpath(root), plan: JSON.stringify({ toolchains: [{ execution: { javaHome, pathEntries: [] } }] }) };
    await writeFile(runFilePath(data, 'run', '.unattended.json'), JSON.stringify(record));
    const env = await unattendedToolchainEnv(data, 'run', root, { JAVA_HOME: 'wrong', PATH: 'existing-path', CEZ_TASK_ID: 'run' });
    expect(env.JAVA_HOME).toBe(javaHome);
    expect(env.PATH).toContain(join(javaHome, 'bin'));
    expect(Object.keys(env).sort()).toEqual(['CEZ_TASK_ID', 'JAVA_HOME', 'PATH']);
    record.plan = JSON.stringify({ toolchains: [{ execution: { javaHome } }, { execution: { javaHome: join(root, 'jdk11') } }] });
    await writeFile(runFilePath(data, 'run', '.unattended.json'), JSON.stringify(record));
    expect(await unattendedToolchainEnv(data, 'run', root, { PATH: 'unchanged' })).toEqual({ PATH: 'unchanged' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('initializes before launch, supplies the thirty-minute limit, and refuses unsupported backends', async () => {
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
    await mkdir(join(dataDir, 'runs', 'probe-run'), { recursive: true });
    await writeFile(runFilePath(dataDir, 'probe-run', '.superpowers.json'), JSON.stringify({ schemaVersion: 1, ref: snapshot.ref }));
    const launch = await prepareUnattendedProbe(dataDir, 'probe-run', cwd, 'claude', false, '/cezar:project-probe Work on tracker ticket [story:123]: 【sales】 Sale Control Thread Pool');
    expect(launch.policy).toEqual({ root: cwd, runId: 'probe-run' });
    expect(artifactPaths(cwd, 'probe-run', join(dataDir, 'runs/probe-run')).topic).toBe('sale-control-thread-pool');
    expect(launch.timeoutMs).toBe(PROBE_TIMEOUT_MS);
    expect(launch.timeoutMs).toBe(1_800_000);
    expect(launch.instructions).toContain('probe-policy.mjs');
    expect(launch.instructions).toContain(runFilePath(dataDir, 'probe-run', '.handoff.md'));
    expect(launch.instructions).toContain('无需查询环境变量');
    expect(launch.instructions).toContain('不执行编译、测试、安装或源码修改');
    expect(launch.instructions).toContain('相互独立的读取与搜索可并行');
    expect(launch.instructions).not.toContain('每批最多三项');
    expect(launch.instructions).not.toContain('validation-plan.json');
    expect(launch.instructions).not.toContain('execution-input.json');
    expect(launch.instructions).not.toContain('CEZ:DONE');
    expect(launch.instructions).not.toContain('{{');
    expect(launch.instructions).toContain('执行已加载的 cezar:project-probe');
    expect(launch.instructions).toContain('CEZ_HANDOFF_FILE');
    expect(launch.instructions).not.toContain('request.md');
    const { readFile } = await import('node:fs/promises');
    expect(JSON.parse(await readFile(artifactPaths(cwd, 'probe-run', join(dataDir, 'runs/probe-run')).file('run.json'), 'utf8')).runId).toBe('probe-run');
    await expect(prepareUnattendedProbe(dataDir, 'probe-run', cwd, 'codex')).rejects.toThrow('cannot enforce');
    expect(() => assertProbeSupport('opencode', { root: cwd, runId: 'probe-run' })).toThrow('cannot enforce');
    expect(() => assertProbeSupport('codex', undefined)).not.toThrow();
    await expect(prepareUnattendedProbe(dataDir, 'another-run', cwd, 'claude')).rejects.toThrow();
    // A copied host-action template needs no vendor snapshot to initialize discovery.
    const hostLaunch = await prepareUnattendedProbe(dataDir, 'host-only', cwd, 'claude', true);
    expect(hostLaunch.instructions).toContain('任务身份：读取');
    expect(JSON.parse(await readFile(artifactPaths(cwd, 'host-only', join(dataDir, 'runs/host-only')).file('run.json'), 'utf8')).runId).toBe('host-only');

    // Real RunManager Continue path must carry the boundary and timeout to the runner.
    const store = RunStore.open(join(cwd, '.ai/cezar'));
    const manager = new RunManager(store, cwd);
    try {
      const workflow = unattendedWorkflows(snapshot.root)[0]!;
      const run = store.createRun({ title: 'Probe recovery', workflow: workflow.name, task: 'Locate relevant Java files', steps: workflow.steps.map(step => ({ id: step.id, name: step.id, kind: step.command ? 'check' : 'agent' })) });
      // Remove the manually initialized identity; the host must create this run's own context.
      await rm(join(cwd, 'docs/superpowers'), { recursive: true });
      store.updateRun(run.id, { titleSummary: 'adding audience package fallback', status: 'failed', worktree: false, workflowDef: workflow, graphState: { cursor: 'probe', taken: [], loops: {} } });
      await mkdir(join(cwd, '.ai/cezar/runs', run.id), { recursive: true });
      await writeFile(runFilePath(join(cwd, '.ai/cezar'), run.id, '.superpowers.json'), JSON.stringify({ schemaVersion: 1, ref: snapshot.ref }));
      vi.spyOn(manager as unknown as { agentEnvForStep: () => Promise<{ env: Record<string, string>; profileId: string }> }, 'agentEnvForStep').mockResolvedValue({ env: {}, profileId: 'fixture' });
      captures.specs = [];
      expect(manager.continueRun(run.id, { text: 'Resume discovery only.' })).toEqual({ ok: true });
      await expect.poll(() => captures.specs.length > 0, { timeout: 15_000 }).toBe(true);
      expect(captures.specs[0]?.probePolicy).toEqual({ root: cwd, runId: run.id });
      expect(captures.specs[0]?.timeoutMs).toBe(1_800_000);
      expect(captures.specs[0]?.mcpServers).toBeUndefined();
      expect(captures.specs[0]?.userPrompt).toContain('原始需求：使用 Read 读取交接文件');
      expect(captures.specs[0]?.userPrompt).toContain('Resume discovery only.');
      expect(captures.specs[0]?.userPrompt).not.toContain('chain of');
      expect(captures.specs[0]?.userPrompt).not.toContain('CEZ:DONE');
      expect(captures.specs[0]?.userPrompt).not.toContain('validation-plan.json');
      expect(artifactPaths(cwd, run.id).topic).toBe('adding-audience-package-fallback');
      await expect.poll(() => store.getRun(run.id)?.status, { timeout: 15_000 }).toBe('failed');
      expect(captures.specs.filter(spec => spec.probePolicy)).toHaveLength(1);
    } finally { manager.dispose(); store.flush(); }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 60_000);


it.each([false, true])('passes an explicit agent timeout on launch (Continue=%s)', async continuation => {
  const root = await mkdtemp(join(tmpdir(), 'cez-agent-deadline-'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  try {
    captures.specs = [];
    vi.spyOn(manager as unknown as { agentEnvForStep: () => Promise<{ env: Record<string, string>; profileId: string }> }, 'agentEnvForStep').mockResolvedValue({ env: {}, profileId: 'fixture' });
    const workflow = { name: 'deadline-test', source: 'file' as const, steps: [{ id: 'implement', prompt: 'Implement existing plan', timeoutMs: 90 * 60_000 }] };
    const run = continuation
      ? store.createRun({ title: 'Continue deadline', workflow: workflow.name, task: 'test', steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }] })
      : manager.startRun(workflow, { task: 'test', worktree: false });
    if (continuation) {
      store.updateStep(run.id, 'implement', { sessionId: 'existing-session', backend: 'claude', status: 'failed' });
      store.updateRun(run.id, { status: 'failed', worktree: false, workflowDef: workflow });
      expect(manager.continueRun(run.id, { text: 'Resume unfinished work.' })).toEqual({ ok: true });
    }
    await expect.poll(() => captures.specs.length, { timeout: 15_000 }).toBe(1);
    expect(captures.specs[0]?.timeoutMs).toBe(90 * 60_000);
    await expect.poll(() => ['done', 'review', 'failed'].includes(store.getRun(run.id)?.status ?? ''), { timeout: 15_000 }).toBe(true);
  } finally { manager.dispose(); store.flush(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 30_000);

it.each([
  { repaired: true, baseline: false }, { repaired: false, baseline: false },
  { repaired: true, baseline: true }, { repaired: false, baseline: true },
])('validates probe before baseline and resumes once for repair ($repaired, baseline recovery=$baseline)', async ({ repaired, baseline }) => {
  const root = await mkdtemp(join(tmpdir(), 'cez-probe-handoff-'));
  let manager: RunManager | undefined;
  let store: RunStore | undefined;
  try {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    git('init');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
    git('worktree', 'add', 'task', '-b', 'probe-handoff');
    const cwd = join(root, 'task'), data = join(cwd, '.ai/cezar');
    await writeFile(join(cwd, 'README.md'), 'Build fixture');
    const snapshot = await ensureBundleSnapshot();
    const workflow = unattendedWorkflows(snapshot.root)[0]!;
    store = RunStore.open(data);
    manager = new RunManager(store, cwd);
    const run = store.createRun({ title: 'Probe handoff', workflow: workflow.name, task: 'Investigate fixture', steps: workflow.steps.map(step => ({ id: step.id, name: step.id, kind: step.command ? 'check' : 'agent' })) });
    store.updateRun(run.id, { status: 'failed', worktree: false, workflowDef: workflow, graphState: { cursor: baseline ? 'baseline' : 'probe', taken: [], loops: { 'final-retry': 1 } } });
    await mkdir(join(data, 'runs', run.id), { recursive: true });
    await writeFile(runFilePath(data, run.id, '.superpowers.json'), JSON.stringify({ schemaVersion: 1, ref: snapshot.ref }));
    vi.spyOn(manager as unknown as { agentEnvForStep: () => Promise<{ env: Record<string, string>; profileId: string }> }, 'agentEnvForStep').mockResolvedValue({ env: {}, profileId: 'fixture' });
    const checks: string[] = [];
    vi.spyOn(manager as unknown as { runCheckStep: (...args: unknown[]) => Promise<{ ok: boolean; output: string; exitCode: number }> }, 'runCheckStep').mockImplementation(async (...args) => {
      checks.push((args[2] as { id: string }).id);
      return { ok: false, output: 'fixture stop', exitCode: 1 };
    });
    captures.specs = [];
    captures.onLaunch = spec => {
      if (!spec.probePolicy) return 'CEZ:VERDICT blocked';
      const probes = captures.specs.filter(item => item.probePolicy);
      const paths = artifactPaths(cwd, run.id, join(data, 'runs', run.id));
      const command = { file: 'npm', args: ['test'], cwd: '.', source: 'README.md', kind: 'test', toolchain: 'fixture-toolchain' };
      writeFileSync(paths.file('environment.json'), JSON.stringify({ schemaVersion: 1,
        toolchains: [{ name: 'fixture-toolchain', targetVersion: null, buildVersion: null, runtimeVersion: null, sources: ['README.md'], ...(repaired && probes.length === (baseline ? 1 : 2) ? { execution: {} } : {}) }],
        environmentChecks: [{ ...command, args: ['--version'], kind: 'check', expectedOutput: ['fixture'] }], baseline: [command], verify: [command] }));
      writeFileSync(paths.file('probe.md'), 'Located fixture build');
      writeFileSync(paths.file('context-map.jsonl'), JSON.stringify({ schemaVersion: 1, stage: 'probe', path: 'README.md', summary: 'Build', relevance: 'Validation', symbols: [], dependsOn: [], confidence: 'high' }));
      writeFileSync(paths.file('routing-input.json'), JSON.stringify({ likelyChangeFiles: [], highRisk: false, crossModule: false, requirementsClear: true }));
      return 'CEZ:VERDICT ready';
    };
    if (baseline) {
      await prepareUnattendedProbe(data, run.id, cwd, 'claude', true);
      const paths = artifactPaths(cwd, run.id, join(data, 'runs', run.id));
      const command = { file: 'npm', args: ['test'], cwd: '.', source: 'README.md', kind: 'test', toolchain: 'fixture-toolchain' };
      await writeFile(paths.file('environment.json'), JSON.stringify({ schemaVersion: 1,
        toolchains: [{ name: 'fixture-toolchain', targetVersion: null, buildVersion: null, runtimeVersion: null, sources: ['README.md'] }],
        environmentChecks: [{ ...command, args: ['--version'], kind: 'check', expectedOutput: ['fixture'] }], baseline: [command], verify: [command] }));
      store.updateStep(run.id, 'probe', { sessionId: 'original-probe-session', backend: 'claude', profileId: 'fixture', status: 'done' });
    }
    expect(manager.continueRun(run.id, { text: 'Resume probe.' })).toEqual({ ok: true });
    await expect.poll(() => store!.getRun(run.id)?.status, { timeout: 60_000 }).toBe('failed');
    const probes = captures.specs.filter(spec => spec.probePolicy);
    expect(probes).toHaveLength(baseline ? 1 : 2);
    const repair = probes.at(-1)!;
    expect(repair.resume).toBe(true);
    expect(repair.sessionId).toBe(baseline ? 'original-probe-session' : probes[0]?.sessionId);
    expect(repair.probePolicy).toEqual({ root: cwd, runId: run.id });
    expect(repair.userPrompt).toContain('宿主环境交接校验失败');
    expect(repair.userPrompt).toContain('fixture-toolchain');
    expect(checks.includes('baseline')).toBe(repaired);
    expect(store.getRun(run.id)?.graphState?.outputs?.probe?.verdict).toBe(repaired ? 'ready' : 'blocked');
    expect(store.getRun(run.id)?.graphState?.loops['final-retry']).toBe(1);
  } finally {
    captures.onLaunch = undefined;
    manager?.dispose(); store?.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 90_000);
