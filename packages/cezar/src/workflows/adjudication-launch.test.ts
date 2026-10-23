import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunSpec, AgentRunResult, ContentBlock, SessionOptions } from '../core/agent-runner.ts';
import { prependSystemPrompt } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { runFilePath } from '../runs/files.ts';
import { ensureBundleSnapshot } from '../superpowers-update.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import type { WorkflowDef } from './types.ts';
import { RunManager } from './run.ts';
import { newArtifactPaths } from '../../scripts/workflow/artifacts.mjs';

const observed = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], callerTurns: 0, judgeTurns: 0, live: false, replies: [] as string[], callerCloses: [] as number[], scenario: 'answer', exitCaller: undefined as (() => void) | undefined, openSessions: new Set<string>() }));
vi.mock('./unattended-guards.ts', async original => ({ ...await original<typeof import('./unattended-guards.ts')>(), isUnattendedGraph: () => true }));
vi.mock('../core/runner-factory.ts', () => ({ createRunner: () => ({ backend: 'claude', interrupt: async () => {}, startSession(spec: AgentRunSpec, emit?: (e: AgentEvent) => void, options?: SessionOptions) {
  observed.specs.push(spec);
  const judge = !spec.userPrompt.includes('裁决结果') && spec.userPrompt.includes('返回节点：design');
  const id = spec.sessionId!;
  let open = observed.live;
  if (open) observed.openSessions.add(id);
  let text = '';
  let finish!: (r: AgentRunResult) => void;
  const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
  const end = () => { options?.onUiEvent?.({ type: 'plan.updated', entries: [] }); if (!judge && open) observed.callerCloses.push(observed.callerTurns); open = false; observed.openSessions.delete(id); finish({ text, sessionId: id, tokensUsed: 0, toolCalls: [] }); };
  if (!judge) observed.exitCaller = end;
  const turn = () => setTimeout(() => {
    const n = judge ? ++observed.judgeTurns : ++observed.callerTurns;
    const q = `Q-00${n}`;
    if (judge && ['cancel', 'caller-exit'].includes(observed.scenario)) {
      if (observed.scenario === 'caller-exit') observed.exitCaller?.();
      return;
    }
    text = judge ? `${q}\norigin: design\n裁决答复 ${n}：保留用户要求并依据当前证据处理。\nCEZ:VERDICT ${observed.scenario === 'blocked' ? 'blocked' : 'answered'}`
      : n < 3 ? `本轮状态不属于澄清问题。\n\n**${q}：本轮需要怎样验收？**\n需要确认验收要求 ${n}。\norigin: design\n证据路径：\n- docs/evidence-${n}.md\nCEZ:VERDICT question` : 'CEZ:VERDICT ready';
    emit?.({ type: 'session', sessionId: id }); emit?.({ type: 'text', text }); emit?.({ type: 'turn-end' });
    if (!observed.live) end();
  }, 0);
  turn();
  return { get open() { return open; }, interrupt: end, end, sendMessage: (blocks: ContentBlock[]) => {
    if (!open) return false;
    observed.replies.push(blocks.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n'));
    turn(); return true;
  }, result };
} }) }));

it.each([
  { backend: 'claude', live: false, scenario: 'answer' }, { backend: 'codex', live: false, scenario: 'answer' },
  { backend: 'claude', live: true, scenario: 'answer' }, { backend: 'codex', live: true, scenario: 'answer' },
  { backend: 'claude', live: true, scenario: 'blocked' }, { backend: 'claude', live: true, scenario: 'cancel' },
  { backend: 'claude', live: true, scenario: 'caller-exit' },
  { backend: 'claude', live: true, scenario: 'dispose' },
] as const)('continues or settles adjudication ($backend, live=$live, $scenario)', async ({ backend, live, scenario }) => {
  const root = await mkdtemp(join(tmpdir(), 'cez-adjudication-launch-')), data = join(root, '.ai/cezar');
  const store = RunStore.open(data);
  let manager: RunManager | undefined;
  try {
    observed.specs = []; observed.callerTurns = 0; observed.judgeTurns = 0;
    observed.live = live; observed.replies = []; observed.callerCloses = [];
    observed.scenario = scenario; observed.exitCaller = undefined; observed.openSessions.clear();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q'); await writeFile(join(root, '.gitignore'), '.ai/\ndocs/\n'); git('add', '.gitignore');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
    const snapshot = await ensureBundleSnapshot();
    const graph: WorkflowGraph = { nodes: [
      { id: 'start', type: 'start' },
      { id: 'design', type: 'agent', runner: backend, prompt: 'CALLER_INITIAL_SETUP', verdicts: ['question', 'ready'] },
      { id: 'adjudicator', type: 'agent', runner: backend, prompt: 'JUDGE_INITIAL_SETUP', skill: 'cezar:adjudicator', session: { continue: 'adjudicator' }, verdicts: ['answered', 'blocked'] },
      { id: 'done', type: 'end', status: 'success' },
      { id: 'stopped', type: 'end', status: 'failed' },
    ], edges: [{ from: 'start.next', to: 'design' }, { from: 'design.question', to: 'adjudicator' }, { from: 'adjudicator.answered', to: 'design' }, { from: 'design.ready', to: 'done' }, { from: 'adjudicator.blocked', to: 'stopped' }] };
    const workflow: WorkflowDef = { name: 'adjudication-launch', source: 'file', graph, steps: graphToSteps(graph) };
    const run = store.createRun({ title: 'Adjudication', runner: backend, task: 'Keep the original requirements', workflow: workflow.name, steps: workflow.steps.map(s => ({ id: s.id, name: s.id, kind: 'agent' })) });
    store.updateRun(run.id, { status: 'failed', worktree: false, workflowDef: workflow, graphState: { cursor: 'design', loops: {}, taken: [] } });
    await mkdir(join(data, 'runs', run.id), { recursive: true });
    await writeFile(runFilePath(data, run.id, '.superpowers.json'), JSON.stringify({ schemaVersion: 1, ref: snapshot.ref }));
    const paths = newArtifactPaths(root, run.id, new Date(), 'fixture', join(data, 'runs', run.id));
    for (const folder of ['specs', 'probe']) await mkdir(join(paths.directory, folder), { recursive: true });
    await mkdir(dirname(paths.file('run.json')), { recursive: true });
    await writeFile(paths.file('run.json'), JSON.stringify({ runId: run.id, root: await realpath(root), artifactPrefix: paths.prefix }));
    await writeFile(paths.file('design.md'), '# Existing design');
    manager = new RunManager(store, root);
    expect(manager.continueRun(run.id, { text: 'Continue with the stated requirements.' })).toEqual({ ok: true });
    if (scenario === 'dispose') {
      await expect.poll(() => observed.callerTurns, { timeout: 30_000, interval: 5 }).toBe(1);
      manager.dispose();
      const before = JSON.stringify(store.getRun(run.id));
      const beforeEvents = store.readEvents(run.id).length;
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(observed.specs).toHaveLength(1);
      expect(observed.openSessions.size).toBe(1);
      (observed.exitCaller as (() => void) | undefined)?.();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(JSON.stringify(store.getRun(run.id))).toBe(before);
      expect(store.readEvents(run.id).length).toBe(beforeEvents);
      return;
    }
    if (scenario === 'cancel') {
      await expect.poll(() => observed.specs.length, { timeout: 30_000 }).toBe(2);
      expect(store.getRun(run.id)?.steps.find(s => s.id === 'design')?.status).toBe('waiting');
      manager.cancel(run.id);
    }
    await expect.poll(() => ['done', 'review', 'failed', 'cancelled'].includes(store.getRun(run.id)?.status ?? ''), { timeout: 30_000 }).toBe(true);
    if (scenario !== 'answer') {
      expect(store.getRun(run.id)?.status).toBe(scenario === 'cancel' ? 'cancelled' : 'failed');
      await expect.poll(() => observed.openSessions.size).toBe(0);
      expect(observed.callerCloses).toEqual([1]);
      expect(observed.replies).toHaveLength(0);
      expect(store.getRun(run.id)?.steps.find(s => s.id === 'design')?.status).not.toBe('waiting');
      if (scenario === 'caller-exit') expect(store.getRun(run.id)?.steps.find(s => s.id === 'adjudicator')?.error).toContain('Caller session exited while waiting');
      return;
    }
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).not.toBe('failed');
    expect(observed.specs).toHaveLength(live ? 3 : 5);
    if (live) {
      expect(observed.replies).toHaveLength(2);
      expect(observed.replies[0]).toContain('裁决答复 1');
      expect(observed.replies[1]).toContain('裁决答复 2');
      expect(observed.replies[1]).not.toContain('裁决答复 1');
      expect(observed.callerCloses).toEqual([3]);
      expect(observed.openSessions.size).toBe(0);
      expect(store.getRun(run.id)?.graphState?.taken.filter(s => s === 'adjudicator.answered->design')).toHaveLength(2);
      return;
    }
    const [caller, firstJudge, firstReturn, secondJudge, secondReturn] = observed.specs;
    expect(firstJudge!.userPrompt).toContain('JUDGE_INITIAL_SETUP');
    expect(firstJudge!.systemPrompt).toContain('Selected skill: /cezar:adjudicator');
    expect(firstJudge!.resume).toBe(false);
    expect(secondJudge!.resume).toBe(true);
    expect(secondJudge!.sessionId).toBe(firstJudge!.sessionId);
    if (backend === 'claude') expect(secondJudge!.systemPrompt).toBe(firstJudge!.systemPrompt);
    else {
      expect(secondJudge!.systemPrompt).toBeUndefined();
      expect(prependSystemPrompt(secondJudge!.systemPrompt, secondJudge!.userPrompt)).toBe(secondJudge!.userPrompt);
      expect(firstReturn!.systemPrompt).toBeUndefined();
    }
    expect(secondJudge!.userPrompt).toContain('Q-002');
    for (const noise of ['JUDGE_INITIAL_SETUP', '共享证据', '"clarification"', '任务身份', '原始需求', '本轮状态不属于澄清问题', '裁决答复 1']) expect(secondJudge!.userPrompt).not.toContain(noise);
    expect(firstReturn!.resume).toBe(true);
    expect(firstReturn!.sessionId).toBe(caller!.sessionId);
    expect(firstReturn!.userPrompt).toContain('裁决答复 1');
    expect(firstReturn!.userPrompt).not.toContain('CALLER_INITIAL_SETUP');
    expect(secondReturn!.userPrompt).toContain('裁决答复 2');
    expect(secondReturn!.userPrompt).not.toContain('裁决答复 1');
    expect(store.getRun(run.id)?.graphState?.taken.filter(s => s === 'adjudicator.answered->design')).toHaveLength(2);
  } finally {
    if (manager) await expect.poll(() => manager!.isActive(store.listRuns()[0]!.id), { timeout: 30_000 }).toBe(false);
    manager?.dispose();
    store.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);
