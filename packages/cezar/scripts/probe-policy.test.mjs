import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { initialize } from './workflow-action.mjs';
import { artifactPaths } from './workflow/artifacts.mjs';

const script = fileURLToPath(new URL('./probe-policy.mjs', import.meta.url));
test('a slow first turn does not block bootstrap reads before any evidence report exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-probe-bootstrap-'));
  try {
    await initialize(root, 'slow-run', 'HEAD');
    await writeFile(join(root, 'pom.xml'), '<project/>');
    const result = spawnSync(process.execPath, [script, 'hook', root, 'slow-run', String(Date.now() - 180_000)], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(root, 'pom.xml') } }), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'allow');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('version lookup uses the selected Java bin before a conflicting terminal default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-probe-version-'));
  try {
    const project = join(root, 'project'), javaHome = join(root, 'jdk8'), wrong = join(root, 'jdk11/bin');
    await mkdir(project); await mkdir(join(javaHome, 'bin'), { recursive: true }); await mkdir(wrong, { recursive: true });
    const name = process.platform === 'win32' ? 'java.cmd' : 'java';
    for (const [dir, label] of [[join(javaHome, 'bin'), 'SELECTED_JAVA_8'], [wrong, 'WRONG_JAVA_11']]) {
      const file = join(dir, name);
      await writeFile(file, process.platform === 'win32' ? `@echo ${label}\r\n` : `#!/bin/sh\necho ${label}\n`);
      await chmod(file, 0o755);
      if (process.platform === 'win32') await writeFile(join(dir, 'java'), '#!/bin/sh\necho WRONG_EXTENSIONLESS_SCRIPT\n');
    }
    const result = spawnSync(process.execPath, [script, 'version', 'java', '-version', javaHome], { cwd: project, encoding: 'utf8', env: { ...process.env, PATH: wrong } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SELECTED_JAVA_8/);
    assert.doesNotMatch(result.stdout, /WRONG_JAVA_11/);
    const absolute = spawnSync(process.execPath, [script, 'version', join(javaHome, 'bin', 'java'), '-version', javaHome], { cwd: project, encoding: 'utf8' });
    assert.equal(absolute.status, 0, absolute.stderr);
    assert.match(absolute.stdout, /SELECTED_JAVA_8/);
    const results = await Promise.all([javaHome, join(root, 'jdk11'), javaHome].map(home =>
      promisify(execFile)(process.execPath, [script, 'version', 'java', '-version', home], { cwd: project, env: { ...process.env, PATH: wrong } })));
    assert.match(results[0].stdout, /SELECTED_JAVA_8/);
    assert.match(results[1].stdout, /WRONG_JAVA_11/);
    assert.match(results[2].stdout, /SELECTED_JAVA_8/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('probe denies build, shell chaining, code writes and delegation before tool execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-probe-policy-'));
  try {
    await initialize(root, 'probe-run', 'HEAD');
    const paths = artifactPaths(root, 'probe-run');
    await writeFile(join(root, 'App.java'), 'class App {}');
    const handoff = join(root, 'host', 'probe-run.handoff.md');
    await mkdir(join(root, 'host')); await writeFile(handoff, '# Handoff\n## Goal\nOriginal request');
    const hookResult = (tool_name, tool_input, startedAt = Date.now()) => {
      const result = spawnSync(process.execPath, [script, 'hook', root, 'probe-run', String(startedAt)], { input: JSON.stringify({ tool_name, tool_input, cwd: root }), encoding: 'utf8', env: { ...process.env, CEZ_HANDOFF_FILE: handoff } });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).hookSpecificOutput;
    };
    const hook = (...args) => hookResult(...args).permissionDecision;
    assert.equal(hook('Read', { file_path: join(root, 'App.java') }), 'allow');
    assert.equal(hook('Grep', { pattern: 'App' }), 'deny');
    assert.match(hookResult('Grep', { pattern: 'App', path: root }).permissionDecisionReason, /Grep.*specific file or module/);
    assert.match(hookResult('Bash', { command: 'ls' }).permissionDecisionReason, /Use Glob/);
    assert.equal(hook('Grep', { pattern: 'App', path: join(root, 'App.java') }), 'allow');
    assert.equal(hook('Glob', { pattern: '**/java.exe', path: tmpdir() }), 'deny');
    assert.equal(hook('Glob', { pattern: join(tmpdir(), '**/java.exe') }), 'deny');
    assert.equal(hook('Glob', { pattern: '../**/java.exe' }), 'deny');
    assert.equal(hook('Write', { file_path: paths.file('probe.md') }), 'allow');
    for (const command of ['mvn test', 'mvn --version && mvn compile', 'cp *.jar /tmp', 'node -e "doAnything()"']) assert.equal(hook('Bash', { command }), 'deny');
    assert.equal(hook('Edit', { file_path: join(root, 'App.java') }), 'deny');
    assert.equal(hook('Write', { file_path: paths.file('run.json') }), 'deny');
    await initialize(root, 'another-run', 'HEAD');
    assert.equal(hook('Write', { file_path: artifactPaths(root, 'another-run').file('probe.md') }), 'deny');
    assert.equal(hook('Agent', { prompt: 'compile the project' }), 'deny');
    assert.equal(hook('mcp__other__shell', {}), 'deny');
    const command = `'${process.execPath.replaceAll('\\', '/')}' '${script.replaceAll('\\', '/')}' version '${process.execPath.replaceAll('\\', '/')}' '--version' ''`;
    assert.equal(hook('Bash', { command }), 'allow');
    assert.equal(hook('Bash', { command: command + ' && mvn test' }), 'deny');
    assert.equal(hook('Bash', { command: command.replace('--version', 'test') }), 'deny');
    const earlier = Date.now() - 180_000;
    assert.equal(hook('Read', { file_path: handoff }, earlier), 'allow');
    assert.equal(hook('Write', { file_path: handoff }), 'deny');
    assert.equal(hook('Write', { file_path: join(paths.directory, 'probe', `${paths.prefix}-request.md`) }), 'deny');
    // Slow model startup must not prevent the evidence reads needed to write a truthful map.
    assert.equal(hook('Read', { file_path: join(root, 'App.java') }, earlier), 'allow');
    assert.equal(hook('Glob', { pattern: '**/*.java', path: root }, earlier), 'allow');
    assert.equal(hook('Grep', { pattern: 'App', path: join(root, 'App.java') }, earlier), 'allow');
    assert.equal(hook('Read', { file_path: paths.file('run.json') }, earlier), 'allow');
    await writeFile(paths.file('probe.md'), '# Entry: App.java');
    await writeFile(paths.file('context-map.jsonl'), JSON.stringify({ path: 'App.java', summary: 'App entry read earlier' }));
    assert.equal(hook('Read', { file_path: join(root, 'App.java') }, earlier), 'allow');
    const version = spawnSync(process.execPath, [script, 'version', process.execPath, '--version', ''], { cwd: root, encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, new RegExp(process.version.replaceAll('.', '\\.')));
    const broken = spawnSync(process.execPath, [script, 'hook', root], { input: '{', encoding: 'utf8' });
    assert.equal(JSON.parse(broken.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally { await rm(root, { recursive: true, force: true }); }
});
