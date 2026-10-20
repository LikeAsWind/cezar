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
const reports = new Set(['request.md', 'probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json']);

async function writable(root, runId, path) {
  if (typeof path !== 'string') return false;
  const target = resolve(root, path);
  const paths = artifactPaths(root, runId);
  if (![...reports].some(name => target === paths.file(name))) return false;
  const directory = await realpath(dirname(target));
  if (await realpath(dirname(target)) !== directory) return false;
  return !existsSync(target) || await realpath(target) === join(directory, basename(target));
}

async function decide(root, runId, event, startedAt) {
  const tool = event.tool_name, input = event.tool_input;
  if (!input || typeof input !== 'object') return false;
  if (['Read', 'Glob', 'Grep'].includes(tool)) {
    const paths = artifactPaths(root, runId);
    const inside = async path => { const rel = relative(await realpath(root), await realpath(resolve(root, path))); return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel); };
    if (tool === 'Grep' && (typeof input.path !== 'string' || resolve(root, input.path) === resolve(root) || !await inside(input.path))) return false;
    if (tool === 'Glob') {
      if (typeof input.pattern !== 'string' || input.pattern.startsWith('~') || input.pattern.startsWith('/') || input.pattern.includes(':') || input.pattern.replaceAll('\\', '/').split('/').includes('..') || isAbsolute(input.pattern)) return false;
      if (typeof input.path === 'string' && !await inside(input.path)) return false;
    }
    const ownReport = tool === 'Read' && typeof input.file_path === 'string' && ['run.json', ...reports].some(name => resolve(root, input.file_path) === paths.file(name));
    if (!ownReport && startedAt > 0 && Date.now() - startedAt > 120_000) {
      for (const name of ['probe.md', 'context-map.jsonl']) if (!existsSync(paths.file(name)) || (await stat(paths.file(name))).size === 0) return false;
    }
    return true;
  }
  if (['Write', 'Edit'].includes(tool)) return writable(root, runId, input.file_path);
  if (tool !== 'Bash' || typeof input.command !== 'string') return false;
  // Only the exact host executable and script, no shell syntax or appended commands.
  if (!input.command.startsWith(prefix)) return false;
  const match = /^'([^']+)' '([^']+)' '([^']*)'$/.exec(input.command.slice(prefix.length));
  if (!match) return false;
  const [, file, flag, javaHome] = match;
  return [file, flag, javaHome].every(safe) && flags.has(flag) && (isAbsolute(file) || /^[\w.-]+$/.test(file)) && (!javaHome || isAbsolute(javaHome));
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
  try {
    let text = '';
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 1024 * 1024) throw new Error('hook input too large'); }
    allowed = await decide(process.argv[3], process.argv[4], JSON.parse(text), Number(process.argv[5]));
  } catch { /* Malformed input and inaccessible paths deny. */ }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allowed ? 'allow' : 'deny',
    permissionDecisionReason: allowed ? 'Probe read/report/version operation.' : 'Probe permits scoped reads/searches, five probe reports and the exact host version query. Grep requires an explicit file/module subdirectory; external Glob and root-wide Grep are denied. After two minutes, save nonempty mapped probe.md and context-map.jsonl from evidence already read before further source searches. Compilation, tests, setup, shell chaining, source edits and delegation belong to later stages. Do not bypass.' } }));
} else if (process.argv[2] === 'version' && process.argv.length <= 6) {
  version(...process.argv.slice(3)).catch(error => { console.error(error.message); process.exitCode = 1; });
} else { console.error('expected hook or version'); process.exitCode = 1; }
