import { z } from 'zod';
import type { ReferenceStatus } from '@open-mercato/cezar-contract';
import type { ForgeItem, ForgePrMergeState, GitlabRepoRef } from './types.ts';

export const gitlabUserSchema = z.object({ id: z.number().optional(), username: z.string(), avatar_url: z.string().nullable().optional() });
export const gitlabPipelineSchema = z.object({ id: z.number().int(), project_id: z.number().int().positive().optional(), sha: z.string(), status: z.string(), web_url: z.string().optional() });
export const gitlabItemSchema = z.object({
  iid: z.number().int().positive(), title: z.string(), state: z.enum(['opened', 'closed', 'merged', 'locked']),
  created_at: z.string(), web_url: z.string(), author: gitlabUserSchema.nullable().optional(),
  assignees: z.array(gitlabUserSchema).optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])),
  user_notes_count: z.number().int().nonnegative(), description: z.string().nullable().optional(),
  draft: z.boolean().optional(), work_in_progress: z.boolean().optional(), sha: z.string().optional(),
  source_branch: z.string().optional(), target_branch: z.string().optional(),
  source_project_id: z.number().nullable().optional(), target_project_id: z.number().optional(),
  has_conflicts: z.boolean().optional(), detailed_merge_status: z.string().optional(), merge_status: z.string().optional(),
  head_pipeline: gitlabPipelineSchema.nullable().optional(),
  diff_refs: z.object({ head_sha: z.string(), base_sha: z.string().optional(), start_sha: z.string().optional() }).nullable().optional(),
  blocking_discussions_resolved: z.boolean().optional(), user: z.object({ can_merge: z.boolean().optional() }).optional(),
});
export type GitlabItem = z.infer<typeof gitlabItemSchema>;
export const gitlabApprovalsSchema = z.object({ approvals_required: z.number().int().nonnegative().optional(),
  approvals_left: z.number().int().nonnegative().optional(), approved: z.boolean().optional(),
  approved_by: z.array(z.object({ user: gitlabUserSchema, approved_at: z.string().optional() })).optional() });
export type GitlabApprovals = z.infer<typeof gitlabApprovalsSchema>;
export const gitlabProjectSchema = z.object({ id: z.number().int(), path_with_namespace: z.string(), default_branch: z.string().nullable().optional(),
  merge_method: z.enum(['merge', 'rebase_merge', 'ff']).optional(), squash_option: z.enum(['never', 'always', 'default_on', 'default_off']).optional(),
  only_allow_merge_if_pipeline_succeeds: z.boolean().optional(), allow_merge_on_skipped_pipeline: z.boolean().optional(),
  only_allow_merge_if_all_discussions_are_resolved: z.boolean().optional() });
export type GitlabProject = z.infer<typeof gitlabProjectSchema>;
export const gitlabApprovalPolicySchema = z.object({ rules: z.array(z.object({ approvals_required: z.number().int().nonnegative(), approved: z.boolean() })) });
const checkEvidenceSchema = z.object({ checks: z.array(z.object({ name: z.string(), state: z.enum(['passing', 'failing', 'pending', 'unknown']), required: z.boolean().nullable(), url: z.string().optional() })) });

export function gitlabWebRoot(ref: GitlabRepoRef): string { return `${ref.webOrigin ?? `https://${ref.host}`}/${ref.projectPath.split('/').map(encodeURIComponent).join('/')}`; }
export function gitlabItemUrl(ref: GitlabRepoRef, kind: 'issue' | 'pr', number: number): string { return `${gitlabWebRoot(ref)}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${number}`; }
export function normalizeGitlabItem(row: GitlabItem, kind: 'issue' | 'pr', ref: GitlabRepoRef): ForgeItem {
  return { kind, number: row.iid, title: row.title, author: row.author?.username ?? '?', createdAt: row.created_at,
    labels: row.labels.map((label) => typeof label === 'string' ? label : label.name),
    url: gitlabItemUrl(ref, kind, row.iid), comments: row.user_notes_count,
    ...(kind === 'pr' ? { isDraft: row.draft ?? row.work_in_progress ?? false, checks: null } : {}) };
}
export function gitlabConflict(row: GitlabItem): boolean { return row.has_conflicts === true || row.detailed_merge_status === 'conflict'; }
export function gitlabMergeable(row: GitlabItem): ForgePrMergeState['mergeable'] {
  if (gitlabConflict(row)) return 'conflicting';
  if (row.detailed_merge_status === 'mergeable' || (!row.detailed_merge_status && row.merge_status === 'can_be_merged')) return 'mergeable';
  return 'unknown';
}
export function gitlabChecks(row: GitlabItem): 'passing' | 'failing' | 'pending' | null | undefined {
  if (!('head_pipeline' in row)) return undefined;
  if (!row.head_pipeline) return null;
  if (row.head_pipeline.sha !== (row.diff_refs?.head_sha ?? row.sha)) return undefined;
  switch (row.head_pipeline.status) {
    case 'success': return 'passing';
    case 'failed': case 'canceled': return 'failing';
    case 'created': case 'waiting_for_resource': case 'preparing': case 'pending': case 'running': case 'scheduled': case 'manual': return 'pending';
    default: return undefined;
  }
}
export function gitlabReview(approvals?: GitlabApprovals): ForgePrMergeState['reviewDecision'] {
  if (approvals?.approvals_required === undefined || approvals.approvals_left === undefined) return 'unknown';
  return approvals.approvals_left > 0 ? 'review-required' : 'approved';
}
export function gitlabReferenceStatus(row: GitlabItem, kind: 'issue' | 'pr', approvals?: GitlabApprovals): ReferenceStatus {
  if (kind === 'issue') return row.state === 'closed' ? 'completed' : 'open';
  if (row.state === 'merged') return 'merged';
  if (row.state === 'closed') return 'closed';
  if (row.draft || row.work_in_progress) return 'draft';
  const checks = gitlabChecks(row);
  if (checks === 'pending') return 'checks-pending';
  if (checks === 'failing') return 'checks-failing';
  if (gitlabReview(approvals) === 'review-required') return 'review-required';
  // `open` is neutral: absent CI/approval requirements cannot establish readiness.
  if (checks === 'passing' && gitlabReview(approvals) === 'approved') return 'ready';
  return 'open';
}

export function normalizeGitlabMergeState(raw: unknown, ref: GitlabRepoRef, approvalInput?: unknown, projectInput?: unknown, policyInput?: unknown, checkInput?: unknown): ForgePrMergeState {
  const row = gitlabItemSchema.parse(raw);
  const approvals = gitlabApprovalsSchema.safeParse(approvalInput);
  const project = gitlabProjectSchema.safeParse(projectInput).data;
  const policy = gitlabApprovalPolicySchema.safeParse(policyInput).data;
  const detail = checkEvidenceSchema.safeParse(checkInput).data;
  const glyph = row.head_pipeline?.status === 'skipped' && row.head_pipeline.sha === (row.diff_refs?.head_sha ?? row.sha) && project?.allow_merge_on_skipped_pipeline === true ? 'passing' : gitlabChecks(row);
  const mergeable = gitlabMergeable(row);
  const reviewDecision = policy ? policy.rules.some((rule) => rule.approvals_required > 0 && !rule.approved) ? 'review-required' : 'approved' : 'unknown';
  const state = row.state === 'merged' ? 'merged' : row.state === 'closed' || row.state === 'locked' ? 'closed' : 'open';
  const isDraft = row.draft ?? row.work_in_progress ?? false;
  const blockers: ForgePrMergeState['blockers'] = [];
  if (isDraft) blockers.push({ code: 'draft', message: 'This merge request is a draft.' });
  if (mergeable === 'conflicting') blockers.push({ code: 'conflicts', message: 'The merge request has conflicts.' });
  else if (mergeable === 'unknown') blockers.push({ code: 'mergeability-unknown', message: 'GitLab has not confirmed mergeability.' });
  if (reviewDecision !== 'approved') blockers.push({ code: 'approvals', message: reviewDecision === 'unknown' ? 'Approval requirements could not be read.' : 'Required approvals are missing.' });
  if (approvals.success && (approvals.data.approvals_left ?? 0) > 0 && reviewDecision === 'approved') blockers.push({ code: 'approvals', message: 'GitLab reports outstanding approvals.' });
  if (glyph === 'failing') blockers.push({ code: 'pipeline-failed', message: 'The head pipeline failed.' });
  if (glyph === 'pending') blockers.push({ code: 'pipeline-pending', message: 'The head pipeline is pending.' });
  if (glyph === undefined || (glyph === null && project?.only_allow_merge_if_pipeline_succeeds !== false)) blockers.push({ code: 'pipeline-unknown', message: 'The head pipeline requirements could not be confirmed.' });
  if (row.detailed_merge_status !== 'mergeable') blockers.push({ code: 'merge-policy', message: `GitLab merge status: ${row.detailed_merge_status ?? 'unknown'}.` });
  if (!project || project.only_allow_merge_if_pipeline_succeeds === undefined || project.only_allow_merge_if_all_discussions_are_resolved === undefined) blockers.push({ code: 'project-policy', message: 'Project merge policy could not be read completely.' });
  if (project?.only_allow_merge_if_all_discussions_are_resolved && row.blocking_discussions_resolved !== true) blockers.push({ code: 'discussions', message: 'Required discussions are unresolved or unreadable.' });
  if (row.user?.can_merge !== true) blockers.push({ code: 'permission', message: 'Merge permission could not be confirmed.' });
  const methods: ForgePrMergeState['methods'] = project?.merge_method === 'merge' && project.squash_option
    ? project.squash_option === 'always' ? ['squash'] : project.squash_option === 'never' ? ['merge'] : ['merge', 'squash'] : [];
  if (!methods.length) blockers.push({ code: 'merge-method', message: 'This project merge strategy cannot be represented by the available merge actions.' });
  if (!/^[0-9a-f]{40}$/i.test(row.diff_refs?.head_sha ?? row.sha ?? '')) blockers.push({ code: 'head-unknown', message: 'Merge request head SHA could not be confirmed.' });
  const canMerge = state === 'open' && !blockers.length && methods.length > 0;
  return { number: row.iid, title: row.title, url: gitlabItemUrl(ref, 'pr', row.iid), state, isDraft,
    headRef: row.source_branch ?? '', baseRef: row.target_branch ?? '', headSha: row.diff_refs?.head_sha ?? row.sha ?? '',
    mergeable, reviewDecision,
    checks: detail?.checks ?? (row.head_pipeline && glyph ? [{ name: 'Head pipeline', state: glyph, required: project?.only_allow_merge_if_pipeline_succeeds ?? null,
      ...(row.head_pipeline.web_url ? { url: row.head_pipeline.web_url } : {}) }] : []),
    checksTier: detail ? 'detailed' : glyph === undefined ? 'none' : 'aggregate', ...(glyph === undefined ? { checksReason: 'Head pipeline is unreadable or does not match the merge request head.' } : !detail && row.head_pipeline ? { checksReason: 'Detailed head pipeline jobs could not be read; showing the pipeline aggregate.' } : {}),
    methods, defaultMethod: methods.includes('squash') && (project?.squash_option === 'always' || project?.squash_option === 'default_on') ? 'squash' : methods[0] ?? null,
    eligibility: state !== 'open' ? 'terminal' : row.user?.can_merge === false ? 'unauthorized' : canMerge ? 'ready' : glyph === 'pending' ? 'pending' : reviewDecision === 'unknown' || blockers.some((b) => b.code.endsWith('unknown') || b.code === 'project-policy' || b.code === 'permission') ? 'unknown' : 'blocked',
    blockers, canMerge, canOverride: false };
}
