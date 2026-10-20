import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, isMap, isScalar } from 'yaml';
import type { ParsedRemote } from '../../git-remotes.ts';

type GitlabHost = { host: string; webOrigin: string };
const CACHE_MS = 5_000;
let cached: { key: string; at: number; hosts: ReadonlyMap<string, GitlabHost>; signature: string; revision: string } | undefined;
let pending: { key: string; value: Promise<ReadonlyMap<string, GitlabHost>> } | undefined;
const unwarmedRevisions = new Map<string, string>();

// glab v1.106 internal/config/config_file.go: override, legacy, XDG user, system.
function configPaths(): string[] {
  if (process.env.GLAB_CONFIG_DIR) return [join(process.env.GLAB_CONFIG_DIR, 'config.yml')];
  const home = homedir();
  // glab v1.106 on Windows writes to %LOCALAPPDATA%\glab-cli\config.yml, not the XDG
  // `~/.config/glab-cli` fallback the path search assumed; the env lookup must cover both.
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const configHome = process.env.XDG_CONFIG_HOME || (process.platform === 'win32'
    ? process.env.APPDATA || join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config'));
  const system = process.env.XDG_CONFIG_DIRS?.split(delimiter).filter(Boolean)
    ?? (process.platform === 'win32' ? [process.env.PROGRAMDATA || 'C:\\ProgramData'] : ['/etc/xdg']);
  return [join(localAppData, 'glab-cli', 'config.yml'), join(home, '.config', 'glab-cli', 'config.yml'),
    join(configHome, 'glab-cli', 'config.yml'),
    ...system.map((dir) => join(dir, 'glab-cli', 'config.yml'))];
}

function hostUrl(value: string, protocol: string): URL | null {
  // Host metadata must never turn credentials, paths or URL fragments into a link.
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(value)) return null;
  try { return new URL(`${protocol}://${value}`); } catch { return null; }
}

async function configSource(paths: string[]): Promise<{ file?: string; signature: string }> {
  for (const path of paths) {
    try {
      const info = await stat(path, { bigint: true });
      return { file: path, signature: JSON.stringify([path, String(info.mtimeNs), String(info.ctimeNs), String(info.size), String(info.dev), String(info.ino)]) };
    } catch { /* next glab search location */ }
  }
  return { signature: 'missing' };
}

async function loadHosts(file?: string): Promise<ReadonlyMap<string, GitlabHost>> {
  const hosts = new Map<string, GitlabHost>();
  const ambiguous = new Set<string>();
  const addHost = (key: string, metadata: GitlabHost) => {
    if (ambiguous.has(key)) return;
    const previous = hosts.get(key);
    if (previous && previous.host !== metadata.host) {
      hosts.delete(key);
      ambiguous.add(key);
    } else hosts.set(key, metadata);
  };
  try {
    if (!file) return hosts;
    const info = await stat(file);
    if (!info.isFile() || info.size > 1_048_576) return hosts;
    // Keep YAML nodes, not a deserialized credential object; retain only allowlisted metadata.
    const doc = parseDocument(await readFile(file, 'utf8'), { logLevel: 'silent' });
    if (doc.errors.length || !isMap(doc.contents)) return hosts;
    const entries = doc.contents.get('hosts', true);
    if (!isMap(entries)) return hosts;
    for (const entry of entries.items) {
      if (!isScalar(entry.key) || typeof entry.key.value !== 'string' || !isMap(entry.value)) continue;
      const protocol = entry.value.get('api_protocol') ?? 'https';
      if (protocol !== 'http' && protocol !== 'https') continue;
      const web = hostUrl(entry.key.value, protocol);
      if (!web) continue;
      const metadata = { host: entry.key.value.toLowerCase(), webOrigin: web.origin };
      // Origin keys isolate HTTP instances; bare hostname keys resolve only SSH aliases.
      addHost(web.origin, metadata);
      addHost(web.hostname, metadata);
      const sshHost = entry.value.get('ssh_host') ?? entry.value.get('gitlab_ssh_host');
      const ssh = typeof sshHost === 'string' ? hostUrl(sshHost, 'https') : null;
      if (ssh) addHost(ssh.hostname, metadata);
    }
  } catch { /* Missing or unreadable glab state leaves plain Git usable. */ }
  return hosts;
}

/** Metadata only: never executes glab, retains credentials, or probes a remote instance. */
export function readGitlabHosts(): Promise<ReadonlyMap<string, GitlabHost>> {
  const paths = configPaths();
  const key = JSON.stringify(paths);
  if (pending?.key === key) return pending.value;
  const value = (async () => {
    // Stat changes bypass the parse TTL, including same-file account/API-host edits.
    const source = await configSource(paths);
    const previous = cached?.key === key ? cached : undefined;
    if (previous?.signature === source.signature && Date.now() - previous.at < CACHE_MS) return previous.hosts;
    const hosts = await loadHosts(source.file);
    const revision = createHash('sha256').update(JSON.stringify([key, source.signature])).digest('hex');
    if (key === JSON.stringify(configPaths())) cached = { key, at: Date.now(), hosts, signature: source.signature, revision };
    return hosts;
  })().finally(() => { if (pending?.value === value) pending = undefined; });
  pending = { key, value };
  return value;
}

/** Private opaque source identity; no file metadata or credential material leaves this module. */
export function gitlabConfigRevision(): string {
  const key = JSON.stringify(configPaths());
  if (cached?.key === key) return cached.revision;
  let revision = unwarmedRevisions.get(key);
  if (!revision) {
    revision = randomUUID(); unwarmedRevisions.set(key, revision);
    while (unwarmedRevisions.size > 100) unwarmedRevisions.delete(unwarmedRevisions.keys().next().value!);
  }
  return revision;
}

/** Synchronous classification consumes warmed local metadata, never waits for I/O. */
export function knownGitlabHost(remote: ParsedRemote): GitlabHost | undefined {
  return cached?.key === JSON.stringify(configPaths()) && Date.now() - cached.at < CACHE_MS
    ? cached.hosts.get(remote.httpOrigin ?? remote.host) : undefined;
}
