import { runFilePath } from '../runs/files.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const service = vi.hoisted(() => ({ ensure: vi.fn(), verify: vi.fn(), root: 'old' }));
vi.mock('../superpowers-update.ts', () => ({
  BUILTIN_SUPERPOWERS_BUNDLE: 'builtin',
  resolveSuperpowersBundle: () => service.root,
  ensureBundleSnapshot: service.ensure,
  verifyBundleSnapshot: service.verify,
  snapshotPath: (digest: string) => digest === 'a'.repeat(64) ? 'snapshot-old' : 'snapshot-new',
}));
vi.mock('./superpowers-bundle.ts', () => ({
  unattendedWorkflows: (root = service.root) => [{ name: 'unattended', source: 'built-in', steps: [{ id: 'probe', skill: 'role', prompt: root }] }],
  unattendedSkills: (root = service.root) => [{ name: 'role', source: 'builtin', path: `${root}/role.md`, body: root }],
}));
import { pinSuperpowersRun } from './superpowers-pin.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.clearAllMocks(); service.root = 'old'; });
async function setup() { const root = await mkdtemp(join(tmpdir(), 'cezar-pin-')); roots.push(root); return root; }
const workflow = { name: 'unattended', source: 'built-in' as const, steps: [{ id: 'probe', skill: 'role', prompt: 'old' }] };
const role = { name: 'role', source: 'builtin' as const, path: 'old/role.md', body: 'old' };
it('keeps Continue on the full original snapshot after active changes', async () => {
 const data = await setup();
 service.ensure.mockResolvedValue({ root: 'snapshot-old', ref: { version: '7.0.0', commit: 'a'.repeat(40), digest: 'a'.repeat(64) } });
 const first = await pinSuperpowersRun(data, 'task-1', workflow, [role]);
 expect(first.workflow.steps[0]!.prompt).toBe('snapshot-old');
 service.root = 'new';
 const resumed = await pinSuperpowersRun(data, 'task-1', first.workflow, [{ ...role, path: 'new/role.md', body: 'new' }]);
 expect(resumed.skills[0]!.body).toBe('snapshot-old');
 expect(service.ensure).toHaveBeenCalledTimes(1);
 expect(service.verify).toHaveBeenCalledWith('snapshot-old', 'a'.repeat(64));
 service.verify.mockRejectedValueOnce(new Error('snapshot missing'));
 await expect(pinSuperpowersRun(data, 'task-1', first.workflow, [role])).rejects.toThrow('snapshot missing');
 await writeFile(runFilePath(data, 'task-1', '.superpowers.json'), '{broken');
 await expect(pinSuperpowersRun(data, 'task-1', first.workflow, [role])).rejects.toThrow();
 expect(service.ensure).toHaveBeenCalledTimes(1);
});
it('preserves local overrides and ignores unrelated tasks', async () => {
 const data = await setup();
 const custom = { ...role, source: 'cezar' as const, body: 'custom' };
 const unrelated = { name: 'custom', source: 'file' as const, steps: [{ id: 'x', prompt: 'hello' }] };
 expect(await pinSuperpowersRun(data, 'task-2', unrelated, [custom])).toEqual({ workflow: unrelated, skills: [custom] });
 expect(service.ensure).not.toHaveBeenCalled();
 service.ensure.mockResolvedValue({ root: 'snapshot-old', ref: { version: '7.0.0', commit: 'a'.repeat(40), digest: 'a'.repeat(64) } });
 expect((await pinSuperpowersRun(data, 'task-3', workflow, [custom])).skills).toEqual([custom]);
});
it('new tasks select the new bundle and custom graphs remain intact', async () => {
 const data = await setup();
 service.root = 'new';
 service.ensure.mockResolvedValue({ root: 'snapshot-new', ref: { version: '8.0.0', commit: 'b'.repeat(40), digest: 'b'.repeat(64) } });
 const updated = await pinSuperpowersRun(data, 'new-task', workflow, [{ ...role, path: 'new/role.md' }]);
 expect(updated.workflow.steps[0]!.prompt).toBe('snapshot-new');
 expect(updated.skills[0]!.body).toBe('snapshot-new');
 const custom = { ...workflow, source: 'file' as const, steps: [{ id: 'my-node', skill: 'role', prompt: 'my graph' }] };
 const result = await pinSuperpowersRun(data, 'custom-task', custom, [{ ...role, path: 'new/role.md' }]);
 expect(result.workflow).toEqual(custom);
 expect(result.skills[0]!.body).toBe('snapshot-new');
 const override = { ...role, source: 'cezar' as const };
 await pinSuperpowersRun(data, 'local-task', custom, [override]);
 expect(service.ensure).toHaveBeenCalledTimes(2);
 await expect(pinSuperpowersRun(data, '../escape', custom, [role])).rejects.toThrow('Invalid run id');
});
it('redirects managed runtime and helper references without replacing a saved graph', async () => {
 const data = await setup();
 service.ensure.mockResolvedValue({ root: 'snapshot-old', ref: { version: '7.0.0', commit: 'a'.repeat(40), digest: 'a'.repeat(64) } });
 const custom = { name: 'my workflow', source: 'file' as const, steps: [
   { id: 'custom', skill: 'role', runner: 'codex' as const, prompt: 'Keep my text; read old/helper.md and ./my-file.md' },
   { id: 'verify', command: 'node old/runtime.mjs verify' },
 ] };
 const result = await pinSuperpowersRun(data, 'custom-paths', custom, [role]);
 expect(service.ensure).toHaveBeenCalledWith('old', { hostWorkflow: false });
 expect(result.workflow.steps).toEqual([
   { ...custom.steps[0], prompt: 'Keep my text; read snapshot-old/helper.md and ./my-file.md' },
   { ...custom.steps[1], command: 'node snapshot-old/runtime.mjs verify' },
 ]);
});

it('redirects Windows asset paths in user prompts', async () => {
 const data = await setup();
 service.root = 'C:\\managed\\bundle';
 service.ensure.mockResolvedValue({ root: 'snapshot-new', ref: { version: '8.0.0', commit: 'b'.repeat(40), digest: 'b'.repeat(64) } });
 const custom = { name: 'windows', source: 'file' as const, steps: [{ id: 'work', skill: 'role', prompt: 'Read C:\\managed\\bundle\\helper.md' }] };
 const result = await pinSuperpowersRun(data, 'windows-task', custom, [{ ...role, path: `${service.root}/role.md` }]);
 expect(result.workflow.steps[0]!.prompt).toBe('Read snapshot-new\\helper.md');
});
it('pins helper-only custom workflows with managed runtime references', async () => {
 const data = await setup();
 service.ensure.mockResolvedValue({ root: 'snapshot-old', ref: { version: '7.0.0', commit: 'a'.repeat(40), digest: 'a'.repeat(64) } });
 const custom = { name: 'helper only', source: 'file' as const, steps: [{ id: 'verify', command: 'node old/runtime.mjs verify' }] };
 const result = await pinSuperpowersRun(data, 'helper-task', custom, []);
 expect(service.ensure).toHaveBeenCalledWith('old', { hostWorkflow: false });
 expect(result.workflow.steps[0]!.command).toBe('node snapshot-old/runtime.mjs verify');
});
