import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGitlabDriver } from './gitlab.ts';
import { normalizeGitlabMergeState } from './gitlab-normalize.ts';
import type { GitlabCommandRunner } from './gitlab-api.ts';
const fixture = vi.hoisted(() => ({ api: vi.fn<GitlabCommandRunner>() }));
vi.mock('./gitlab-api.ts', async (original) => {
  const actual = await original<typeof import('./gitlab-api.ts')>();
  return { ...actual, gitlabClient: (root: string, ref: Parameters<typeof actual.gitlabClient>[1]) => actual.createGitlabApi(root, ref, fixture.api) };
});
const ref = { host: 'gitlab.com', projectPath: 'group/sub/target' };
const sha = 'a'.repeat(40);
const row = (extra = {}) => ({ iid: 7, title: 'Fix', state: 'opened', created_at: '2026-10-16T00:00:00Z', web_url: 'https://gitlab.com/group/sub/target/-/merge_requests/7', labels: [], user_notes_count: 0,
  sha, source_branch: 'cez/test', target_branch: 'master', detailed_merge_status: 'mergeable', head_pipeline: null, user: { can_merge: true }, ...extra });
const project = { id: 1, path_with_namespace: ref.projectPath, merge_method: 'merge' as const, squash_option: 'default_off' as const, only_allow_merge_if_pipeline_succeeds: false, only_allow_merge_if_all_discussions_are_resolved: false };
const approval = { approvals_required: 0, approvals_left: 0 };
beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0'); fixture.api.mockReset().mockImplementation(async (args) => {
    const path = args[6]!;
    return JSON.stringify(path.endsWith('/merge') ? row({ state: 'merged', merge_commit_sha: 'b'.repeat(40) }) : path.endsWith('/approval_state') ? { rules: [] } : path.endsWith('/approvals') ? approval : path.endsWith('/7') ? row() : project);
  });
});
afterEach(() => vi.unstubAllEnvs());
const driver = () => createGitlabDriver('/repo', ref);
it('does not advertise a merge-commit or rebase action for ff/semi-linear policies', () => {
  for (const merge_method of ['ff', 'rebase_merge'] as const) {
    const state = normalizeGitlabMergeState(row(), ref, approval, { ...project, merge_method });
    expect(state.methods).toEqual([]); expect(state.canMerge).toBe(false); expect(state.blockers.some((b) => b.code === 'merge-method')).toBe(true);
  }
});
it('validates unknown provider data and never turns a snapshot approved:true into policy proof', () => {
  expect(() => normalizeGitlabMergeState({ bad: true }, ref, approval, project)).toThrow();
  expect(normalizeGitlabMergeState(row(), ref, { approved: true }, project)).toMatchObject({ canMerge: false, reviewDecision: 'unknown' });
});
it('rejects override, stale expected head, unapproved policy and unreadable CI before mutation', async () => {
  const d = driver(); expect(d.mergePR).toBeTypeOf('function');
  expect(await d.mergePR!(7, { method: 'merge', expectedHeadSha: sha, overrideRules: true })).toMatchObject({ merged: false, status: 403 });
  expect(await d.mergePR!(7, { method: 'merge', expectedHeadSha: 'c'.repeat(40) })).toMatchObject({ merged: false, status: 409 });
  fixture.api.mockImplementation(async (args) => JSON.stringify(args[6]!.endsWith('/7') ? row({ head_pipeline: undefined }) : args[6]!.endsWith('/approvals') ? { approvals_required: 1, approvals_left: 1 } : project));
  expect(await driver().mergePR!(7, { method: 'merge', expectedHeadSha: sha })).toMatchObject({ merged: false });
  expect(fixture.api.mock.calls.some(([args]) => args[4] === 'PUT')).toBe(false);
});
it('revalidates fresh policy/head and sends the expected SHA with a semantically executable action', async () => {
  const d = driver(); expect(d.mergePR).toBeTypeOf('function');
  expect(await d.mergePR!(7, { method: 'squash', expectedHeadSha: sha })).toMatchObject({ merged: true, number: 7, method: 'squash', mergeCommitSha: 'b'.repeat(40) });
  const writes = fixture.api.mock.calls.filter(([args]) => args[4] === 'PUT'); expect(writes).toHaveLength(1);
  expect(writes[0]![0]).toContain('projects/group%2Fsub%2Ftarget/merge_requests/7/merge');
  expect(JSON.parse(writes[0]![1].input!)).toEqual({ sha, squash: true });
});
it('guards concurrent merges across separate driver instances', async () => {
  let release!: () => void;
  let held = false;
  fixture.api.mockImplementation(async (args) => {
    if (args[6]!.endsWith('/7')) { if (!held) { held = true; await new Promise<void>((resolve) => { release = resolve; }); } return JSON.stringify(row()); }
    return JSON.stringify(args[6]!.endsWith('/approvals') ? approval : args[6]!.endsWith('/approval_state') ? { rules: [] } : args[6]!.endsWith('/merge') ? row({ state: 'merged' }) : project);
  });
  const d = driver(); expect(d.mergePR).toBeTypeOf('function');
  const pending = d.mergePR!(7, { method: 'merge', expectedHeadSha: sha });
  expect(await driver().mergePR!(7, { method: 'merge', expectedHeadSha: sha })).toMatchObject({ merged: false, status: 409 });
  await vi.waitFor(() => expect(release).toBeTypeOf('function')); release(); await pending;
});
it('distinguishes confirmed CE from denied or unsupported EE approval policy', async () => {
  for (const enterprise of [false, true, undefined]) {
    fixture.api.mockImplementation(async (args) => {
      const path = args[6]!;
      if (path.endsWith('/approval_state')) return 'HTTP/2.0 404 Not Found\r\n\r\n{}';
      return JSON.stringify(path === 'version' ? { enterprise } : path.endsWith('/7') ? row() : path.endsWith('/approvals') ? { approved: true, approved_by: [] } : project);
    });
    const result = await driver().prMergeState!(7, { refresh: true });
    expect(result).toMatchObject({ available: true, mergeState: { canMerge: enterprise === false, reviewDecision: enterprise === false ? 'approved' : 'unknown' } });
  }
});
it('hydrates jobs only for the merge panel using the pipeline project identity and retains aggregate on unreadable jobs', async () => {
  let denied = false;
  fixture.api.mockImplementation(async (args) => {
    const path = args[6]!;
    if (path.includes('/pipelines/')) {
      expect(path).toBe('projects/42/pipelines/3/jobs?per_page=100&page=1');
      if (denied) return 'HTTP/2.0 403 Forbidden\r\n\r\n{}';
      return JSON.stringify([{ id: 1, name: 'unit', status: 'success', web_url: 'https://gitlab.com/jobs/1' }]);
    }
    return JSON.stringify(path.endsWith('/7') ? row({ head_pipeline: { id: 3, project_id: 42, sha, status: 'success' } }) : path.endsWith('/approval_state') ? { rules: [] } : path.endsWith('/approvals') ? approval : project);
  });
  expect(await driver().prMergeState!(7, { refresh: true })).toMatchObject({ available: true, mergeState: { checksTier: 'detailed', checks: [{ name: 'unit', state: 'passing', required: null }] } });
  denied = true;
  expect(await driver().prMergeState!(7, { refresh: true })).toMatchObject({ available: true, mergeState: { checksTier: 'aggregate', checksReason: expect.any(String), checks: [{ name: 'Head pipeline' }] } });
});
it('discards detailed jobs when the pipeline changes on the same MR source head', async () => {
  let snapshots = 0;
  fixture.api.mockImplementation(async (args) => {
    const path = args[6]!;
    if (path.includes('/pipelines/')) return JSON.stringify([{ id: 1, name: 'old successful job', status: 'success' }]);
    return JSON.stringify(path.endsWith('/7') ? row({ head_pipeline: { id: ++snapshots === 1 ? 3 : 4, project_id: 42, sha, status: snapshots === 1 ? 'success' : 'running' } }) : path.endsWith('/approval_state') ? { rules: [] } : path.endsWith('/approvals') ? approval : project);
  });
  expect(await driver().prMergeState!(7, { refresh: true })).toMatchObject({ available: true, mergeState: { checksTier: 'aggregate', checks: [{ name: 'Head pipeline', state: 'pending' }], canMerge: false } });
});
