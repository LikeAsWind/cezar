import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgeKindOfRemote, forgeWebRoot, resolveForge } from './index.ts';
import { readGitlabHosts } from './gitlab-hosts.ts';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), homedir: () => fixture.home }));

describe('GitLab host metadata', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cez-glab-hosts-'));
    fixture.home = join(dir, 'home');
    vi.stubEnv('GLAB_CONFIG_DIR', dir);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });
  const config = (content: string) => writeFile(join(dir, 'config.yml'), content);

  it('keeps unchanged configuration identity stable across process/module restarts', async () => {
    await config('hosts:\n  code.example.net: {}\n');
    const first = await import('./gitlab-hosts.ts');
    await first.readGitlabHosts();
    const revision = first.gitlabConfigRevision();
    vi.resetModules();
    const restarted = await import('./gitlab-hosts.ts');
    await restarted.readGitlabHosts();
    expect(restarted.gitlabConfigRevision()).toBe(revision);
  });

  it('uses the glab override before local-AppData, legacy, XDG user and XDG system locations', async () => {
    const local = join(dir, 'local', 'glab-cli');
    const legacy = join(fixture.home, '.config', 'glab-cli');
    const xdg = join(dir, 'xdg', 'glab-cli');
    const system = join(dir, 'system', 'glab-cli');
    for (const [path, host] of [[local, 'local.example.net'], [legacy, 'legacy.example.net'], [xdg, 'xdg.example.net'], [system, 'system.example.net']]) {
      await mkdir(path!, { recursive: true });
      await writeFile(join(path!, 'config.yml'), `hosts:\n  ${host}: {}\n`);
    }
    vi.stubEnv('LOCALAPPDATA', join(dir, 'local'));
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
    vi.stubEnv('XDG_CONFIG_DIRS', join(dir, 'system'));
    expect([...(await readGitlabHosts())]).toEqual([]); // Override never falls through.
    vi.stubEnv('GLAB_CONFIG_DIR', '');
    expect((await readGitlabHosts()).has('local.example.net')).toBe(true);
    await rm(join(local, 'config.yml'));
    expect((await readGitlabHosts()).has('legacy.example.net')).toBe(true);
    await rm(join(legacy, 'config.yml'));
    vi.stubEnv('XDG_CONFIG_DIRS', join(dir, 'system2')); // Different search paths invalidate the cache.
    expect((await readGitlabHosts()).has('xdg.example.net')).toBe(true);
    await rm(join(xdg, 'config.yml'));
    vi.stubEnv('XDG_CONFIG_DIRS', join(dir, 'system'));
    expect((await readGitlabHosts()).has('system.example.net')).toBe(true);
  });

  it('reads only host metadata and maps SSH aliases to canonical web origins', async () => {
    await config(`hosts:
  code.example.com:8443:
    token: fixture-credential
    ssh_host: ssh.example.com:2222
    api_host: api.example.com:9443
    api_protocol: https
  second.example.com:8080:
    api_protocol: http
`);
    const hosts = await readGitlabHosts();
    expect(hosts.get('ssh.example.com')).toEqual({ host: 'code.example.com:8443', webOrigin: 'https://code.example.com:8443' });
    expect(hosts.get('second.example.com')).toEqual({ host: 'second.example.com:8080', webOrigin: 'http://second.example.com:8080' });
    expect(forgeKindOfRemote('ssh://git@ssh.example.com:2222/group/sub/project.git')).toBe('gitlab');
    expect(forgeWebRoot('ssh://git@ssh.example.com:2222/group/sub/project.git')).toBe('https://code.example.com:8443/group/sub/project');
    expect(forgeKindOfRemote('https://api.example.com/group/project.git')).toBeNull();
    expect(resolveForge({ root: '/repo', branch: 'main', remote: 'git@ssh.example.com:group/sub/project.git' })?.kind).toBe('gitlab');
    expect(JSON.stringify([...hosts])).not.toContain('fixture-credential');
  });

  it('classifies cold unknown hosts only after warming and never guesses from their name', async () => {
    expect(forgeKindOfRemote('git@new-gitlab.example.net:group/project.git')).toBeNull();
    await config('hosts:\n  new-gitlab.example.net: {}\n');
    await readGitlabHosts();
    expect(forgeKindOfRemote('git@new-gitlab.example.net:group/project.git')).toBe('gitlab');
    expect(forgeKindOfRemote('git@other-gitlab.example.net:group/project.git')).toBeNull();
  });

  it('distinguishes HTTP ports on one host and rejects ambiguous SSH hostnames', async () => {
    await config(`hosts:
  shared.example.net:8443:
    ssh_host: first-ssh.example.net:2222
  shared.example.net:9443:
    ssh_host: second-ssh.example.net:2222
`);
    await readGitlabHosts();
    expect(forgeWebRoot('https://shared.example.net:8443/group/sub/first.git')).toBe('https://shared.example.net:8443/group/sub/first');
    expect(forgeWebRoot('https://shared.example.net:9443/group/sub/second.git')).toBe('https://shared.example.net:9443/group/sub/second');
    expect(forgeWebRoot('ssh://git@shared.example.net:8443/group/project.git')).toBeNull();
    expect(forgeKindOfRemote('git@shared.example.net:group/project.git')).toBeNull();
    expect(forgeWebRoot('git@first-ssh.example.net:group/project.git')).toBe('https://shared.example.net:8443/group/project');
  });

  it.each(['https', 'http'])('does not classify an implicit default %s port from a custom-port instance', async (protocol) => {
    await config(`hosts:\n  isolated.example.net:8443:\n    api_protocol: ${protocol}\n`);
    await readGitlabHosts();
    expect(forgeKindOfRemote(`${protocol}://isolated.example.net/group/project.git`)).toBeNull();
    expect(forgeWebRoot(`${protocol}://isolated.example.net/group/project.git`)).toBeNull();
    expect(forgeWebRoot(`${protocol}://isolated.example.net:8443/group/project.git`)).toBe(`${protocol}://isolated.example.net:8443/group/project`);
  });

  it.each([['https', '443'], ['http', '80']])('keeps default and custom %s ports independently addressable', async (protocol, port) => {
    await config(`hosts:
  coexist.example.net:
    api_protocol: ${protocol}
  coexist.example.net:8443:
    api_protocol: ${protocol}
`);
    await readGitlabHosts();
    expect(forgeKindOfRemote(`${protocol}://coexist.example.net/group/default.git`)).toBe('gitlab');
    expect(forgeWebRoot(`${protocol}://coexist.example.net/group/default.git`)).toBe(`${protocol}://coexist.example.net/group/default`);
    expect(forgeWebRoot(`${protocol}://coexist.example.net:${port}/group/default.git`)).toBe(`${protocol}://coexist.example.net/group/default`);
    expect(forgeWebRoot(`${protocol}://coexist.example.net:8443/group/custom.git`)).toBe(`${protocol}://coexist.example.net:8443/group/custom`);
    expect(forgeKindOfRemote('git@coexist.example.net:group/project.git')).toBeNull();
  });

  it.each([['https', '443'], ['http', '80']])('normalizes explicitly configured default %s ports', async (protocol, port) => {
    await config(`hosts:\n  normalized.example.net:${port}:\n    api_protocol: ${protocol}\n`);
    await readGitlabHosts();
    expect(forgeWebRoot(`${protocol}://normalized.example.net:${port}/group/project.git`)).toBe(`${protocol}://normalized.example.net/group/project`);
    expect(forgeWebRoot(`${protocol}://normalized.example.net/group/project.git`)).toBe(`${protocol}://normalized.example.net/group/project`);
  });

  it('keeps SSH alias ambiguity separate from exact HTTP instance matching', async () => {
    await config(`hosts:
  first.example.net:
    ssh_host: shared-ssh.example.net
  second.example.net:
    ssh_host: shared-ssh.example.net
`);
    await readGitlabHosts();
    expect(forgeWebRoot('https://first.example.net/group/project.git')).toBe('https://first.example.net/group/project');
    expect(forgeWebRoot('https://second.example.net/group/project.git')).toBe('https://second.example.net/group/project');
    expect(forgeKindOfRemote('git@shared-ssh.example.net:group/project.git')).toBeNull();
    expect(forgeKindOfRemote('https://shared-ssh.example.net/group/project.git')).toBeNull();
  });

  it('expires additions and removals instead of retaining stale host mappings', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await config('hosts:\n  before.example.net: {}\n');
    await readGitlabHosts();
    await config('hosts:\n  after.example.net: {}\n');
    expect((await readGitlabHosts()).has('before.example.net')).toBe(false);
    vi.setSystemTime(Date.now() + 5_001);
    expect(forgeKindOfRemote('git@before.example.net:group/project.git')).toBeNull();
    const hosts = await readGitlabHosts();
    expect(hosts.has('before.example.net')).toBe(false);
    expect(hosts.has('after.example.net')).toBe(true);
    expect(forgeKindOfRemote('git@before.example.net:group/project.git')).toBeNull();
  });

  it('discovers metadata without a glab executable or network subprocess', async () => {
    vi.stubEnv('PATH', '');
    await config('hosts:\n  offline.example.net: {}\n');
    await readGitlabHosts();
    expect(forgeKindOfRemote('git@offline.example.net:group/project.git')).toBe('gitlab');
    expect(resolveForge({ root: '/repo', branch: 'main', remote: 'git@offline.example.net:group/project.git' })?.kind).toBe('gitlab');
  });

  it.each(['hosts: [', 'hosts: invalid', 'hosts:\n  bad.example.net: null\n', 'hosts:\n  "user:credential@evil.example.net": {}\n'])('ignores malformed metadata without leaking parser errors', async (content) => {
    await config(content);
    expect([...(await readGitlabHosts())]).toEqual([]);
  });

  it('degrades quietly for an absent or unreadable config', async () => {
    expect([...(await readGitlabHosts())]).toEqual([]);
    vi.stubEnv('GLAB_CONFIG_DIR', join(dir, 'unreadable'));
    await mkdir(join(dir, 'unreadable', 'config.yml'), { recursive: true });
    expect([...(await readGitlabHosts())]).toEqual([]);
  });
});
