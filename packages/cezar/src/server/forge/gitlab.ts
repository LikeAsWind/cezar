import { createGitlabReads } from './gitlab-read.ts';
import { gitlabReason } from './gitlab-api.ts';
import { gitlabWebRoot, gitlabProjectSchema } from './gitlab-normalize.ts';
import { createGitlabWrites } from './gitlab-write.ts';
import { createGitlabMerge } from './gitlab-merge.ts';
import type { ForgeAvailability, ForgeDriver, GitlabRepoRef } from './types.ts';

const detection = new Map<string, { at: number; value: ForgeAvailability }>();
const pending = new Map<string, Promise<ForgeAvailability>>();

export function createGitlabDriver(root: string, ref: GitlabRepoRef): ForgeDriver {
  const reads = createGitlabReads(root, ref);
  const key = reads.client.identity;
  const detect = (): Promise<ForgeAvailability> => {
    if (process.env.CEZ_DRY_RUN === '1') return Promise.resolve({ available: true });
    if (!reads.client.isCurrent()) return Promise.resolve({ available: false, reason: 'GitLab configuration changed; reload the view' });
    const hit = detection.get(key);
    if (hit && Date.now() - hit.at < 15_000) return Promise.resolve(hit.value);
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const result = reads.client.api('', gitlabProjectSchema).then(() => ({ available: true }), (error: unknown) => ({ available: false, reason: gitlabReason(error, ref) }))
      .then((value) => { detection.set(key, { at: Date.now(), value }); while (detection.size > 100) detection.delete(detection.keys().next().value!); return value; })
      .finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  };
  return { kind: 'gitlab', detect,
    detectCached: () => { if (process.env.CEZ_DRY_RUN === '1') return { available: true }; if (!reads.client.isCurrent()) return null; const hit = detection.get(key); if (!hit || Date.now() - hit.at >= 15_000) void detect(); return hit?.value ?? null; },
    list: reads.list, comments: reads.comments, checks: reads.checks, refStatuses: reads.refStatuses,
    listIssues: async (opts) => (await reads.list(opts)).issues, listPRs: async (opts) => (await reads.list(opts)).prs,
    searchItems: reads.searchItems, recentCreated: reads.recentCreated, prDiff: reads.prDiff,
    ...createGitlabWrites(root, ref, reads), ...createGitlabMerge(root, ref, reads), invalidate: reads.client.invalidate,
    viewUrl: (kind, value) => {
      const base = gitlabWebRoot(ref);
      const path = String(value).split('/').map(encodeURIComponent).join('/');
      return kind === 'repo' ? base : `${base}/-/${{ issue: 'issues', pr: 'merge_requests', branch: 'tree', commit: 'commit' }[kind]}/${path}`;
    },
  };
}
