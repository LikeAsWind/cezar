import { execFile } from 'node:child_process';
import { z } from 'zod';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { parseRemote, resolveTaskRemotes } from '../git-remotes.ts';
import { createGitlabApi, gitlabReason, type GitlabCommandRunner } from '../server/forge/gitlab-api.ts';
import { knownGitlabHost } from '../server/forge/gitlab-hosts.ts';
import type { GitlabRepoRef } from '../server/forge/types.ts';

/**
 * Pull-request head checkouts for automations (spec 2026-10-06-agentic-e2e-checks Phase 3).
 *
 * A `checkout: 'pr-head'` automation verifies the PR it matched, not the base branch: before the
 * run starts, the PR is read from GitHub, its head is fetched into a NAMESPACED ref
 * (`refs/cezar/pr/<n>` — never a branch, so nothing appears in the user's branch list), and the
 * run forks its worktree from the fetched sha. Every outcome ends somewhere: a closed PR and an
 * unadmitted fork are skipped, an unreachable head fails the launch, and only a resolved head
 * starts a run.
 */

export interface PrHead {
  number: number;
  /** The base repository, `owner/name` — the one the automation polls. */
  repo: string;
  /** Where the head lives; differs from `repo` for a fork. */
  headRepo: string;
  headRef: string;
  /** The FETCHED sha — what is tested and recorded, even if the API said otherwise. */
  headSha: string;
  baseRef: string;
  /** `refs/cezar/pr/<n>`. */
  ref: string;
  /** The PR's web page, for the run's PR reference. */
  url: string;
  untrusted: boolean;
}

export type PrHeadResolution =
  | { kind: 'ok'; head: PrHead; note?: string }
  | { kind: 'skipped'; reason: 'pr-not-open' | 'fork-head' }
  | { kind: 'failed'; reason: string };

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (command: 'gh' | 'glab' | 'git', args: string[], cwd: string) => Promise<CommandResult>;

/** A GitLab MR's head metadata, read through the bounded `glab` API. */
const gitlabMrSchema = z.object({
  iid: z.number().int().positive(),
  state: z.enum(['opened', 'closed', 'merged', 'locked']),
  web_url: z.string(),
  source_project_id: z.number().int().positive(),
  target_project_id: z.number().int().positive(),
  source_branch: z.string().min(1),
  target_branch: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  diff_refs: z.object({ head_sha: z.string() }).nullable().optional(),
});

/** The source project's identity, resolved via glab, plus the fork/untrusted distinction. */
const gitlabProjectIdentitySchema = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/),
  ssh_url_to_repo: z.string().optional(),
  http_url_to_repo: z.string().optional(),
});

/**
 * GitLab MR-head resolution (spec 2026-10-16-gitlab-forge-parity): the head metadata comes from
 * `glab api` on the MR's target instance, the source project/branch/SHA are validated before
 * checkout, and the head is fetched from the branch ref on the source project. A fork MR fetches
 * from the fork's namespace; the same `refs/cezar/pr/<n>` ref is written either way.
 */
export async function resolveGitlabMrHead(options: {
  root: string;
  ref: GitlabRepoRef;
  number: number;
  allowForkHeads: boolean;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<PrHeadResolution> {
  const { root, ref, number } = options;
  if ((options.env ?? process.env).CEZ_DRY_RUN === '1') {
    return fixturePrHead({ ...options, repo: ref.projectPath, url: `${ref.webOrigin ?? `https://${ref.host}`}/${ref.projectPath}/-/merge_requests/${number}` });
  }
  const exec = options.run ?? runCommand;
  const glabRun: GitlabCommandRunner = async (args, opts) => {
    if (options.run) {
      // The injected command runner sees `glab` calls: replay them through its `CommandResult`.
      const result = await options.run('glab', args, opts.cwd);
      if (!result.ok) {
        const error = new Error(result.stderr || 'glab failed');
        throw error;
      }
      return result.stdout;
    }
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execute = promisify(execFile);
    const { stdout } = await execute('glab', args, { ...opts, encoding: 'utf8', windowsHide: true });
    return String(stdout);
  };

  const refTag = prHeadRef(number);
  try {
    const api = createGitlabApi(root, ref, glabRun);
    const mr = await api.api(`merge_requests/${number}`, gitlabMrSchema, { refresh: true });
    if (mr.state !== 'opened') return { kind: 'skipped', reason: 'pr-not-open' };
    const headSha = mr.diff_refs?.head_sha ?? mr.sha;
    if (!headSha) return { kind: 'failed', reason: 'pr-head-unavailable: GitLab merge request head is unavailable' };

    // A project's numeric ID is an instance-level identity; read each project through a client
    // addressed by its id (the `gitlab-merge.ts` `pipeline.project_id` pattern), not as a path
    // under the target project's namespace.
    const sourceApi = createGitlabApi(root, { ...ref, projectPath: String(mr.source_project_id) }, glabRun);
    const targetApi = createGitlabApi(root, { ...ref, projectPath: String(mr.target_project_id) }, glabRun);
    const [source, target] = await Promise.all([
      sourceApi.api('', gitlabProjectIdentitySchema, { refresh: true }),
      targetApi.api('', gitlabProjectIdentitySchema, { refresh: true }),
    ]);
    const headRepo = source.path_with_namespace;
    if (source.id !== mr.source_project_id || target.id !== mr.target_project_id || target.path_with_namespace.toLowerCase() !== ref.projectPath.toLowerCase()) {
      return unavailable('GitLab project identity changed', '');
    }
    const untrusted = source.id !== target.id;
    if (untrusted && !options.allowForkHeads) return { kind: 'skipped', reason: 'fork-head' };

    // Fetch the head branch from the SOURCE project's namespace, never the target's.
    const sourceRef = `${headRepo}:${mr.source_branch}`;
    const transport = await gitlabHeadTransport(exec, root, ref, headRepo, source);
    if (!transport) return unavailable('no matching Git transport for the merge request source', '');
    const fetched = await exec('git', ['fetch', '--no-tags', transport, `+refs/heads/${mr.source_branch}:${refTag}`], root);
    if (!fetched.ok) return unavailable(`could not fetch ${sourceRef}`, fetched.stderr);
    const resolved = await exec('git', ['rev-parse', '--verify', `${refTag}^{commit}`], root);
    if (!resolved.ok) return unavailable(`could not resolve ${refTag}`, resolved.stderr);
    const fetchedSha = resolved.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(fetchedSha)) return unavailable('invalid fetched merge request SHA', '');

    return {
      kind: 'ok',
      head: {
        number, repo: target.path_with_namespace, headRepo, headRef: mr.source_branch, headSha: fetchedSha,
        baseRef: mr.target_branch, ref: refTag, url: mr.web_url, untrusted,
      },
      ...(fetchedSha !== headSha
        ? { note: `merge request !${number} moved while launching — testing the fetched head ${fetchedSha.slice(0, 12)} (the API reported ${headSha.slice(0, 12)})` }
        : {}),
    };
  } catch (error) {
    return unavailable('could not read the merge request', gitlabReason(error, ref));
  }
}

async function gitlabHeadTransport(exec: CommandRunner, root: string, ref: GitlabRepoRef, sourcePath: string,
  source: z.infer<typeof gitlabProjectIdentitySchema>): Promise<string | undefined> {
  const sameInstance = (raw: string) => {
    const remote = parseRemote(raw);
    if (!remote) return null;
    const known = knownGitlabHost(remote);
    const host = known?.host ?? remote.host;
    const origin = known?.webOrigin ?? remote.httpOrigin;
    if (remote.httpOrigin ? origin !== (ref.webOrigin ?? `https://${ref.host}`) : host !== ref.host) return null;
    return remote;
  };
  const list = await exec('git', ['remote'], root);
  const remotes: Array<{ name: string; url: string; projectPath: string }> = [];
  for (const name of list.ok ? list.stdout.trim().split(/\r?\n/).filter(Boolean) : []) {
    const result = await exec('git', ['remote', 'get-url', name], root);
    const url = result.stdout.trim();
    const remote = result.ok ? sameInstance(url) : null;
    if (remote) remotes.push({ name, url, projectPath: remote.projectPath });
  }
  const direct = remotes.find(remote => remote.projectPath.toLowerCase() === sourcePath.toLowerCase());
  if (direct) return direct.name;
  const target = remotes.find(remote => remote.projectPath.toLowerCase() === ref.projectPath.toLowerCase());
  if (target) {
    if (/^[^/]+@[^:]+:/.test(target.url)) return `${target.url.slice(0, target.url.indexOf(':') + 1)}${sourcePath}.git`;
    try {
      const url = new URL(target.url);
      if (url.protocol !== 'ssh:' && url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
      url.pathname = `/${sourcePath}.git`;
      if (url.protocol !== 'ssh:') { url.username = ''; url.password = ''; }
      url.search = ''; url.hash = '';
      return url.toString();
    } catch { return undefined; }
  }
  for (const url of [source.ssh_url_to_repo, source.http_url_to_repo]) {
    if (url && sameInstance(url)?.projectPath.toLowerCase() === sourcePath.toLowerCase()) return url;
  }
  return undefined;
}


const pullSchema = z.object({
  state: z.string(),
  html_url: z.string().url(),
  head: z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    ref: z.string().min(1),
    // `null` when the fork was deleted: there is no head repository to trust.
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string().min(1) }),
});

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The one ref a PR head is fetched into. */
export function prHeadRef(number: number): string {
  return `refs/cezar/pr/${number}`;
}

export const runCommand: CommandRunner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr || (error ? error.message : '')) });
    });
  });

/** A failure reason safe for the execution log: secrets and token shapes removed, bounded. */
function unavailable(what: string, stderr: string): PrHeadResolution {
  const detail = redactSecrets(stderr.trim(), collectSecretValues()).slice(0, 1_000);
  return { kind: 'failed', reason: `pr-head-unavailable: ${what}${detail ? ` — ${detail}` : ''}` };
}

/** The remote whose URL is `repo`, else the base remote, else `origin` (the old default). */
async function remoteForRepo(exec: CommandRunner, root: string, repo: string): Promise<string> {
  const remotes = await resolveTaskRemotes((args) => exec('git', args, root));
  for (const name of remotes.names) {
    const url = await exec('git', ['remote', 'get-url', name], root);
    const parsed = url.ok ? parseRemote(url.stdout.trim()) : null;
    if (parsed && `${parsed.owner}/${parsed.repo}`.toLowerCase() === repo.toLowerCase()) return name;
  }
  return remotes.base ?? 'origin';
}

export async function resolvePrHead(options: {
  root: string;
  repo: string;
  number: number;
  allowForkHeads: boolean;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  /** When set, route through the GitLab provider instead of `gh` (approval-snapshot checkouts). */
  gitlabRef?: GitlabRepoRef;
}): Promise<PrHeadResolution> {
  if (options.gitlabRef) {
    return resolveGitlabMrHead({
      root: options.root, ref: options.gitlabRef, number: options.number,
      allowForkHeads: options.allowForkHeads, run: options.run, env: options.env,
    });
  }
  const { root, repo, number } = options;
  const exec = options.run ?? runCommand;
  if (!REPO_RE.test(repo) || !Number.isSafeInteger(number) || number <= 0) {
    return { kind: 'failed', reason: `pr-head-unavailable: invalid pull request ${repo}#${number}` };
  }
  const ref = prHeadRef(number);

  // `CEZ_DRY_RUN=1`: no `gh`, no fetch. The fixture PR is open, same-repo, and its head is the
  // repository's current HEAD, pinned into the same namespaced ref a real fetch would write.
  if ((options.env ?? process.env).CEZ_DRY_RUN === '1') {
    const head = await exec('git', ['rev-parse', 'HEAD'], root);
    if (!head.ok) return unavailable('could not read the fixture head', head.stderr);
    const sha = head.stdout.trim();
    const pinned = await exec('git', ['update-ref', ref, sha], root);
    if (!pinned.ok) return unavailable(`could not write ${ref}`, pinned.stderr);
    return {
      kind: 'ok',
      head: {
        number, repo, headRepo: repo, headRef: `fixture-pr-${number}`, headSha: sha, baseRef: 'main', ref,
        url: `https://github.com/${repo}/pull/${number}`, untrusted: false,
      },
    };
  }

  const api = await exec('gh', ['api', `repos/${repo}/pulls/${number}`], root);
  if (!api.ok) return unavailable('could not read the pull request', api.stderr);
  let parsed: z.infer<typeof pullSchema>;
  try {
    parsed = pullSchema.parse(JSON.parse(api.stdout));
  } catch {
    return unavailable('unexpected pull request payload', '');
  }
  if (parsed.state !== 'open') return { kind: 'skipped', reason: 'pr-not-open' };
  const headRepo = parsed.head.repo?.full_name ?? '(deleted fork)';
  const untrusted = headRepo.toLowerCase() !== repo.toLowerCase();
  if (untrusted && !options.allowForkHeads) return { kind: 'skipped', reason: 'fork-head' };

  // `refs/pull/N/head` lives on the PR's repo, not necessarily `origin` (#1383).
  const remote = await remoteForRepo(exec, root, repo);
  const fetched = await exec('git', ['fetch', '--no-tags', remote, `+refs/pull/${number}/head:${ref}`], root);
  if (!fetched.ok) return unavailable(`could not fetch refs/pull/${number}/head`, fetched.stderr);
  const resolved = await exec('git', ['rev-parse', '--verify', `${ref}^{commit}`], root);
  if (!resolved.ok) return unavailable(`could not resolve ${ref}`, resolved.stderr);
  const headSha = resolved.stdout.trim();

  return {
    kind: 'ok',
    head: {
      number, repo, headRepo, headRef: parsed.head.ref, headSha, baseRef: parsed.base.ref, ref,
      url: parsed.html_url, untrusted,
    },
    // The PR moved between the API read and the fetch: test what was fetched, and say so.
    ...(headSha !== parsed.head.sha
      ? { note: `pull request #${number} moved while launching — testing the fetched head ${headSha.slice(0, 12)} (the API reported ${parsed.head.sha.slice(0, 12)})` }
      : {}),
  };
}

async function fixturePrHead(options: { root: string; repo: string; number: number; url: string; run?: CommandRunner }): Promise<PrHeadResolution> {
  const exec = options.run ?? runCommand;
  const head = await exec('git', ['rev-parse', 'HEAD'], options.root);
  if (!head.ok) return unavailable('could not read the fixture head', head.stderr);
  const sha = head.stdout.trim();
  const ref = prHeadRef(options.number);
  const pinned = await exec('git', ['update-ref', ref, sha], options.root);
  if (!pinned.ok) return unavailable(`could not write ${ref}`, pinned.stderr);
  return { kind: 'ok', head: { number: options.number, repo: options.repo, headRepo: options.repo, headRef: `fixture-pr-${options.number}`, headSha: sha, baseRef: 'main', ref, url: options.url, untrusted: false } };
}

/**
 * Delete every `refs/cezar/pr/<n>` no remaining run still needs. Idempotent, never throws: a
 * stale ref is harmless, leaking one per PR forever is not, so every worktree removal path
 * sweeps rather than tracking which removal was the last.
 */
export async function prunePrHeadRefs(
  root: string,
  stillNeeded: ReadonlySet<number>,
  run: CommandRunner = runCommand,
): Promise<void> {
  const listed = await run('git', ['for-each-ref', '--format=%(refname)', 'refs/cezar/pr/'], root);
  if (!listed.ok) return;
  for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const match = /^refs\/cezar\/pr\/([1-9][0-9]*)$/.exec(name);
    if (!match || stillNeeded.has(Number(match[1]))) continue;
    await run('git', ['update-ref', '-d', name], root);
  }
}
