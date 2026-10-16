import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from './boot.ts';
import { loadWorkspaceConfig } from './config.ts';
import { clearProjectProbeCache, registerProject } from './projects.ts';

/**
 * Workspace initialization runs config migrations but never turns the launch
 * directory into a project. Project registration stays an explicit gesture.
 */
describe('initWorkspace', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repos: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-boot-home-'));
    repos = mkdtempSync(join(realpathSync(tmpdir()), 'cez-boot-repos-'));
    process.env.CEZ_HOME = home;
    clearProjectProbeCache();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repos, { recursive: true, force: true });
  });

  const makeRepo = (name: string): string => {
    const dir = join(repos, name);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    return dir;
  };

  const registeredRoots = async (): Promise<string[]> =>
    (await loadWorkspaceConfig()).projects.map((project) => project.root);

  it('leaves an empty registry empty when initialization runs from a repository', async () => {
    const root = makeRepo('first');
    expect(await initWorkspace(root)).toBeUndefined();
    expect(await registeredRoots()).toEqual([]);
  });

  it('does not add an unregistered launch folder when the user has projects', async () => {
    await registerProject(makeRepo('kept'));
    const scratch = makeRepo('scratch');

    expect(await initWorkspace(scratch)).toBeUndefined();
    expect((await registeredRoots()).map((root) => root.split(/[\\/]/).at(-1))).toEqual(['kept']);
  });

  it('does not select or update a registered project when initialized from it', async () => {
    const root = makeRepo('known');
    const first = await registerProject(root);
    await registerProject(makeRepo('other'));

    expect(await initWorkspace(root)).toBeUndefined();
    const entry = (await loadWorkspaceConfig()).projects.find((project) => project.id === first.id);
    expect(entry?.lastOpenedAt).toBe(first.lastOpenedAt);
    expect(await registeredRoots()).toHaveLength(2);
  });

  it('runs migrations even when it registers nothing', async () => {
    await registerProject(makeRepo('kept'));
    await initWorkspace(makeRepo('scratch'));
    // The migration cursor is the observable proof migrations ran — the
    // suppressed registration must not short-circuit the rest of boot.
    expect((await loadWorkspaceConfig()).schemaVersion).toBeGreaterThan(0);
  });
});
