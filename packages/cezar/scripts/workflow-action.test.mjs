import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { routeDecision, executionDecision, executionEnvironment, validationPlan, testExecutionEvidence } from './workflow-action.mjs';
import { artifactPaths, artifactNames } from './workflow/artifacts.mjs';

const script = fileURLToPath(new URL('./workflow-action.mjs', import.meta.url));
test('Maven build success cannot hide skipped or absent tests', () => {
  const spec = { file: 'C:/tools/mvn.cmd', kind: 'test' };
  assert.equal(testExecutionEvidence(spec, '[INFO] Tests are skipped.\n[INFO] BUILD SUCCESS').status, 'skipped');
  assert.equal(testExecutionEvidence(spec, '[INFO] No tests to run.\nBUILD SUCCESS').status, 'not-executed');
  assert.equal(testExecutionEvidence(spec, '[INFO] BUILD SUCCESS').status, 'unverified');
  assert.equal(testExecutionEvidence(spec, 'Tests run: 0, Failures: 0, Errors: 0, Skipped: 0').status, 'not-executed');
  assert.equal(testExecutionEvidence(spec, 'Tests run: 2, Failures: 0, Errors: 0, Skipped: 2').status, 'skipped');
  assert.equal(testExecutionEvidence(spec, 'Tests are skipped.\nTests run: 3, Failures: 0, Errors: 0, Skipped: 1').status, 'executed');
  assert.equal(testExecutionEvidence({ ...spec, kind: 'build' }, 'BUILD SUCCESS'), undefined);
});
test('routing counts expected edits, not the files read for context', () => {
  const input = { likelyChangeFiles: ['src/service.java'], contextFiles: Array.from({ length: 12 }, (_, n) => `src/context${n}.java`), highRisk: false, crossModule: false, requirementsClear: true };
  assert.equal(routeDecision(input).tier, 'fast');
  assert.equal(routeDecision(input).likelyChangeFileCount, 1);
  assert.throws(() => routeDecision({ ...input, likelyChangeFiles: undefined }));
});

test('an unresolved environment blocker cannot be silently stripped before baseline', async () => {
  const command = { file: 'npm', args: ['test'], source: 'package.json', kind: 'test' };
  await assert.rejects(validationPlan('.', { schemaVersion: 1, baseline: [command], verify: [command], blocked: ['Build JDK not selected'] }), /Build JDK not selected/);
  await assert.rejects(validationPlan('.', { schemaVersion: 1, baseline: [], verify: [], blocked: ['Required JDK missing'] }), /Required JDK missing/);
});
test('host routing and toolchain binding require no Superpowers assets', () => {
  const input = { likelyChangeFiles: ['src/example.java'], highRisk: false, crossModule: false, requirementsClear: true };
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
    const cli = (action, env = {}) => spawnSync(process.execPath, [script, action], { cwd, encoding: 'utf8', env: { ...process.env, CEZ_RUN_ID: 'generic-run', CEZ_TASK_ID: 'generic-run', NODE_PATH: '', ...env } });
    let result = cli('init'); assert.equal(result.status, 0, result.stderr);
    const paths = artifactPaths(cwd, 'generic-run');
    await writeFile(paths.file('ledger.md'), 'REVIEW-1: unresolved classification; technical decision, not missing product authority.');
    result = cli('blocked'); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recorded|Blocker|blocked/i);
    await assert.rejects(readFile(paths.file('blocked.md')), { code: 'ENOENT' });
    const host = join(root, 'host'); await mkdir(join(host, 'runs'), { recursive: true });
    const handoff = join(host, 'runs', 'generic-run.handoff.md'); await writeFile(handoff, '## Goal\nFix it');
    const record = { id: 'generic-run', worktreePath: cwd, graphState: { taken: ['builder.changes->design-retry', 'design-retry.exhausted->blocked-report'], loops: { 'design-retry': 4 }, outputs: { builder: { verdict: 'changes', summary: 'REVIEW-1: classification unresolved' } } } };
    await writeFile(join(host, 'runs.json'), JSON.stringify([record]));
    result = cli('blocked', { CEZ_HANDOFF_FILE: handoff }); assert.equal(result.status, 0, result.stderr);
    const report = await readFile(handoff, 'utf8');
    assert.match(report, /design-retry.exhausted->blocked-report/);
    assert.match(report, /REVIEW-1: classification unresolved/);
    await writeFile(join(host, 'runs.json'), JSON.stringify([{ ...record, worktreePath: root }]));
    assert.notEqual(cli('blocked', { CEZ_HANDOFF_FILE: handoff }).status, 0);
    assert.equal(await readFile(handoff, 'utf8'), report);
    const command = { file: process.execPath, args: ['check.cjs'], cwd: '.', source: 'manifest.txt', kind: 'test' };
    await writeFile(paths.file('environment.json'), JSON.stringify({ schemaVersion: 1, baseline: [command], verify: [command], environmentChecks: [{ file: process.execPath, args: ['--version'], cwd: '.', source: 'manifest.txt', kind: 'check', expectedOutput: [process.versions.node] }] }));
    result = cli('baseline'); assert.equal(result.status, 0, result.stderr);
    result = cli('verify'); assert.equal(result.status, 0, result.stderr);
    result = cli('seal'); assert.equal(result.status, 0, result.stderr);
    const verification = JSON.parse(await readFile(paths.file('verify.json'), 'utf8'));
    assert.equal(verification.results[0].exitCode, 0);
    assert.equal(verification.environment.checks[0].matched, true);
    assert.match(verification.environment.checks[0].output, new RegExp(process.versions.node.replaceAll('.', '\\.')));
    await assert.rejects(readFile(paths.file('environment-verify.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(paths.file('environment-verify-1.log')), { code: 'ENOENT' });
    await writeFile(join(cwd, 'check.cjs'), 'process.exit(7);');
    assert.notEqual(cli('seal').status, 0);
    result = cli('verify'); assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(await readFile(paths.file('verify.json'), 'utf8')).results[0].exitCode, 7);
    assert.notEqual(cli('invented-action').status, 0);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
});

test('host artifact catalog excludes duplicate reports while preserving native skill documents', () => {
  for (const name of ['implementation.md', 'delivery.md', 'blocked.md', 'last-failure.txt', 'resume-message.md', 'builder-review.md', 'review.md', 'environment-baseline.json', 'environment-verify.json']) assert.ok(!artifactNames.includes(name), name);
  for (const name of ['design.md', 'plan.md', 'ledger.md', 'context-map.jsonl', 'validation-plan.json', 'verify.json', 'verified.json']) assert.ok(artifactNames.includes(name), name);
});

test('custom adjudicator reads consolidated environment evidence', async () => {
  const skill = await readFile(new URL('../src/workflows/assets/superpowers/skills/adjudicator/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /environment\.checks/);
  assert.ok(!skill.includes('environment-baseline.json'));
  assert.ok(!skill.includes('environment-verify.json'));
});
