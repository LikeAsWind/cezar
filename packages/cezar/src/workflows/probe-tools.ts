import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

type Locations = { javaHomes: string[]; mavenExecutables: string[]; versions: 'not queried'; incomplete: boolean };
/** Bounded discovery from actual environment/PATH evidence; no shell or recursive scan. */
export async function discoverJavaLocations(env: NodeJS.ProcessEnv = process.env): Promise<Locations> {
  const found: Locations = { javaHomes: [], mavenExecutables: [], versions: 'not queried', incomplete: false };
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scan(env, found, () => expired).catch(() => { found.incomplete = true; }),
      new Promise<void>(resolve => { timer = setTimeout(() => { expired = true; found.incomplete = true; resolve(); }, 2_000); }),
    ]);
    return { ...found, javaHomes: [...new Set(found.javaHomes)], mavenExecutables: [...new Set(found.mavenExecutables)].slice(0, 8) };
  } finally { expired = true; if (timer) clearTimeout(timer); }
}

async function scan(env: NodeJS.ProcessEnv, found: Locations, expired: () => boolean): Promise<void> {
  const value = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const local = (path: string) => isAbsolute(path) && !path.startsWith('\\\\') && !path.startsWith('//');
  const dirs = [...new Set((value('PATH') ?? '').split(delimiter).map(path => path.replace(/^"|"$/g, '')).filter(local))].slice(0, 128);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const isFile = async (path: string) => { try { return (await stat(path)).isFile(); } catch { return false; } };
  const candidates = new Set<string>();
  for (const name of ['JAVA_HOME', 'JDK_HOME']) { const home = value(name); if (home && local(home)) candidates.add(home); }
  const mavenExecutables = found.mavenExecutables;
  for (const dir of dirs) {
    if (expired()) return;
    const java = join(dir, 'java' + suffix);
    if (await isFile(java)) {
      if (expired()) return;
      if (basename(dir).toLowerCase() === 'bin') candidates.add(dirname(dir));
      try { candidates.add(dirname(dirname(await realpath(java)))); } catch { /* Unknown link target. */ }
    }
    for (const name of process.platform === 'win32' ? ['mvn.exe', 'mvn.cmd', 'mvn.bat'] : ['mvn']) {
      if (expired()) return;
      const executable = join(dir, name);
      if (await isFile(executable)) { mavenExecutables.push(executable); break; }
    }
  }
  // An installed JDK on PATH often lives beside another required version.
  for (const parent of [...new Set([...candidates].map(dirname))].slice(0, 8)) {
    if (expired()) return;
    try {
      const siblings = await readdir(parent, { withFileTypes: true });
      for (const sibling of siblings.filter(entry => entry.isDirectory()).slice(0, 64)) candidates.add(join(parent, sibling.name));
    } catch { /* Read-only evidence can be absent. */ }
  }
  const javaHomes = found.javaHomes;
  for (const home of candidates) {
    if (expired()) return;
    if (await isFile(join(home, 'bin', 'java' + suffix)) && await isFile(join(home, 'bin', 'javac' + suffix))) javaHomes.push(home);
    if (javaHomes.length === 12) break;
  }
}
