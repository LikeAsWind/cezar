import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, appendFile, stat } from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { artifactDirectory, artifactPaths, newArtifactPaths } from './workflow/artifacts.mjs';
export { artifactDirectory } from './workflow/artifacts.mjs';

const repoPath = z.string().min(1).refine(p => !p.includes('\\') && !p.startsWith('/') && !p.includes(':') && !p.split('/').includes('..'), 'expected a repository-relative path');
const routingSchema = z.object({
  candidateFiles: z.array(repoPath).nullable(),
  highRisk: z.boolean(),
  crossModule: z.boolean().nullable(),
  requirementsClear: z.boolean(),
});
const rank = { fast: 0, standard: 1, deep: 2 };
const riskPath = /(?:^|\/)(?:auth|permissions?|payments?|migrations?|contracts?|scheduler|semaphore|worktrees?)(?:\/|\.|-)|(?:^|\/)\.env\.example$/i;
const commandSchema = z.object({
  file: z.string().min(1).max(4096).refine(file => file.trim() === file && !/[\r\n\0"%!^&|<>]/.test(file) && !file.replaceAll('\\', '/').split('/').includes('..'), 'expected one executable name or observed tool path, not a shell expression'),
  args: z.array(z.string().max(4096).refine(arg => !/[\r\n\0"%!^&|<>]/.test(arg), 'shell expressions are not command arguments')).max(80),
  cwd: repoPath.default('.'),
  source: repoPath,
  kind: z.enum(['test', 'typecheck', 'build', 'lint', 'package', 'check']),
  toolchain: z.string().min(1).optional(),
}).strict();
const baselineCommandSchema = commandSchema.extend({
  expectedFailure: z.object({
    exitCode: z.number().int().positive(), outputIncludes: z.array(z.string().trim().min(1)).min(1),
    outputHash: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(1),
  }).strict().optional(),
}).refine(command => !command.expectedFailure || command.kind === 'test', 'only evidenced product test failures may be expected');
const validationSchema = z.object({ schemaVersion: z.literal(1),
  toolchains: z.array(z.object({
    name: z.string().min(1), module: repoPath.default('.'),
    targetVersion: z.string().min(1).nullable(), buildVersion: z.string().min(1).nullable(),
    runtimeVersion: z.string().min(1).nullable(), sources: z.array(repoPath).min(1),
    constraints: z.array(z.string().min(1)).default([]),
    execution: z.object({
      javaHome: z.string().min(1).refine(isAbsolute, 'Java home must be absolute').optional(),
      pathEntries: z.array(z.string().min(1).refine(isAbsolute, 'tool path must be absolute')).max(20).default([]),
    }).strict().optional(),
  }).strict()).max(30).default([]),
  environmentChecks: z.array(commandSchema.extend({
    kind: z.literal('check'), expectedOutput: z.array(z.string().trim().min(1).max(4096)).min(1).max(20),
  })).max(30).default([]),
  setup: z.array(commandSchema.extend({ kind: z.literal('setup') })).max(10).default([]),
  baseline: z.array(baselineCommandSchema).min(1).max(20), verify: z.array(commandSchema).min(1).max(30),
  dependencyRoots: z.array(repoPath).max(100).default([]),
  workspaceLinks: z.array(z.object({ link: repoPath, target: repoPath }).strict()).max(200).default([]),
}).refine(plan => plan.toolchains.length === 0 || plan.environmentChecks.length > 0,
  'declared toolchains require executable environment checks');

async function inWorktree(root, path) {
  const physical = await realpath(path);
  const rel = relative(await realpath(root), physical);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('validation path escapes the task worktree');
  return physical;
}

export async function validationPlan(root, environment) {
  const plan = validationSchema.parse(environment);
  if (new Set(plan.toolchains.map(tool => tool.name)).size !== plan.toolchains.length) throw new Error('toolchain names must be unique');
  for (const toolchain of plan.toolchains) {
    for (const source of toolchain.sources) {
      await inWorktree(root, resolve(root, source));
      if (!(await stat(join(root, source))).isFile()) throw new Error('toolchain evidence must be an existing source file');
    }
    for (const entry of toolchain.execution?.pathEntries ?? []) if (!(await stat(entry)).isDirectory()) throw new Error('toolchain PATH entry must be a directory');
    if (toolchain.execution?.javaHome) {
      for (const tool of ['java', 'javac']) {
        if (!(await stat(join(toolchain.execution.javaHome, 'bin', tool + (process.platform === 'win32' ? '.exe' : '')))).isFile()) throw new Error('selected Java home must contain java and javac');
      }
    }
    if (toolchain.execution && !plan.environmentChecks.some(check => check.toolchain === toolchain.name)) throw new Error('selected toolchain requires a version check using the same binding');
  }
  for (const command of [...plan.setup, ...plan.environmentChecks, ...plan.baseline, ...plan.verify]) {
    if (command.toolchain && !plan.toolchains.some(tool => tool.name === command.toolchain && tool.execution)) throw new Error('command references an unavailable executable toolchain');
    await inWorktree(root, resolve(root, command.source));
    if (!(await stat(join(root, command.source))).isFile()) throw new Error('validation command needs an existing source file');
    const program = basename(command.file.replaceAll('\\', '/')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    if (['java', 'javac', 'mvn', 'mvnw', 'gradle', 'gradlew'].includes(program)) {
      const selected = plan.toolchains.find(tool => tool.name === command.toolchain);
      if (!selected?.execution?.javaHome) throw new Error('Java build/test commands require a selected Java home; never fall back to the terminal default');
    }
    if (program === 'git' && JSON.stringify(command.args) !== JSON.stringify(['diff', '--check'])) throw new Error('Git validation is limited to diff --check');
    if (['node', 'python', 'python3', 'sh', 'bash', 'dash', 'zsh', 'ruby', 'perl', 'pwsh', 'powershell', 'cmd'].includes(program)) {
      const evalFlags = program === 'node' ? ['-e', '--eval', '-p', '--print'] : ['ruby', 'perl'].includes(program) ? ['-e'] : ['pwsh', 'powershell'].includes(program) ? ['-c', '-command', '-encodedcommand', '-enc'] : program === 'cmd' ? ['/c', '/k'] : ['-c'];
      const valueFlags = ['-r', '--require', '--import', '--loader', '--experimental-loader', '-W', '-X'];
      for (let i = 0; i < command.args.length; i++) {
        const arg = command.args[i];
        if (arg === '--' || arg === '-m' || !(arg.startsWith('-') || program === 'cmd' && arg.startsWith('/'))) break;
        if (evalFlags.some(flag => arg.toLowerCase() === flag || arg.startsWith(`${flag}=`) || (flag.length === 2 && arg.startsWith(flag)))) throw new Error('inline command evaluation is not a validation plan');
        if (valueFlags.includes(arg)) i++;
      }
    }
  }
  return plan;
}

export function executionEnvironment(plan, command, inherited = process.env) {
  const selected = plan.toolchains.find(tool => tool.name === command.toolchain)?.execution;
  if (!selected) return { ...inherited };
  const env = { ...inherited };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const previous = pathKey ? env[pathKey] : '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  const prefixes = [...(selected.javaHome ? [join(selected.javaHome, 'bin')] : []), ...selected.pathEntries];
  env.PATH = [...prefixes, previous].filter(Boolean).join(delimiter);
  if (selected.javaHome) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'java_home') delete env[key];
    env.JAVA_HOME = selected.javaHome;
  }
  return env;
}

export async function executionDirectory(root, command) {
  await inWorktree(root, resolve(root, command.source));
  const cwd = await inWorktree(root, resolve(root, command.cwd));
  if (!(await stat(cwd)).isDirectory()) throw new Error('validation working directory is not a directory');
  if (command.file.includes('/') || command.file.includes('\\')) {
    const executable = resolve(cwd, command.file);
    if (!isAbsolute(command.file)) await inWorktree(root, executable);
    if (!(await stat(executable)).isFile()) throw new Error('discovered executable path is not a file');
  }
  return cwd;
}

export async function checkDependencies(root, plan) {
  for (const path of plan.dependencyRoots) await inWorktree(root, resolve(root, path));
  for (const { link, target } of plan.workspaceLinks) {
    const installed = await inWorktree(root, resolve(root, link));
    const expected = await inWorktree(root, resolve(root, target));
    if (installed !== expected) throw new Error(`dependency link does not target this worktree: ${link}`);
  }
}

async function checkEnvironment(root, paths, plan, action) {
  const checks = [];
  for (const spec of plan.environmentChecks) {
    const log = `environment-${action}-${checks.length + 1}.log`;
    const started = Date.now();
    let result;
    try {
      const cwd = await executionDirectory(root, spec);
      result = await commandResult(formatCommand(spec), cwd, paths.file(log), 60_000, executionEnvironment(plan, spec));
    } catch (error) {
      await writeFile(paths.file(log), `${error instanceof Error ? error.message : String(error)}\n`);
      result = { command: formatCommand(spec), exitCode: 1, durationMs: Date.now() - started, timedOut: false, cancelled: false };
    }
    const output = stripVTControlCharacters(await readFile(paths.file(log), 'utf8')).replaceAll('\r\n', '\n');
    const matched = result.exitCode === 0 && spec.expectedOutput.every(value => output.includes(value));
    checks.push({ ...result, spec, log, matched });
    await save(paths.file(`environment-${action}.json`), { toolchains: plan.toolchains, checks });
    if (!matched) throw new Error(`environment check failed or expected output missing; read ${log}`);
  }
}

function formatCommand(command) {
  const quote = process.platform === 'win32'
    ? value => `"${value}"`
    : value => `'${value.replaceAll("'", "'\\''")}'`;
  return [command.file, ...command.args].map(quote).join(' ');
}

export function routeDecision(raw, previous) {
  const data = routingSchema.parse(raw);
  const files = data.candidateFiles === null ? null : [...new Set(data.candidateFiles)];
  const workspaces = new Set((files ?? []).filter(p => /^(packages|apps|services)\/[^/]+\//.test(p)).map(p => p.split('/').slice(0, 2).join('/')));
  const reasons = [];
  let tier = 'standard';
  if (data.highRisk || files?.some(p => riskPath.test(p))) reasons.push('high_risk');
  if (data.crossModule || workspaces.size > 1) reasons.push('cross_module');
  if (files && files.length > 10) reasons.push('many_files');
  if (reasons.length) tier = 'deep';
  else if (!data.requirementsClear) reasons.push('unresolved_requirements');
  else if (files && files.length >= 1 && files.length <= 3 && data.crossModule === false) {
    tier = 'fast';
    reasons.push('small_known_local_change');
  } else reasons.push(files?.length ? 'standard_scope' : 'unknown_or_zero_match');
  if (previous && rank[previous] > rank[tier]) {
    tier = previous;
    reasons.push('retain_previous_tier');
  }
  return { tier, reasons, candidateFileCount: files?.length ?? null };
}

export function executionDecision(raw) {
  const input = z.object({ schemaVersion: z.literal(1), tasksIndependent: z.boolean().nullable(),
    subagents: z.object({ available: z.boolean().nullable(), tool: z.string().trim().min(1).nullable(), evidence: z.string().trim().min(1) }).strict(),
  }).strict().parse(raw);
  if (input.subagents.available && !input.subagents.tool) throw new Error('An available subagent capability requires an observed tool name');
  const sdd = input.tasksIndependent === true && input.subagents.available === true;
  return { mode: sdd ? 'sdd' : 'native', reason: sdd ? 'independent_tasks_and_observed_subagent_tool' : input.tasksIndependent !== true ? 'tasks_coupled_or_independence_unknown' : 'subagent_capability_unavailable_or_unknown', evidence: input.subagents.evidence };
}

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

export async function initialize(root, runId, base) {
  if (!runId || !base) throw new Error('run identity and base are required');
  try { return await readContext(root, runId); }
  catch (error) { if (error.message !== 'Run artifacts have not been initialized') throw error; }
  const paths = newArtifactPaths(root, runId);
  for (const directory of [paths.directory, dirname(paths.file('run.json')), dirname(paths.file('design.md')), dirname(paths.file('plan.md'))]) {
    await mkdir(directory, { recursive: true });
    await inWorktree(root, directory);
  }
  const path = paths.file('run.json');
  const data = { schemaVersion: 1, runId, base, root: await realpath(root), artifactPrefix: paths.prefix };
  await save(path, data);
  return data;
}

export async function readContext(root, runId) {
  const data = await json(artifactPaths(root, runId).file('run.json'));
  if (data.runId !== runId || data.root !== await realpath(root)) throw new Error('context belongs to a different run or worktree');
  return data;
}

export async function commandResult(command, cwd, logPath, timeoutMs = 900_000, env = process.env) {
  const started = Date.now();
  const fd = openSync(logPath, 'w');
  const windows = process.platform === 'win32';
  const child = spawn(command, {
    cwd, env, shell: windows ? process.env.ComSpec || 'cmd.exe' : 'sh',
    detached: !windows, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  let timedOut = false;
  let cancelled = false;
  let failure;
  const killTree = () => {
    if (!child.pid) return;
    if (windows) {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The process group already exited. */ }
    }
  };
  const cancel = () => { cancelled = true; killTree(); };
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
  const status = await new Promise(resolveStatus => {
    child.once('error', error => { failure = error.message; resolveStatus(null); });
    child.once('close', code => resolveStatus(code));
  });
  clearTimeout(timer);
  process.removeListener('SIGTERM', cancel);
  process.removeListener('SIGINT', cancel);
  if (failure || timedOut || cancelled) await appendFile(logPath, `\n${failure ?? (timedOut ? 'command process tree timed out' : 'command cancelled')}\n`);
  return { command, exitCode: timedOut || cancelled || failure ? 1 : status ?? 1, durationMs: Date.now() - started, timedOut, cancelled, ...(failure ? { spawnError: failure } : {}) };
}

export async function captureDiff(root, runId, base) {
  const paths = artifactPaths(root, runId);
  const selection = ['.', ...(paths.legacy ? ['.superpowers/probe'] : ['', 'probe/', 'specs/', 'plans/'].map(category => `${artifactDirectory}/${category}${paths.prefix}-*`)).map(path => `:(exclude)${path}`)];
  const tracked = spawnSync('git', ['diff', '--no-ext-diff', '--binary', base, '--', ...selection], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (tracked.status !== 0) throw new Error(tracked.stderr || 'cannot capture task diff');
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...selection], { cwd: root, encoding: 'utf8' });
  if (untracked.status !== 0) throw new Error('cannot enumerate new files');
  const files = untracked.stdout.split('\0').filter(Boolean);
  let output = tracked.stdout;
  for (const path of files) {
    const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--binary', '--', '/dev/null', path], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (diff.status !== 0 && diff.status !== 1) throw new Error(`cannot capture new file: ${path}`);
    output += diff.stdout;
  }
  await writeFile(paths.file('branch.diff'), output);
  return createHash('sha256').update(output).digest('hex');
}

export async function main(action) {
  if (!['init', 'route', 'execution', 'baseline', 'verify', 'seal'].includes(action)) throw new Error(`unknown workflow action: ${action}`);
  const root = process.cwd();
  const runId = ['init', 'route'].includes(action)
    ? process.env.CEZ_TASK_ID || process.env.CEZ_RUN_ID
    : process.env.CEZ_RUN_ID || process.env.CEZ_TASK_ID;
  if (action === 'init') {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (head.status !== 0) throw new Error('an isolated Git worktree is required');
    const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' });
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
    if (gitDir.status !== 0 || common.status !== 0 || gitDir.stdout.trim() === common.stdout.trim()) throw new Error('select an isolated cezar worktree, not in-place execution');
    await initialize(root, runId, head.stdout.trim());
    console.log(artifactPaths(root, runId).file('run.json'));
    return;
  }
  const context = await readContext(root, runId);
  const paths = artifactPaths(root, runId);
  if (action === 'route') {
    const data = await json(paths.file('routing-input.json'));
    const previous = existsSync(paths.file('route.json')) ? (await json(paths.file('route.json'))).tier : undefined;
    const decision = routeDecision(data, previous);
    await save(paths.file('route.json'), decision);
    console.log(decision.tier);
    return;
  }
  if (action === 'execution') {
    const decision = executionDecision(await json(paths.file('execution-input.json')));
    await save(paths.file('execution.json'), decision);
    console.log(decision.mode);
    return;
  }
  if (action === 'baseline' || action === 'verify') {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20+ is required');
    const environment = await json(paths.file('environment.json'));
    const plan = await validationPlan(root, action === 'baseline' ? environment : await json(paths.file('validation-plan.json')));
    if (action === 'baseline') await save(paths.file('validation-plan.json'), plan);
    const commands = action === 'baseline' ? [...plan.setup, ...plan.baseline] : plan.verify;
    const results = [];
    let dependenciesChecked = false;
    for (const spec of commands) {
      if (spec.kind !== 'setup' && !dependenciesChecked) {
        await checkDependencies(root, plan);
        await checkEnvironment(root, paths, plan, action);
        dependenciesChecked = true;
      }
      const cwd = await executionDirectory(root, spec);
      const command = formatCommand(spec);
      const log = `${action}-${results.length + 1}.log`;
      const result = await commandResult(command, cwd, paths.file(log), 900_000, executionEnvironment(plan, spec));
      const expected = action === 'baseline' ? spec.expectedFailure : undefined;
      const output = stripVTControlCharacters(await readFile(paths.file(log), 'utf8')).replaceAll('\r\n', '\n');
      const outputHash = createHash('sha256').update(output).digest('hex');
      const knownFailure = expected && !result.timedOut && !result.cancelled && !result.spawnError && result.exitCode === expected.exitCode && outputHash === expected.outputHash && expected.outputIncludes.every(fragment => output.includes(fragment));
      const classification = result.exitCode === 0 ? 'passed' : knownFailure ? 'known-product-failure' : 'unexpected-failure';
      results.push({ ...result, spec, log, classification, outputHash });
      console.log(`${command}: exit ${result.exitCode} (${result.durationMs}ms)`);
      await save(paths.file(`${action}.json`), { runId, results });
      if (result.exitCode !== 0 && !knownFailure) throw new Error(`${action} failed; read ${log}`);
    }
    if (action === 'verify') {
      const diffHash = await captureDiff(root, runId, context.base);
      await save(paths.file('verified.json'), { runId, diffHash, commands });
    }
    return;
  }
  if (action === 'seal') {
    const verified = await json(paths.file('verified.json'));
    const currentHash = await captureDiff(root, runId, context.base);
    if (verified.runId !== runId || verified.diffHash !== currentHash) throw new Error('code changed after final verification');
    console.log('Verified task diff unchanged; return to cezar review.');
    return;
  }
  throw new Error(`unknown action: ${action}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(async error => {
    console.error(error.message);
    try {
      const action = process.argv[2];
      const identity = ['init', 'route'].includes(action) ? process.env.CEZ_TASK_ID || process.env.CEZ_RUN_ID : process.env.CEZ_RUN_ID || process.env.CEZ_TASK_ID;
      await readContext(process.cwd(), identity);
      await writeFile(artifactPaths(process.cwd(), identity).file('last-failure.txt'), error.message + '\n');
    } catch { /* Another run's context must remain untouched, including failure reporting. */ }
    process.exitCode = 1;
  });
}
