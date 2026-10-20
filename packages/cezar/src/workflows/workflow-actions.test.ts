import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { workflowActionCommand, workflowActionOf } from './workflow-actions.ts';
import { unattendedWorkflows } from './superpowers-bundle.ts';
import { BUILTIN_SUPERPOWERS_BUNDLE } from '../superpowers-update.ts';
import { guardUnattendedCheck, isUnattendedGraph } from './unattended-guards.ts';
import { newArtifactPaths } from '../../scripts/workflow/artifacts.mjs';
import { loadWorkflows } from './load.ts';
import { UNATTENDED_TEMPLATE } from './templates/unattended.ts';
import { stringify } from 'yaml';

it('loads the new template using host actions without a bundle runtime dependency', () => {
  const workflow = unattendedWorkflows(BUILTIN_SUPERPOWERS_BUNDLE)[0]!;
  for (const action of ['baseline', 'route', 'execution', 'verify', 'seal'] as const) {
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
    await mkdir(join(cwd, 'docs/superpowers/probe'), { recursive: true });
    const paths = newArtifactPaths(cwd, 'generic');
    await writeFile(paths.file('run.json'), JSON.stringify({ runId: 'generic', root: await realpath(cwd), artifactPrefix: paths.prefix }));
    const graph = { nodes: [{ id: 'custom-validation', type: 'check' as const, command: workflowActionCommand('verify') }], edges: [] };
    expect(isUnattendedGraph(data, 'generic', graph)).toBe(true);
    await writeFile(paths.file('validation-plan.json'), '{}');
    await guardUnattendedCheck(data, 'generic', cwd, workflowActionCommand('baseline'), 'after');
    await guardUnattendedCheck(data, 'generic', cwd, workflowActionCommand('verify'), 'before');
    await writeFile(paths.file('validation-plan.json'), '{"changed":true}');
    await expect(guardUnattendedCheck(data, 'generic', cwd, workflowActionCommand('verify'), 'before')).rejects.toThrow('validation plan');
    expect(await readFile(join(data, 'runs/generic.unattended.json'), 'utf8')).not.toContain('changed');
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
