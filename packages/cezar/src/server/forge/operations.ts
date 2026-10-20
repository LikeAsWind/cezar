import type { GithubData, GithubChecksData, GithubRefStatusData } from '@open-mercato/cezar-contract';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { taskRemotes } from '../../git-worktree.ts';
import { getRepoInfo } from '../git.ts';
import { fetchGithub, fetchGithubChecks, fetchGithubComments, fetchGithubPrDiff, fetchGithubRefStatus, searchGithubItems, readCachedRefStatuses } from '../github.ts';
import { resolveForge } from './index.ts';
import { readGitlabHosts } from './gitlab-hosts.ts';
import { createDraftPr as createGithubPr, updatePr, commentOnIssue, commentOnPr, forgetRefStatus } from './github.ts';
import type { DraftPrInput, DraftPrOutcome, ForgeCommentsData, ForgeListOptions, ForgePrDiffResult, ForgeSearchData } from './types.ts';
const execute = promisify(execFile);

/** Warm only local metadata before resolving self-managed instances. */
export async function resolveProjectForge(root: string) {
  const [info] = await Promise.all([getRepoInfo(root), readGitlabHosts()]);
  if (info) {
    const remotes = await taskRemotes(root);
    if (remotes.base) {
      try { info.remote = (await execute('git', ['remote', 'get-url', remotes.base], { cwd: root, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true })).stdout.trim(); }
      catch { return { driver: null, remote: info.remote, resolutionFailed: true }; }
    }
  }
  return { driver: resolveForge(info), remote: info?.remote };
}
const unavailable = 'Platform features are unavailable for this repository';
export async function createForgePr(input: DraftPrInput): Promise<DraftPrOutcome> {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(input.repoRoot);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) return createGithubPr(input);
  return driver ? driver.createPR(input) : { ok: false, error: unavailable };
}
export async function updateForgePr(root: string, number: number, input: { ready?: boolean; addLabels?: string[]; reviewers?: string[] }) {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) return updatePr(root, number, input);
  return driver ? driver.updatePR(number, input) : { ok: false as const, error: unavailable };
}
export async function commentForge(root: string, kind: 'issue' | 'pr', number: number, body: string) {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) return kind === 'issue' ? commentOnIssue(root, number, body) : commentOnPr(root, number, body);
  return driver ? driver.comment(kind, number, body) : { ok: false as const, error: unavailable };
}
export async function invalidateForge(root: string, kind: 'issue' | 'pr', number: number): Promise<void> {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) forgetRefStatus(root, number);
  else driver?.invalidate?.(kind, number);
}
export async function fetchForgeList(root: string, opts: ForgeListOptions = {}): Promise<GithubData> {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) return fetchGithub(root, opts.refresh, opts.limit, opts);
  return driver ? driver.list(opts) : { available: false, reason: unavailable, issues: [], prs: [] };
}
export async function fetchForgeComments(root: string, kind: 'issue' | 'pr', number: number, refresh = false): Promise<ForgeCommentsData> {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) return fetchGithubComments(root, kind, number, refresh);
  return driver ? driver.comments(kind, number, refresh) : { available: false, reason: unavailable, comments: [] };
}
export async function fetchForgeChecks(root: string, numbers: number[]): Promise<GithubChecksData> {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) return fetchGithubChecks(root, numbers);
  return driver ? driver.checks(numbers) : { available: false, reason: unavailable };
}
export async function fetchForgeRefStatus(root: string, input: { prs?: number[]; issues?: number[] }): Promise<GithubRefStatusData> {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) return fetchGithubRefStatus(root, input);
  return driver ? driver.refStatuses(input) : { available: false, reason: unavailable, recheckAfterMs: null };
}
export async function searchForgeItems(root: string, kind: 'issue' | 'pr', query: string, limit?: number): Promise<ForgeSearchData> {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) return searchGithubItems(root, kind, query, limit);
  return driver?.searchItems ? driver.searchItems(kind, query, { limit }) : { available: false, reason: unavailable, items: [] };
}
export async function fetchForgePrDiff(root: string, number: number, refresh = false): Promise<ForgePrDiffResult> {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  if (driver?.kind === 'github' || (!remote && !resolutionFailed)) return fetchGithubPrDiff(root, number, refresh);
  return driver?.prDiff ? driver.prDiff(number, { refresh }) : { available: false, reason: unavailable };
}
export async function readForgeCachedRefStatuses(root: string, numbers: number[]) {
  const { driver, remote, resolutionFailed } = await resolveProjectForge(root);
  return driver?.kind === 'github' || (!remote && !resolutionFailed) ? readCachedRefStatuses(root, numbers) : { prs: {}, issues: {} };
}
