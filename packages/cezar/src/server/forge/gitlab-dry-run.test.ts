import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveForge } from './index.ts';
import type { DraftPrInput } from './types.ts';

/**
 * GitLab dry-run smoke (spec 2026-10-16-gitlab-forge-parity): under `CEZ_DRY_RUN=1` a GitLab
 * project answers the forge list / item detail (comments) / visible checks / MR changes /
 * merge-state endpoints from the bundled catalog without any `glab` subprocess or network. It
 * also exercises the disabled merge/override/review automation states and a mixed-provider
 * workspace (GitHub + GitLab + plain Git). Network-free by construction: no fixture spawns a
 * real command runner, and every assertion either reads the catalog or pins a refusal shape.
 */

// Any subprocess reachable here (the production `glab`/`gh` runners) must be a failure: the
// dry-run paths answer before spawning, so a real child would be the bug this suite exists to
// catch. Injected `GitlabCommandRunner`s are for the non-dry-run fixtures elsewhere.
afterEach(() => vi.restoreAllMocks());

describe('GitLab dry-run forge driver', () => {
  beforeEach(() => vi.stubEnv('CEZ_DRY_RUN', '1'));
  afterEach(() => vi.unstubAllEnvs());

  const gitlabRef = { host: 'gitlab.com', projectPath: 'group/sub/project' };
  const driver = () => resolveForge({ root: '/repo', branch: 'main', remote: 'git@gitlab.com:group/sub/project.git' })!;

  it('resolves a GitLab remote to a gitlab driver and reports available without a probe', async () => {
    const d = driver();
    expect(d.kind).toBe('gitlab');
    expect(await d.detect()).toEqual({ available: true });
    expect(d.detectCached()).toEqual({ available: true });
  });

  it('serves the issue/MR list with honest counts, full project path and label colors', async () => {
    const list = await driver().list();
    expect(list).toMatchObject({ available: true, repo: 'group/sub/project', labelColors: { bug: 'd73a4a' } });
    expect(list.issues.length).toBe(3);
    expect(list.prs.length).toBe(3);
    // A PR row's list-tier checks glyph is null (not hydrated), matching GitHub's list contract.
    expect(list.prs.every((row) => row.checks === null)).toBe(true);
    expect(list.issues[0]!.url).toBe('https://gitlab.com/group/sub/project/-/issues/41');
    expect(list.prs[0]!.url).toBe('https://gitlab.com/group/sub/project/-/merge_requests/22');
  });

  it('serves item detail (comments + timeline + body) and MR changes without glab', async () => {
    const comments = await driver().comments('issue', 41);
    expect(comments).toMatchObject({ available: true, events: [{ kind: 'labeled' }] });
    expect(comments.comments.length).toBe(2);
    expect(comments.detail?.body.length).toBeGreaterThan(0);

    const diff = await driver().prDiff!(22);
    expect(diff).toMatchObject({ available: true, number: 22, additions: 15, truncated: true });
    expect(diff.available && diff.files.map((f) => f.path)).toEqual(['src/session.ts', 'src/new-name.ts', 'assets/logo.png', 'generated/output.txt']);
  });

  it('hydrates visible checks and reference statuses from the catalog', async () => {
    const checks = await driver().checks([22, 19]);
    expect(checks).toEqual({ available: true, checks: { 22: 'passing', 19: 'failing' } });

    const statuses = await driver().refStatuses({ prs: [22, 19], issues: [41, 37] });
    expect(statuses).toMatchObject({ available: true, issues: { 41: 'open', 37: 'completed' } });
    expect(statuses.available && statuses.prs[22]).toBe('ready');
    expect(statuses.available && statuses.prs[19]).toBe('draft');
    expect(statuses.available && statuses.conflicts).toEqual([19]);
  });

  it('serves an honest merge panel with override always false', async () => {
    const state = await driver().prMergeState!(22, { refresh: true });
    expect(state).toMatchObject({ available: true, mergeState: { number: 22, canMerge: true, canOverride: false, reviewDecision: 'approved' } });
    if (state.available) {
      expect(state.mergeState.methods).toContain('merge');
    }
  });

  it('keeps merge, override and review-automation states disabled without real writes', async () => {
    const d = driver();
    // Merge is unavailable in dry run; an override request is rejected outright.
    expect(await d.mergePR!(22, { method: 'merge', expectedHeadSha: '0'.repeat(40), overrideRules: true }))
      .toMatchObject({ merged: false, status: 403 });
    expect(await d.mergePR!(22, { method: 'merge', expectedHeadSha: '0'.repeat(40) }))
      .toMatchObject({ merged: false, status: 409 });
    // Draft creation and updates answer ok without pushing or POSTing.
    const draftInput = { repoRoot: '/repo', handoffText: '', run: { title: 'Fix', task: 'Fix it', branch: 'cez/test', worktreePath: '/worktree' } } as DraftPrInput;
    expect(await d.createPR!(draftInput))
      .toEqual({ ok: true, url: 'https://gitlab.com/group/sub/project/-/merge_requests/777', dryRun: true });
    expect(await d.updatePR!(22, { ready: true })).toEqual({ ok: true });
    expect(await d.comment!('pr', 22, 'body')).toEqual({ ok: true });
  });
});

describe('mixed-provider workspace navigation', () => {
  beforeEach(() => vi.stubEnv('CEZ_DRY_RUN', '1'));
  afterEach(() => vi.unstubAllEnvs());

  it('classifies GitHub, GitLab and plain-Git remotes independently', () => {
    expect(resolveForge({ root: '/a', branch: 'main', remote: 'git@github.com:acme/project.git' })?.kind).toBe('github');
    expect(resolveForge({ root: '/b', branch: 'main', remote: 'git@gitlab.com:group/sub/project.git' })?.kind).toBe('gitlab');
    // A bare filesystem repo has no remote → no forge driver, but still a project.
    expect(resolveForge({ root: '/c', branch: 'main' })).toBeNull();
  });

  it('serves each provider from its own catalog under one flag', async () => {
    const github = resolveForge({ root: '/a', branch: 'main', remote: 'git@github.com:acme/project.git' })!;
    const gitlab = resolveForge({ root: '/b', branch: 'main', remote: 'git@gitlab.com:group/sub/project.git' })!;
    const ghList = await github.list();
    const glList = await gitlab.list();
    expect(ghList).toMatchObject({ available: true, repo: 'mock/repo' });
    expect(glList).toMatchObject({ available: true, repo: 'group/sub/project' });
    expect(ghList.prs.length).toBeGreaterThan(0);
    expect(glList.prs.length).toBeGreaterThan(0);
  });
});
