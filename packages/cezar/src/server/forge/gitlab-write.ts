import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { autosaveCommit, taskRemotes } from '../../git-worktree.ts';
import { parseRemote, splitRemoteRef } from '../../git-remotes.ts';
import { knownGitlabHost, readGitlabHosts } from './gitlab-hosts.ts';
import { gitlabClient, gitlabOperation, gitlabReason, gitlabRemainingMs, type GitlabApiOptions } from './gitlab-api.ts';
import { buildPrBody } from './github.ts';
import { gitlabChecks, gitlabItemSchema, gitlabItemUrl, gitlabProjectSchema } from './gitlab-normalize.ts';
import type { createGitlabReads } from './gitlab-read.ts';
import type { DraftPrInput, DraftPrOutcome, ForgePrStatus, GitlabRepoRef } from './types.ts';

const execute = promisify(execFile);
const creating = new Set<string>();
const user = z.object({ id: z.number().int().positive(), username: z.string() });
const updateSchema = gitlabItemSchema.extend({ reviewers: z.array(user).optional(), assignees: z.array(user).optional(), assignee: user.nullable().optional() });
const assigneesOf = (row: z.infer<typeof updateSchema>) => row.assignees ?? (row.assignee === null ? [] : row.assignee ? [row.assignee] : undefined);
const readyTitle = (title: string) => title.replace(/^(?:(?:draft|wip):\s*|\[(?:draft|wip)\]\s*|\((?:draft|wip)\)\s*)+/i, '');
type WriteResult = { ok: true } | { ok: false; error: string };
async function git(root: string, args: string[]): Promise<string> {
  return (await execute('git', args, { cwd: root, timeout: gitlabRemainingMs(), maxBuffer: 4 * 1024 * 1024,
    windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}

export function createGitlabWrites(root: string, ref: GitlabRepoRef, reads: ReturnType<typeof createGitlabReads>) {
  const { client } = reads;
  const fail = (error: unknown) => gitlabReason(error, ref);
  async function identities(cwd: string) {
    await client.ensureCurrent();
    const remotes = await taskRemotes(cwd);
    if (!remotes.base || !remotes.push) throw new Error('remote');
    const parse = async (name: string, push = false) => {
      const urls = (await git(cwd, ['remote', 'get-url', ...(push ? ['--push', '--all'] : []), name])).split(/\r?\n/).filter(Boolean);
      if (urls.length !== 1) throw new Error('remote');
      const parsed = parseRemote(urls[0]!);
      if (!parsed) throw new Error('remote');
      await readGitlabHosts();
      const host = knownGitlabHost(parsed) ?? (parsed.host === 'gitlab.com' ? { host: 'gitlab.com', webOrigin: 'https://gitlab.com' } : undefined);
      if (!host || host.host !== ref.host || host.webOrigin !== (ref.webOrigin ?? `https://${ref.host}`)) throw new Error('cross-forge');
      return { ...host, projectPath: parsed.projectPath };
    };
    const target = await parse(remotes.base);
    if (target.projectPath !== ref.projectPath) throw new Error('target');
    const source = await parse(remotes.push, true);
    const targetProject = await client.api('', gitlabProjectSchema, { refresh: true });
    const sourceClient = source.projectPath === ref.projectPath ? client : gitlabClient(root, source);
    const sourceProject = sourceClient === client ? targetProject : await sourceClient.api('', gitlabProjectSchema, { refresh: true });
    return { remotes, sourceClient, sourceProject, targetProject };
  }
  async function find(branch: string, sourceId: number, targetId: number, targetBranch?: string, refresh = false) {
    const result = await reads.pages('merge_requests', gitlabItemSchema,
      { state: targetBranch ? 'opened' : 'all', scope: 'all', source_branch: branch, order_by: 'updated_at', sort: 'desc' }, 1_000, undefined, refresh);
    if (result.next || result.truncated) throw new Error('truncated');
    return result.rows.find((row) => row.source_branch === branch && row.source_project_id === sourceId && row.target_project_id === targetId && (!targetBranch || row.target_branch === targetBranch));
  }
  async function createPR(input: DraftPrInput): Promise<DraftPrOutcome> {
    return gitlabOperation(async () => {
      const { run } = input;
      if (!run.worktreePath || !run.branch) return { ok: false, error: 'this task has no worktree/branch to publish' };
      const key = JSON.stringify([ref.host, ref.webOrigin, ref.projectPath, run.branch]);
      if (creating.has(key)) return { ok: false, error: 'Merge request creation is already in progress for this branch' };
      creating.add(key);
      try {
        await client.ensureCurrent();
        const saved = await autosaveCommit(run.worktreePath, 'pre-PR');
        gitlabRemainingMs();
        if (saved === 'refused') return { ok: false, error: 'worktree has unresolved merge conflicts — resolve them, then publish again' };
        if (saved === 'failed') return { ok: false, error: 'could not commit the final changes — check git status in the worktree' };
        if (process.env.CEZ_DRY_RUN === '1') return { ok: true, url: gitlabItemUrl(ref, 'pr', 777), dryRun: true };
        let ids: Awaited<ReturnType<typeof identities>>;
        try { ids = await identities(run.worktreePath); }
        catch (error) {
          if (error instanceof Error && ['remote', 'cross-forge', 'target'].includes(error.message)) return { ok: false, error: 'GitLab source and target remotes must identify projects on the selected instance' };
          throw error;
        }
        const base = run.baseBranch ? splitRemoteRef(run.baseBranch, ids.remotes.names).branch : undefined;
        const targetBranch = base && !/^[0-9a-f]{7,40}$/i.test(base) ? base : ids.targetProject.default_branch;
        if (!targetBranch) return { ok: false, error: 'GitLab target branch could not be resolved' };
        try { await git(run.worktreePath, ['push', '-u', ids.remotes.push!, run.branch]); }
        catch { return { ok: false, error: 'git push failed — check Git authentication and the worktree branch' }; }
        const existing = await find(run.branch, ids.sourceProject.id, ids.targetProject.id, targetBranch, true);
        if (existing) return { ok: true, url: gitlabItemUrl(ref, 'pr', existing.iid), dryRun: false };
        const title = input.draft === false ? readyTitle(run.title) : `Draft: ${readyTitle(run.title)}`;
        let created;
        try {
          created = await ids.sourceClient.api('merge_requests', gitlabItemSchema, { method: 'POST', fields: {
            source_branch: run.branch, target_branch: targetBranch, target_project_id: ids.targetProject.id, title,
            description: buildPrBody(input.handoffText, run.task),
          } });
        } catch (error) {
          client.invalidate('pr');
          // A timeout can arrive after the server accepted the POST. Never repeat that POST.
          const recovered = await find(run.branch, ids.sourceProject.id, ids.targetProject.id, targetBranch, true).catch(() => undefined);
          if (recovered) return { ok: true, url: gitlabItemUrl(ref, 'pr', recovered.iid), dryRun: false };
          return { ok: false, error: `Merge request creation could not be confirmed — inspect the branch on GitLab before retrying. ${fail(error)}` };
        } finally { client.invalidate('pr'); ids.sourceClient.invalidate('pr'); }
        if (created.source_project_id !== ids.sourceProject.id || created.target_project_id !== ids.targetProject.id || created.source_branch !== run.branch || created.target_branch !== targetBranch) return { ok: false, error: 'GitLab returned an unexpected merge request identity — inspect the branch before retrying' };
        return { ok: true, url: gitlabItemUrl(ref, 'pr', created.iid), dryRun: false };
      } catch (error) { return { ok: false, error: fail(error) }; }
      finally { creating.delete(key); }
    });
  }
  async function updatePR(number: number, input: { ready?: boolean; addLabels?: string[]; reviewers?: string[] }): Promise<WriteResult> {
    return gitlabOperation(async () => {
      if (process.env.CEZ_DRY_RUN === '1') return { ok: true };
      try {
        const row = await client.api(`merge_requests/${number}`, updateSchema, { refresh: true });
        const fields: NonNullable<GitlabApiOptions['fields']> = {};
        let legacyAssignee: number | undefined;
        if (input.ready) fields.title = readyTitle(row.title);
        if (input.addLabels?.length) {
          if (input.addLabels.some((label) => label.includes(','))) return { ok: false, error: 'GitLab label names cannot contain commas in this operation' };
          fields.add_labels = [...new Set(input.addLabels)].join(',');
        }
        if (input.reviewers?.length) {
          let existing = row.reviewers;
          const legacy = existing === undefined;
          if (legacy) {
            const version = /^(\d+)\.(\d+)(?:\.|$)/.exec((await client.version()).version ?? '');
            if (!version || Number(version[1]) > 13 || Number(version[1]) === 13 && Number(version[2]) >= 7) {
              return { ok: false, error: 'GitLab reviewer support could not be confirmed; existing assignments were not changed' };
            }
            existing = assigneesOf(row);
            if (!existing) return { ok: false, error: 'Existing GitLab assignees could not be read' };
          }
          const ids = new Set(existing!.map((reviewer) => reviewer.id));
          for (const username of new Set(input.reviewers)) {
            const users = await client.users(username, z.array(user));
            const matches = users.filter((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
            if (matches.length !== 1) return { ok: false, error: 'GitLab reviewer username could not be resolved exactly' };
            ids.add(matches[0]!.id);
          }
          if (legacy) {
            // Old GitLab editions may only support one assignee. Never let an
            // attempted addition silently replace an existing review owner.
            if (ids.size !== 1) return { ok: false, error: 'Legacy GitLab review assignment requires one assignee; existing assignees were not changed' };
            legacyAssignee = [...ids][0]!;
            fields.assignee_id = legacyAssignee;
          } else fields.reviewer_ids = [...ids];
        }
        if (Object.keys(fields).length) {
          try {
            const updated = await client.api(`merge_requests/${number}`, updateSchema, { method: 'PUT', fields });
            if (legacyAssignee !== undefined && !assigneesOf(updated)?.some(assignee => assignee.id === legacyAssignee)) {
              return { ok: false, error: 'GitLab assignee update could not be confirmed; inspect the merge request before retrying' };
            }
          }
          finally { client.invalidate('pr', number); }
        }
        return { ok: true };
      } catch (error) { return { ok: false, error: fail(error) }; }
    });
  }
  async function comment(kind: 'issue' | 'pr', number: number, body: string): Promise<WriteResult> {
    return gitlabOperation(async () => {
      if (process.env.CEZ_DRY_RUN === '1') return { ok: true };
      try { await client.api(`${kind === 'issue' ? 'issues' : 'merge_requests'}/${number}/notes`, z.object({ id: z.number().int() }), { method: 'POST', fields: { body } }); return { ok: true }; }
      catch (error) { return { ok: false, error: `Comment could not be confirmed — inspect the conversation before retrying. ${fail(error)}` }; }
      finally { client.invalidate(kind, number); }
    });
  }
  async function prStatus(branch: string): Promise<ForgePrStatus | null> {
    return gitlabOperation(async () => {
      if (process.env.CEZ_DRY_RUN === '1') return null;
      try {
        const ids = await identities(root);
        const row = await find(branch, ids.sourceProject.id, ids.targetProject.id);
        return row ? { number: row.iid, url: gitlabItemUrl(ref, 'pr', row.iid), state: row.state === 'merged' ? 'merged' : row.state === 'closed' ? 'closed' : 'open', isDraft: row.draft ?? row.work_in_progress ?? false, checks: gitlabChecks(row) ?? null } : null;
      } catch { return null; }
    });
  }
  return { createPR, updatePR, comment, prStatus };
}
