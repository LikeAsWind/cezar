import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationCoordinator } from './coordinator.ts';
import { AutomationStore } from './store.ts';

const dirs: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-coordinator-'));
  dirs.push(root);
  return root;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('AutomationCoordinator', () => {
  it('discovers only projects carrying the optional definitions file', async () => {
    const first = await project();
    const second = await project();
    await mkdir(join(first, '.ai/cezar'), { recursive: true });
    await writeFile(join(first, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    const coordinator = new AutomationCoordinator({
      listProjects: async () => [
        { id: 'first', root: first, status: 'ok' },
        { id: 'second', root: second, status: 'ok' },
      ],
    });
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual(['first']);
    await expect(import('node:fs/promises').then(({ stat }) => stat(join(second, '.ai')))).rejects.toThrow();
  });

  it('drops removed and gone projects without failing other handles', async () => {
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    let status: 'ok' | 'missing' = 'ok';
    const coordinator = new AutomationCoordinator({
      listProjects: async () => [{ id: 'one', root, status }],
    });
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual(['one']);
    status = 'missing';
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual([]);
  });

  it('evicts a project handle that is not in the registry', async () => {
    const boot = await project();
    const registered = await project();
    for (const root of [boot, registered]) {
      await mkdir(join(root, '.ai/cezar'), { recursive: true });
      await writeFile(join(root, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    }
    const coordinator = new AutomationCoordinator({
      listProjects: async () => [{ id: 'kept', root: registered, status: 'ok' }],
    });
    expect(coordinator.store('launch-folder', boot)).toBeDefined();

    await coordinator.refresh();

    expect(coordinator.ids()).toEqual(['kept']);
    expect(coordinator.store('launch-folder')).toBeUndefined();
  });

  it('evicts stale handles when the registry is empty', async () => {
    const gone = await project();
    await mkdir(join(gone, '.ai/cezar'), { recursive: true });
    await writeFile(join(gone, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    const coordinator = new AutomationCoordinator({ listProjects: async () => [] });
    expect(coordinator.store('gone', gone)).toBeDefined();
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual([]);
  });

  /**
   * Two explicit project ids can resolve to one physical root in malformed or
   * legacy state; they still share one file-backed store.
   *
   * `AutomationStore` is file-backed with an in-memory snapshot taken at `open()`,
   * so one store per root prevents divergent snapshots.
   */
  it('serves two ids for one root from a single store', async () => {
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    let registry: { id: string; root: string; status: 'ok' }[] = [];
    const coordinator = new AutomationCoordinator({
      listProjects: async () => registry,
    });
    const boot = coordinator.store('my-repo', root);
    expect(boot).toBeDefined();

    // …and what Add project does: the same root, now carrying a registry slug.
    registry = [{ id: 'my-repo', root, status: 'ok' }];
    await coordinator.refresh();

    expect(coordinator.store('my-repo')).toBe(boot);
    expect(coordinator.ids()).toEqual(['my-repo']);
  });

  it('schedules a doubly-addressed root once under a registered id', async () => {
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    AutomationStore.open(join(root, '.ai/cezar')).create(
      {
        name: 'Review PRs',
        enabled: true,
        events: ['pull_request.opened'],
        intervalSeconds: 300,
        filters: { lookbackDays: 7, maxRecords: 25 },
        task: { prompt: 'Review' },
      },
      'review-prs',
    );
    const coordinator = new AutomationCoordinator({
      listProjects: async () => [{ id: 'my-repo', root, status: 'ok' }],
    });
    await coordinator.refresh();

    expect(coordinator.enabledProjectIds()).toEqual(['my-repo']);
  });

  it('keeps the surviving id its store when its twin is removed', async () => {
    // Dropping the shared store with the first id to leave would hand the survivor
    // a fresh snapshot — the divergence again, by a slower route.
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    const coordinator = new AutomationCoordinator({ listProjects: async () => [] });
    const first = coordinator.store('one', root);
    expect(coordinator.store('my-repo', root)).toBe(first);

    coordinator.remove('my-repo');

    expect(coordinator.store('one')).toBe(first);
    expect(coordinator.ids()).toEqual(['one']);
  });

  it('degrades registry and corrupt definition failures to warnings', async () => {
    const warn = vi.fn();
    const coordinator = new AutomationCoordinator({ listProjects: async () => { throw new Error('offline'); }, warn });
    await expect(coordinator.refresh()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});
