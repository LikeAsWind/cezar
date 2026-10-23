import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { artifactPaths } from '../../scripts/workflow/artifacts.mjs';
import { guardProbeEnvironment } from './probe-environment.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cez-probe-env-'));
  const data = join(root, '.ai/cezar');
  await mkdir(join(data, 'runs/run'), { recursive: true });
  await mkdir(join(root, 'docs/superpowers/probe'), { recursive: true });
  await writeFile(join(data, 'runs/run/run.json'), JSON.stringify({ runId: 'run', root: await realpath(root), artifactPrefix: '2026-10-23-probe' }));
  await writeFile(join(root, 'pom.xml'), '<project/>');
  const command = { file: 'mvn', args: ['compile'], cwd: '.', source: 'pom.xml', kind: 'build', toolchain: 'jdk8-maven-v2' };
  const environment = { schemaVersion: 1, toolchains: [{ name: 'jdk8-maven-v2', module: '.', targetVersion: '1.8', buildVersion: '1.8', runtimeVersion: null, sources: ['pom.xml'] }],
    environmentChecks: [{ ...command, file: 'java', args: ['-version'], kind: 'check', expectedOutput: ['1.8'] }], baseline: [command], verify: [command] };
  const file = artifactPaths(root, 'run', join(data, 'runs/run')).file('environment.json');
  const save = (value: unknown) => writeFile(file, JSON.stringify(value));
  const fix = async () => {
    const javaHome = join(root, 'jdk8');
    await mkdir(join(javaHome, 'bin'), { recursive: true });
    for (const name of ['java', 'javac']) await writeFile(join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), '');
    await save({ ...environment, toolchains: [{ ...environment.toolchains[0], execution: { javaHome, pathEntries: [] } }] });
  };
  await save(environment);
  return { root, data, fix };
}

it('accepts a valid environment without asking probe to repair or executing commands', async () => {
  const f = await fixture();
  try {
    await f.fix();
    const repair = vi.fn();
    expect(await guardProbeEnvironment(f.data, 'run', f.root, repair)).toBeUndefined();
    expect(repair).not.toHaveBeenCalled();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it('returns the missing toolchain binding to probe and accepts one successful repair', async () => {
  const f = await fixture();
  try {
    const repair = vi.fn(async (prompt: string) => { expect(prompt).toContain('jdk8-maven-v2'); expect(prompt).toContain('execution'); await f.fix(); return true; });
    expect(await guardProbeEnvironment(f.data, 'run', f.root, repair)).toBeUndefined();
    expect(repair).toHaveBeenCalledTimes(1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it('blocks after an unsuccessful repair and never grants another attempt on recovery', async () => {
  const f = await fixture();
  try {
    const repair = vi.fn(async () => true);
    expect(await guardProbeEnvironment(f.data, 'run', f.root, repair)).toContain('jdk8-maven-v2');
    expect(repair).toHaveBeenCalledTimes(1);
    const recovered = vi.fn();
    expect(await guardProbeEnvironment(f.data, 'run', f.root, recovered)).toContain('jdk8-maven-v2');
    expect(recovered).not.toHaveBeenCalled();
    await f.fix();
    expect(await guardProbeEnvironment(f.data, 'run', f.root, recovered)).toBeUndefined();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it('does not accept valid files when the repair session did not return ready', async () => {
  const f = await fixture();
  try {
    expect(await guardProbeEnvironment(f.data, 'run', f.root, async () => { await f.fix(); return false; })).toContain('ready');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
