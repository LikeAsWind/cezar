import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
const f = vi.hoisted(() => ({ driver: vi.fn(), update: vi.fn() }));
vi.mock('../server/tracker/index.ts', () => ({ createTrackerService: () => ({ driver: f.driver }) }));
import { RunManager } from './run.ts';
const association = { kind: 'tapd' as const, source: { id: 'tapd', webUrl: 'https://www.tapd.cn' }, externalId: '123', externalName: 'Search', connectionId: '00000000-0000-4000-8000-000000000001' };
beforeEach(() => {
  f.driver.mockReset().mockResolvedValue({ association, updateStatus: f.update });
  f.update.mockReset().mockResolvedValue({ available: true, id: 'story:456', status: 'acceptance', statusName: '验收' });
});
function invoke(source: unknown = { association, id: 'story:456' }) {
  const manager = Object.create(RunManager.prototype) as RunManager;
  Object.assign(manager, { repoRoot: 'C:/project', dataDir: 'C:/project/.ai/cezar', store: {
    getRun: () => ({ trackerTask: source }), redactRunText: (_id: string, text: string) => text,
  } });
  const outputs = new Map<string, Record<string, string | number>>();
  const persist = vi.fn();
  const execute = manager['runSystemNode'].bind(manager);
  return { outputs, persist, run: () => execute('run', {} as Parameters<typeof execute>[1], { id: 'tapd-acceptance', type: 'tracker.update-status', statusName: '验收' }, outputs, '', vi.fn(), persist) };
}
it('updates the frozen story identity through the project tracker and persists the verified result', async () => {
  const node = invoke();
  expect(await node.run()).toBe('done');
  expect(f.driver).toHaveBeenCalledWith('C:/project', 'C:/project/.ai/cezar');
  expect(f.update).toHaveBeenCalledWith('story:456', '验收');
  expect(node.outputs.get('tapd-acceptance')).toEqual({ id: 'story:456', status: 'acceptance', statusName: '验收' });
  expect(node.persist).toHaveBeenCalledOnce();
});
it('refuses to update a story after the project connection or workspace changed', async () => {
  f.driver.mockResolvedValue({ association: { ...association, externalId: 'other' }, updateStatus: f.update });
  expect(await invoke().run()).toBe('failed');
  expect(f.update).not.toHaveBeenCalled();
});
it('records rejected status writes as a retryable workflow failure', async () => {
  f.update.mockResolvedValue({ available: false, reason: 'TAPD denied write access' });
  const node = invoke();
  expect(await node.run()).toBe('failed');
  expect(node.outputs.get('tapd-acceptance')).toEqual({ error: 'TAPD denied write access' });
});
it('skips ordinary tasks without a TAPD story instead of guessing IDs from task text', async () => {
  expect(await invoke(null).run()).toBe('skipped');
  expect(f.driver).not.toHaveBeenCalled();
});
it('persists the manual tracker handoff identity before execution so a restart can recover it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-tracker-task-'));
  const data = join(root, '.ai/cezar');
  const store = RunStore.open(data);
  const manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
  const pump = vi.spyOn(manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
  vi.stubEnv('CEZ_AUTONAME', '0');
  try {
    const trackerTask = { association, id: 'story:456' };
    const run = manager.startRun({ name: 'fixture', source: 'built-in', steps: [{ id: 'work', prompt: 'work' }] }, { task: 'work', trackerTask });
    store.flush();
    expect(RunStore.open(data).getRun(run.id)?.trackerTask).toEqual(trackerTask);
  } finally {
    manager.dispose();
    pump.mockRestore();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
