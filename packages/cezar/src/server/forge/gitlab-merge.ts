import { z } from 'zod';
import { gitlabClient, gitlabOperation, gitlabReason, GitlabApiError } from './gitlab-api.ts';
import { gitlabApprovalPolicySchema, gitlabApprovalsSchema, gitlabItemSchema, gitlabItemUrl, gitlabProjectSchema, normalizeGitlabMergeState } from './gitlab-normalize.ts';
import type { GitlabItem } from './gitlab-normalize.ts';
import type { ForgeMergeInput, ForgeMergeResult, ForgePrCheck, ForgePrMergeStateResult, GitlabRepoRef } from './types.ts';

const merging = new Set<string>();
const mergedSchema = gitlabItemSchema.extend({ merge_commit_sha: z.string().nullable().optional(), squash_commit_sha: z.string().nullable().optional() });
const jobSchema = z.object({ id: z.number().int(), name: z.string(), status: z.string(), web_url: z.string().optional() });

/** CEZ_DRY_RUN=1 — a ready, mergeable MR so the merge panel is demoable offline (no `glab`). */
function mockGitlabMergeState(ref: GitlabRepoRef, number: number): ForgePrMergeStateResult {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  return {
    available: true,
    mergeState: normalizeGitlabMergeState(
      {
        iid: number, title: 'Dry-run merge request', state: 'opened', created_at: new Date().toISOString(),
        web_url: gitlabItemUrl(ref, 'pr', number), author: { username: 'mock' }, labels: [], user_notes_count: 0,
        source_branch: 'cez/dry-run', target_branch: 'main', detailed_merge_status: 'mergeable', has_conflicts: false,
        blocking_discussions_resolved: true, user: { can_merge: true }, diff_refs: { head_sha: sha },
        head_pipeline: { id: 1, project_id: 1, sha, status: 'success' },
      },
      ref,
      { approvals_required: 0, approvals_left: 0, approved: true },
      { id: 1, path_with_namespace: ref.projectPath, merge_method: 'merge', squash_option: 'default_off', only_allow_merge_if_pipeline_succeeds: false, only_allow_merge_if_all_discussions_are_resolved: false },
      { rules: [] },
    ),
  };
}

export function createGitlabMerge(root: string, ref: GitlabRepoRef, reads: { client: ReturnType<typeof gitlabClient>; detail: (kind: 'issue' | 'pr', number: number, refresh?: boolean) => Promise<GitlabItem> }) {
  const { client } = reads;
  async function detailedChecks(row: z.infer<typeof gitlabItemSchema>) {
    const pipeline = row.head_pipeline;
    if (!pipeline?.project_id || pipeline.sha !== (row.diff_refs?.head_sha ?? row.sha)) return undefined;
    const pipelineClient = gitlabClient(root, { ...ref, projectPath: String(pipeline.project_id) });
    const checks: ForgePrCheck[] = [];
    try {
      for (let page = 1; page <= 3; page++) {
        const jobs = await pipelineClient.page(`pipelines/${pipeline.id}/jobs?per_page=100&page=${page}`, z.array(jobSchema), { refresh: true });
        checks.push(...jobs.data.map((job) => ({ name: job.name, state: job.status === 'success' || job.status === 'skipped' ? 'passing' as const : ['failed', 'canceled'].includes(job.status) ? 'failing' as const : ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'manual'].includes(job.status) ? 'pending' as const : 'unknown' as const,
          required: null, ...(job.web_url ? { url: job.web_url } : {}) })));
        if (jobs.headers['x-next-page'] === '' || jobs.headers['x-next-page'] === undefined && jobs.data.length < 100) return { checks };
        if (jobs.headers['x-next-page'] !== undefined && jobs.headers['x-next-page'] !== String(page + 1)) return undefined;
      }
    } catch { /* Aggregate pipeline evidence remains usable when job detail is denied. */ }
    return undefined;
  }
  async function approvalPolicy(number: number, refresh = false) {
    try { return await client.api(`merge_requests/${number}/approval_state`, gitlabApprovalPolicySchema, { refresh }); }
    catch (error) {
      // A hidden/unsupported EE endpoint also returns 404. Only explicit CE metadata proves no rules.
      if (error instanceof GitlabApiError && error.status === 404 && (await client.version()).enterprise === false) return { rules: [] };
      return undefined;
    }
  }
  async function prMergeState(number: number, opts?: { refresh?: boolean }): Promise<ForgePrMergeStateResult> {
    return gitlabOperation(async () => {
      if (process.env.CEZ_DRY_RUN === '1') return mockGitlabMergeState(ref, number);
      try {
        const row = await reads.detail('pr', number, opts?.refresh);
        const [project, approvals, policy, checks] = await Promise.allSettled([
          client.api('', gitlabProjectSchema, opts), client.api(`merge_requests/${number}/approvals`, gitlabApprovalsSchema, opts), approvalPolicy(number, opts?.refresh), detailedChecks(row),
        ]);
        const current = await reads.detail('pr', number, true);
        if ((current.diff_refs?.head_sha ?? current.sha) !== (row.diff_refs?.head_sha ?? row.sha)) throw new GitlabApiError('GitLab merge request head changed while reading changes; refresh');
        const samePipeline = row.head_pipeline && current.head_pipeline && row.head_pipeline.project_id === current.head_pipeline.project_id && row.head_pipeline.id === current.head_pipeline.id && row.head_pipeline.sha === current.head_pipeline.sha;
        return { available: true, mergeState: normalizeGitlabMergeState(current, ref,
          approvals.status === 'fulfilled' ? approvals.value : undefined, project.status === 'fulfilled' ? project.value : undefined, policy.status === 'fulfilled' ? policy.value : undefined, samePipeline && checks.status === 'fulfilled' ? checks.value : undefined) };
      } catch (error) { return { available: false, reason: gitlabReason(error, ref) }; }
    });
  }
  async function mergePR(number: number, input: ForgeMergeInput): Promise<ForgeMergeResult> {
    if (input.overrideRules) return { merged: false, status: 403, code: 'override-unsupported', error: 'GitLab merge override is not supported' };
    const key = JSON.stringify([ref.host, ref.webOrigin ?? `https://${ref.host}`, ref.projectPath, number]);
    if (merging.has(key)) return { merged: false, status: 409, code: 'merge-in-progress', error: 'A merge is already in progress for this merge request' };
    merging.add(key);
    try {
      return await gitlabOperation(async () => {
        if (process.env.CEZ_DRY_RUN === '1') return { merged: false, status: 409, error: 'GitLab merge is unavailable in dry run' };
        const result = await prMergeState(number, { refresh: true });
        if (!result.available) return { merged: false, status: 502, error: result.reason };
        const current = result.mergeState;
        if (input.expectedHeadSha !== current.headSha) return { merged: false, status: 409, code: 'head-changed', error: 'The merge request head changed; refresh before merging', current };
        if (!current.methods.includes(input.method)) return { merged: false, status: 409, code: 'method-unavailable', error: 'This merge method is unavailable under the project policy', current };
        if (!current.canMerge) return { merged: false, status: current.eligibility === 'unauthorized' ? 403 : 409, code: 'merge-blocked', error: current.blockers.map((b) => b.message).join(' ') || 'This merge request cannot be merged', current };
        try {
          let merged;
          try {
            merged = await client.api(`merge_requests/${number}/merge`, mergedSchema, { method: 'PUT', fields: { sha: input.expectedHeadSha, squash: input.method === 'squash' } });
          } catch (error) {
            client.invalidate('pr', number);
            const recovered = await client.api(`merge_requests/${number}`, mergedSchema, { refresh: true }).catch(() => undefined);
            if (!recovered || recovered.state !== 'merged' || (recovered.diff_refs?.head_sha ?? recovered.sha) !== input.expectedHeadSha) {
              return { merged: false, status: error instanceof GitlabApiError && error.status === 403 ? 403 : error instanceof GitlabApiError && [405, 409, 422].includes(error.status ?? 0) ? 409 : 502,
                error: `Merge could not be confirmed — refresh before retrying. ${gitlabReason(error, ref)}` };
            }
            merged = recovered;
          }
          if (merged.iid !== number || merged.state !== 'merged' || (merged.diff_refs?.head_sha ?? merged.sha) !== input.expectedHeadSha) return { merged: false, status: 502, error: 'GitLab did not confirm the expected head was merged; refresh before retrying' };
          const commit = merged.merge_commit_sha ?? merged.squash_commit_sha;
          return { merged: true, number, url: gitlabItemUrl(ref, 'pr', number), method: input.method, ...(commit ? { mergeCommitSha: commit } : {}) };
        } finally { client.invalidate('pr', number); }
      });
    } finally { merging.delete(key); }
  }
  return { prMergeState, mergePR };
}
