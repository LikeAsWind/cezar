import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveForge } from './index.ts';
import { z } from 'zod';
import { createGitlabReads } from './gitlab-read.ts';
import { createGitlabApi, gitlabOperation, type GitlabCommandRunner } from './gitlab-api.ts';
import { gitlabConflict, gitlabMergeable, gitlabReferenceStatus, gitlabItemSchema, normalizeGitlabMergeState } from './gitlab-normalize.ts';

let sequence = 0;
const item = (iid = 1, fields: Record<string, unknown> = {}) => ({ iid, title: `Item ${iid}`, state: 'opened', created_at: '2026-10-15T00:00:00Z', web_url: 'https://example.invalid/item',
  author: { username: 'ada' }, labels: [{ name: 'bug', color: '#aabbcc' }], user_notes_count: 7, sha: 'a'.repeat(40), ...fields });
const http = (data: unknown, headers: Record<string, string> = {}, status = 200) => `HTTP/2.0 ${status} OK\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n${JSON.stringify(data)}`;
function fixture(handler: (path: string, args: string[], options: { timeout: number; maxBuffer: number }) => string | Promise<string>) {
  const ref = { host: `fixture-${++sequence}.example`, projectPath: 'group/sub/project' };
  const run = vi.fn<GitlabCommandRunner>(async (args, opts) => handler(args[6]!, args, opts));
  return { reads: createGitlabReads('/repo', ref, run), api: createGitlabApi('/repo', ref, run), run, ref };
}
afterEach(() => vi.restoreAllMocks());

it('exposes GitLab bounded reads through the driver', () => {
  const driver = resolveForge({ root: '/repo', branch: 'master', remote: 'git@gitlab.com:group/sub/project.git' });
  expect(driver?.listIssues).toBeTypeOf('function');
});

describe('GitLab fixture reads', () => {
  it('lists without per-MR hydration, targets the full project and instance, and caches both kinds', async () => {
    const { reads, run, ref } = fixture(() => http([item()]));
    const result = await reads.list();
    expect(result).toMatchObject({ available: true, issues: [{ number: 1, comments: 7 }], prs: [{ number: 1, checks: null }], labelColors: { bug: 'aabbcc' } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.every(([args]) => args[2] === ref.host && args[6]!.startsWith('projects/group%2Fsub%2Fproject/'))).toBe(true);
    expect(run.mock.calls.every(([args]) => args[6]!.includes('state=opened') && args[6]!.includes('scope=all') && !args.includes('--paginate'))).toBe(true);
    expect(result.prs[0]?.url).toBe(`https://${ref.host}/group/sub/project/-/merge_requests/1`);
    await reads.list(); expect(run).toHaveBeenCalledTimes(2);
    await reads.list({ refresh: true }); expect(run).toHaveBeenCalledTimes(4);
  });
  it('continues at row 16 within a 20-row page and never skips or duplicates it', async () => {
    const { reads } = fixture(() => http(Array.from({ length: 20 }, (_, index) => item(index + 1))));
    const first = await reads.list({ limit: 15 });
    const second = await reads.list({ limit: 15, issuesCursor: first.issuesNextCursor!, prsCursor: first.prsNextCursor! });
    expect(first.issues.map((row) => row.number)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
    expect(second.issues.map((row) => row.number)).toEqual([16, 17, 18, 19, 20]);
    expect(second.issuesNextCursor).toBeNull();
    expect(second.issuesTotal).toBeUndefined();
  });
  it('rejects malformed, cross-kind, cross-host and changed-filter continuation tokens', async () => {
    const first = fixture(() => http(Array.from({ length: 20 }, (_, index) => item(index + 1))));
    const list = await first.reads.list({ limit: 15 });
    expect((await first.reads.list({ issuesCursor: 'not-a-token' })).available).toBe(false);
    expect((await first.reads.list({ prsCursor: list.issuesNextCursor! })).available).toBe(false);
    const second = fixture(() => http([]));
    expect((await second.reads.list({ issuesCursor: list.issuesNextCursor! })).available).toBe(false);
    const changedOrigin = createGitlabReads('/repo', { ...first.ref, webOrigin: `http://${first.ref.host}` }, first.run);
    expect((await changedOrigin.list({ issuesCursor: list.issuesNextCursor! })).available).toBe(false);
    await expect(first.reads.pages('issues', gitlabItemSchema, { state: 'all' }, 15, list.issuesNextCursor!)).rejects.toThrow('incompatible');
  });
  it('follows missing-total full pages and exposes capped lists with continuations', async () => {
    const { reads, run } = fixture((path) => {
      const page = Number(new URL(`https://test/${path}`).searchParams.get('page'));
      return http(Array.from({ length: 100 }, (_, index) => item((page - 1) * 100 + index + 1)), { 'x-next-page': String(page + 1) });
    });
    const result = await reads.pages('issues', gitlabItemSchema, { state: 'opened', scope: 'all' }, 1_001);
    expect(result).toMatchObject({ truncated: true });
    expect(result.rows).toHaveLength(1_000); expect(result.next).toBeTypeOf('string'); expect(run).toHaveBeenCalledTimes(10);
  });
  it('rejects cross-origin Link continuations and preserves successful kind on a partial list failure', async () => {
    const { reads } = fixture((path) => path.includes('/issues?') ? http([item()]) : http([], { link: '<https://evil.example/api/v4/projects/x/merge_requests?page=2&per_page=100>; rel="next"' }));
    const result = await reads.list();
    expect(result).toMatchObject({ available: false, truncated: true, issues: [{ number: 1 }], prs: [] });
    expect(result.reason).toContain('Unsafe');
  });
  it('keeps issue #1 and MR !1 independent and uses repeated array IID filters', async () => {
    const { reads, run } = fixture((path) => path.includes('/approvals') ? http({ approvals_required: 0, approvals_left: 0 }) : /\/merge_requests\/\d+$/.test(path) ? http(item(1, { head_pipeline: null })) : http([item(1, { state: path.includes('/issues?') ? 'closed' : 'opened' })]));
    expect(await reads.refStatuses({ prs: [1, 2, 1], issues: [1, 2] })).toMatchObject({ available: true, issues: { 1: 'completed' }, prs: { 1: 'open' } });
    expect(run).toHaveBeenCalledTimes(4);
    const query = new URL(`https://test/${run.mock.calls[0]![0][6]}`).searchParams;
    expect(query.getAll('iids[]')).toEqual(['1', '2']); expect(query.get('state')).toBe('all');
    await reads.refStatuses({ prs: [1, 2], issues: [1, 2] }); expect(run).toHaveBeenCalledTimes(4);
  });
  it('does not paint an open MR green when CI or mandatory approval evidence is unreadable', async () => {
    const missingCi = fixture((path) => path.includes('/approvals') ? http({ approvals_required: 0, approvals_left: 0 }) : /\/merge_requests\/\d+$/.test(path) ? http(item()) : http([item()]));
    expect(await missingCi.reads.refStatuses({ prs: [1] })).toMatchObject({ available: false, reason: expect.stringContaining('CI') });
    const missingApprovals = fixture((path) => path.includes('/approvals') ? http({ approved: true }) : /\/merge_requests\/\d+$/.test(path) ? http(item(1, { head_pipeline: { id: 1, sha: 'a'.repeat(40), status: 'success' } })) : http([item()]));
    expect(await missingApprovals.reads.refStatuses({ prs: [1] })).toMatchObject({ available: false, reason: expect.stringContaining('Approval') });
  });
  it('hydrates only requested MRs and refuses missing or mismatched head pipelines', async () => {
    let state = 'success'; let sha = 'a'.repeat(40);
    const { reads, run } = fixture(() => http(item(1, { head_pipeline: { id: 3, sha, status: state } })));
    expect(await reads.checks([1, 1])).toEqual({ available: true, checks: { 1: 'passing' } }); expect(run).toHaveBeenCalledTimes(1);
    await reads.checks([1]); expect(run).toHaveBeenCalledTimes(1);
    reads.client.invalidate(); sha = 'b'.repeat(40);
    expect(await reads.checks([1])).toMatchObject({ available: false, reason: expect.stringContaining('head') });
    reads.client.invalidate(); sha = 'a'.repeat(40); state = 'skipped';
    expect((await reads.checks([1])).available).toBe(false);
    const absent = fixture(() => http(item()));
    expect((await absent.reads.checks([1])).available).toBe(false);
  });
  it('invalidates only the matching kind/IID and its list aggregates', async () => {
    const { reads, run } = fixture(() => http([item()]));
    await reads.list(); expect(run).toHaveBeenCalledTimes(2);
    reads.client.invalidate('pr', 1);
    await reads.list(); expect(run).toHaveBeenCalledTimes(3);
    reads.client.invalidate('issue', 1);
    await reads.list(); expect(run).toHaveBeenCalledTimes(4);
  });
  it('degrades absent CLI, malformed JSON, denied endpoints and unreadable details explicitly', async () => {
    for (const message of ['spawn glab ENOENT', '403 Forbidden', 'timeout']) {
      const { reads } = fixture(() => { throw new Error(message); });
      expect(await reads.list()).toMatchObject({ available: false, reason: message.includes('ENOENT') ? expect.stringContaining('glab auth login --hostname') : expect.any(String), issues: [], prs: [] });
      expect((await reads.refStatuses({ prs: [1] })).available).toBe(false);
    }
    expect((await fixture(() => 'not json').reads.comments('issue', 1)).available).toBe(false);
  });
  it('loads descriptions, user comments and structured timeline events without parsing system text', async () => {
    const { reads } = fixture((path) => path.includes('/notes?') ? http([
      { id: 1, body: 'comment', created_at: '2026-10-16T00:00:00Z', author: { username: 'ada' }, system: false },
      { id: 2, body: 'approved by someone', created_at: '2026-10-16T00:00:01Z', author: { username: 'ada' }, system: true },
    ]) : path.includes('resource_state_events') ? http([{ id: 3, state: 'closed', user: { username: 'ada' }, created_at: '2026-10-16T00:00:02Z' }]) : path.includes('resource_label_events') ? http([]) : http(item(1, { description: 'body' })));
    expect(await reads.comments('issue', 1)).toMatchObject({ available: true, comments: [{ body: 'comment' }], events: [{ kind: 'closed' }], detail: { body: 'body' }, truncated: false });
  });
  it('preserves rename/head identity and marks omitted or oversized patches', async () => {
    const { reads } = fixture((path) => path.includes('/diffs?') ? http([
      { old_path: 'old.ts', new_path: 'new.ts', renamed_file: true, new_file: false, deleted_file: false, diff: '@@ -1 +1 @@\n-old\n+new' },
      { old_path: 'large', new_path: 'large', renamed_file: false, new_file: false, deleted_file: false, too_large: true },
      { old_path: 'img', new_path: 'img', renamed_file: false, new_file: false, deleted_file: false, diff: 'Binary files a/img and b/img differ' },
    ]) : http(item()));
    expect(await reads.prDiff(1)).toMatchObject({ available: true, headSha: 'a'.repeat(40), truncated: true, files: [{ path: 'new.ts', previousPath: 'old.ts', additions: 1, deletions: 1 }, { patchUnavailableReason: 'too-large' }, { patchUnavailableReason: 'binary' }] });
  });
  it('does not label an unavailable diff page as an absent merge request', async () => {
    const { reads } = fixture((path) => path.includes('/diffs?') ? http({}, {}, 404) : http(item()));
    await expect(reads.prDiff(1)).resolves.toMatchObject({ available: false });
  });
  it('does not mistake an IID in a failed command for an HTTP response status', async () => {
    const { reads } = fixture(() => { throw new Error('Command failed: glab api projects/group%2Fproject/merge_requests/404\nnetwork timeout'); });
    await expect(reads.prDiff(404)).resolves.toMatchObject({ available: false });
  });
});

describe('GitLab operation budgets', () => {
  it('caps all nested requests at twenty, and shares a decreasing deadline', async () => {
    let now = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { api, run } = fixture(() => { now += 1_000; return http([]); });
    await expect(gitlabOperation(async () => { for (let index = 0; index < 30; index++) await api.api(`issues/${index}`, z.array(z.unknown())); })).rejects.toThrow('budget');
    expect(run).toHaveBeenCalledTimes(15);
    expect(run.mock.calls[0]![1].timeout).toBe(15_000); expect(run.mock.calls[14]![1].timeout).toBe(1_000);
    const other = fixture(() => http([]));
    await expect(gitlabOperation(async () => { for (let index = 0; index < 30; index++) await other.api.api(`issues/${index}`, z.array(z.unknown())); })).rejects.toThrow('budget');
    expect(other.run).toHaveBeenCalledTimes(20);
  });
  it('enforces response and cumulative byte caps', async () => {
    const huge = fixture(() => JSON.stringify('a'.repeat(4 * 1024 * 1024)));
    await expect(huge.api.api('issues', z.string())).rejects.toThrow('size');
    const cumulative = fixture(() => JSON.stringify('a'.repeat(3 * 1024 * 1024)));
    await expect(gitlabOperation(async () => { for (let index = 0; index < 3; index++) await cumulative.api.api(`issues/${index}`, z.string()); })).rejects.toThrow('size');
    expect(cumulative.run).toHaveBeenCalledTimes(3);
  });
  it('honors Retry-After without retries inside the same operation', async () => {
    let now = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    let throttled = true;
    const { reads, run } = fixture(() => throttled ? http({}, { 'retry-after': '30' }, 429) : http([]));
    expect((await reads.list()).available).toBe(false); expect(run).toHaveBeenCalledTimes(1);
    await reads.list(); expect(run).toHaveBeenCalledTimes(1);
    now += 30_001; throttled = false;
    expect((await reads.list()).available).toBe(true); expect(run).toHaveBeenCalledTimes(3);
  });
  it('limits concurrent subprocesses to four per instance and deduplicates in-flight reads', async () => {
    let active = 0; let maximum = 0;
    const releases: Array<() => void> = [];
    const { api, run } = fixture(async () => { active++; maximum = Math.max(maximum, active); await new Promise<void>((resolve) => releases.push(resolve)); active--; return http([]); });
    const work = Promise.all(Array.from({ length: 12 }, (_, index) => api.api(`issues/${index}`, z.array(z.unknown()))));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));
    for (let group = 0; group < 3; group++) { releases.splice(0).forEach((release) => release()); if (group < 2) await vi.waitFor(() => expect(run).toHaveBeenCalledTimes((group + 2) * 4)); }
    await work; expect(maximum).toBe(4);
    const pair = Promise.all([api.api('same', z.array(z.unknown())), api.api('same', z.array(z.unknown()))]);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(13)); releases.splice(0).forEach((release) => release()); await pair;
  });
  it('bounds an in-flight cache wait by the waiting operation remaining deadline', async () => {
    let now = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    let release!: (value: string) => void;
    const { api } = fixture(() => new Promise<string>((resolve) => { release = resolve; }));
    const original = api.api('same', z.array(z.unknown()));
    const done = setTimeout(() => release(http([])), 30);
    try {
      await expect(gitlabOperation(async () => { now += 14_999; return api.api('same', z.array(z.unknown())); })).rejects.toThrow('deadline');
    } finally { clearTimeout(done); release(http([])); await original; }
  });
  it('returns unavailable when a checks batch exhausts its shared budget rather than dropping IDs', async () => {
    const { reads, run } = fixture((path) => http(item(Number(/\/(\d+)$/.exec(path)?.[1] ?? 1), { head_pipeline: { id: 1, sha: 'a'.repeat(40), status: 'success' } })));
    expect(await reads.checks(Array.from({ length: 100 }, (_, index) => index + 1))).toMatchObject({ available: false, reason: expect.stringContaining('budget') });
    expect(run.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

describe('GitLab normalization', () => {
  it('maps closed and reopened issues without inventing not-planned', () => {
    expect(gitlabReferenceStatus(gitlabItemSchema.parse(item(1, { state: 'closed', labels: ['duplicate'] })), 'issue')).toBe('completed');
    expect(gitlabReferenceStatus(gitlabItemSchema.parse(item()), 'issue')).toBe('open');
  });
  it.each([
    [{ has_conflicts: true }, true, 'conflicting'], [{ detailed_merge_status: 'conflict' }, true, 'conflicting'],
    [{ detailed_merge_status: 'broken_status' }, false, 'unknown'], [{ detailed_merge_status: 'need_rebase' }, false, 'unknown'],
    [{ detailed_merge_status: 'checking', has_conflicts: false }, false, 'unknown'], [{ merge_status: 'cannot_be_merged' }, false, 'unknown'],
    [{ detailed_merge_status: 'mergeable' }, false, 'mergeable'],
  ])('keeps explicit conflict separate from potential status %j', (fields, conflict, mergeable) => {
    const row = gitlabItemSchema.parse(item(1, fields));
    expect(gitlabConflict(row)).toBe(conflict); expect(gitlabMergeable(row)).toBe(mergeable);
  });
  it('keeps missing approval requirements and unreadable CI ineligible even when CE approved is true', () => {
    const result = normalizeGitlabMergeState(gitlabItemSchema.parse(item(1, { detailed_merge_status: 'mergeable', user: { can_merge: true } })), { host: 'gitlab.com', projectPath: 'group/project' }, { approved: true });
    expect(result).toMatchObject({ canMerge: false, canOverride: false, reviewDecision: 'unknown', checksTier: 'none', eligibility: 'unknown' });
  });
});
