import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { RunStore } from '../runs/store.ts';
import { createSystemRuntime } from './system-runtime.ts';

vi.mock('../runs/arm-repo-handle.ts', () => ({ armRepoHandle: vi.fn() }));
vi.mock('./git.ts', () => ({ getRepoInfo: vi.fn(async () => null) }));

describe('SystemRuntime', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts with no registered projects without opening a RunStore', async () => {
    const openStore = vi.fn(RunStore.open);
    const runtime = createSystemRuntime({ listProjects: async () => [], openStore });

    await runtime.start();

    expect(openStore).not.toHaveBeenCalled();
    expect(runtime.contexts.ids()).toEqual([]);
    runtime.dispose();
  });

  it('builds a registered project only through its explicit id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-runtime-'));
    roots.push(root);
    const runtime = createSystemRuntime({
      listProjects: async () => [{ id: 'alpha', root, status: 'not-git' }],
    });

    await runtime.start();
    expect(runtime.contexts.ids()).toEqual([]);

    const context = await runtime.contexts.context('alpha');

    expect(context.id).toBe('alpha');
    expect(context.root).toBe(root);
    runtime.dispose();
  });

  it('setAutomationStore routes late-bound context builds through the shared provider (F4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-runtime-'));
    roots.push(root);
    const runtime = createSystemRuntime({
      listProjects: async () => [{ id: 'alpha', root, status: 'not-git' }],
    });
    // Production constructs the runtime WITHOUT the provider, then startServer
    // late-binds the coordinator's cached store. The built context must then
    // hand back that shared instance, and the map stays the runtime's own.
    const shared = AutomationStore.open(join(root, '.ai/cezar'));
    const provider = vi.fn(() => shared);
    runtime.contexts.setAutomationStore(provider);

    const context = await runtime.contexts.context('alpha');

    expect(context.automationStore).toBe(shared);
    expect(provider).toHaveBeenCalledWith('alpha', root);
    expect(runtime.contexts.peek('alpha')).toBe(context);
    runtime.dispose();
  });

  it('a deps-supplied automationStore wins over a later setAutomationStore call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-runtime-'));
    roots.push(root);
    const depsStore = AutomationStore.open(join(root, '.ai/cezar'));
    const runtime = createSystemRuntime({
      listProjects: async () => [{ id: 'alpha', root, status: 'not-git' }],
      automationStore: () => depsStore,
    });
    const late = AutomationStore.open(join(root, '.ai/cezar'));
    runtime.contexts.setAutomationStore(() => late);

    const context = await runtime.contexts.context('alpha');

    expect(context.automationStore).toBe(depsStore);
    runtime.dispose();
  });
});
