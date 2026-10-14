import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
