import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, captureDiff } from '../workflow-action.mjs';
import { artifactPaths, newArtifactPaths } from './artifacts.mjs';
import { spawnSync } from 'node:child_process';

test('all stages use dated run-scoped docs paths, preserve existing docs, and resume with the saved date', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-dated-artifacts-'));
  try {
    await mkdir(join(root, 'docs/superpowers'), { recursive: true });
    await writeFile(join(root, 'docs/superpowers/.gitignore'), '# user-owned\n');
    await initialize(root, 'first-run', 'HEAD');
    const first = artifactPaths(root, 'first-run');
    assert.match(first.relative('probe.md'), /^docs\/superpowers\/probe\/\d{4}-\d{2}-\d{2}-first-run-probe\.md$/);
    assert.match(first.relative('request.md'), /\/probe\/.*-request\.md$/);
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

test('legacy frozen runs retain their original artifact layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-legacy-artifacts-'));
  try {
    await mkdir(join(root, '.superpowers/probe'), { recursive: true });
    await writeFile(join(root, '.superpowers/probe/run.json'), JSON.stringify({ runId: 'old', root: await realpath(root), base: 'HEAD' }));
    assert.equal(artifactPaths(root, 'old').file('probe.md'), join(root, '.superpowers/probe/probe.md'));
    assert.throws(() => artifactPaths(root, 'other'), /different run/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('already pinned dated-flat runs keep their saved paths without silently moving files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-flat-artifacts-'));
  try {
    const prefix = '2026-10-20-existing';
    await mkdir(join(root, 'docs/superpowers'), { recursive: true });
    const file = join(root, 'docs/superpowers', `${prefix}-run.json`);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, runId: 'existing', root: await realpath(root), base: 'HEAD', artifactPrefix: prefix }));
    await initialize(root, 'existing', 'changed');
    assert.equal(artifactPaths(root, 'existing').file('run.json'), file);
    assert.equal(artifactPaths(root, 'existing').file('probe.md'), join(root, 'docs/superpowers', `${prefix}-probe.md`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Continue rejects category directories replaced with links outside the worktree', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cez-artifact-link-'));
  try {
    const root = join(sandbox, 'worktree'), outside = join(sandbox, 'outside'); await mkdir(root); await mkdir(outside);
    await initialize(root, 'linked-run', 'HEAD');
    const dir = join(root, 'docs/superpowers/specs');
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
    await writeFile(paths.file('delivery.md'), 'published report');
    assert.equal(await captureDiff(root, 'seal-run', base), first);
    await writeFile(join(root, 'docs/superpowers/other-topic.md'), 'real task documentation');
    const docsChanged = await captureDiff(root, 'seal-run', base);
    assert.notEqual(docsChanged, first);
    await writeFile(join(root, 'app.txt'), 'changed\n');
    assert.notEqual(await captureDiff(root, 'seal-run', base), docsChanged);
  } finally { await rm(root, { recursive: true, force: true }); }
});
