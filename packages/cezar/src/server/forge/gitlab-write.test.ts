import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGitlabDriver } from './gitlab.ts';
import type { DraftPrInput } from './types.ts';
import type { GitlabCommandRunner } from './gitlab-api.ts';

const fixture = vi.hoisted(() => ({ saved: vi.fn(), remotes: vi.fn(), git: vi.fn(), api: vi.fn<GitlabCommandRunner>() }));
vi.mock('../../git-worktree.ts', () => ({ autosaveCommit: fixture.saved, taskRemotes: fixture.remotes }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(),
  execFile: Object.assign((...args: unknown[]) => fixture.git(...args), { [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => fixture.git(...args) }) }));
vi.mock('./gitlab-api.ts', async (original) => {
  const actual = await original<typeof import('./gitlab-api.ts')>();
  return { ...actual, gitlabClient: (root: string, ref: Parameters<typeof actual.gitlabClient>[1]) => actual.createGitlabApi(root, ref, fixture.api) };
});
const ref = { host: 'gitlab.com', projectPath: 'group/sub/target' };
const input = { repoRoot: '/repo', handoffText: '', run: { title: 'Fix', task: 'Fix it', branch: 'cez/test', worktreePath: '/worktree', baseBranch: 'upstream/master' } } as DraftPrInput;
export const mr = (extra: Record<string, unknown> = {}) => ({ iid: 7, title: 'Draft: Fix', state: 'opened', created_at: '2026-10-16T00:00:00Z', web_url: 'https://gitlab.com/group/sub/target/-/merge_requests/7',
  labels: ['existing'], reviewers: [{ id: 5, username: 'existing' }], user_notes_count: 0, source_branch: 'cez/test', target_branch: 'master', source_project_id: 2, target_project_id: 1, ...extra });
beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0'); fixture.saved.mockReset().mockResolvedValue('saved');
  fixture.remotes.mockReset().mockResolvedValue({ base: 'upstream', push: 'origin', names: ['upstream', 'origin'] });
  fixture.git.mockReset().mockImplementation(async (_bin: string, args: string[]) => ({ stdout: args[0] === 'remote' ? `git@gitlab.com:${args.at(-1) === 'upstream' ? 'group/sub/target' : 'ada/sub/fork'}.git` : '', stderr: '' }));
  fixture.api.mockReset().mockImplementation(async (args) => {
    const path = args[6]!;
    if (path === 'projects/group%2Fsub%2Ftarget') return JSON.stringify({ id: 1, path_with_namespace: 'group/sub/target', default_branch: 'master' });
    if (path === 'projects/ada%2Fsub%2Ffork') return JSON.stringify({ id: 2, path_with_namespace: 'ada/sub/fork' });
    if (path.startsWith('users?')) return JSON.stringify([{ id: 9, username: 'ada' }]);
    if (path.includes('merge_requests?')) return '[]';
    if (path.endsWith('/notes')) return JSON.stringify({ id: 1 });
    return JSON.stringify(mr());
  });
});
afterEach(() => vi.unstubAllEnvs());
const driver = () => createGitlabDriver('/repo', ref);
it('refuses missing worktree, refused autosave and failed autosave before publishing', async () => {
  expect(await driver().createPR({ ...input, run: { ...input.run, worktreePath: undefined } })).toMatchObject({ ok: false, error: expect.stringContaining('worktree') });
  fixture.saved.mockResolvedValue('refused'); expect(await driver().createPR(input)).toMatchObject({ ok: false, error: expect.stringContaining('conflicts') });
  fixture.saved.mockResolvedValue('failed'); expect(await driver().createPR(input)).toMatchObject({ ok: false, error: expect.stringContaining('commit') });
  expect(fixture.git).not.toHaveBeenCalled(); expect(fixture.api).not.toHaveBeenCalled();
});
it('publishes a fork with full target/source numeric IDs, base branch and explicit instance', async () => {
  expect(await driver().createPR(input)).toEqual({ ok: true, url: mr().web_url, dryRun: false });
  expect(fixture.git.mock.calls.some(([, args]) => args.join(' ') === 'push -u origin cez/test')).toBe(true);
  const [call, options] = fixture.api.mock.calls.find(([args]) => args[4] === 'POST')!;
  expect(call).toEqual(expect.arrayContaining(['--hostname', 'gitlab.com', 'projects/ada%2Fsub%2Ffork/merge_requests']));
  expect(JSON.parse(options.input!)).toMatchObject({ target_project_id: 1, source_branch: 'cez/test', target_branch: 'master', title: 'Draft: Fix' });
});
it('stops on push failure and never creates an MR', async () => {
  fixture.git.mockImplementation(async (_bin: string, args: string[]) => { if (args[0] === 'push') throw new Error('push failed'); return { stdout: 'git@gitlab.com:group/sub/target.git' }; });
  expect(await driver().createPR(input)).toMatchObject({ ok: false, error: expect.stringContaining('push') });
  expect(fixture.api.mock.calls.some(([args]) => args[4] === 'POST')).toBe(false);
});
it('publishes the completed delivery report rather than the progress log', async () => {
  const summary = '## 解决方案\nclose 幂等、按归属池归还。\n\n## 测试\n298 项测试通过。\n\n## 遗留限制\n待上线观察。';
  await driver().createPR({ ...input, handoffText: '## Goal\n修复重复归还\n\n## Progress log\n- seal complete\n',
    run: { ...input.run, graphState: { loops: {}, taken: [], outputs: { deliver: { summary, verdict: 'ready' } } } } });
  const [, options] = fixture.api.mock.calls.find(([args]) => args[4] === 'POST')!;
  const body = JSON.parse(options.input!).description;
  expect(body).toContain(summary);
  expect(body).not.toContain('Progress log');
});
it('matches duplicate MRs by branch AND both project IDs across forks, including uncertain creation', async () => {
  let posted = false;
  fixture.api.mockImplementation(async (args) => {
    const path = args[6]!;
    if (path === 'projects/group%2Fsub%2Ftarget') return JSON.stringify({ id: 1, path_with_namespace: ref.projectPath, default_branch: 'master' });
    if (path === 'projects/ada%2Fsub%2Ffork') return JSON.stringify({ id: 2, path_with_namespace: 'ada/sub/fork' });
    if (args[4] === 'POST') { posted = true; throw new Error('timeout'); }
    return JSON.stringify([mr({ iid: 99, source_project_id: 3 }), ...(posted ? [mr()] : [])]);
  });
  expect(await driver().createPR(input)).toMatchObject({ ok: true, url: mr().web_url });
  expect(fixture.api.mock.calls.filter(([args]) => args[4] === 'POST')).toHaveLength(1);
});
it('updates ready/addLabels/reviewers through supported endpoints without dropping existing reviewers', async () => {
  const d = driver(); expect(d.updatePR).toBeTypeOf('function');
  expect(await d.updatePR!(7, { ready: true, addLabels: ['bug'], reviewers: ['ada'] })).toEqual({ ok: true });
  const [write, options] = fixture.api.mock.calls.find(([args]) => args[4] === 'PUT')!;
  expect(JSON.parse(options.input!)).toEqual({ title: 'Fix', add_labels: 'bug', reviewer_ids: [5, 9] });
  expect(fixture.api.mock.calls.some(([args]) => args[6] === 'users?username=ada&per_page=100')).toBe(true);
  expect(write).toEqual(expect.arrayContaining(['--input', '-']));
});
it('rejects fuzzy or absent usernames before any mutation', async () => {
  fixture.api.mockImplementation(async (args) => JSON.stringify(args[6]!.startsWith('users?') ? [{ id: 9, username: 'ada-other' }] : mr()));
  expect(await driver().updatePR?.(7, { reviewers: ['ada'] })).toMatchObject({ ok: false });
  expect(fixture.api.mock.calls.some(([args]) => args[4] !== 'GET')).toBe(false);
});
function legacyReviewApi(assignees: { id: number; username: string }[] = [], version = '12.5.3') {
  fixture.api.mockImplementation(async (args, options) => {
    if (args[6] === 'version') return JSON.stringify({ version });
    if (args[6]!.startsWith('users?')) return JSON.stringify([{ id: 9, username: 'ada' }]);
    const assigned = args[4] === 'PUT' ? JSON.parse(options.input!).assignee_id : undefined;
    const current = assigned ? [{ id: assigned, username: 'ada' }] : assignees;
    return JSON.stringify(mr({ reviewers: undefined, assignees: current, assignee: current[0] ?? null }));
  });
}
it('uses a legacy GitLab assignee for review when reviewers are unsupported', async () => {
  legacyReviewApi();
  expect(await driver().updatePR!(7, { reviewers: ['ada'] })).toEqual({ ok: true });
  const [, options] = fixture.api.mock.calls.find(([args]) => args[4] === 'PUT')!;
  expect(JSON.parse(options.input!)).toEqual({ assignee_id: 9 });
});
it('keeps an existing legacy assignee and rejects replacing them before mutation', async () => {
  legacyReviewApi([{ id: 5, username: 'existing' }]);
  expect(await driver().updatePR!(7, { reviewers: ['ada'] })).toMatchObject({ ok: false, error: expect.stringContaining('assignee') });
  expect(fixture.api.mock.calls.some(([args]) => args[4] === 'PUT')).toBe(false);
});
it('can repeat a legacy review assignment to the same assignee', async () => {
  legacyReviewApi([{ id: 9, username: 'ada' }]);
  expect(await driver().updatePR!(7, { reviewers: ['ada'] })).toEqual({ ok: true });
});
it('does not treat unreadable legacy assignees as an empty assignment', async () => {
  fixture.api.mockImplementation(async args => JSON.stringify(args[6] === 'version' ? { version: '12.5.3' } : mr({ reviewers: undefined })));
  expect(await driver().updatePR!(7, { reviewers: ['ada'] })).toMatchObject({ ok: false, error: expect.stringContaining('assignees could not be read') });
  expect(fixture.api.mock.calls.some(([args]) => args[4] === 'PUT')).toBe(false);
});
it.each(['17.0.0', 'unknown'])('does not infer legacy reviewer support from missing fields on GitLab %s', async version => {
  legacyReviewApi([], version);
  expect(await driver().updatePR!(7, { reviewers: ['ada'] })).toMatchObject({ ok: false });
  expect(fixture.api.mock.calls.some(([args]) => args[4] === 'PUT')).toBe(false);
});
it('does not report legacy review assignment as successful when GitLab ignores it', async () => {
  fixture.api.mockImplementation(async args => JSON.stringify(args[6] === 'version' ? { version: '12.5.3' }
    : args[6]!.startsWith('users?') ? [{ id: 9, username: 'ada' }]
    : mr({ reviewers: undefined, assignees: [], assignee: null })));
  expect(await driver().updatePR!(7, { reviewers: ['ada'] })).toMatchObject({ ok: false, error: expect.stringContaining('confirmed') });
});
it('keeps issue and MR comments distinct and invalidates only the affected resource', async () => {
  const d = driver(); expect(d.comment).toBeTypeOf('function');
  expect(await d.comment!('issue', 7, 'issue body')).toEqual({ ok: true });
  expect(await d.comment!('pr', 7, 'MR body')).toEqual({ ok: true });
  expect(fixture.api.mock.calls.filter(([args]) => args[4] === 'POST').map(([args]) => args[6])).toEqual(['projects/group%2Fsub%2Ftarget/issues/7/notes', 'projects/group%2Fsub%2Ftarget/merge_requests/7/notes']);
});
it('prStatus selects the push project even with the same branch on another fork', async () => {
  fixture.api.mockImplementation(async (args) => JSON.stringify(args[6]!.startsWith('projects/ada%2Fsub%2Ffork') ? { id: 2, path_with_namespace: 'ada/sub/fork' } : args[6]!.includes('merge_requests?') ? [mr({ iid: 99, source_project_id: 3 }), mr()] : { id: 1, path_with_namespace: ref.projectPath }));
  expect(await driver().prStatus('cez/test')).toMatchObject({ number: 7 });
});
it('honors draft:false even when the run title carries a draft marker', async () => {
  expect(await driver().createPR({ ...input, draft: false, run: { ...input.run, title: 'Draft: Fix' } })).toMatchObject({ ok: true });
  expect(JSON.parse(fixture.api.mock.calls.find(([args]) => args[4] === 'POST')![1].input!)).toMatchObject({ title: 'Fix' });
});
it('uses the effective push URL even when a single remote fetches the target and pushes a rewritten fork URL', async () => {
  fixture.remotes.mockResolvedValue({ base: 'origin', push: 'origin', names: ['origin'] });
  fixture.git.mockImplementation(async (_bin: string, args: string[]) => ({ stdout: args[0] !== 'remote' ? '' : args.includes('--push') ? 'ssh://git@gitlab.com/ada/sub/fork.git\n' : 'git@gitlab.com:group/sub/target.git' }));
  expect(await driver().createPR({ ...input, run: { ...input.run, baseBranch: 'origin/master' } })).toMatchObject({ ok: true });
  expect(fixture.git.mock.calls.some(([, args]) => args.join(' ') === 'remote get-url --push --all origin')).toBe(true);
  expect(fixture.api.mock.calls.find(([args]) => args[4] === 'POST')![0][6]).toBe('projects/ada%2Fsub%2Ffork/merge_requests');
});
it.each(['git@github.com:ada/project.git', 'git@other.example:ada/project.git', 'git@gitlab.com:ada/sub/fork.git\ngit@gitlab.com:other/fork.git'])('rejects unsupported or ambiguous effective push destinations before push or POST: %s', async (pushUrl) => {
  fixture.remotes.mockResolvedValue({ base: 'origin', push: 'origin', names: ['origin'] });
  fixture.git.mockImplementation(async (_bin: string, args: string[]) => ({ stdout: args.includes('--push') ? pushUrl : 'git@gitlab.com:group/sub/target.git' }));
  expect(await driver().createPR(input)).toMatchObject({ ok: false });
  expect(fixture.git.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  expect(fixture.api.mock.calls.some(([args]) => args[4] === 'POST')).toBe(false);
});
