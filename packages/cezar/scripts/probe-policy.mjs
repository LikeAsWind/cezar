// Host-owned probe boundary. No dependencies on the target project or snapshot.
import { realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { artifactPaths } from './workflow/artifacts.mjs';

const script = fileURLToPath(import.meta.url);
const quote = value => `'${value.replaceAll('\\', '/')}'`;
const prefix = `${quote(process.execPath)} ${quote(script)} version `;
const safe = value => !/[\r\n\0'"`$%!^&|<>]/.test(value);
const flags = new Set(['--version', '-version', '-v']);
const reports = new Set(['probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json']);

async function writable(root, runId, path) {
  if (typeof path !== 'string') return false;
  const target = resolve(root, path);
  const paths = artifactPaths(root, runId);
  if (![...reports].some(name => target === paths.file(name))) return false;
  const directory = await realpath(dirname(target));
  if (await realpath(dirname(target)) !== directory) return false;
  return !existsSync(target) || await realpath(target) === join(directory, basename(target));
}

function deny(reason) { throw new Error(reason); }

async function decide(root, runId, event) {
  const tool = event.tool_name, input = event.tool_input;
  if (!input || typeof input !== 'object') return false;
  if (['Read', 'Glob', 'Grep'].includes(tool)) {
    artifactPaths(root, runId);
    const inside = async path => { const rel = relative(await realpath(root), await realpath(resolve(root, path))); return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel); };
    if (tool === 'Grep' && (typeof input.path !== 'string' || resolve(root, input.path) === resolve(root) || !await inside(input.path))) deny('Grep requires a specific file or module directory inside this worktree. Use Glob to locate the relevant module/file first, then search that path.');
    if (tool === 'Glob') {
      if (typeof input.pattern !== 'string' || input.pattern.startsWith('~') || input.pattern.startsWith('/') || input.pattern.includes(':') || input.pattern.replaceAll('\\', '/').split('/').includes('..') || isAbsolute(input.pattern)) deny('Glob requires a repository-relative pattern such as **/pom.xml; pass the worktree directory as path.');
      if (typeof input.path === 'string' && !await inside(input.path)) deny('Glob path must stay inside the task worktree; use host-discovered tool locations instead of scanning external installations.');
    }
    // Saving early is advisory: a slow first turn must not prevent the reads needed for a truthful map.
    return true;
  }
  if (['Write', 'Edit'].includes(tool)) {
    if (!await writable(root, runId, input.file_path)) deny('Probe may write only the four mapped probe reports. The host handoff, run.json, source and configuration are read-only in this stage.');
    return true;
  }
  if (tool !== 'Bash' || typeof input.command !== 'string') deny('This tool is unavailable during probe; use native Read/Glob/Grep and mapped report writes, without delegation.');
  // Only the exact host executable and script, no shell syntax or appended commands.
  if (!input.command.startsWith(prefix)) deny('Probe Bash permits only the exact host version-query command. Use Glob to list repository files; compilation, tests and arbitrary shell commands belong to later stages.');
  const match = /^'([^']+)' '([^']+)' '([^']*)'$/.exec(input.command.slice(prefix.length));
  if (!match) deny('Version query requires exactly three single-quoted arguments: executable, version flag and Java home (or empty string); no shell chaining.');
  const [, file, flag, javaHome] = match;
  if (![file, flag, javaHome].every(safe) || !flags.has(flag) || !(isAbsolute(file) || /^[\w.-]+$/.test(file)) || javaHome && !isAbsolute(javaHome)) deny('Version query needs an observed executable, --version/-version/-v, and an absolute Java home or empty string.');
  return true;
}

async function version(file, flag, javaHome = '') {
  if (!file || ![file, flag, javaHome].every(safe) || !flags.has(flag)) throw new Error('only one executable version query is allowed');
  const env = { ...process.env };
  const oldPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  if (javaHome) {
    if (!isAbsolute(javaHome)) throw new Error('Java home must be absolute');
    for (const key of Object.keys(env)) if (['path', 'java_home'].includes(key.toLowerCase())) delete env[key];
    env.JAVA_HOME = javaHome;
    env.PATH = join(javaHome, 'bin') + delimiter + oldPath;
  }
  let executable = file;
  const extensions = process.platform === 'win32' && !/\.(exe|cmd|bat|com)$/i.test(file) ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  if (isAbsolute(file)) executable = extensions.map(ext => file + ext).find(existsSync) ?? file;
  if (!isAbsolute(executable)) {
    if (!/^[\w.-]+$/.test(file)) throw new Error('expected an installed executable');
    const selectedPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    executable = selectedPath.split(delimiter).filter(isAbsolute).flatMap(dir => extensions.map(ext => join(dir, file + ext))).find(existsSync);
    if (!executable) throw new Error('tool unavailable on PATH');
  }
  const physical = await realpath(executable), root = await realpath(process.cwd());
  const rel = relative(root, physical);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('probe never executes project scripts or wrappers; read their declarations instead');
  if (!(await stat(physical)).isFile() || !safe(physical)) throw new Error('invalid installed executable');
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(physical);
  const result = spawnSync(batch ? process.env.ComSpec || 'cmd.exe' : physical,
    batch ? ['/d', '/s', '/c', `""${physical}" ${flag}"`] : [flag],
    { env, cwd: root, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: batch, timeout: 15_000, maxBuffer: 256 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[2] === 'hook') {
  let allowed = false;
  let reason = 'Malformed probe tool input.';
  try {
    let text = '';
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 1024 * 1024) throw new Error('hook input too large'); }
    allowed = await decide(process.argv[3], process.argv[4], JSON.parse(text));
  } catch (error) { reason = error instanceof Error ? error.message : 'Probe boundary check failed.'; }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allowed ? 'allow' : 'deny',
    permissionDecisionReason: allowed ? 'Probe read/report/version operation.' : reason } }));
} else if (process.argv[2] === 'version' && process.argv.length <= 6) {
  version(...process.argv.slice(3)).catch(error => { console.error(error.message); process.exitCode = 1; });
} else { console.error('expected hook or version'); process.exitCode = 1; }
