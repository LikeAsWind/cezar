import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, captureTree, treeDiff, assertValidationExtension, validationCoverage } from '../workflow-action.mjs';
import { artifactPaths } from './artifacts.mjs';

test('failed verification replaces stale evidence and snapshots current code even before commands start', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-verify-handoff-'));
  try {
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    git('init'); await writeFile(join(cwd, 'check.cjs'), 'process.exit(1)');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    await initialize(cwd, 'verify-run', git('rev-parse', 'HEAD'));
    const paths = artifactPaths(cwd, 'verify-run');
    const command = { file: process.execPath, args: ['check.cjs'], cwd: '.', source: 'check.cjs', kind: 'test' };
    await writeFile(paths.file('validation-plan.json'), JSON.stringify({ schemaVersion: 1, baseline: [command], verify: [command] }));
    await writeFile(join(cwd, 'check.cjs'), 'console.error("current failure"); process.exit(1)');
    const verify = () => spawnSync(process.execPath, [fileURLToPath(new URL('../workflow-action.mjs', import.meta.url)), 'verify'], { cwd, env: { ...process.env, CEZ_RUN_ID: 'verify-run' }, encoding: 'utf8' });
    await writeFile(paths.file('verified.json'), '{"stale":true}');
    assert.notEqual(verify().status, 0);
    await assert.rejects(readFile(paths.file('verified.json')), { code: 'ENOENT' });
    assert.match(await readFile(paths.file('branch.diff'), 'utf8'), /current failure/);
    assert.equal(JSON.parse(await readFile(paths.file('verify.json'), 'utf8')).results[0].exitCode, 1);
    await writeFile(paths.file('validation-plan.json'), '{}');
    assert.notEqual(verify().status, 0);
    const early = JSON.parse(await readFile(paths.file('verify.json'), 'utf8'));
    assert.equal(early.results.length, 0);
    assert.ok(early.error);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('scope expansion preserves frozen checks and detects module selectors instead of assuming root cwd covers everything', () => {
  const a = { file: 'mvn', args: ['-pl', 'module-a', 'test'], cwd: '.', source: 'pom.xml', kind: 'test' };
  const previous = { schemaVersion: 1, verify: [a], toolchains: [{ name: 'jdk8', targetVersion: '8' }] };
  assert.deepEqual(validationCoverage(previous, ['module-a/src/A.java', 'module-b/src/B.java']), ['module-b/src/B.java']);
  for (const helper of [
    { file: 'git', args: ['diff', '--check'], cwd: '.', source: 'pom.xml', kind: 'check' },
    { file: 'node', args: ['narrow-check.cjs'], cwd: '.', source: 'package.json', kind: 'test' },
    { file: 'pytest', args: ['module-a/tests'], cwd: '.', source: 'pyproject.toml', kind: 'test' },
    { file: 'go', args: ['test', './module-a/...'], cwd: '.', source: 'go.mod', kind: 'test' },
    { file: 'npm', args: ['test', '--', 'module-a'], cwd: '.', source: 'package.json', kind: 'test' },
  ]) assert.deepEqual(validationCoverage({ verify: [a, helper] }, ['module-b/src/B.java']), ['module-b/src/B.java']);
  assert.deepEqual(validationCoverage({ verify: [{ ...a, args: ['-f', 'pom.xml', '-pl', 'module-a', 'test'] }] }, ['module-a/src/A.java', 'module-b/src/B.java']), ['module-b/src/B.java']);
  assert.deepEqual(validationCoverage({ verify: [{ ...a, file: 'gradle', args: [':module-a:test'] }] }, ['module-a/src/A.java', 'module-b/src/B.java']), ['module-b/src/B.java']);
  assert.throws(() => assertValidationExtension(previous, { ...previous, verify: [{ ...a, args: ['package', '-DskipTests'] }] }), /frozen/i);
  assert.throws(() => assertValidationExtension(previous, { ...previous, toolchains: [{ name: 'jdk8', targetVersion: '21' }] }), /frozen/i);
  assert.doesNotThrow(() => assertValidationExtension(previous, { ...previous, verify: [a, { ...a, args: ['-pl', 'module-b', 'test'] }] }));
});

test('scope check runs only added baselines, preserves original results and freezes the expanded plan', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-scope-handoff-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    git('init');
    for (const name of ['a', 'b']) {
      await mkdir(join(cwd, name)); await writeFile(join(cwd, name, 'check.cjs'), `console.log('${name} passed')`);
    }
    git('add', '.'); assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture').status, 0);
    await initialize(cwd, 'scope-run', git('rev-parse', 'HEAD').stdout.trim());
    const paths = artifactPaths(cwd, 'scope-run');
    const command = name => ({ file: process.execPath, args: ['check.cjs'], cwd: name, source: `${name}/check.cjs`, kind: 'test' });
    const initial = { schemaVersion: 1, baseline: [command('a')], verify: [command('a')] };
    await writeFile(paths.file('environment.json'), JSON.stringify(initial));
    await writeFile(paths.file('routing-input.json'), JSON.stringify({ likelyChangeFiles: ['a/check.cjs', 'b/check.cjs'], highRisk: false, crossModule: true, requirementsClear: true }));
    const cli = action => spawnSync(process.execPath, [fileURLToPath(new URL('../workflow-action.mjs', import.meta.url)), action], { cwd, encoding: 'utf8', env: { ...process.env, CEZ_RUN_ID: 'scope-run' } });
    assert.equal(cli('baseline').status, 0);
    assert.notEqual(cli('scope').status, 0);
    const expanded = { ...initial, baseline: [command('a'), command('b')], verify: [command('a'), command('b')] };
    await writeFile(paths.file('environment.json'), JSON.stringify(expanded));
    const result = cli('scope'); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /deep$/);
    const baseline = JSON.parse(await readFile(paths.file('baseline.json'), 'utf8'));
    assert.equal(baseline.results.length, 2);
    assert.deepEqual(baseline.results.map(result => result.spec.cwd), ['a', 'b']);
    assert.equal(JSON.parse(await readFile(paths.file('validation-plan.json'), 'utf8')).verify.length, 2);
    await assert.rejects(readFile(paths.file('scope.json')), { code: 'ENOENT' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('review snapshots produce only the fix increment including uncommitted and new files without touching the index', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-fix-range-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(git('init').status, 0);
    await writeFile(join(cwd, 'a.txt'), 'initial\n'); git('add', '.');
    assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture').status, 0);
    await initialize(cwd, 'fix-run', git('rev-parse', 'HEAD').stdout.trim());
    await writeFile(join(cwd, 'a.txt'), 'reviewed change\n');
    await writeFile(join(cwd, 'new.txt'), 'reviewed new file\n');
    const beforeIndex = git('diff', '--cached').stdout;
    const base = await captureTree(cwd, 'fix-run');
    await writeFile(join(cwd, 'a.txt'), 'fixed change\n');
    const head = await captureTree(cwd, 'fix-run');
    const diff = await treeDiff(cwd, base, head);
    assert.match(diff, /reviewed change/); assert.match(diff, /fixed change/);
    assert.doesNotMatch(diff, /new.txt/);
    assert.equal(git('diff', '--cached').stdout, beforeIndex);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
