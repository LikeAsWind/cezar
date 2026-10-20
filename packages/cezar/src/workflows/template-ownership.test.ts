import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { BUILT_IN_GRAPH_WORKFLOWS } from './templates.ts';
import { BUILTIN_SUPERPOWERS_BUNDLE, ensureBundleSnapshot } from '../superpowers-update.ts';

it('keeps skill and vendor assets beside the workflow sources', () => {
  expect(BUILTIN_SUPERPOWERS_BUNDLE).toBe(fileURLToPath(new URL('./assets/superpowers/', import.meta.url)));
});

it('registers unattended with the other built-in templates', () => {
  const workflow = BUILT_IN_GRAPH_WORKFLOWS.find(workflow => workflow.name === 'unattended');
  expect(workflow).toBeDefined();
  expect(Object.keys(workflow!.graph!).sort()).toEqual(['edges', 'nodes']);
});

it('snapshots the host template without shipping a duplicate runtime or artifact implementation', async () => {
  for (const file of ['workflow.yaml', 'runtime.mjs', 'artifacts.mjs', 'vendor/runtime/zod.mjs']) {
    await expect(access(join(BUILTIN_SUPERPOWERS_BUNDLE, file))).rejects.toThrow();
  }
  const snapshot = await ensureBundleSnapshot(BUILTIN_SUPERPOWERS_BUNDLE);
  const template = JSON.parse(await readFile(join(snapshot.root, 'workflow.json'), 'utf8'));
  expect(template.name).toBe('unattended');
  expect(template.nodes.some((node: { command?: string }) => node.command === 'cezar workflow-action verify')).toBe(true);
}, 30_000);

it('combines the current host template with older skill assets without changing the old snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-old-skill-bundle-'));
  try {
    await cp(BUILTIN_SUPERPOWERS_BUNDLE, root, { recursive: true });
    await writeFile(join(root, 'workflow.yaml'), 'version: 2\nname: old-template\n');
    await writeFile(join(root, 'runtime.mjs'), '// old runtime');
    const snapshot = await ensureBundleSnapshot(root, { hostWorkflow: true });
    expect(JSON.parse(await readFile(join(snapshot.root, 'workflow.json'), 'utf8')).name).toBe('unattended');
    await expect(access(join(snapshot.root, 'runtime.mjs'))).rejects.toThrow();
    expect(await readFile(join(root, 'runtime.mjs'), 'utf8')).toBe('// old runtime');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
