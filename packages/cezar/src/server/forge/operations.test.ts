import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../../runs/store.ts';
import type { RunManager } from '../../workflows/run.ts';
import { createApp } from '../server.ts';
import { testRuntime } from '../runtime.testkit.ts';
import { apiRequest } from '../loopback-request.testkit.ts';
import { readForgeCachedRefStatuses } from './operations.ts';
import { createDraftPr } from '../pr.ts';
import type { GitlabCommandRunner } from './gitlab-api.ts';

const fixture = vi.hoisted(() => ({ root: '', remote: 'git@gitlab.com:group/sub/project.git', base: null as string | null, lookup: vi.fn(), command: vi.fn<GitlabCommandRunner>() }));
vi.mock('../../git-worktree.ts', async (original) => ({ ...await original<typeof import('../../git-worktree.ts')>(), autosaveCommit: async () => 'unchanged', taskRemotes: async () => ({ base: fixture.base, push: 'origin', names: ['origin', 'upstream'] }) }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const run = promisify(actual.execFile);
  return { ...actual, execFile: Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
    [Symbol.for('nodejs.util.promisify.custom')]: (bin: string, args: string[], opts: object) => bin === 'git' && args[0] === 'remote' && args[1] === 'get-url' ? fixture.lookup(args[2]) : run(bin, args, opts),
  }) };
});
vi.mock('../git.ts', async (original) => ({ ...await original<typeof import('../git.ts')>(),
  getRepoInfo: vi.fn(async () => ({ root: fixture.root, branch: 'master', remote: fixture.remote })) }));
vi.mock('./gitlab-api.ts', async (original) => {
  const actual = await original<typeof import('./gitlab-api.ts')>();
  return { ...actual, gitlabClient: (root: string, ref: Parameters<typeof actual.gitlabClient>[1]) => actual.createGitlabApi(root, ref, fixture.command) };
});
const row = (kind: 'issue' | 'pr', closed = false) => ({ iid: 1, title: 'Fixture', state: closed ? 'closed' : 'opened', created_at: '2026-10-16T00:00:00Z', web_url: 'https://gitlab.com/group/sub/project',
  user_notes_count: 0, labels: [], author: { username: 'ada' }, sha: 'a'.repeat(40), description: 'Detail', ...(kind === 'pr' ? { head_pipeline: { id: 3, sha: 'a'.repeat(40), status: 'success' } } : {}) });

describe('existing platform HTTP routes select the project forge', () => {
  let store: RunStore;
  beforeEach(() => {
    fixture.root = mkdtempSync(join(tmpdir(), 'cez-forge-route-'));
    fixture.remote = 'git@gitlab.com:group/sub/project.git';
    fixture.base = null; fixture.lookup.mockReset();
    // GitLab read paths under test here exercise the real bounded-read implementation against the
    // injected command runner; the dry-run catalog mock is covered by `gitlab-dry-run.test.ts`.
    // The GitHub dry-run default and the task-route publish tests opt back in below.
    vi.stubEnv('CEZ_DRY_RUN', '0');
    store = RunStore.open(join(fixture.root, '.ai/cezar'));
    fixture.command.mockReset().mockImplementation(async (args) => {
      const path = args[6]!;
      if (path.includes('/approvals')) return JSON.stringify({ approvals_required: 0, approvals_left: 0 });
      if (path.includes('/notes?') || path.includes('/resource_')) return '[]';
      if (path.includes('/diffs?')) return JSON.stringify([{ old_path: 'a', new_path: 'a', new_file: false, deleted_file: false, renamed_file: false, diff: '@@ -1 +1 @@\n-old\n+new' }]);
      if (/\/merge_requests\/\d+$/.test(path)) return JSON.stringify(row('pr'));
      if (/\/issues\/\d+$/.test(path)) return JSON.stringify(row('issue'));
      return JSON.stringify([row(path.includes('/issues?') ? 'issue' : 'pr', path.includes('/issues?') && path.includes('state=all'))]);
    });
  });
  afterEach(() => { store.flush(); rmSync(fixture.root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const app = () => createApp({ runtime: testRuntime({ repoRoot: fixture.root, store, manager: { isActive: () => false } as unknown as RunManager }), version: 'test' });
  it('delegates list, comments, checks, references, search and changes to GitLab behind the historical routes', async () => {
    const server = app();
    const get = async (suffix: string) => { const response = await apiRequest(server, `/api/v1/p/boot/github${suffix}`); expect(response.status).toBe(200); return response.json(); };
    expect(await get('')).toMatchObject({ available: true, prs: [{ checks: null, url: 'https://gitlab.com/group/sub/project/-/merge_requests/1' }] });
    expect(await get('/comments/issue/1')).toMatchObject({ available: true, detail: { body: 'Detail' } });
    expect(await get('/checks?prs=1')).toEqual({ available: true, checks: { 1: 'passing' } });
    expect(await get('/ref-status?prs=1&issues=1')).toMatchObject({ available: true, issues: { 1: 'completed' }, prs: { 1: 'ready' } });
    expect(await get('/search?kind=pr&q=fixture')).toMatchObject({ available: true, items: [{ number: 1 }] });
    expect(await get('/prs/1/changes')).toMatchObject({ available: true, headSha: 'a'.repeat(40), files: [{ path: 'a' }] });
    expect(fixture.command.mock.calls.every(([args]) => args[2] === 'gitlab.com' && args[6]?.startsWith('projects/group%2Fsub%2Fproject/'))).toBe(true);
    expect(await readForgeCachedRefStatuses(fixture.root, [1])).toEqual({ prs: {}, issues: {} });
  });
  it('preserves the existing GitHub dry-run defaults through the same routes', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    fixture.remote = 'git@github.com:acme/demo.git';
    const response = await apiRequest(app(), '/api/v1/p/boot/github');
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ available: true });
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it('routes task PR creation to the selected GitLab provider', async () => {
    // No worktree must retain the provider's no-publish guard, not enter GitHub creation.
    const outcome = await createDraftPr({ repoRoot: fixture.root, handoffText: '', run: { branch: 'cez/test', worktreePath: undefined } as import('../../runs/store.ts').RunRecord });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('worktree') });
    const d = await import('./operations.ts');
    expect(d).toHaveProperty('updateForgePr'); expect(d).toHaveProperty('commentForge');
  });
  it('publishes through the task route with the selected provider and preserves GitHub dry-run behavior', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const run = store.createRun({ title: 'Fix', task: 'Fix it', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'review', worktreePath: fixture.root, branch: 'cez/test' });
    const server = app();
    let response = await apiRequest(server, `/api/v1/p/boot/runs/${run.id}/pr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ url: 'https://gitlab.com/group/sub/project/-/merge_requests/777', dryRun: true });
    fixture.remote = 'git@github.com:acme/demo.git';
    response = await apiRequest(server, `/api/v1/p/boot/runs/${run.id}/pr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ url: 'https://github.com/open-mercato/demo/pull/777', dryRun: true });
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it('uses the selected base remote rather than origin and never publishes if that lookup fails', async () => {
    fixture.base = 'upstream'; fixture.remote = 'git@github.com:ada/fork.git';
    fixture.lookup.mockResolvedValue({ stdout: 'git@gitlab.com:group/sub/project.git' });
    const d = await import('./operations.ts');
    expect((await d.resolveProjectForge(fixture.root)).driver?.kind).toBe('gitlab');
    fixture.lookup.mockRejectedValue(new Error('unreadable base'));
    fixture.remote = undefined as unknown as string;
    const result = await d.createForgePr({ repoRoot: fixture.root, handoffText: '', run: { branch: 'cez/test', worktreePath: '/must-not-publish' } as import('../../runs/store.ts').RunRecord });
    expect(result).toEqual({ ok: false, error: 'Platform features are unavailable for this repository' });
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it('warms configured self-managed host metadata and names the configured instance explicitly', async () => {
    vi.stubEnv('GLAB_CONFIG_DIR', fixture.root);
    writeFileSync(join(fixture.root, 'config.yml'), 'hosts:\n  code.example.net:8443:\n    ssh_host: ssh.example.net\n    api_protocol: https\n');
    fixture.remote = 'git@ssh.example.net:group/sub/project.git';
    const response = await apiRequest(app(), '/api/v1/p/boot/github');
    expect(await response.json()).toMatchObject({ available: true, prs: [{ url: 'https://code.example.net:8443/group/sub/project/-/merge_requests/1' }] });
    expect(fixture.command.mock.calls.every(([args]) => args[2] === 'code.example.net:8443')).toBe(true);
  });
  it('degrades unsupported hosts and absent glab without trying another provider', async () => {
    fixture.remote = 'git@unknown.example:group/project.git';
    const unknown = await apiRequest(app(), '/api/v1/p/boot/github/checks?prs=1');
    expect(await unknown.json()).toMatchObject({ available: false }); expect(fixture.command).not.toHaveBeenCalled();
    fixture.remote = 'git@gitlab.com:group/project.git';
    fixture.command.mockRejectedValue(new Error('spawn glab ENOENT'));
    const missing = await apiRequest(app(), '/api/v1/p/boot/github');
    expect(missing.status).toBe(200); expect(await missing.json()).toMatchObject({ available: false, reason: expect.stringContaining('glab auth login --hostname gitlab.com') });
  });
  it('preserves 404 only for a genuinely absent MR, while read failures stay explicit unavailable', async () => {
    fixture.command.mockImplementation(async (args) => {
      if (/\/merge_requests\/\d+$/.test(args[6]!)) return 'HTTP/2.0 404 Not Found\r\n\r\n{}';
      throw new Error('offline');
    });
    const response = await apiRequest(app(), '/api/v1/p/boot/github/prs/1/changes');
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'Merge request !1 not found' });
    fixture.command.mockRejectedValue(new Error('offline'));
    const offline = await apiRequest(app(), '/api/v1/p/boot/github/prs/1/changes');
    expect(offline.status).toBe(200); expect(await offline.json()).toMatchObject({ available: false });
  });
});
