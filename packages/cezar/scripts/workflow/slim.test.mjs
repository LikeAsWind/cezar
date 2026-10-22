import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, testExecutionEvidence } from '../workflow-action.mjs';
import { artifactPaths } from './artifacts.mjs';

const action = fileURLToPath(new URL('../workflow-action.mjs', import.meta.url));
test('keeps machine reports in the run directory and discards successful raw output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-slim-gate-'));
  try {
    const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    git('init');
    await writeFile(join(root, 'build.json'), '{}');
    await writeFile(join(root, 'check.cjs'), "console.log('ordinary compiler chatter'.repeat(1000));");
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
    await initialize(root, 'slim-run', git('rev-parse', 'HEAD'));
    const paths = artifactPaths(root, 'slim-run');
    const command = { file: process.execPath, args: ['check.cjs'], source: 'build.json', kind: 'check' };
    await writeFile(paths.file('environment.json'), JSON.stringify({ schemaVersion: 1, baseline: [command], verify: [command] }));
    const run = phase => spawnSync(process.execPath, [action, phase], { cwd: root, encoding: 'utf8', env: { ...process.env, CEZ_RUN_ID: 'slim-run', CEZ_TASK_ID: 'slim-run' } });
    const baseline = run('baseline'); assert.equal(baseline.status, 0, baseline.stderr);
    const result = JSON.parse(await readFile(paths.file('baseline.json'), 'utf8')).results[0];
    assert.equal(result.classification, 'passed');
    assert.equal(result.log, undefined);
    assert.equal(result.diagnostics, undefined);
    assert.ok((await readdir(paths.stateDirectory)).every(name => !name.endsWith('.log')));
    assert.deepEqual(await readdir(join(root, 'docs/superpowers')), ['plans', 'probe', 'specs']);
    await rm(paths.file('environment.json'));
    const verification = run('verify'); assert.equal(verification.status, 0, verification.stderr);
    await writeFile(join(root, 'check.cjs'), "console.log('ordinary chatter'.repeat(3000)); console.error('[ERROR] specific failure'); process.exit(1);");
    const failed = run('verify'); assert.notEqual(failed.status, 0);
    const failure = JSON.parse(await readFile(paths.file('verify.json'), 'utf8')).results[0];
    assert.match(failure.diagnostics, /specific failure/);
    assert.ok(failure.diagnostics.length <= 12000);
    assert.ok((await readdir(paths.stateDirectory)).every(name => !name.endsWith('.log')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retains Maven counts while rejecting skip-only success', () => {
  const spec = { file: 'mvn', args: ['test'], kind: 'test' };
  assert.deepEqual(testExecutionEvidence(spec, 'Tests run: 12, Failures: 0, Errors: 0, Skipped: 0'), { status: 'executed', counts: { tests: 12, failures: 0, errors: 0, skipped: 0 } });
  assert.equal(testExecutionEvidence(spec, 'Tests are skipped. BUILD SUCCESS').status, 'skipped');
});
