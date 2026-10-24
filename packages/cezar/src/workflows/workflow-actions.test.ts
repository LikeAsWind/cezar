import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runFilePath } from '../runs/files.ts';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { WORKFLOW_ACTION_SCRIPT, workflowActionCommand, workflowActionOf } from './workflow-actions.ts';
import { unattendedWorkflows } from './superpowers-bundle.ts';
import { BUILTIN_SUPERPOWERS_BUNDLE } from '../superpowers-update.ts';
import { guardUnattendedCheck, isUnattendedGraph } from './unattended-guards.ts';
import { newArtifactPaths } from '../../scripts/workflow/artifacts.mjs';
import { loadWorkflows } from './load.ts';
import { UNATTENDED_TEMPLATE } from './templates/unattended.ts';
import { stringify } from 'yaml';

it('validates environment bindings through the real host action without running project commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-environment-action-'));
  const exec = promisify(execFile);
  try {
    const git = (...args: string[]) => exec('git', args, { cwd: root, windowsHide: true });
    await git('init');
    await writeFile(join(root, 'manifest.txt'), 'fixture validation');
    await writeFile(join(root, 'check.cjs'), "require('node:fs').writeFileSync('executed.txt', 'executed');");
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    await git('worktree', 'add', 'task', '-b', 'environment-test');
    const cwd = join(root, 'task');
    const cli = (action: string) => exec(process.execPath, [WORKFLOW_ACTION_SCRIPT, action], { cwd, windowsHide: true,
      env: { ...process.env, CEZ_RUN_ID: 'environment-run', CEZ_TASK_ID: 'environment-run', CEZ_HANDOFF_FILE: '' } });
    await cli('init');
    const { artifactPaths } = await import('../../scripts/workflow/artifacts.mjs');
    const files = artifactPaths(cwd, 'environment-run');
    const command = { file: process.execPath, args: ['check.cjs'], source: 'manifest.txt', kind: 'test', toolchain: 'selected-toolchain' };
    const tool = { name: 'selected-toolchain', targetVersion: null, buildVersion: null, runtimeVersion: null, sources: ['manifest.txt'] };
    const plan = { schemaVersion: 1, toolchains: [tool], baseline: [command], verify: [command],
      environmentChecks: [{ ...command, args: ['--version'], kind: 'check', expectedOutput: [process.versions.node] }] };
    await writeFile(files.file('environment.json'), JSON.stringify(plan));
    await expect(cli('environment')).rejects.toThrow('selected-toolchain');
    await writeFile(files.file('environment.json'), JSON.stringify({ ...plan, toolchains: [{ ...tool, execution: {} }] }));
    expect((await cli('environment')).stdout).toContain('Probe environment validated');
    await expect(readFile(join(cwd, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(files.file('baseline.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}, 30_000);

it('loads the new template using host actions without a bundle runtime dependency', () => {
  const workflow = unattendedWorkflows(BUILTIN_SUPERPOWERS_BUNDLE)[0]!;
  for (const action of ['baseline', 'route', 'execution', 'verify', 'seal', 'blocked'] as const) {
    const node = workflow.graph!.nodes.find(n => n.type === 'check' && workflowActionOf(n.command) === action);
    expect(node, action).toBeDefined();
  }
  expect(JSON.stringify(workflow)).not.toContain('runtime.mjs');
  expect(workflowActionOf(workflowActionCommand('verify') + ' && echo bypass')).toBeUndefined();
  expect(workflowActionOf('cezar workflow-action verify')).toBe('verify');
  expect(workflowActionOf('cez workflow-action baseline')).toBe('baseline');
  expect(workflowActionOf('cezar workflow-action verify && echo bypass')).toBeUndefined();
});

it('protects a copied graph with renamed nodes and no Superpowers pin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-generic-guard-'));
  try {
    const data = join(root, 'host'), cwd = join(root, 'task');
    await mkdir(join(data, 'runs'), { recursive: true });
    const paths = newArtifactPaths(cwd, 'generic', new Date(), 'task', join(data, 'runs/generic'));
    await mkdir(join(paths.directory, 'probe'), { recursive: true });
    await mkdir(join(paths.directory, 'logs'), { recursive: true });
    await mkdir(dirname(paths.file('run.json')), { recursive: true }); await writeFile(paths.file('run.json'), JSON.stringify({ runId: 'generic', root: await realpath(cwd), artifactPrefix: paths.prefix }));
    const graph = { nodes: [{ id: 'custom-validation', type: 'check' as const, command: workflowActionCommand('verify') }], edges: [] };
    expect(isUnattendedGraph(data, 'generic', graph)).toBe(true);
    await writeFile(paths.file('validation-plan.json'), '{}');
    await guardUnattendedCheck(data, 'generic', cwd, workflowActionCommand('baseline'), 'after');
    await guardUnattendedCheck(data, 'generic', cwd, workflowActionCommand('verify'), 'before');
    await writeFile(paths.file('validation-plan.json'), '{"changed":true}');
    await expect(guardUnattendedCheck(data, 'generic', cwd, workflowActionCommand('verify'), 'before')).rejects.toThrow('validation plan');
    expect(await readFile(runFilePath(data, 'generic', '.unattended.json'), 'utf8')).not.toContain('changed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps a legacy snapshot on its own runtime instead of upgrading its execution entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-legacy-template-'));
  try {
    await writeFile(join(root, 'context.md'), 'Legacy context');
    await writeFile(join(root, 'workflow.yaml'), `version: 2
name: legacy
nodes:
  - { id: start, type: start }
  - { id: verify, type: check, command: __VERIFY_COMMAND__ }
  - { id: done, type: end, status: success }
  - { id: failed, type: end, status: failed }
edges:
  - { from: start.next, to: verify }
  - { from: verify.pass, to: done }
  - { from: verify.fail, to: failed }
`);
    const legacy = unattendedWorkflows(root)[0]!;
    const verify = legacy.graph!.nodes.find(node => node.id === 'verify');
    expect(verify?.type === 'check' && verify.command).toContain(`${root.replaceAll('\\', '/')}/runtime.mjs`);
    expect(verify?.type === 'check' && workflowActionOf(verify.command)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

it('loads a copied YAML template through the ordinary project workflow loader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-copied-template-'));
  try {
    const yaml = stringify(UNATTENDED_TEMPLATE);
    expect(yaml).not.toMatch(/__[A-Z_]+__/);
    await mkdir(join(root, '.ai/cezar/workflows'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/workflows/copied.yaml'), yaml.replace('name: unattended', 'name: copied-unattended'));
    const catalog = await loadWorkflows(root);
    expect(catalog.issues).toEqual([]);
    const copied = catalog.workflows.find(workflow => workflow.name === 'copied-unattended')!;
    expect(copied.source).toBe('file');
    expect(copied.steps.filter(step => step.command).every(step => step.command!.includes('scripts/workflow-action.mjs'))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);


it('records blocked evidence using the run index above the task directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-blocked-directory-'));
  try {
    const data = join(root, 'host'), cwd = join(root, 'task'), runId = 'blocked-task';
    await mkdir(join(data, 'runs', runId), { recursive: true });
    await mkdir(cwd, { recursive: true });
    const paths = newArtifactPaths(cwd, runId, new Date(), 'task', join(data, 'runs', runId));
    await mkdir(join(paths.directory, 'probe'), { recursive: true });
    await mkdir(dirname(paths.file('run.json')), { recursive: true }); await writeFile(paths.file('run.json'), JSON.stringify({ runId, root: await realpath(cwd), artifactPrefix: paths.prefix }));
    const handoff = runFilePath(data, runId, '.handoff.md');
    await writeFile(handoff, '# Handoff\n');
    await writeFile(join(data, 'runs.json'), JSON.stringify([{ id: runId, worktreePath: cwd, graphState: { taken: ['design.blocked->blocked-report'], outputs: { design: { summary: 'Missing requirement evidence' } } } }]));
    await promisify(execFile)(process.execPath, [WORKFLOW_ACTION_SCRIPT, 'blocked'], {
      cwd, env: { ...process.env, CEZ_RUN_ID: runId, CEZ_TASK_ID: runId, CEZ_HANDOFF_FILE: handoff }, windowsHide: true,
    });
    expect(await readFile(handoff, 'utf8')).toContain('Missing requirement evidence');
  } finally { await rm(root, { recursive: true, force: true }); }
});
