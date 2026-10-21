import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { unattendedContext } from './unattended-probe.ts';
import { newArtifactPaths } from '../../scripts/workflow/artifacts.mjs';

it('hands existing map contents, selected tools and progress to the next node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-shared-context-'));
  try {
    const paths = newArtifactPaths(root, 'context-run');
    await mkdir(join(paths.directory, 'probe'), { recursive: true });
    await mkdir(join(paths.directory, 'logs'), { recursive: true });
    await writeFile(paths.file('run.json'), JSON.stringify({ runId: 'context-run', root: await realpath(root), artifactPrefix: paths.prefix }));
    await writeFile(paths.file('context-map.jsonl'), JSON.stringify({ path: 'src/Counter.java', summary: 'Known failure counter', symbols: ['recordFailure'], dependsOn: [] }) + '\n');
    await writeFile(paths.file('environment.json'), JSON.stringify({ toolchains: [{ name: 'jdk8', buildVersion: '1.8.0_202', execution: { javaHome: '/selected/jdk8' } }] }));
    await writeFile(paths.file('ledger.md'), 'Task 1 code saved; test execution unresolved.');
    await writeFile(paths.file('baseline.json'), JSON.stringify({ results: [{ spec: { kind: 'test' }, exitCode: 0 }] }));
    const text = await unattendedContext(root, 'context-run');
    expect(text).toContain('src/Counter.java');
    expect(text).toContain('recordFailure');
    expect(text).toContain('/selected/jdk8');
    expect(text).toContain('Task 1 code saved');
    expect(text).toContain('unverified');
    expect(text).toContain('reference data');
    await mkdir(join(paths.directory, 'plans'), { recursive: true });
    await writeFile(paths.file('plan.md'), 'Modify src/Counter.java');
    await writeFile(paths.file('context-map.jsonl'), [
      { path: 'src/Unrelated.java', summary: 'x'.repeat(50_000) },
      { path: 'src/Counter.java', summary: 'Relevant counter', symbols: ['recordFailure'] },
    ].map(row => JSON.stringify(row)).join('\n'));
    const bounded = await unattendedContext(root, 'context-run');
    expect(bounded).toContain('Relevant counter');
    expect(bounded).toContain('"omittedMapEntries": 1');
    await writeFile(paths.file('run.json'), JSON.stringify({ runId: 'another-run', root: await realpath(root), artifactPrefix: paths.prefix }));
    await expect(unattendedContext(root, 'context-run')).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
