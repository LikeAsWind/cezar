import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { UNATTENDED_TEMPLATE } from '../../src/workflows/templates/unattended.ts';
import { routeDecision, initialize as runtimeInitialize, readContext, validationPlan, executionDirectory, checkDependencies, captureDiff, artifactDirectory, commandResult } from '../workflow-action.mjs';
import { graphIssues, advance, enterGraph, portsOfNode, compareValues } from '../../src/workflows/graph.ts';

import { artifactPaths } from './artifacts.mjs';
const bundle = fileURLToPath(new URL('../../src/workflows/assets/superpowers/', import.meta.url));
const hostAction = fileURLToPath(new URL('../workflow-action.mjs', import.meta.url));
const identities = new Map();
async function initialize(root, id, base) { const data = await runtimeInitialize(root, id, base); identities.set(root, id); return data; }
const artifact = (root, name) => artifactPaths(root, identities.get(root)).file(name);

test('selected Java home is applied to checks, baseline and verify instead of the inherited default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-selected-jdk-'));
  try {
    const javaHome = join(root, 'jdk8');
    await mkdir(join(javaHome, 'bin'), { recursive: true });
    for (const file of process.platform === 'win32' ? ['java.exe', 'javac.exe'] : ['java', 'javac']) await writeFile(join(javaHome, 'bin', file), 'fixture');
    await writeFile(join(root, 'pom.xml'), '<project/>');
    await writeFile(join(root, 'check.cjs'), `const fs=require('node:fs');if(process.env.JAVA_HOME!==${JSON.stringify(javaHome)} || !process.env.PATH.startsWith(${JSON.stringify(join(javaHome, 'bin'))}))process.exit(9);console.log('Java version: 1.8.0_fixture');fs.appendFileSync('bound.log','ok\\n');`);
    for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']]) {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    await initialize(root, 'selected-jdk', 'HEAD');
    const command = { file: process.execPath, args: ['check.cjs'], source: 'pom.xml', kind: 'build', toolchain: 'java-app' };
    const environment = { schemaVersion: 1, toolchains: [{ name: 'java-app', module: '.', targetVersion: '8', buildVersion: '1.8.0_fixture', runtimeVersion: null, sources: ['pom.xml'], execution: { javaHome, pathEntries: [] } }],
      environmentChecks: [{ ...command, kind: 'check', expectedOutput: ['Java version: 1.8.0_fixture'] }], baseline: [command], verify: [command] };
    await writeFile(artifact(root, 'environment.json'), JSON.stringify(environment));
    const result = spawnSync(process.execPath, [hostAction, 'baseline'], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME: 'wrong-default-jdk', CEZ_RUN_ID: 'selected-jdk' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(join(root, 'bound.log'), 'utf8')).trim().split('\n').length, 2);
    const plan = JSON.parse(await readFile(artifact(root, 'validation-plan.json'), 'utf8'));
    assert.equal(plan.toolchains[0].execution.javaHome, javaHome);
    const verify = spawnSync(process.execPath, [hostAction, 'verify'], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME: 'another-wrong-jdk', CEZ_RUN_ID: 'selected-jdk' } });
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal((await readFile(join(root, 'bound.log'), 'utf8')).trim().split('\n').length, 4);
    await rm(join(javaHome, 'bin'), { recursive: true });
    await assert.rejects(validationPlan(root, environment), /ENOENT|Java|java/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host actions import without target-project node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-host-import-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { routeDecision } = await import(${JSON.stringify(pathToFileURL(hostAction).href)}); if (routeDecision({ likelyChangeFiles: ['src/example.ts'], highRisk: false, crossModule: false, requirementsClear: true }).tier !== 'fast') process.exit(2);`],
      { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('execution strategy requires independent tasks and an observed subagent capability, not just a deep tier', async () => {
  const { executionDecision } = await import('../workflow-action.mjs');
  const input = { schemaVersion: 1, tasksIndependent: true, subagents: { available: true, tool: 'observed-task-tool', evidence: 'This runner exposes the named tool in this session.' } };
  assert.equal(executionDecision(input).mode, 'sdd');
  assert.equal(executionDecision({ ...input, tasksIndependent: false }).mode, 'native');
  assert.equal(executionDecision({ ...input, tasksIndependent: null }).mode, 'native');
  assert.equal(executionDecision({ ...input, subagents: { available: false, tool: null, evidence: 'No task dispatch tool is exposed.' } }).mode, 'native');
  assert.throws(() => executionDecision({ ...input, subagents: { available: true, tool: null, evidence: '' } }));
});

test('an evidenced product baseline failure is recorded without accepting final verification failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-known-baseline-'));
  try {
    await writeFile(join(root, 'failure.cjs'), "console.error('KNOWN_ORDER_FILTER_BUG');process.exit(1);");
    const dir = join(root, artifactDirectory);
    await initialize(root, 'known-baseline', 'example-base');
    const command = { file: process.execPath, args: ['failure.cjs'], cwd: '.', source: 'failure.cjs', kind: 'test' };
    const expectedFailure = { exitCode: 1, outputIncludes: ['KNOWN_ORDER_FILTER_BUG'], outputHash: createHash('sha256').update('KNOWN_ORDER_FILTER_BUG\n').digest('hex'), reason: 'The user explicitly requested fixing this isolated, reproduced product bug.' };
    const environment = { schemaVersion: 1, baseline: [{ ...command, expectedFailure }], verify: [command] };
    await writeFile(artifact(root, 'environment.json'), JSON.stringify(environment));
    const cli = action => spawnSync(process.execPath, [hostAction, action], { cwd: root, env: { ...process.env, CEZ_RUN_ID: 'known-baseline', CEZ_TASK_ID: 'known-baseline' }, encoding: 'utf8' });
    const baseline = cli('baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    const evidence = JSON.parse(await readFile(artifact(root, 'baseline.json'), 'utf8'));
    assert.equal(evidence.results[0].exitCode, 1);
    assert.equal(evidence.results[0].classification, 'known-product-failure');
    assert.notEqual(cli('verify').status, 0, 'final verification must still fail');
    await writeFile(join(root, 'failure.cjs'), "console.error('KNOWN_ORDER_FILTER_BUG');console.error('UNRELATED_FAILURE');process.exit(1);");
    assert.notEqual(cli('baseline').status, 0, 'an additional unexpected failure must not match the known failure');
    await assert.rejects(validationPlan(root, { ...environment, verify: [{ ...command, expectedFailure }] }));
    await writeFile(artifact(root, 'environment.json'), JSON.stringify({ ...environment, baseline: [{ ...command, expectedFailure: { ...expectedFailure, outputIncludes: ['DIFFERENT_BUG'] } }] }));
    assert.notEqual(cli('baseline').status, 0, 'a different failure remains blocked');
  } finally { await rm(root, { recursive: true, force: true }); }
});
const input = { likelyChangeFiles: ['packages/web/src/components/icons.tsx'], highRisk: false,
  crossModule: false, requirementsClear: true };

test('small, known, local changes are fast; high risk and cross-module override file count', () => {
  assert.equal(routeDecision(input).tier, 'fast');
  assert.equal(routeDecision({ ...input, highRisk: true }).tier, 'deep');
  assert.equal(routeDecision({ ...input, crossModule: true }).tier, 'deep');
  assert.equal(routeDecision({ ...input, likelyChangeFiles: ['packages/contract/src/projects.ts'] }).tier, 'deep');
});

test('unknown, zero-match, and ambiguous scope cannot silently become fast', () => {
  assert.equal(routeDecision({ ...input, likelyChangeFiles: null }).tier, 'standard');
  assert.equal(routeDecision({ ...input, likelyChangeFiles: [] }).tier, 'standard');
  assert.equal(routeDecision({ ...input, requirementsClear: false }).tier, 'standard');
  assert.equal(routeDecision({ ...input, requirementsClear: false, highRisk: true }).tier, 'deep');
  assert.equal(routeDecision({ ...input, requirementsClear: false }, 'deep').tier, 'deep');
  assert.throws(() => routeDecision({ likelyChangeFiles: [] }));
  assert.throws(() => routeDecision({ ...input, likelyChangeFiles: ['../outside.ts'] }));
});

test('full candidate counts, cross-workspace detection and monotonic upgrades', () => {
  assert.equal(routeDecision({ ...input, likelyChangeFiles: Array.from({ length: 11 }, (_, n) => `src/f${n}.ts`) }).tier, 'deep');
  assert.equal(routeDecision({ ...input, likelyChangeFiles: ['packages/web/src/a.ts', 'packages/cezar/src/b.ts'] }).tier, 'deep');
  assert.equal(routeDecision(input, 'deep').tier, 'deep');
  assert.equal(routeDecision(input, 'standard').tier, 'standard');
});

test('run artifacts resume idempotently but reject another run identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-context-'));
  try {
    await initialize(root, 'run-a', 'abc123');
    const before = await readContext(root, 'run-a');
    await initialize(root, 'run-a', 'different-current-head');
    assert.equal((await readContext(root, 'run-a')).base, before.base);
    await assert.rejects(readContext(root, 'run-b'), /not been initialized/);
    const cli = spawnSync(process.execPath, [hostAction, 'route'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CEZ_RUN_ID: 'run-b' },
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /not been initialized/);
    await assert.rejects(readFile(artifact(root, 'last-failure.txt')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('agent nodes can route with CEZ_TASK_ID while host checks use CEZ_RUN_ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-agent-id-'));
  try {
    await initialize(root, 'agent-id', 'abc123');
    await writeFile(artifact(root, 'routing-input.json'), JSON.stringify(input));
    const cli = spawnSync(process.execPath, [hostAction, 'route'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CEZ_TASK_ID: 'agent-id', CEZ_RUN_ID: '' },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.trim(), 'fast');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pinned original prompts and their supporting files match the provenance manifest', async () => {
  const manifest = JSON.parse(await readFile(join(bundle, 'provenance.json'), 'utf8'));
  for (const [path, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(join(bundle, path))).digest('hex'), hash, path);
  assert.ok(Object.keys(manifest.files).length >= 74);
});

test('Java validation uses discovered Maven commands, never cezar npm scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-java-'));
  try {
    await writeFile(join(root, 'pom.xml'), '<project/>');
    const javaHome = join(root, 'jdk8'); await mkdir(join(javaHome, 'bin'), { recursive: true });
    for (const tool of ['java', 'javac']) await writeFile(join(javaHome, 'bin', tool + (process.platform === 'win32' ? '.exe' : '')), 'fixture');
    const command = { file: 'mvn', args: ['-B', 'test', '-DskipTests=false', '-Dmaven.test.skip=false'], cwd: '.', source: 'pom.xml', kind: 'test', toolchain: 'java' };
    const environment = { schemaVersion: 1, toolchains: [{ name: 'java', module: '.', targetVersion: '8', buildVersion: '8', runtimeVersion: null, sources: ['pom.xml'], execution: { javaHome } }], environmentChecks: [{ ...command, kind: 'check', args: ['-version'], expectedOutput: ['1.8'] }], baseline: [command], verify: [command] };
    const plan = await validationPlan(root, environment);
    await assert.rejects(validationPlan(root, { ...environment, toolchains: [...environment.toolchains, { ...environment.toolchains[0], name: 'other-jdk' }], environmentChecks: [...environment.environmentChecks, { ...environment.environmentChecks[0], toolchain: 'other-jdk' }] }), /one selected toolchain per module/);
    await assert.rejects(validationPlan(root, { ...environment, verify: [{ ...command, args: ['test', '-Dtest=ExampleTest'] }] }), /skipTests=false/);
    assert.equal(plan.verify[0].file, 'mvn');
    assert.ok(!JSON.stringify(plan).includes('npm'));
    for (const variant of [
      { file: 'dotnet', args: ['build', '-c', 'Release'] },
      { file: 'cargo', args: ['test', '-p', 'crate'] },
      { file: 'python', args: ['-m', 'pytest', '-c', 'pytest.ini'] },
      { file: 'mvn', args: ['-e', 'test', '-DskipTests=false', '-Dmaven.test.skip=false'] },
    ]) {
      await validationPlan(root, { ...environment, verify: [{ ...command, ...variant }] });
    }
    await assert.rejects(validationPlan(root, { ...environment, verify: [{ ...command, file: 'node', args: ['--require', 'module', '-e', 'process.exit()'] }] }), /inline command evaluation/);
    await assert.rejects(validationPlan(root, { ...environment, verify: [{ ...command, toolchain: undefined }] }), /selected Java home/);
    await assert.rejects(validationPlan(root, { ...environment, verify: [{ ...command, toolchain: 'absent' }] }), /unavailable/);
    await assert.rejects(validationPlan(root, { schemaVersion: 1, baseline: [], verify: [] }));
    await assert.rejects(validationPlan(root, { schemaVersion: 1, baseline: [command], verify: [{ ...command, file: 'mvn & echo injected' }] }));
    await assert.rejects(validationPlan(root, { schemaVersion: 1, baseline: [command], verify: [{ ...command, args: ['test & echo injected'] }] }));
    await assert.rejects(validationPlan(root, { schemaVersion: 1, baseline: [command], verify: [{ ...command, cwd: '..' }] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a newly discovered toolchain and repository wrapper need no runtime allowlist update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-dynamic-toolchain-'));
  try {
    await writeFile(join(root, 'mix.exs'), 'def project, do: []\n');
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts/verify project.sh'), '#!/bin/sh\nexit 0\n');
    const command = { file: 'mix', args: ['test'], cwd: '.', source: 'mix.exs', kind: 'test' };
    const plan = await validationPlan(root, {
      schemaVersion: 1,
      setup: [{ ...command, args: ['deps.get'], kind: 'setup' }],
      baseline: [command],
      verify: [command, { ...command, file: './scripts/verify project.sh', args: [], kind: 'check' }],
    });
    assert.equal(plan.setup[0].file, 'mix');
    assert.equal(plan.verify[1].file, './scripts/verify project.sh');
    await assert.rejects(validationPlan(root, { schemaVersion: 1, baseline: [command], verify: [{ ...command, kind: 'setup' }] }));
    await assert.rejects(validationPlan(root, { schemaVersion: 1, baseline: [command], verify: [{ ...command, file: '../outside.sh' }] }));
    await assert.rejects(executionDirectory(root, { ...command, file: './scripts/missing.sh' }));
    for (const [file, args] of [['sh', ['-c', 'true']], ['ruby', ['-e', 'exit']]]) {
      await assert.rejects(validationPlan(root, { schemaVersion: 1, baseline: [command], verify: [{ ...command, file, args }] }), /inline command evaluation/);
    }
    const generated = { ...command, file: './python', cwd: 'venv' };
    await validationPlan(root, { schemaVersion: 1, baseline: [generated], verify: [generated] });
    await assert.rejects(executionDirectory(root, generated));
    await mkdir(join(root, 'venv'));
    await writeFile(join(root, 'venv/python'), 'generated tool');
    await executionDirectory(root, generated);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependency isolation uses detected paths and mappings, not a language-specific recipe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-dependencies-'));
  try {
    const plan = { dependencyRoots: ['deps'], workspaceLinks: [{ link: 'deps/lib', target: 'modules/lib' }] };
    await assert.rejects(checkDependencies(root, plan), /ENOENT/);
    await mkdir(join(root, 'deps/lib'), { recursive: true });
    await mkdir(join(root, 'modules/lib'), { recursive: true });
    await assert.rejects(checkDependencies(root, plan), /does not target this worktree/);
    await checkDependencies(root, { dependencyRoots: ['deps'], workspaceLinks: [{ link: 'modules/lib', target: 'modules/lib' }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host baseline runs the discovered setup then checks; verification reuses the frozen plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-dynamic-execution-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const cli = action => spawnSync(process.execPath, [hostAction, action], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CEZ_RUN_ID: 'dynamic-run' },
  });
  try {
    git('init');
    await writeFile(join(root, 'build.json'), '{}\n');
    await writeFile(join(root, 'setup.cjs'), "require('node:fs').mkdirSync('deps',{recursive:true}); require('node:fs').mkdirSync('build',{recursive:true});\n");
    await writeFile(join(root, 'check.cjs'), "require('node:fs').statSync('../deps'); console.log('actual project check ran');\n");
    git('add', '.');
    git('-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@example.invalid', 'commit', '-m', 'project');
    await initialize(root, 'dynamic-run', git('rev-parse', 'HEAD'));
    const command = { file: process.execPath, args: ['../check.cjs'], cwd: 'build', source: 'build.json', kind: 'test' };
    const dir = join(root, artifactDirectory);
    await writeFile(artifact(root, 'environment.json'), JSON.stringify({ schemaVersion: 1,
      setup: [{ ...command, args: ['setup.cjs'], cwd: '.', kind: 'setup' }], baseline: [command], verify: [command], dependencyRoots: ['deps'] }));
    const baseline = cli('baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    const evidence = JSON.parse(await readFile(artifact(root, 'baseline.json'), 'utf8'));
    assert.deepEqual(evidence.results.map(result => result.spec.kind), ['setup', 'test']);
    await writeFile(artifact(root, 'environment.json'), JSON.stringify({ schemaVersion: 1, baseline: [], verify: [] }));
    const verification = cli('verify');
    assert.equal(verification.status, 0, verification.stderr);
    assert.match(await readFile(artifact(root, 'verify-1.log'), 'utf8'), /actual project check ran/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a timed-out gate kills its child process tree and preserves a log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-timeout-'));
  let descendant;
  try {
    await writeFile(join(root, 'hang.cjs'), `const {spawn}=require('node:child_process');\nconst child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});\nrequire('node:fs').writeFileSync('child.pid',String(child.pid));\nsetInterval(()=>{},1000);\n`);
    const result = await commandResult(`"${process.execPath.replaceAll('\\', '/')}" hang.cjs`, root, join(root, 'gate.log'), 2000);
    descendant = Number(await readFile(join(root, 'child.pid'), 'utf8'));
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 1);
    assert.match(await readFile(join(root, 'gate.log'), 'utf8'), /timed out/);
    assert.throws(() => process.kill(descendant, 0), /ESRCH/);
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});

test('review snapshot includes committed, staged, unstaged and new files, excluding scratch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-diff-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init');
    await writeFile(join(root, 'existing.txt'), 'before\n');
    git('add', 'existing.txt');
    git('-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@example.invalid', 'commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    await initialize(root, 'diff-run', base);
    await writeFile(join(root, 'existing.txt'), 'staged\n');
    git('add', 'existing.txt');
    await writeFile(join(root, 'existing.txt'), 'unstaged\n');
    await writeFile(join(root, 'new-file.txt'), 'new content\n');
    const dir = join(root, artifactDirectory);
    const first = await captureDiff(root, identities.get(root), base);
    const diff = await readFile(artifact(root, 'branch.diff'), 'utf8');
    assert.match(diff, /unstaged/);
    assert.match(diff, /new content/);
    assert.doesNotMatch(diff, /run\.json/);
    assert.equal(first, await captureDiff(root, identities.get(root), base));
    await writeFile(join(root, 'new-file.txt'), 'changed after verification\n');
    assert.notEqual(first, await captureDiff(root, identities.get(root), base));
  } finally { await rm(root, { recursive: true, force: true }); }
});

const graph = () => parseGraph();
async function parseGraph() {
  const doc = structuredClone(UNATTENDED_TEMPLATE);
  return { nodes: doc.nodes, edges: doc.edges };
}
function walk(g, choices) {
  const counts = new Map();
  const visited = [];
  let result = enterGraph(g, counts);
  for (let i = 0; i < 120 && result.kind === 'node'; i++) {
    const node = result.node;
    visited.push(node.id);
    const selection = node.id === 'route' && ['fast', 'standard', 'deep'].includes(choices.route) || node.id === 'execution-route' && ['native', 'sdd'].includes(choices['execution-route']) ? 'pass' : choices[node.id];
    const port = node.type === 'if'
      ? String(compareValues(`${choices[node.condition.ref.split('.')[0]] ?? (node.condition.ref === 'execution-route.output' ? 'sdd' : '')}\n`.trim(), node.condition.op, node.condition.value))
      : typeof selection === 'function' ? selection() : selection ?? (node.type === 'check' ? 'pass' : node.verdicts?.[0] ?? 'done');
    result = advance(g, node.id, port, counts);
  }
  assert.equal(result.kind, 'end', 'graph must terminate');
  return { result, visited };
}

for (const tier of ['fast', 'standard', 'deep']) {
  test(`${tier} path ends only after final validation and independent review`, async () => {
    const g = await graph();
    const { result, visited } = walk(g, { route: tier, plan: tier, 'fast-plan': tier });
    assert.equal(result.status, 'success');
    assert.ok(visited.includes(`execute-${tier}`));
    assert.ok(visited.includes('verify'));
    assert.ok(visited.includes('review'));
    assert.ok(visited.indexOf('verify') < visited.indexOf('review'));
    assert.equal(visited.includes('design'), tier !== 'fast');
  });
}

test('deep native fallback keeps verification and independent review without claiming SDD', async () => {
  const g = await graph();
  const { result, visited } = walk(g, { route: 'deep', plan: 'deep', 'execution-route': 'native' });
  assert.equal(result.status, 'success');
  assert.ok(visited.includes('execute-deep-native'));
  assert.ok(!visited.includes('execute-deep'));
  assert.ok(visited.includes('verify') && visited.includes('review'));
});

test('every verdict and failure has a wired exit; no human gate or external side-effect nodes', async () => {
  const g = await graph();
  for (const node of g.nodes) {
    assert.ok(['start', 'end', 'loop', 'agent', 'check', 'if'].includes(node.type));
    if (node.type === 'end') continue;
    for (const port of portsOfNode(node)) {
      assert.ok(g.edges.some(e => e.from === `${node.id}.${port}`), `missing exit ${node.id}.${port}`);
    }
  }
});

test('failed verification before review still gets a complete first review after one fix', async () => {
  const g = await graph();
  let attempts = 0;
  const { result, visited } = walk(g, { route: 'fast', 'fast-plan': 'fast', verify: () => ++attempts === 1 ? 'fail' : 'pass' });
  assert.equal(result.status, 'success');
  assert.equal(visited.filter(x => x === 'fix').length, 1);
  assert.ok(visited.indexOf('fix') < visited.indexOf('review'));
});

test('persistent validation/review failure, failed baseline and explicit blocking terminate', async () => {
  const g = await graph();
  for (const choices of [{ verify: 'fail' }, { review: 'changes' }, { baseline: 'fail' }, { route: 'fail' }, { probe: 'blocked' }]) {
    const { result, visited } = walk(g, { route: 'fast', 'fast-plan': 'fast', ...choices });
    assert.equal(result.status, 'failed');
    assert.ok(visited.filter(x => x === 'fix').length <= 1);
  }
});

test('design revision and complexity escalation are bounded and preserve a final review', async () => {
  const g = await graph();
  const rejected = walk(g, { route: 'standard', plan: 'standard', builder: 'changes' });
  assert.equal(rejected.result.status, 'failed');
  assert.equal(rejected.visited.filter(x => x === 'builder').length, 2);
  const upgraded = walk(g, { route: 'fast', 'fast-plan': 'fast', 'execute-fast': 'deep', plan: 'deep' });
  assert.equal(upgraded.result.status, 'success');
  assert.ok(upgraded.visited.includes('execute-deep'));
  assert.ok(upgraded.visited.includes('review'));
});


test('brainstorming asks one question at a time and reuses adjudication before design approval', async () => {
  const g = await graph();
  let rounds = 0;
  const { result, visited } = walk(g, { route: 'standard', plan: 'standard',
    design: () => ++rounds <= 3 ? 'question' : 'ready', adjudicator: 'answered' });
  assert.equal(result.status, 'success');
  assert.equal(visited.filter(id => id === 'adjudicator').length, 3);
  assert.equal(visited.filter(id => id === 'design').length, 4);
  assert.ok(visited.lastIndexOf('adjudicator') < visited.indexOf('builder'));
  assert.equal(g.nodes.find(n => n.id === 'design').skill, 'superpowers:brainstorming');
});

test('unanswerable clarification and exhausted question rounds terminate before implementation', async () => {
  const g = await graph();
  for (const outcome of ['blocked', 'answered']) {
    const { result, visited } = walk(g, { route: 'standard', plan: 'standard', design: 'question', adjudicator: outcome });
    assert.equal(result.status, 'failed');
    assert.ok(!visited.includes('execute-standard'));
    assert.ok(visited.filter(id => id === 'adjudicator').length <= 8);
  }
});

test('builder gaps can return through the same clarification role; fast tasks skip it', async () => {
  const g = await graph();
  let designs = 0;
  let reviews = 0;
  const normal = walk(g, { route: 'standard', plan: 'standard',
    design: () => ++designs === 2 ? 'question' : 'ready',
    builder: () => ++reviews === 1 ? 'changes' : 'approve', adjudicator: 'answered' });
  assert.equal(normal.result.status, 'success');
  assert.equal(normal.visited.filter(id => id === 'adjudicator').length, 1);
  assert.ok(normal.visited.indexOf('builder') < normal.visited.indexOf('adjudicator'));
  const fast = walk(g, { route: 'fast', 'fast-plan': 'fast' });
  assert.equal(fast.visited.includes('adjudicator'), false);
});


test('later planning, execution and repair questions reuse the adjudicator and return to their caller', async () => {
  const g = await graph();
  for (const caller of ['fast-plan', 'plan', 'execute-fast', 'execute-standard', 'execute-deep', 'fix']) {
    let attempts = 0;
    let verification = 0;
    const tier = ['plan', 'execute-standard'].includes(caller) ? 'standard' : caller === 'execute-deep' ? 'deep' : 'fast';
    const normalVerdict = caller === 'fast-plan' || caller === 'plan' ? tier : caller === 'fix' ? 'fixed' : 'complete';
    const { result, visited } = walk(g, { route: tier, plan: tier, 'fast-plan': tier,
      [caller]: () => ++attempts === 1 ? 'question' : normalVerdict,
      adjudicator: caller,
      ...(caller === 'fix' ? { verify: () => ++verification === 1 ? 'fail' : 'pass' } : {}) });
    assert.equal(result.status, 'success', caller);
    const answer = visited.indexOf('adjudicator');
    assert.ok(answer > 0, caller);
    assert.equal(visited[answer + 1], caller);
    assert.ok(visited.includes('review'));
  }
});


test('toolchain constraints survive plan freezing; version checks precede compilation and reject drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-toolchain-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const cli = action => spawnSync(process.execPath, [hostAction, action], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CEZ_RUN_ID: 'toolchain-run' },
  });
  try {
    git('init');
    await writeFile(join(root, 'pom.xml'), '<project><java.version>1.8</java.version></project>');
    await writeFile(join(root, 'tool-version.txt'), '1.8.0_402');
    await mkdir(join(root, 'version-env'));
    await writeFile(join(root, 'version.cjs'), "console.error('Java version: '+require('node:fs').readFileSync('tool-version.txt','utf8'));");
    await writeFile(join(root, 'compile.cjs'), "require('node:fs').writeFileSync('compiled.txt','compiled');");
    git('add', '.');
    git('-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@example.invalid', 'commit', '-m', 'project');
    await initialize(root, 'toolchain-run', git('rev-parse', 'HEAD'));
    const dir = join(root, artifactDirectory);
    const command = { file: process.execPath, args: ['compile.cjs'], cwd: '.', source: 'pom.xml', kind: 'build' };
    const toolchain = { name: 'java', module: '.', targetVersion: '1.8',
      buildVersion: '1.8.0_402', runtimeVersion: null, sources: ['pom.xml'],
      constraints: ['Use Java 8 syntax and APIs; deployment JDK is not verified'] };
    const environment = { schemaVersion: 1, toolchains: [toolchain],
      environmentChecks: [{ ...command, kind: 'check', args: ['version.cjs'], expectedOutput: ['Java version: 1.8.0_402'] },
        { ...command, kind: 'check', cwd: 'version-env', args: ['--version'], expectedOutput: [process.version] }],
      baseline: [command], verify: [command] };
    await writeFile(artifact(root, 'environment.json'), JSON.stringify(environment));
    const baseline = cli('baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    const frozen = JSON.parse(await readFile(artifact(root, 'validation-plan.json'), 'utf8'));
    assert.deepEqual(frozen.toolchains, [toolchain]);
    assert.deepEqual(frozen.environmentChecks[0].expectedOutput, ['Java version: 1.8.0_402']);
    const evidence = JSON.parse(await readFile(artifact(root, 'environment-baseline.json'), 'utf8'));
    assert.equal(evidence.checks[0].matched, true);
    await rm(join(root, 'compiled.txt'));
    assert.equal(cli('verify').status, 0);
    await rm(join(root, 'compiled.txt'));
    await writeFile(join(root, 'tool-version.txt'), '11.0.22');
    await writeFile(artifact(root, 'environment.json'), JSON.stringify({ ...environment,
      environmentChecks: [{ ...environment.environmentChecks[0], expectedOutput: ['Java version: 11.0.22'] }] }));
    const drift = cli('verify');
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /environment check.*expected output/i);
    await assert.rejects(readFile(join(root, 'compiled.txt')), /ENOENT/);
    const failed = JSON.parse(await readFile(artifact(root, 'environment-verify.json'), 'utf8'));
    assert.equal(failed.checks[0].matched, false);
    await writeFile(join(root, 'tool-version.txt'), '1.8.0_402');
    assert.equal(cli('verify').status, 0);
    await rm(join(root, 'compiled.txt'));
    await rm(join(root, 'version-env'), { recursive: true });
    assert.equal(cli('verify').status, 1);
    const missing = JSON.parse(await readFile(artifact(root, 'environment-verify.json'), 'utf8'));
    assert.equal(missing.checks[1].matched, false);
    assert.match(await readFile(artifact(root, missing.checks[1].log), 'utf8'), /ENOENT/);
    await assert.rejects(readFile(join(root, 'compiled.txt')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('declared toolchains require executable version evidence instead of report-only fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-v7-toolchain-schema-'));
  try {
    await writeFile(join(root, 'pom.xml'), '<project/>');
    const command = { file: 'mvn', args: ['test'], source: 'pom.xml', kind: 'test' };
    const toolchain = { name: 'java', module: '.', targetVersion: '8', buildVersion: '11', runtimeVersion: null, sources: ['pom.xml'] };
    await assert.rejects(validationPlan(root, { schemaVersion: 1, toolchains: [toolchain], baseline: [command], verify: [command] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
