import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, captureDiff } from '../workflow-action.mjs';
import { artifactNames, artifactPaths, newArtifactPaths } from './artifacts.mjs';
import { spawnSync } from 'node:child_process';

test('titles determine stable topics; same-day duplicates cannot overwrite each other', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-topic-artifacts-'));
  try {
    const [first, second] = await Promise.all([
      initialize(root, 'first-id', 'HEAD', 'Sale Control Thread Pool'),
      initialize(root, 'second-id', 'HEAD', 'Sale Control Thread Pool'),
    ]);
    assert.deepEqual(new Set([first.topic, second.topic]), new Set(['sale-control-thread-pool', 'sale-control-thread-pool-2']));
    assert.notEqual(first.artifactPrefix, second.artifactPrefix);
    for (const data of [first, second]) {
      const paths = artifactPaths(root, data.runId);
      assert.equal(paths.prefix, `${data.artifactDate}-${data.topic}`);
      assert.ok(!paths.prefix.includes(data.runId));
      assert.equal((await initialize(root, data.runId, 'changed', 'Changed title')).artifactPrefix, data.artifactPrefix);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('readable Unicode titles stay safe and recovery locates run identity inside metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-topic-unicode-'));
  try {
    const saved = await initialize(root, 'internal-id', 'HEAD', '修复线程池 / 分流:异常');
    assert.equal(saved.topic, '修复线程池-分流-异常');
    const paths = artifactPaths(root, 'internal-id');
    assert.ok(paths.relative('probe.md').endsWith('-修复线程池-分流-异常-probe.md'));
    const { readFile } = await import('node:fs/promises');
    const data = JSON.parse(await readFile(paths.file('run.json'), 'utf8'));
    data.artifactPrefix = `2000-01-01-${data.topic}`;
    data.artifactDate = '2000-01-01';
    const old = paths.file('run.json');
    await writeFile(old, JSON.stringify(data));
    await rename(old, join(paths.directory, 'probe', `${data.artifactPrefix}-run.json`));
    assert.equal((await initialize(root, 'internal-id', 'HEAD', 'Other title')).artifactPrefix, data.artifactPrefix);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('probe, specs, plans and logs remain sibling directories with run-prefixed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-grouped-artifacts-'));
  try {
    await initialize(root, 'grouped-run', 'HEAD');
    const paths = artifactPaths(root, 'grouped-run');
    assert.equal(paths.directory, join(root, 'docs/superpowers'));
    assert.equal(paths.file('probe.md'), join(paths.directory, 'probe', `${paths.prefix}-probe.md`));
    assert.equal(paths.file('design.md'), join(paths.directory, 'specs', `${paths.prefix}-design.md`));
    assert.equal(paths.file('plan.md'), join(paths.directory, 'plans', `${paths.prefix}-plan.md`));
    assert.equal(paths.file('blocked.md'), join(paths.directory, 'logs', `${paths.prefix}-blocked.md`));
    assert.equal(paths.file('last-failure.txt'), join(paths.directory, 'logs', `${paths.prefix}-last-failure.txt`));
    assert.equal(paths.file('baseline-build.log'), join(paths.directory, 'logs', `${paths.prefix}-baseline-build.log`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('all stages use dated run-scoped docs paths, preserve existing docs, and resume with the saved date', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-dated-artifacts-'));
  try {
    await mkdir(join(root, 'docs/superpowers'), { recursive: true });
    await writeFile(join(root, 'docs/superpowers/.gitignore'), '# user-owned\n');
    await initialize(root, 'first-run', 'HEAD', 'First run');
    const first = artifactPaths(root, 'first-run');
    assert.match(first.relative('probe.md'), /^docs\/superpowers\/probe\/\d{4}-\d{2}-\d{2}-first-run-probe\.md$/);
    assert.ok(!artifactNames.includes('request.md'));
    assert.match(first.relative('run.json'), /\/probe\/.*-run\.json$/);
    assert.match(first.relative('design.md'), /\/specs\/.*-design\.md$/);
    assert.match(first.relative('plan.md'), /\/plans\/.*-plan\.md$/);
    await initialize(root, 'second-run', 'HEAD');
    assert.notEqual(artifactPaths(root, 'second-run').file('probe.md'), first.file('probe.md'));
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(join(root, 'docs/superpowers/.gitignore'), 'utf8'), '# user-owned\n');
    assert.equal(artifactPaths(root, 'first-run').prefix, first.prefix);
    assert.notEqual(newArtifactPaths(root, 'first-run', new Date(2000, 0, 1)).prefix, first.prefix);
    assert.throws(() => artifactPaths(root, '../outside'));
    assert.throws(() => first.file('../outside.md'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Continue rejects category directories replaced with links outside the worktree', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cez-artifact-link-'));
  try {
    const root = join(sandbox, 'worktree'), outside = join(sandbox, 'outside'); await mkdir(root); await mkdir(outside);
    await initialize(root, 'linked-run', 'HEAD');
    const dir = join(artifactPaths(root, 'linked-run').directory, 'specs');
    await rename(dir, dir + '-before');
    await symlink(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => artifactPaths(root, 'linked-run'), /escapes/);
    await assert.rejects(initialize(root, 'linked-run', 'HEAD'), /escapes/);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test('seal excludes only this run artifacts while retaining other docs and source changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-artifact-seal-'));
  try {
    const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    git('init'); await writeFile(join(root, 'app.txt'), 'base\n'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD'); await initialize(root, 'seal-run', base);
    const paths = artifactPaths(root, 'seal-run');
    const first = await captureDiff(root, 'seal-run', base);
    await writeFile(paths.file('ledger.md'), 'published report');
    assert.equal(await captureDiff(root, 'seal-run', base), first);
    await writeFile(paths.file('baseline-1.log'), 'host output');
    assert.equal(await captureDiff(root, 'seal-run', base), first);
    await initialize(root, 'other-run', base, 'Task');
    await writeFile(artifactPaths(root, 'other-run').file('design.md'), 'Another task design');
    assert.notEqual(await captureDiff(root, 'seal-run', base), first);
    await writeFile(join(root, 'docs/superpowers/other-topic.md'), 'real task documentation');
    const docsChanged = await captureDiff(root, 'seal-run', base);
    assert.notEqual(docsChanged, first);
    await writeFile(join(root, 'app.txt'), 'changed\n');
    assert.notEqual(await captureDiff(root, 'seal-run', base), docsChanged);
  } finally { await rm(root, { recursive: true, force: true }); }
});
