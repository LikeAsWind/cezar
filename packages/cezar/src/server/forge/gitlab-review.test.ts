import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createGitlabApi, gitlabClient, gitlabOperation, gitlabReason, type GitlabCommandRunner } from './gitlab-api.ts';
import { readGitlabHosts } from './gitlab-hosts.ts';
import { createGitlabReads } from './gitlab-read.ts';
import { createGitlabDriver } from './gitlab.ts';

const cli = vi.hoisted(() => ({ run: vi.fn<GitlabCommandRunner>() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const execFile = Object.assign((...args: unknown[]) => Reflect.apply(actual.execFile, actual, args), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (file: string, args: string[], options: Parameters<GitlabCommandRunner>[1]) => {
      if (file !== 'glab') throw new Error('Unexpected subprocess in the GitLab review fixture');
      return { stdout: await cli.run(args, options), stderr: '' };
    },
  });
  return { ...actual, execFile };
});

let sequence = 0;
let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); cli.run.mockReset();
  if (directory) { await rm(directory, { recursive: true, force: true }); directory = undefined; }
});
const item = (iid: number) => ({ iid, title: `Item ${iid}`, state: 'opened', created_at: '2026-10-16T00:00:00Z',
  web_url: 'https://code.example.net/group/project', author: { username: 'ada' }, labels: [], user_notes_count: 0 });
async function configFixture() {
  directory = await mkdtemp(join(tmpdir(), 'cez-glab-review-'));
  vi.stubEnv('GLAB_CONFIG_DIR', directory); vi.stubEnv('CEZ_DRY_RUN', '0');
  const file = join(directory, 'config.yml');
  const write = (api: 'a' | 'b') => writeFile(file, `hosts:\n  code.example.net:\n    api_host: api-${api}.internal\n    token: fixture-credential\n`);
  await write('a'); await readGitlabHosts();
  cli.run.mockImplementation(async () => {
    const content = await readFile(file, 'utf8');
    return JSON.stringify(Array.from({ length: 20 }, (_, index) => item(index + 1 + (content.includes('api-b') ? 100 : 0))));
  });
  return { ref: { host: 'code.example.net', projectPath: 'group/project' }, root: directory, write };
}

describe('GitLab review regressions', () => {
  it('never exposes CLI commands, credential URLs, response headers or bodies in public failure reasons', async () => {
    const secret = 'fixture-secret';
    const ref = { host: `sanitized-${++sequence}.example`, projectPath: 'group/project' };
    const upstream = `Command failed: glab api https://user:${secret}@api.example/projects\nPRIVATE-TOKEN: ${secret}\n${secret}`;
    const run: GitlabCommandRunner = async () => { throw Object.assign(new Error(upstream), { stderr: `HTTP/2.0 502 Bad Gateway\r\nPRIVATE-TOKEN: ${secret}\r\n\r\n${secret}` }); };
    const result = await createGitlabReads('/repo', ref, run).list();
    expect(result.available).toBe(false);
    expect(result.reason).toBe('GitLab API returned 502');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(gitlabReason(new Error(upstream), ref)).not.toContain(secret);
    const malformed: GitlabCommandRunner = async () => `not-json-${secret}`;
    const invalid = await createGitlabReads('/repo', { ...ref, host: `invalid-${sequence}.example` }, malformed).list();
    expect(invalid.reason).not.toContain(secret);
  });
  it.each([
    [{ code: 'ENOENT' }, 'glab CLI not found'],
    [{ code: 'ETIMEDOUT' }, 'timed out'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'size budget'],
    [{ stderr: 'glab: forbidden (HTTP 403)' }, 'GitLab access denied'],
    [{ stderr: 'glab: not found (HTTP 404)' }, 'GitLab API returned 404'],
    [{ stderr: 'glab: unavailable (HTTP 503)' }, 'GitLab API returned 503'],
    [{}, 'GitLab request failed'],
  ])('keeps useful failure categories while discarding unsafe diagnostics %j', async (fields, reason) => {
    const ref = { host: `failure-${++sequence}.example`, projectPath: 'group/project' };
    const run: GitlabCommandRunner = async () => { throw Object.assign(new Error('fixture-secret'), fields); };
    const result = await createGitlabReads('/repo', ref, run).list();
    expect(result.reason).toContain(reason); expect(result.reason).not.toContain('fixture-secret');
  });
  it('honors an HTTP-date Retry-After on a nonzero glab exit', async () => {
    let now = Date.UTC(2026, 9, 16, 0, 0); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const until = new Date(now + 3_600_000).toUTCString();
    const ref = { host: `cooldown-${++sequence}.example`, projectPath: 'group/project' };
    const run = vi.fn<GitlabCommandRunner>().mockRejectedValue(Object.assign(new Error('glab API failed (HTTP 429)'), { stderr: `HTTP/2.0 429 Too Many Requests\r\nRetry-After: ${until}\r\n\r\nfixture-secret` }));
    const api = createGitlabApi('/repo', ref, run);
    await expect(api.api('issues', z.array(z.unknown()))).rejects.toMatchObject({ status: 429 });
    now += 61_000;
    await expect(api.api('issues', z.array(z.unknown()))).rejects.toMatchObject({ status: 429 });
    expect(run).toHaveBeenCalledTimes(1);
    now += 3_600_000; run.mockResolvedValue('[]');
    await expect(api.api('issues', z.array(z.unknown()))).resolves.toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('rotates production clients and discards cached rows when the same glab config file changes API host', async () => {
    const { root, ref, write } = await configFixture();
    const previous = gitlabClient(root, ref);
    expect((await createGitlabReads(root, ref).list()).issues[0]?.number).toBe(1);
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    await write('b'); now += 5_001; await readGitlabHosts();
    const current = gitlabClient(root, ref);
    expect(current).not.toBe(previous);
    expect((await createGitlabReads(root, ref).list()).issues[0]?.number).toBe(101);
    expect(cli.run).toHaveBeenCalledTimes(4);
  });
  it('rejects old within-page cursors after same-file config replacement without exposing config contents', async () => {
    const { root, ref, write } = await configFixture();
    const first = await createGitlabReads(root, ref).list({ limit: 15 });
    const decoded = Buffer.from(first.issuesNextCursor!, 'base64url').toString();
    expect(decoded).not.toContain('fixture-credential'); expect(decoded).not.toContain('api-a.internal'); expect(decoded).not.toContain(root);
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    await write('b'); now += 5_001; await readGitlabHosts();
    const continued = await createGitlabReads(root, ref).list({ limit: 15, issuesCursor: first.issuesNextCursor!, refresh: true });
    expect(continued.available).toBe(false);
    expect(continued.issues).toEqual([]);
  });
  it('rejects an old in-flight response when config changes and prevents its cache publication', async () => {
    const { root, ref, write } = await configFixture();
    let release!: (value: string) => void;
    cli.run.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const previous = gitlabClient(root, ref);
    const request = previous.api('issues', z.array(z.unknown()));
    const assertion = expect(request).rejects.toThrow('configuration changed');
    await vi.waitFor(() => expect(cli.run).toHaveBeenCalledTimes(1));
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    await write('b'); now += 5_001; await readGitlabHosts();
    release(JSON.stringify([item(1)])); await assertion;
    await expect(previous.api('issues', z.array(z.unknown()))).rejects.toThrow('configuration changed');
    expect((await createGitlabReads(root, ref).list()).issues[0]?.number).toBe(101);
  });
  it('retains the production client across unchanged metadata TTL refreshes', async () => {
    const { root, ref } = await configFixture();
    const first = gitlabClient(root, ref);
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    now += 5_001; await readGitlabHosts();
    expect(gitlabClient(root, ref)).toBe(first);
  });
  it('retires a production client when the selected config disappears or is created again', async () => {
    const { root, ref, write } = await configFixture();
    const configured = gitlabClient(root, ref);
    await rm(join(root, 'config.yml')); await readGitlabHosts();
    const missing = gitlabClient(root, ref);
    expect(missing).not.toBe(configured);
    await write('a'); await readGitlabHosts();
    const recreated = gitlabClient(root, ref);
    expect(recreated).not.toBe(missing); expect(recreated).not.toBe(configured);
  });
  it('retires cached availability for a changed config generation', async () => {
    const { root, ref, write } = await configFixture();
    cli.run.mockResolvedValue(JSON.stringify({ id: 1, path_with_namespace: ref.projectPath }));
    const previous = createGitlabDriver(root, ref);
    expect(await previous.detect()).toEqual({ available: true });
    expect(previous.detectCached()).toEqual({ available: true });
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    await write('b'); now += 5_001; await readGitlabHosts();
    expect(previous.detectCached()).toBeNull();
    const current = createGitlabDriver(root, ref);
    expect(await current.detect()).toEqual({ available: true });
    expect(cli.run).toHaveBeenCalledTimes(2);
  });
  it('pins nested reads to one config generation even when a new client is selected', async () => {
    const { root, ref, write } = await configFixture();
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    await gitlabOperation(async () => {
      await gitlabClient(root, ref).api('issues', z.array(z.unknown()));
      await write('b'); now += 5_001; await readGitlabHosts();
      await expect(gitlabClient(root, ref).api('issues', z.array(z.unknown()), { refresh: true })).rejects.toThrow('configuration changed');
    });
    expect(cli.run).toHaveBeenCalledTimes(1);
  });
});
