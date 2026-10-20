import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { routeDecision, executionDecision, executionEnvironment } from './workflow-action.mjs';
import { artifactPaths } from './workflow/artifacts.mjs';

const script = fileURLToPath(new URL('./workflow-action.mjs', import.meta.url));
test('host routing and toolchain binding require no Superpowers assets', () => {
  const input = { candidateFiles: ['src/example.java'], highRisk: false, crossModule: false, requirementsClear: true };
  assert.equal(routeDecision(input).tier, 'fast');
  assert.equal(routeDecision({ ...input, highRisk: true }).tier, 'deep');
  assert.equal(executionDecision({ schemaVersion: 1, tasksIndependent: false, subagents: { available: false, tool: "none", evidence: "not exposed" } }).mode, 'native');
  const env = executionEnvironment({ toolchains: [{ name: 'jdk', execution: { javaHome: '/observed/jdk8', pathEntries: [] } }] }, { toolchain: 'jdk' }, { PATH: 'existing', JAVA_HOME: 'wrong' });
  assert.equal(env.JAVA_HOME, '/observed/jdk8');
});

test('host CLI initializes and verifies a dependency-free worktree, rejects changed code and real command failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-host-action-'));
  try {
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git('init');
    await writeFile(join(root, 'check.cjs'), "console.log('passed');");
    await writeFile(join(root, 'manifest.txt'), 'check.cjs is the project check');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    git('worktree', 'add', 'isolated task', '-b', 'task');
    const cwd = join(root, 'isolated task');
    const cli = action => spawnSync(process.execPath, [script, action], { cwd, encoding: 'utf8', env: { ...process.env, CEZ_RUN_ID: 'generic-run', CEZ_TASK_ID: 'generic-run', NODE_PATH: '' } });
    let result = cli('init'); assert.equal(result.status, 0, result.stderr);
    const paths = artifactPaths(cwd, 'generic-run');
    const command = { file: process.execPath, args: ['check.cjs'], cwd: '.', source: 'manifest.txt', kind: 'test' };
    await writeFile(paths.file('environment.json'), JSON.stringify({ schemaVersion: 1, baseline: [command], verify: [command] }));
    result = cli('baseline'); assert.equal(result.status, 0, result.stderr);
    result = cli('verify'); assert.equal(result.status, 0, result.stderr);
    result = cli('seal'); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(paths.file('verify.json'), 'utf8')).results[0].exitCode, 0);
    await writeFile(join(cwd, 'check.cjs'), 'process.exit(7);');
    assert.notEqual(cli('seal').status, 0);
    result = cli('verify'); assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(await readFile(paths.file('verify.json'), 'utf8')).results[0].exitCode, 7);
    assert.notEqual(cli('invented-action').status, 0);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
});
