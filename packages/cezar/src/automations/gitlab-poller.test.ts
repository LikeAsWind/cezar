import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitlabCommandRunner } from '../server/forge/gitlab-api.ts';
import { GitlabPoller, gitlabApprovalKey } from './gitlab-poller.ts';
import type { GithubAutomationDefinition } from './types.ts';

const ref = { host: 'gitlab.com', projectPath: 'group/sub/project', webOrigin: 'https://gitlab.com' };

const http = (data: unknown, headers: Record<string, string> = {}) =>
  `HTTP/2.0 200 OK\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n${JSON.stringify(data)}`;

/** One open MR fixture with no EE rule fields (CE edition). */
const mr = (iid = 1, fields: Record<string, unknown> = {}) => ({
  iid, title: `MR ${iid}`, state: 'opened', created_at: '2026-10-15T00:00:00Z', web_url: `https://gitlab.com/group/sub/project/-/merge_requests/${iid}`,
  author: { username: 'ada', id: 1 }, labels: [], user_notes_count: 0, sha: 'a'.repeat(40),
  source_branch: `branch-${iid}`, target_branch: 'main',
  ...fields,
});

const approvals = (approvedBy: Array<{ user: { id: number; username: string }; approved_at?: string }>, extra: Record<string, unknown> = {}) => ({
  approved_by: approvedBy,
  ...extra,
});

const definition: GithubAutomationDefinition = {
  id: 'a', revision: 1, name: 'n', enabled: true, kind: 'github', events: ['pull_request.approval_observed'],
  intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'p' }, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z',
};

let sequence = 0;
function makePoller(handler: (path: string, args: string[]) => string | Promise<string> | never) {
  const run = vi.fn<GitlabCommandRunner>(async (args, opts) => handler(args[6]!, args));
  const host = { ...ref, host: `fixture-${++sequence}.example` };
  return { poller: new GitlabPoller({ root: '/repo', ref: host, run }), run, host };
}

afterEach(() => vi.restoreAllMocks());

describe('GitlabPoller (approval snapshots)', () => {
  it('emits an approval-observed candidate per individual approver, keyed by instance+project+iid+approver+approved_at', async () => {
    const { poller, run, host } = makePoller((path) =>
      path.includes('/approvals')
        ? http(approvals([
            { user: { id: 10, username: 'reviewer' }, approved_at: '2026-10-16T09:00:00Z' },
            { user: { id: 11, username: 'second' }, approved_at: '2026-10-16T09:05:00Z' },
          ]))
        : http([mr(1)]));
    const result = await poller.poll(definition, { approvalBaseline: {} });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      event: 'pull_request.approval_observed', number: 1, reviewer: 'reviewer',
      repo: host.projectPath, timestamp: '2026-10-16T09:00:00Z',
    });
    expect(result.candidates[0]!.eventId).toBe(gitlabApprovalKey(host, 1, '10', '2026-10-16T09:00:00Z'));
    expect(run).toHaveBeenCalled();
  });

  it('launches nothing for retained approvals on a fresh baseline (enable/restart)', async () => {
    const { poller } = makePoller((path) =>
      path.includes('/approvals')
        ? http(approvals([{ user: { id: 10, username: 'reviewer' }, approved_at: '2026-10-16T09:00:00Z' }]))
        : http([mr(1)]));
    const result = await poller.poll(definition, { approvalBaseline: {} });
    expect(result.candidates).toHaveLength(1);
    expect(result.approvalBaseline).toBeDefined();

    // Restart with the persisted baseline: same snapshot launches none.
    const replay = await poller.poll(definition, { approvalBaseline: result.approvalBaseline });
    expect(replay.candidates).toHaveLength(0);
  });

  it('a new approved_at timestamp is a new occurrence; reappearance of the same one is not', async () => {
    const { poller } = makePoller((path) =>
      path.includes('/approvals')
        ? http(approvals([{ user: { id: 10, username: 'reviewer' }, approved_at: '2026-10-16T09:00:00Z' }]))
        : http([mr(1)]));
    const first = await poller.poll(definition, { approvalBaseline: {} });
    expect(first.candidates).toHaveLength(1);

    // Withdrawn between polls (not in the snapshot), then re-approved at a NEW timestamp.
    const withdrawn = makePoller((path) =>
      path.includes('/approvals') ? http(approvals([])) : http([mr(1)]));
    const mid = await withdrawn.poller.poll(definition, { approvalBaseline: first.approvalBaseline });
    expect(mid.candidates).toHaveLength(0);

    const reapproved = makePoller((path) =>
      path.includes('/approvals')
        ? http(approvals([{ user: { id: 10, username: 'reviewer' }, approved_at: '2026-10-16T10:00:00Z' }]))
        : http([mr(1)]));
    const later = await reapproved.poller.poll(definition, { approvalBaseline: mid.approvalBaseline });
    expect(later.candidates).toHaveLength(1);
    expect(later.candidates[0]!.timestamp).toBe('2026-10-16T10:00:00Z');
  });

  it('a CE fixture with no EE rule fields still yields a valid individual snapshot', async () => {
    const { poller } = makePoller((path) =>
      path.includes('/approvals')
        ? http(approvals([{ user: { id: 10, username: 'reviewer' }, approved_at: '2026-10-16T09:00:00Z' }], { approved: true }))
        : http([mr(1)]));
    // No approvals_required/approvals_left/approval_rules_left/has_approval_rules keys at all.
    const result = await poller.poll(definition, { approvalBaseline: {} });
    expect(result.candidates).toHaveLength(1);
  });

  it('marks the trigger unsupported when approved_at is missing, and launches nothing for it', async () => {
    const { poller } = makePoller((path) =>
      path.includes('/approvals')
        ? http(approvals([{ user: { id: 10, username: 'reviewer' } }]))
        : http([mr(1)]));
    const result = await poller.poll(definition, { approvalBaseline: {} });
    expect(result.candidates).toHaveLength(0);
    expect(result.unsupported).toContain('approved_at');
  });

  it('does not clear the baseline when one MR approval read fails', async () => {
    const baseline = { [gitlabApprovalKey(ref, 2, '10', '2026-10-16T08:00:00Z')]: '2026-10-16T08:00:00Z' };
    const { poller } = makePoller((path) => {
      if (path.includes('/merge_requests/1/approvals')) throw new Error('403 Forbidden');
      if (path.includes('/merge_requests/2/approvals')) return http(approvals([]));
      return http([mr(1), mr(2)]);
    });
    const result = await poller.poll(definition, { approvalBaseline: baseline });
    // The failed MR contributes no candidate but the persisted baseline is preserved and extended.
    expect(result.approvalBaseline).toMatchObject(baseline);
    expect(result.truncated).toBe(true);
  });

  it('does not discard unseen retained approvals behind another MR high-watermark', async () => {
    const { poller } = makePoller((path) =>
      path.includes('/approvals')
        ? http(approvals([
            { user: { id: 10, username: 'old' }, approved_at: '2026-10-15T09:00:00Z' },
            { user: { id: 11, username: 'new' }, approved_at: '2026-10-16T09:00:00Z' },
          ]))
        : http([mr(1)]));
    const result = await poller.poll(definition, { approvalBaseline: {}, since: '2026-10-16T00:00:00Z' });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(row => row.reviewer)).toEqual(['old', 'new']);
  });

  it('signals no baseline (preview before first enable) instead of a bare zero matches', async () => {
    const { poller } = makePoller((path) =>
      path.includes('/approvals')
        ? http(approvals([{ user: { id: 10, username: 'reviewer' }, approved_at: '2026-10-16T09:00:00Z' }]))
        : http([mr(1)]));
    const result = await poller.poll(definition, {});
    expect(result.candidates).toHaveLength(0);
    expect(result.approvalBaseline).toEqual(expect.any(Object));
    expect(result.noBaseline).toContain('baseline');
  });
});

describe('GitLab exact events and bounded progress', () => {
  it('never substitutes an approval for a saved reviewed trigger', async () => {
    const { poller } = makePoller(path => path.includes('/approvals')
      ? http(approvals([{ user: { id: 10, username: 'r' }, approved_at: '2026-10-16T10:00:00Z' }])) : http([mr()]));
    const result = await poller.poll({ ...definition, events: ['pull_request.reviewed'] }, { approvalBaseline: {} });
    expect(result.candidates).toEqual([]);
    expect(result.unsupported).toContain('reviewed');
  });

  it('rolls back a failed chunk and detects its older approval on retry', async () => {
    let failing = true;
    const { poller } = makePoller(path => {
      if (!path.includes('/approvals')) return http([mr(1), mr(2)]);
      if (path.includes('/2/') && failing) throw new Error('offline');
      return http(approvals([{ user: { id: 10, username: 'r' }, approved_at: path.includes('/1/') ? '2026-10-16T10:00:00Z' : '2026-10-16T09:50:00Z' }]));
    });
    const first = await poller.poll(definition, { approvalBaseline: {} });
    expect(first.candidates).toEqual([]);
    expect(first.approvalBaseline).toEqual({});
    expect(first.cursor).toBeUndefined();
    failing = false;
    const retried = await poller.poll(definition, { approvalBaseline: first.approvalBaseline, since: '2026-10-16T09:58:00Z' });
    expect(retried.candidates.map(row => row.number)).toEqual([1, 2]);
  });

  it('resumes beyond the request budget after restart without replaying initial retained approvals', async () => {
    const { poller, run, host } = makePoller(path => path.includes('/approvals')
      ? http(approvals([{ user: { id: 10, username: 'r' }, approved_at: '2026-10-16T10:00:00Z' }]))
      : http(Array.from({ length: 25 }, (_, index) => mr(index + 1))));
    const first = await poller.poll(definition);
    expect(first.truncated).toBe(true);
    expect(first.candidates).toEqual([]);
    expect(first.scan).toBeDefined();
    expect(run.mock.calls.length).toBeLessThanOrEqual(20);
    const resumed = await new GitlabPoller({ root: '/repo', ref: host, run }).poll(definition, {
      approvalBaseline: first.approvalBaseline, scan: first.scan,
    });
    expect(resumed.candidates).toEqual([]);
    expect(resumed.truncated).toBe(false);
    expect(Object.keys(resumed.approvalBaseline ?? {})).toHaveLength(25);
  });

  it('re-establishes a re-enabled baseline without clearing earlier identities or launching retained approvals', async () => {
    const { poller } = makePoller(path => path.includes('/approvals')
      ? http(approvals([{ user: { id: 10, username: 'r' }, approved_at: '2026-10-16T10:00:00Z' }])) : http([mr()]));
    const result = await poller.poll(definition, { approvalBaseline: { old: '2026-10-15T00:00:00Z' }, initializing: true });
    expect(result.candidates).toEqual([]);
    expect(result.approvalBaseline?.old).toBe('2026-10-15T00:00:00Z');
    expect(result.initializedAt).toBeDefined();
  });

  it('shares the request budget across approvals and short resource-label pages and preserves continuation', async () => {
    const { poller, run } = makePoller(path => {
      if (path.includes('/approvals')) return http(approvals([{ user: { id: 10, username: 'r' }, approved_at: '2026-10-16T10:00:00Z' }]));
      if (path.includes('/resource_label_events')) {
        const page = Number(new URL(`https://fixture/${path}`).searchParams.get('page'));
        return http([{ id: page, created_at: '2026-10-16T10:01:00Z', action: 'add', label: { name: 'bug' } }], { 'x-next-page': String(page + 1) });
      }
      return http(path.includes('/issues?') ? [mr(1)] : Array.from({ length: 16 }, (_, index) => mr(index + 1)));
    });
    const result = await poller.poll({ ...definition, events: ['pull_request.approval_observed', 'issue.labeled'] }, { approvalBaseline: {} });
    expect(result.partial).not.toBe(true);
    expect(result.scan?.labelCursor).toBeDefined();
    expect(run.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('uses creation and resource-label timestamps for existing issue/MR events, including closed items', async () => {
    const { poller } = makePoller(path => path.includes('/resource_label_events') ? http([
      { id: 8, user: { id: 2, username: 'r' }, created_at: '2026-10-16T10:00:00Z', action: 'add', label: { id: 1, name: 'bug' }, resource_type: 'Issue', resource_id: 3 },
      { id: 9, user: { id: 2, username: 'r' }, created_at: '2026-10-16T10:01:00Z', action: 'remove', label: { id: 1, name: 'bug' }, resource_type: 'Issue', resource_id: 3 },
    ]) : http([mr(3, { state: 'closed', assignees: [{ id: 2, username: 'assigned' }] })]));
    const result = await poller.poll({ ...definition, events: ['pull_request.opened', 'issue.opened', 'issue.labeled', 'issue.unlabeled'] }, { approvalBaseline: {}, since: '2026-10-14T00:00:00Z' });
    expect(result.candidates.map(row => row.event)).toEqual(['pull_request.opened', 'issue.opened', 'issue.labeled', 'issue.unlabeled']);
    expect(result.candidates[2]).toMatchObject({ timestamp: '2026-10-16T10:00:00Z', changedLabel: 'bug', assignees: ['assigned'] });
  });
});
