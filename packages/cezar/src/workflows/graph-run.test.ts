import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import { loadWorkflows } from './load.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (process.platform === 'win32' && typeof args[0] === 'string' && args[0].endsWith('.mjs')) {
        return actual.spawn(process.execPath, [args[0], ...(Array.isArray(args[1]) ? args[1] : [])], args[2]);
      }
      // These fixtures use POSIX commands. Windows' bash alias can resolve to WSL,
      // whose cwd/mount namespace is different from this native test repository.
      if (process.platform === 'win32' && args[0] === 'bash') {
        return actual.spawn(join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe'), Array.isArray(args[1]) ? args[1] : [], args[2]);
      }
      return actual.spawn(...args);
    },
  };
});

/**
 * Graph workflows end to end (spec 2026-09-30-workflow-node-editor, phase 1): a real
 * RunManager, the bundled mock agent (`CEZ_DRY_RUN=1`), real check commands.
 */
describe('graph workflows run through RunManager', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let savedDryRun: string | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-graph-run-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    await rm(repoRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function settle(id: string) {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 60_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    return store.getRun(id)!;
  }

  function def(graph: WorkflowGraph): WorkflowDef {
    return { name: 'graph', source: 'file', steps: graphToSteps(graph), graph };
  }

  // `tests` fails on its first run only. `log` records rendered node refs to a file — the mock
  // agent truncates prompts, so a check command is where the rendering is observable.
  const LOOPING: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'implement', type: 'agent', prompt: '{{task}}' },
      { id: 'tests', type: 'check', command: 'test -f .attempted || { touch .attempted; echo BOOM-OUTPUT; exit 1; }' },
      { id: 'retry', type: 'loop', max: 2 },
      { id: 'fix', type: 'agent', prompt: 'fix attempt {{nodes.retry.iteration}} after {{nodes.tests.output}}' },
      { id: 'log', type: 'check', command: 'echo "{{nodes.retry.iteration}}/{{nodes.retry.max}} exit={{nodes.tests.exitCode}}" >> refs.txt' },
      { id: 'ok', type: 'end', status: 'success' },
      { id: 'gave-up', type: 'end', status: 'failed' },
    ],
    edges: [
      { from: 'start', to: 'implement' },
      { from: 'implement', to: 'tests' },
      { from: 'tests.pass', to: 'ok' },
      { from: 'tests.fail', to: 'retry' },
      { from: 'retry.repeat', to: 'fix' },
      { from: 'retry.exhausted', to: 'gave-up' },
      { from: 'fix', to: 'log' },
      { from: 'log', to: 'tests' },
    ],
  };

  it('loops back through the loop node, renders node refs, and ends at the success end', async () => {
    const record = manager.startRun(def(LOOPING), { task: 'build the thing', worktree: false });
    const final = await settle(record.id);

    expect(final.status).not.toBe('failed');
    expect(final.steps.map((s) => [s.id, s.status, s.iterations])).toEqual([
      ['implement', 'done', 1],
      ['tests', 'done', 2],
      ['fix', 'done', 1],
      ['log', 'done', 1],
    ]);
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    expect(notes).toHaveLength(2);
    expect(readFileSync(join(repoRoot, 'refs.txt'), 'utf8')).toBe('1/2 exit=1\n');
    // Phase 3: the walk is on the record for the live graph.
    expect(final.graphState).toMatchObject({
      loops: { retry: 1 },
      taken: [
        'start.next->implement',
        'implement.done->tests',
        'tests.fail->retry',
        'retry.repeat->fix',
        'fix.done->log',
        'log.pass->tests',
        'tests.pass->ok',
      ],
    });
  }, 90_000);

  it('fails the run when the loop is exhausted', async () => {
    const graph: WorkflowGraph = {
      ...LOOPING,
      nodes: LOOPING.nodes.map((n) => (n.id === 'tests' ? { id: 'tests', type: 'check', command: 'exit 1' } : n)),
    };
    const final = await settle(manager.startRun(def(graph), { task: 'never passes', worktree: false }).id);
    expect(final.status).toBe('failed');
    expect(final.error).toBe('workflow ended at "gave-up"');
    expect(final.steps.find((s) => s.id === 'tests')?.iterations).toBe(3);
    expect(final.steps.find((s) => s.id === 'fix')?.iterations).toBe(2);
  }, 90_000);

  const REVIEW_FLOW = (reviewPrompt: string): WorkflowGraph => ({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'implement', type: 'agent', prompt: '{{task}}' },
      { id: 'review', type: 'agent', prompt: reviewPrompt, verdicts: ['approve', 'changes'] },
      { id: 'fix', type: 'agent', prompt: 'address review', session: { continue: 'implement' } },
      { id: 'mark', type: 'check', command: 'echo "{{nodes.review.verdict}}" >> verdicts.txt' },
      { id: 'ok', type: 'end', status: 'success' },
    ],
    edges: [
      { from: 'start', to: 'implement' },
      { from: 'implement', to: 'review' },
      { from: 'review.approve', to: 'mark' },
      { from: 'review.changes', to: 'fix' },
      { from: 'fix', to: 'mark' },
      { from: 'mark', to: 'ok' },
    ],
  });

  it('branches on the verdict the agent ends its turn with', async () => {
    const final = await settle(
      manager.startRun(def(REVIEW_FLOW('review it mock:verdict=approve')), { task: 'x', worktree: false }).id,
    );
    expect(final.status).not.toBe('failed');
    expect(final.steps.map((s) => [s.id, s.status])).toEqual([
      ['implement', 'done'],
      ['review', 'done'],
      ['mark', 'done'],
      ['fix', 'pending'],
    ]);
    expect(readFileSync(join(repoRoot, 'verdicts.txt'), 'utf8')).toBe('approve\n');
  }, 90_000);

  it('continues a missing verdict in place, and session.continue resumes the named node', async () => {
    const argsFile = join(repoRoot, 'mock-args.ndjson');
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    try {
      // No `mock:verdict=` → the first turn has no marker; the nudge is answered with the first
      // listed verdict, `approve`… so to reach `fix` the order is swapped in this graph.
      const graph = REVIEW_FLOW('review it');
      const review = graph.nodes.find((n) => n.id === 'review');
      if (review?.type === 'agent') review.verdicts = ['changes', 'approve'];
      const final = await settle(manager.startRun(def(graph), { task: 'x', worktree: false }).id);
      expect(final.status, final.error).not.toBe('failed');
      expect(readFileSync(join(repoRoot, 'verdicts.txt'), 'utf8')).toBe('changes\n');
      const byId = new Map(final.steps.map((s) => [s.id, s]));
      expect(byId.get('fix')?.status).toBe('done');
      // `fix` reopened implement's session rather than minting its own.
      expect(byId.get('fix')?.sessionId).toBe(byId.get('implement')?.sessionId);
      const spawns = readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
      const resumed = spawns.filter((a) => a.includes('--resume')).map((a) => a[a.indexOf('--resume') + 1]);
      // Verdict recovery keeps the review process alive; only fix needs a resume.
      expect(resumed).toEqual([byId.get('implement')?.sessionId]);
    } finally {
      delete process.env.CEZ_MOCK_ARGS_FILE;
    }
  }, 90_000);

  it('keeps background work alive through an empty turn until its result is collected', async () => {
    const argsFile = join(repoRoot, 'mock-args.ndjson');
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    try {
      const final = await settle(manager.startRun(def(REVIEW_FLOW('mock:background-verdict')), { task: 'x', worktree: false }).id);
      expect(final.status).not.toBe('failed');
      expect(final.graphState?.outputs?.review).toMatchObject({ verdict: 'approve', summary: 'Background tests finished with exit code 0.' });
      const spawns = readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]);
      expect(spawns.some(args => args.includes('--resume'))).toBe(false);
    } finally {
      delete process.env.CEZ_MOCK_ARGS_FILE;
    }
  }, 90_000);

  it('fails consecutive empty turns explicitly and preserves the last useful evidence', async () => {
    const final = await settle(manager.startRun(def(REVIEW_FLOW('mock:empty-verdict')), { task: 'x', worktree: false }).id);
    expect(final.status).toBe('failed');
    expect(final.steps.find(step => step.id === 'review')?.error).toContain('two consecutive empty turns');
    expect(final.graphState?.outputs?.review).toMatchObject({ verdict: '', summary: 'Background test outcome is unknown.' });
  }, 90_000);

  it('rejects an early success verdict while a reported background task has no collected result', async () => {
    const final = await settle(manager.startRun(def(REVIEW_FLOW('mock:pending-verdict')), { task: 'x', worktree: false }).id);
    expect(final.status, final.error).not.toBe('failed');
    expect(final.graphState?.outputs?.review).toMatchObject({ verdict: 'approve', summary: 'Collected background test exit code 0.' });
    expect(final.steps.find(step => step.id === 'review')?.pendingBackgroundTaskIds).toEqual([]);
  }, 90_000);

  it('accepts foreground test results without requiring TaskOutput for a progress id', async () => {
    const final = await settle(manager.startRun(def(REVIEW_FLOW('mock:foreground-task')), { task: 'x', worktree: false }).id);
    expect(final.status, final.error).not.toBe('failed');
    expect(final.graphState?.outputs?.review).toMatchObject({ verdict: 'approve', summary: 'Foreground test results collected.' });
    expect(final.steps.find(step => step.id === 'review')?.pendingBackgroundTaskIds ?? []).toEqual([]);
  }, 90_000);

  it('collects pending background results instead of parking on MONITORING', async () => {
    const graph = REVIEW_FLOW('mock:pending-verdict mock:monitoring');
    const review = graph.nodes.find(node => node.id === 'review');
    if (review?.type === 'agent') review.timeoutMs = 5000;
    const final = await settle(manager.startRun(def(graph), { task: 'x', worktree: false }).id);
    expect(final.status, final.error).not.toBe('failed');
    expect(final.graphState?.outputs?.review).toMatchObject({ verdict: 'approve', summary: 'Collected background test exit code 0.' });
    expect(final.steps.find(step => step.id === 'review')?.pendingBackgroundTaskIds).toEqual([]);
  }, 90_000);

  it('preserves passive monitoring when no native background result is pending', async () => {
    const record = manager.startRun(def(REVIEW_FLOW('mock:monitoring')), { task: 'x', worktree: false });
    try {
      await expect.poll(() => store.getRun(record.id)?.activity, { timeout: 30_000 }).toBe('monitoring');
      expect(store.getRun(record.id)?.steps.find(step => step.id === 'mark')?.status).toBe('pending');
      expect(store.readEvents(record.id).some(event => event.type === 'note' && String(event.message).includes('continuing unfinished node'))).toBe(false);
    } finally { manager.cancel(record.id); }
    await settle(record.id);
  }, 90_000);

  it('retains recorded background work across durable state reload and a new CLI process', async () => {
    const record = manager.startRun(def(REVIEW_FLOW('mock:recovered-verdict')), { task: 'x', worktree: false });
    store.updateStep(record.id, 'review', { pendingBackgroundTaskIds: ['mock-bg'] });
    store.flush();
    const reloaded = RunStore.open(join(repoRoot, '.ai/cezar'));
    expect(reloaded.getRun(record.id)?.steps.find(step => step.id === 'review')?.pendingBackgroundTaskIds).toEqual(['mock-bg']);
    const final = await settle(record.id);
    expect(final.status, final.error).not.toBe('failed');
    expect(final.graphState?.outputs?.review?.summary).toBe('Collected background test exit code 0.');
  }, 90_000);

  it('keeps the original timeout across missing-verdict continuations', async () => {
    const graph = REVIEW_FLOW('mock:verdict-timeout');
    const review = graph.nodes.find(node => node.id === 'review');
    if (review?.type === 'agent') review.timeoutMs = 1500;
    const final = await settle(manager.startRun(def(graph), { task: 'x', worktree: false }).id);
    expect(final.status).toBe('failed');
    expect(final.steps.find(step => step.id === 'review')?.error).toContain('timed out');
    expect(final.graphState?.outputs?.review?.verdict).toBe('');
  }, 90_000);

  it('bounds nonempty turns that never hand off a verdict', async () => {
    const final = await settle(manager.startRun(def(REVIEW_FLOW('mock:unmarked-verdict')), { task: 'x', worktree: false }).id);
    expect(final.status).toBe('failed');
    expect(final.steps.find(step => step.id === 'review')?.error).toContain('in-session continuations');
    expect(final.graphState?.outputs?.review?.verdict).toBe('');
  }, 90_000);

  it('cancels a node while it is collecting unfinished work', async () => {
    const record = manager.startRun(def(REVIEW_FLOW('mock:empty-verdict')), { task: 'x', worktree: false });
    const deadline = Date.now() + 15_000;
    while ((store.getRun(record.id)?.steps.find(step => step.id === 'review')?.usageTurnsStarted ?? 0) < 2) {
      if (Date.now() > deadline) throw new Error('node did not continue in the live session');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(manager.cancel(record.id)).toBe(true);
    const final = await settle(record.id);
    expect(final.status).toBe('cancelled');
    expect(final.steps.find(step => step.id === 'mark')?.status).toBe('pending');
  }, 90_000);

  it('loads a version: 2 file from .ai/cezar/workflows beside v1 files', async () => {
    const dir = join(repoRoot, '.ai/cezar/workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'graph.yaml'),
      [
        'version: 2',
        'name: graph-flow',
        'nodes:',
        '  - { id: start, type: start }',
        '  - { id: work, type: agent, prompt: "{{task}}" }',
        '  - { id: verify, type: check, command: "true" }',
        'edges:',
        '  - { from: start, to: work }',
        '  - { from: work.done, to: verify }',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'broken.yaml'), 'version: 2\nname: broken\nnodes:\n  - { id: a, type: agent }\nedges: []\n');
    const { workflows, issues } = await loadWorkflows(repoRoot);
    const graph = workflows.find((w) => w.name === 'graph-flow');
    expect(graph?.steps.map((s) => s.id)).toEqual(['work', 'verify']);
    expect(graph?.graph?.nodes).toHaveLength(3);
    expect(issues.map((i) => i.message).join()).toMatch(/exactly one start node/);
    expect(workflows.some((w) => w.name === 'quick-task')).toBe(true);
  });
});
