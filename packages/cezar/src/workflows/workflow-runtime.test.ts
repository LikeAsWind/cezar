import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { UNATTENDED_TEMPLATE } from './templates/unattended.ts';
import { graphIssues, type WorkflowGraph } from './graph.ts';
import { workflowRuntimeFor, workflowExecutionView } from './workflow-runtime.ts';
import { IMPLEMENT_AND_VERIFY, IMPLEMENT_REVIEW_PR, FIX_CI, REVIEW_COUNCIL } from './templates.ts';
import { withEnvironmentRecovery } from './unattended-environment.ts';
import { bindWorkflowActions } from './workflow-actions.ts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../runs/store.ts';
import { newArtifactPaths } from '../../scripts/workflow/artifacts.mjs';
import { realpath } from 'node:fs/promises';
import { workflowGraphNodeSchema } from '@open-mercato/cezar-contract';
import { unattendedArtifactStage } from './unattended-roles.ts';
import { unattendedContext } from './unattended-probe.ts';

function renamed(graph: WorkflowGraph): WorkflowGraph {
  const names: Record<string, string> = { probe: 'discover', baseline: 'build-baseline', design: 'architecture', plan: 'write-plan', adjudicator: 'decision', verify: 'test-all', review: 'audit', 'blocked-report': 'stop-report', 'validation-scope': 'coverage',
    'environment-check': 'check-tools', 'probe-retry': 'tool-round', 'probe-repair': 'repair-tools',
    'execute-fast': 'implement-small', 'execute-standard': 'implement-medium', 'execute-deep-native': 'implement-complex', 'execute-deep': 'implement-sdd' };
  const id = (value: string) => names[value] ?? value;
  const from = (value: string) => { const [node, ...port] = value.split('.'); return [id(node!), ...port].join('.'); };
  return { nodes: graph.nodes.map(node => ({ ...node, id: id(node.id),
    ...(node.type === 'agent' && node.session ? { session: { continue: id(node.session.continue) } } : {}),
    ...(node.type === 'if' && node.condition.kind === 'output' ? { condition: { ...node.condition, ref: from(node.condition.ref) } } : {}),
  })), edges: graph.edges.map(edge => ({ from: from(edge.from), to: id(edge.to) })) };
}

it('uses declared roles and graph edges for renamed callers, artifacts and recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-renamed-runtime-'));
  const data = join(root, '.ai/cezar');
  try {
    const graph = renamed(UNATTENDED_TEMPLATE);
    const runtime = workflowRuntimeFor(data, 'run', graph)!;
    expect(runtime.returningCaller('architecture', ['decision.answered->architecture'])).toBe(true);
    expect(runtime.resumeInstructions('architecture', ['ready', 'question']).suffix).toContain('builder check');
    expect(runtime.recoveryPoint({ loops: {}, taken: ['audit.blocked->stop-report'] })).toBe('test-all');
    expect(runtime.recoveryPoint({ loops: {}, taken: ['write-plan.question->clarification-round', 'decision.blocked->stop-report'] })).toBe('write-plan');
    expect(runtime.recoveryPoint({ cursor: 'build-baseline', loops: {}, taken: [] })).toBe('check-tools');
    expect(runtime.recoveryPoint({ loops: { 'tool-round': 1 }, taken: ['tool-round.exhausted->stop-report'] })).toBe('check-tools');
    for (const [id, stage] of [['implement-small', 'execute-fast'], ['implement-medium', 'execute-standard'], ['implement-complex', 'execute-deep-native'], ['implement-sdd', 'execute-deep'], ['audit', 'review'], ['write-plan', 'plan']]) {
      expect(unattendedArtifactStage(graph, id!)).toBe(stage);
    }
    const paths = newArtifactPaths(root, 'run', new Date(), 'renamed', join(data, 'runs/run'));
    await mkdir(join(data, 'runs/run'), { recursive: true });
    await writeFile(paths.file('run.json'), JSON.stringify({ runId: 'run', root: await realpath(root), artifactPrefix: paths.prefix }));
    const launch = await runtime.prepareAgent({ cwd: root, step: { id: 'architecture', skill: 'superpowers:brainstorming' }, backend: 'claude',
      run: undefined, events: [], prompt: 'Design', env: {}, treeBlocks: [], resuming: true, returningCaller: false });
    expect(launch.prompt).toContain('-design.md');
    expect(launch.prompt).toContain('-probe.md');
    await writeFile(join(data, 'runs/run/unattended-question.json'), JSON.stringify({ q: 'Q-001', origin: 'architecture', answered: true,
      history: [{ q: 'Q-001', origin: 'architecture', text: 'Question', answer: 'EXISTING_ARCHITECTURE_ANSWER', status: 'answered' }] }));
    const context = await unattendedContext(root, 'run', { steps: [], graphState: { loops: {}, taken: [], outputs: { architecture: { summary: 'CURRENT_ARCHITECTURE_CHECKPOINT' } } } }, 'design', data, true, [], 'architecture');
    expect(context).toContain('CURRENT_ARCHITECTURE_CHECKPOINT');
    expect(context).toContain('EXISTING_ARCHITECTURE_ANSWER');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps template identities and hidden environment repair out of the shared engine', async () => {
  const source = await readFile(new URL('./run.ts', import.meta.url), 'utf8');
  expect(/from ['"].*unattended|cezar:project-probe|cezar:adjudicator|guardProbeEnvironment|probeRepair|managedUnattended/.test(source)).toBe(false);
  const policy = await readFile(new URL('./unattended-runtime.ts', import.meta.url), 'utf8');
  expect(/from ['"].*\/run\.ts|runAgentStep|startSession|createRunner/.test(policy)).toBe(false);
});

it('keeps every unattended node within the shared contract and explicitly wires agent verdicts and failures', () => {
  const graph = UNATTENDED_TEMPLATE;
  for (const node of graph.nodes) {
    expect(workflowGraphNodeSchema.safeParse(node).success, node.id).toBe(true);
    const ports = node.type === 'agent' ? [...node.verdicts ?? [], 'failed'] : node.type === 'check' ? ['pass', 'fail'] : [];
    for (const port of ports) expect(graph.edges.some(edge => edge.from === `${node.id}.${port}`), `${node.id}.${port}`).toBe(true);
  }
});

it('leaves other built-in workflows on the ordinary graph engine', () => {
  for (const workflow of [IMPLEMENT_AND_VERIFY, IMPLEMENT_REVIEW_PR, FIX_CI, REVIEW_COUNCIL]) {
    expect(workflowRuntimeFor('unused', 'run', workflow.graph)).toBeUndefined();
  }
});

it('derives a visible recovery graph without changing the pinned definition or replenishing budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-workflow-runtime-'));
  const data = join(root, '.ai/cezar');
  const store = RunStore.open(data);
  try {
    const newIds = new Set(['environment-check', 'probe-retry', 'probe-repair']);
    const legacy = { nodes: UNATTENDED_TEMPLATE.nodes.filter(node => !newIds.has(node.id)),
      edges: [...UNATTENDED_TEMPLATE.edges.filter(edge => !newIds.has(edge.from.split('.')[0]!) && !newIds.has(edge.to)), { from: 'probe.ready', to: 'baseline' }] };
    const original = JSON.stringify(legacy);
    const mixedBackend = structuredClone(legacy);
    const probe = mixedBackend.nodes.find(node => node.id === 'probe')!;
    if (probe.type === 'agent') { probe.runner = 'claude'; probe.model = 'sonnet'; }
    expect(withEnvironmentRecovery(mixedBackend).nodes.find(node => node.id === 'probe-repair')).toMatchObject({ runner: 'claude', model: 'sonnet' });
    const runtime = workflowRuntimeFor(data, 'run', legacy)!;
    const expected = structuredClone(withEnvironmentRecovery(legacy));
    bindWorkflowActions(expected.nodes);
    expect(runtime.executionGraph()).toEqual(expected);
    expect(graphIssues(runtime.executionGraph())).toEqual([]);
    expect(runtime.recoveryPoint({ cursor: 'baseline', loops: {}, taken: [] })).toBe('environment-check');
    expect(runtime.recoveryPoint({ loops: { 'probe-retry': 1 }, taken: ['probe-retry.exhausted->blocked-report'] })).toBe('environment-check');
    expect(runtime.recoveryPoint({ loops: {}, taken: ['probe-retry.exhausted->blocked-report', 'review.blocked->blocked-report'] })).toBe('verify');
    await mkdir(join(data, 'runs/run'), { recursive: true });
    await writeFile(join(data, 'runs/run/probe-environment-repair.json'), '{}');
    expect(runtime.recoveryLoops({ 'final-retry': 2 })).toEqual({ 'final-retry': 2, 'probe-retry': 1 });
    expect(runtime.recoveryLoops({ 'probe-retry': 2 })).toEqual({ 'probe-retry': 2 });
    const run = store.createRun({ title: 'Pinned', task: 'Task', workflow: 'unattended', steps: [] });
    store.updateRun(run.id, { workflowDef: { name: 'unattended', source: 'built-in', graph: legacy, steps: [] } });
    const pinned = store.getRun(run.id)!;
    expect(workflowExecutionView(data, pinned)).toBe(pinned);
    store.addStep(run.id, { id: 'environment-check', name: 'Validation', kind: 'check' });
    const view = workflowExecutionView(data, pinned);
    expect(view.workflowDef?.graph?.nodes.some(node => node.id === 'environment-check')).toBe(true);
    expect(JSON.stringify(pinned.workflowDef?.graph)).toBe(original);
    expect(JSON.stringify(legacy)).toBe(original);
  } finally { store.flush(); await rm(root, { recursive: true, force: true }); }
});

it('expresses validation and bounded repair as ordinary graph nodes', () => {
  const graph = UNATTENDED_TEMPLATE;
  expect(graphIssues(graph)).toEqual([]);
  expect(graph.nodes.find(node => node.id === 'environment-check')).toMatchObject({ type: 'check', command: 'cezar workflow-action environment' });
  expect(graph.nodes.find(node => node.id === 'probe-retry')).toMatchObject({ type: 'loop', max: 1 });
  expect(graph.nodes.find(node => node.id === 'probe-repair')).toMatchObject({ type: 'agent', session: { continue: 'probe' } });
  expect(graph.edges).toEqual(expect.arrayContaining([
    { from: 'probe.ready', to: 'environment-check' },
    { from: 'environment-check.pass', to: 'baseline' },
    { from: 'environment-check.fail', to: 'probe-retry' },
    { from: 'probe-retry.repeat', to: 'probe-repair' },
    { from: 'probe-repair.ready', to: 'environment-check' },
    { from: 'probe-retry.exhausted', to: 'blocked-report' },
  ]));
});
