import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunManager } from './run.ts';
import type { RunRecord } from '../runs/store.ts';
const fixture = vi.hoisted(() => ({ create: vi.fn(), comment: vi.fn(), update: vi.fn(), checks: vi.fn(), old: vi.fn() }));
vi.mock('../server/forge/operations.ts', () => ({ createForgePr: fixture.create, commentForge: fixture.comment, updateForgePr: fixture.update, fetchForgeChecks: fixture.checks }));
vi.mock('../server/pr.ts', () => ({ createDraftPr: fixture.old }));
vi.mock('../server/forge/github.ts', async (original) => ({ ...await original<typeof import('../server/forge/github.ts')>(), commentOnPr: fixture.old, commentOnIssue: fixture.old, updatePr: fixture.old, fetchGithubChecks: fixture.old }));
vi.mock('../handoff.ts', async (original) => ({ ...await original<typeof import('../handoff.ts')>(), readHandoff: () => 'handoff' }));
let record: RunRecord;
let manager: RunManager;
const outputs = new Map<string, Record<string, string | number>>();
const url = 'https://code.example/group/sub/project/-/merge_requests/7';
beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0'); vi.useFakeTimers();
  Object.values(fixture).forEach((mock) => mock.mockReset());
  fixture.create.mockResolvedValue({ ok: true, url, dryRun: false }); fixture.comment.mockResolvedValue({ ok: true }); fixture.update.mockResolvedValue({ ok: true }); fixture.checks.mockResolvedValue({ available: true, checks: { 7: 'passing' } }); fixture.old.mockResolvedValue({ ok: false, error: 'wrong provider' });
  record = { id: 'run', title: 'Fix', task: 'task', branch: 'cez/test', worktreePath: '/worktree', referencedIssueUrl: 'https://code.example/group/sub/project/-/issues/3' } as RunRecord;
  outputs.clear();
  manager = Object.assign(Object.create(RunManager.prototype), { repoRoot: '/repo', dataDir: '/data', store: {
    getRun: () => record, updateRun: (_id: string, patch: Partial<RunRecord>) => Object.assign(record, patch),
    recordPrRef: (_id: string, ref: RunRecord['prRefs'] extends Array<infer T> | undefined ? T : never) => { record.prRefs = [ref]; },
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const node = (value: Parameters<RunManager['runSystemNode']>[2], resuming = false) => manager['runSystemNode']('run', {} as Parameters<RunManager['runSystemNode']>[1], value, outputs, 'task', () => undefined, undefined, resuming);
it('preserves reviewer assignment failure for recovery and downstream notifications', async () => {
  record.pullRequestUrl = url;
  fixture.update.mockResolvedValue({ ok: false, error: 'Reviewer unavailable' });
  expect(await node({ id: 'request-review', type: 'github.pr-update', reviewers: ['reviewer'] })).toBe('failed');
  expect(outputs.get('request-review')).toEqual({ error: 'Reviewer unavailable' });
});
it('routes all five persisted github node names through provider operations, including recovered MR URLs', async () => {
  expect(await node({ id: 'pr', type: 'github.draft-pr' })).toBe('created');
  expect(outputs.get('pr')).toEqual({ url, number: 7 });
  expect(record.prRefs?.[0]).toMatchObject({ number: 7, origin: 'created' });
  record.prRefs = undefined;
  expect(await node({ id: 'pr', type: 'github.draft-pr' }, true)).toBe('created'); expect(fixture.create).toHaveBeenCalledTimes(1);
  expect(await node({ id: 'comment', type: 'github.pr-comment', body: 'MR body' })).toBe('done');
  expect(await node({ id: 'update', type: 'github.pr-update', ready: true, addLabels: ['bug'], reviewers: ['ada'] })).toBe('done');
  expect(await node({ id: 'issue', type: 'github.issue-comment', body: 'Issue body' })).toBe('done');
  manager['parkGraphNode'] = vi.fn<RunManager['parkGraphNode']>(async (_runId, _state, _nodeId, _opts, setup) => {
    let result: { kind: 'answer'; text: string } | undefined;
    const stop = setup((answer) => { if (answer.kind === 'answer') result = answer; });
    await vi.advanceTimersByTimeAsync(1); stop?.();
    return result ?? { kind: 'timeout' };
  });
  expect(await node({ id: 'ci', type: 'github.wait-ci', timeoutMs: 60_000, pollMs: 10_000 }, true)).toBe('green');
  expect(fixture.comment.mock.calls).toEqual([['/repo', 'pr', 7, 'MR body'], ['/repo', 'issue', 3, 'Issue body']]);
  expect(fixture.update).toHaveBeenCalledWith('/repo', 7, { ready: true, addLabels: ['bug'], reviewers: ['ada'] });
  expect(fixture.checks).toHaveBeenCalledWith('/repo', [7]); expect(fixture.old).not.toHaveBeenCalled();
});
it('keeps wait-ci timeout authoritative and stops polling after late unavailable provider results', async () => {
  record.pullRequestUrl = url;
  let finish!: (value: unknown) => void;
  fixture.checks.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  manager['parkGraphNode'] = vi.fn<RunManager['parkGraphNode']>(async (_runId, _state, _nodeId, opts, setup) => {
    expect(opts.timeoutMs).toBe(60_000);
    const stop = setup(() => undefined);
    await vi.advanceTimersByTimeAsync(1); stop?.(); finish({ available: false }); await vi.advanceTimersByTimeAsync(60_000);
    return { kind: 'timeout' };
  });
  expect(await node({ id: 'ci', type: 'github.wait-ci', timeoutMs: 60_000, pollMs: 10_000 }, true)).toBe('timeout');
  expect(fixture.checks).toHaveBeenCalledTimes(1);
});
