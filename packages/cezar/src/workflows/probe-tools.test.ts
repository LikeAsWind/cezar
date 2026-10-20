import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { discoverJavaLocations } from './probe-tools.ts';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: (path: string) => String(path).includes('cez-stalled-fs-') ? new Promise(() => {}) : actual.stat(path) };
});

it('returns partial discovery rather than waiting indefinitely on a stalled PATH filesystem', async () => {
  const found = await discoverJavaLocations({ PATH: join(tmpdir(), 'cez-stalled-fs-bin') });
  expect(found.javaHomes).toEqual([]);
  expect(found.incomplete).toBe(true);
});

it('finds a matching sibling JDK from PATH evidence without a full-machine traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-probe-tools-'));
  try {
    for (const version of ['jdk8', 'jdk21']) {
      await mkdir(join(root, 'java', version, 'bin'), { recursive: true });
      for (const tool of ['java', 'javac']) await writeFile(join(root, 'java', version, 'bin', tool + (process.platform === 'win32' ? '.exe' : '')), 'fixture');
    }
    await mkdir(join(root, 'maven/bin'), { recursive: true });
    await writeFile(join(root, 'maven/bin', process.platform === 'win32' ? 'mvn.cmd' : 'mvn'), 'fixture');
    const found = await discoverJavaLocations({ PATH: [join(root, 'java/jdk21/bin'), join(root, 'maven/bin')].join(delimiter), UNRELATED_SECRET: 'never-copy-me' });
    expect(found.javaHomes).toContain(join(root, 'java/jdk8'));
    expect(found.javaHomes).toContain(join(root, 'java/jdk21'));
    expect(found.mavenExecutables).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain('never-copy-me');
  } finally { await rm(root, { recursive: true, force: true }); }
});
