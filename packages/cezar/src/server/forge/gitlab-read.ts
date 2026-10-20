import { z } from 'zod';
import type { GithubData, GithubChecksData, GithubRefStatusData } from '@open-mercato/cezar-contract';
import { createGitlabApi, gitlabClient, gitlabOperation, gitlabReason, GITLAB_BUDGET, GitlabApiError, type GitlabCommandRunner } from './gitlab-api.ts';
import { gitlabApprovalsSchema, gitlabChecks, gitlabConflict, gitlabItemSchema, gitlabItemUrl,
  gitlabReferenceStatus, gitlabReview, normalizeGitlabItem, type GitlabItem } from './gitlab-normalize.ts';
import { createGitlabMerge } from './gitlab-merge.ts';
import { GithubPrNotFoundError } from './github.ts';
import type { ForgeCommentsData, ForgeListOptions, ForgePrDiffResult, ForgeRecentCreatedData, ForgeSearchData, ForgeTimelineEvent, GitlabRepoRef } from './types.ts';

const cursorSchema = z.object({ v: z.literal(1), scope: z.string(), page: z.number().int().min(1).max(1_000_000), size: z.literal(100), position: z.number().int().min(0).max(99) });
const noteSchema = z.object({ id: z.number(), body: z.string(), created_at: z.string(), author: z.object({ username: z.string(), avatar_url: z.string().nullable().optional() }), system: z.boolean() });
const diffSchema = z.object({ old_path: z.string(), new_path: z.string(), new_file: z.boolean(), renamed_file: z.boolean(), deleted_file: z.boolean(),
  diff: z.string().optional(), too_large: z.boolean().optional(), collapsed: z.boolean().optional() });
type Kind = 'issue' | 'pr';
const endpoint = (kind: Kind) => kind === 'issue' ? 'issues' : 'merge_requests';
type PageResult<T> = { rows: T[]; next: string | null; truncated: boolean; total?: number };

// ---- CEZ_DRY_RUN mock (spec 2026-10-16-gitlab-forge-parity) -------------------
// A small fixed catalog so a GitLab project's forge tab is demoable offline, mirroring the
// GitHub driver's `mockGithub()`. Rows carry merge/CI evidence so checks, ref-status, changes
// and merge-state all answer without `glab`. `CEZ_DRY_RUN=1` never spawns a subprocess here.

const DRY_SHA = '0123456789abcdef0123456789abcdef01234567';
const DRY_SHA_B = 'fedcba9876543210fedcba9876543210fedcba98';
const DRY_APPROVALS = { approvals_required: 0, approvals_left: 0, approved: true, approved_by: [] };

function mockGitlabItem(ref: GitlabRepoRef, kind: Kind, over: Partial<GitlabItem> & { iid: number; title: string }): GitlabItem {
  return {
    state: 'opened',
    created_at: new Date(Date.now() - (200 - over.iid) * 3_600_000).toISOString(),
    web_url: gitlabItemUrl(ref, kind, over.iid), author: { username: 'mock' }, labels: [],
    user_notes_count: 0,
    ...over,
  };
}

function mockGitlabCatalog(ref: GitlabRepoRef): { issues: GitlabItem[]; prs: GitlabItem[] } {
  const issues: GitlabItem[] = [
    mockGitlabItem(ref, 'issue', { iid: 41, title: 'Login form drops session on refresh', labels: [{ name: 'bug', color: '#d73a4a' }, { name: 'auth', color: '#5319e7' }], user_notes_count: 3, description: 'Repro: log in, hit reload — you land back on /login.' }),
    mockGitlabItem(ref, 'issue', { iid: 39, title: 'Add --json flag to cez CLI output', labels: [{ name: 'enhancement', color: '#a2eeef' }, { name: 'cli', color: '#0e8a16' }], user_notes_count: 1, description: 'For scripting it would help if `cez list` could emit JSON.' }),
    mockGitlabItem(ref, 'issue', { iid: 37, title: 'Flaky e2e: worktree cleanup race', state: 'closed', labels: [{ name: 'bug', color: '#d73a4a' }, { name: 'flaky-test', color: '#fbca04' }], user_notes_count: 6, description: 'Cancelling a run while the agent holds a file lock leaves a dangling worktree.' }),
  ];
  const prs: GitlabItem[] = [
    mockGitlabItem(ref, 'pr', { iid: 22, title: 'Fix flaky auth test in CI', labels: [{ name: 'tests', color: '#c5def5' }],
      source_branch: 'cez/22', target_branch: 'main', detailed_merge_status: 'mergeable', has_conflicts: false,
      blocking_discussions_resolved: true, user: { can_merge: true }, diff_refs: { head_sha: DRY_SHA },
      head_pipeline: { id: 1, project_id: 1, sha: DRY_SHA, status: 'success' }, description: 'Loosens the timing assertion in refresh.test.ts.' }),
    mockGitlabItem(ref, 'pr', { iid: 19, title: 'Rate limit /api/runs', labels: [{ name: 'server', color: '#1d76db' }, { name: 'draft', color: '#6a737d' }],
      draft: true, has_conflicts: true, source_branch: 'cez/19', target_branch: 'main',
      diff_refs: { head_sha: DRY_SHA_B }, head_pipeline: { id: 2, project_id: 1, sha: DRY_SHA_B, status: 'failed' },
      user_notes_count: 4, description: 'Draft: token-bucket middleware on the runs router.' }),
    mockGitlabItem(ref, 'pr', { iid: 17, title: 'Bump dependencies', state: 'merged', labels: [{ name: 'deps', color: '#fbca04' }],
      source_branch: 'cez/17', target_branch: 'main', diff_refs: { head_sha: DRY_SHA }, user_notes_count: 2 }),
  ];
  return { issues, prs };
}

const DRY_LABEL_COLORS = { bug: 'd73a4a', auth: '5319e7', enhancement: 'a2eeef', cli: '0e8a16', 'flaky-test': 'fbca04', tests: 'c5def5', server: '1d76db', draft: '6a737d', deps: 'fbca04' };

function mockGitlabList(ref: GitlabRepoRef): GithubData {
  const catalog = mockGitlabCatalog(ref);
  return {
    available: true, repo: ref.projectPath, syncedAt: new Date().toISOString(),
    issues: catalog.issues.map((row) => normalizeGitlabItem(row, 'issue', ref)),
    prs: catalog.prs.map((row) => normalizeGitlabItem(row, 'pr', ref)),
    labelColors: DRY_LABEL_COLORS,
    issuesTotal: catalog.issues.length, prsTotal: catalog.prs.length,
  };
}

function mockGitlabComments(ref: GitlabRepoRef, kind: Kind, number: number): ForgeCommentsData {
  const catalog = mockGitlabCatalog(ref);
  const row = (kind === 'issue' ? catalog.issues : catalog.prs).find((item) => item.iid === number)
    ?? mockGitlabItem(ref, kind, { iid: number, title: `Mock ${kind} ${number}` });
  const base = Date.now() - 3_600_000;
  const at = (offset: number) => new Date(base + offset).toISOString();
  return {
    available: true,
    comments: [
      { id: 1, author: 'ada', createdAt: at(0), body: 'Thanks for the report — I can reproduce.', kind: 'comment', url: `${gitlabItemUrl(ref, kind, number)}#note_1` },
      { id: 2, author: 'lin', createdAt: at(600_000), body: 'Here is the failing screen:\n\n![failure](https://example.invalid/failure.png)', kind: 'comment', url: `${gitlabItemUrl(ref, kind, number)}#note_2` },
    ],
    events: [{ id: 'state-1', kind: 'labeled', actor: 'ada', createdAt: at(300_000), label: { name: 'bug', color: 'd73a4a' } }],
    detail: { body: (row.description ?? '').slice(0, 8_000) },
  };
}

function mockGitlabPrDiff(ref: GitlabRepoRef, number: number): ForgePrDiffResult {
  return {
    available: true, number, headSha: DRY_SHA, additions: 15, deletions: 4, truncated: true,
    reason: 'One or more patches were not provided by GitLab.',
    files: [
      { path: 'src/session.ts', status: 'modified', additions: 8, deletions: 3, patch: '@@ -1,3 +1,4 @@\n-old\n+new\n context' },
      { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed', additions: 7, deletions: 1, patch: '@@ -1 +1 @@\n-old name\n+new name' },
      { path: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'binary' },
      { path: 'generated/output.txt', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'too-large', truncated: true },
    ],
  };
}

/** Injectable command boundary keeps fixture tests offline without replacing the reads. */
export function createGitlabReads(root: string, ref: GitlabRepoRef, run?: GitlabCommandRunner) {
  const client = run ? createGitlabApi(root, ref, run) : gitlabClient(root, ref);
  const fail = (error: unknown) => gitlabReason(error, ref);
  async function pages<T>(path: string, schema: z.ZodType<T>, filters: Record<string, string>, limit: number, cursor?: string, refresh = false, pageBudget: number = GITLAB_BUDGET.pages): Promise<PageResult<T>> {
    return gitlabOperation(async () => {
      await client.ensureCurrent();
      const scope = JSON.stringify([ref.host, ref.webOrigin ?? `https://${ref.host}`, ref.projectPath, client.generation, path, Object.entries(filters).sort()]);
      let page = 1; let position = 0;
      if (cursor) {
        if (cursor.length > 2_000) throw new GitlabApiError('Invalid GitLab continuation token');
        try { const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); if (parsed.scope !== scope) throw new Error(); page = parsed.page; position = parsed.position; }
        catch { throw new GitlabApiError('Invalid or incompatible GitLab continuation token'); }
      }
      const token = (nextPage: number, nextPosition = 0) => Buffer.from(JSON.stringify({ v: 1, scope, page: nextPage, size: 100, position: nextPosition })).toString('base64url');
      const rows: T[] = [];
      let total: number | undefined;
      for (let count = 0; count < Math.min(pageBudget, GITLAB_BUDGET.pages); count++) {
        const query = new URLSearchParams({ ...filters, per_page: '100', page: String(page) });
        if (filters['iids[]']) { query.delete('iids[]'); for (const iid of filters['iids[]'].split(',')) query.append('iids[]', iid); }
        const result = await client.page(`${path}?${query}`, z.array(schema), { refresh });
        const reported = result.headers['x-total'];
        if (reported && /^\d+$/.test(reported)) total = Number(reported);
        if (position > result.data.length) throw new GitlabApiError('GitLab continuation position no longer exists; refresh the list');
        const take = Math.min(limit - rows.length, result.data.length - position);
        rows.push(...result.data.slice(position, position + take));
        if (position + take < result.data.length) return { rows, next: token(page, position + take), truncated: false, ...(total !== undefined ? { total } : {}) };
        let next: number | undefined;
        const header = result.headers['x-next-page'];
        if (header !== undefined) {
          if (header && !/^\d+$/.test(header)) throw new GitlabApiError('Invalid GitLab pagination header');
          if (header) next = Number(header);
        } else if (result.headers.link) {
          const target = /<([^>]+)>;\s*rel="next"/.exec(result.headers.link)?.[1];
          if (target) {
            const url = new URL(target);
            const origin = ref.webOrigin ?? `https://${ref.host}`;
            const expected = `/api/v4/projects/${encodeURIComponent(ref.projectPath)}/${path}`;
            if (url.origin !== origin || url.username || url.password || url.pathname !== expected || url.searchParams.get('per_page') !== '100') throw new GitlabApiError('Unsafe GitLab continuation target');
            for (const [key, value] of Object.entries(filters)) if (url.searchParams.get(key) !== value) throw new GitlabApiError('Incompatible GitLab continuation filters');
            const pageValue = url.searchParams.get('page') ?? '';
            if (!/^\d+$/.test(pageValue)) throw new GitlabApiError('Invalid GitLab continuation page');
            next = Number(pageValue);
          }
        } else if (result.data.length === 100) next = page + 1;
        if (next !== undefined && (!Number.isSafeInteger(next) || next <= page)) throw new GitlabApiError('Invalid GitLab continuation page');
        if (!next) return { rows, next: null, truncated: false, ...(total !== undefined ? { total } : {}) };
        if (rows.length >= limit) return { rows, next: token(next), truncated: false, ...(total !== undefined ? { total } : {}) };
        page = next; position = 0;
      }
      return { rows, next: token(page), truncated: true, ...(total !== undefined ? { total } : {}) };
    });
  }
  const detail = (kind: Kind, number: number, refresh = false) => client.api(`${endpoint(kind)}/${number}`, gitlabItemSchema, { refresh });
  async function parallel<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
    const output: R[] = [];
    let index = 0;
    let failed = false;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!failed && index < items.length) { const current = index++; try { output[current] = await work(items[current]!); } catch (error) { failed = true; throw error; } }
    }));
    const error = workers.find((result) => result.status === 'rejected');
    if (error?.status === 'rejected') throw error.reason;
    return output;
  }
  async function list(opts: ForgeListOptions = {}): Promise<GithubData> {
    return gitlabOperation(async () => {
      if (process.env.CEZ_DRY_RUN === '1') return mockGitlabList(ref);
      const result: GithubData = { available: true, repo: ref.projectPath, issues: [], prs: [], syncedAt: new Date().toISOString() };
      const limit = Math.max(1, Math.min(1_000, opts.limit ?? 50));
      for (const kind of ['issue', 'pr'] as const) {
        try {
          const data = await pages(endpoint(kind), gitlabItemSchema, { state: 'opened', scope: 'all', order_by: 'created_at', sort: 'desc', with_labels_details: 'true' }, limit, kind === 'issue' ? opts.issuesCursor : opts.prsCursor, opts.refresh);
          const items = data.rows.map((row) => normalizeGitlabItem(row, kind, ref));
          if (kind === 'issue') { result.issues = items; result.issuesNextCursor = data.next; if (data.total !== undefined) result.issuesTotal = data.total; }
          else { result.prs = items; result.prsNextCursor = data.next; if (data.total !== undefined) result.prsTotal = data.total; }
          for (const row of data.rows) for (const label of row.labels) if (typeof label !== 'string' && label.color) (result.labelColors ??= {})[label.name] = label.color.replace(/^#/, '');
          if (data.truncated) { result.truncated = true; result.reason = 'GitLab list reached its page budget; continue to load more.'; }
        } catch (error) { result.available = false; result.reason = fail(error); result.truncated = true; }
      }
      return result;
    });
  }
  async function searchItems(kind: Kind, query: string, opts?: { limit?: number }): Promise<ForgeSearchData> {
    return gitlabOperation(async () => {
      try {
        const data = await pages(endpoint(kind), gitlabItemSchema, { state: 'all', scope: 'all', search: query, in: 'title,description', order_by: 'updated_at', sort: 'desc' }, Math.min(100, Math.max(1, opts?.limit ?? 30)));
        return { available: true, items: data.rows.map((row) => normalizeGitlabItem(row, kind, ref)), truncated: !!data.next || data.truncated };
      } catch (error) { return { available: false, items: [], reason: fail(error) }; }
    });
  }
  async function checks(numbers: number[]): Promise<GithubChecksData> {
    return gitlabOperation(async () => {
      if (process.env.CEZ_DRY_RUN === '1') {
        const requested = new Set(numbers);
        const prs = mockGitlabCatalog(ref).prs.filter((row) => requested.has(row.iid));
        return { available: true, checks: Object.fromEntries(prs.map((row) => [row.iid, gitlabChecks(row) ?? null])) };
      }
      try {
        const values = await parallel([...new Set(numbers)], async (number) => {
          const row = await detail('pr', number);
          const glyph = gitlabChecks(row);
          if (glyph === undefined) throw new GitlabApiError(`GitLab CI for merge request !${number} is unreadable or does not match its head`);
          return [number, glyph] as const;
        });
        return { available: true, checks: Object.fromEntries(values) };
      } catch (error) { return { available: false, reason: fail(error) }; }
    });
  }
  async function refStatuses(input: { prs?: number[]; issues?: number[] }): Promise<GithubRefStatusData> {
    return gitlabOperation(async () => {
      if (process.env.CEZ_DRY_RUN === '1') {
        const catalog = mockGitlabCatalog(ref);
        const prs: Record<number, ReturnType<typeof gitlabReferenceStatus>> = {};
        const issues: typeof prs = {};
        const conflicts: number[] = [];
        for (const row of catalog.prs) {
          if (!(input.prs ?? []).includes(row.iid)) continue;
          prs[row.iid] = gitlabReferenceStatus(row, 'pr', DRY_APPROVALS);
          if (gitlabConflict(row) && row.state === 'opened') conflicts.push(row.iid);
        }
        for (const row of catalog.issues) {
          if ((input.issues ?? []).includes(row.iid)) issues[row.iid] = gitlabReferenceStatus(row, 'issue');
        }
        return { available: true, prs, issues, conflicts, recheckAfterMs: 30_000 };
      }
      try {
        const prs: Record<number, ReturnType<typeof gitlabReferenceStatus>> = {};
        const issues: typeof prs = {};
        const conflicts: number[] = [];
        for (const kind of ['issue', 'pr'] as const) {
          const numbers = [...new Set(kind === 'issue' ? input.issues ?? [] : input.prs ?? [])];
          if (!numbers.length) continue;
          const query = { state: 'all', scope: 'all', 'iids[]': numbers.join(','), order_by: 'created_at', sort: 'desc' };
          const requested = await pages(endpoint(kind), gitlabItemSchema, query, 1_000);
          if (requested.next || requested.truncated) throw new GitlabApiError('GitLab reference batch was truncated');
          await parallel(requested.rows.filter((row) => numbers.includes(row.iid)), async (row) => {
            if (kind === 'issue') { issues[row.iid] = gitlabReferenceStatus(row, kind); return; }
            if (gitlabConflict(row) && row.state === 'opened') conflicts.push(row.iid);
            if (row.state !== 'opened' || row.draft || row.work_in_progress) { prs[row.iid] = gitlabReferenceStatus(row, kind); return; }
            const full = await detail('pr', row.iid);
            const approval = await client.api(`merge_requests/${row.iid}/approvals`, gitlabApprovalsSchema);
            const glyph = gitlabChecks(full);
            if (glyph === undefined) throw new GitlabApiError(`GitLab CI for merge request !${row.iid} is unreadable or does not match its head`);
            if (gitlabReview(approval) === 'unknown') throw new GitlabApiError(`Approval requirements for GitLab merge request !${row.iid} could not be read`);
            prs[row.iid] = gitlabReferenceStatus(full, 'pr', approval);
            if (gitlabConflict(full) && !conflicts.includes(row.iid)) conflicts.push(row.iid);
          });
        }
        return { available: true, prs, issues, conflicts, recheckAfterMs: 30_000 };
      } catch (error) { return { available: false, reason: fail(error), recheckAfterMs: 60_000 }; }
    });
  }
  async function comments(kind: Kind, number: number, refresh = false): Promise<ForgeCommentsData> {
    return gitlabOperation(async () => {
      if (process.env.CEZ_DRY_RUN === '1') return mockGitlabComments(ref, kind, number);
      try {
        const row = await detail(kind, number, refresh);
        const notes = await pages(`${endpoint(kind)}/${number}/notes`, noteSchema, { sort: 'asc', order_by: 'created_at' }, 1_000, undefined, refresh);
        const result: ForgeCommentsData = { available: true, comments: notes.rows.filter((note) => !note.system).map((note) => ({ id: note.id, author: note.author.username,
          ...(note.author.avatar_url ? { avatarUrl: note.author.avatar_url } : {}), createdAt: note.created_at, body: note.body.slice(0, 8_000), kind: 'comment', url: `${gitlabItemUrl(ref, kind, number)}#note_${note.id}` })),
          detail: { body: (row.description ?? '').slice(0, 8_000) }, truncated: !!notes.next || notes.truncated, events: [] };
        const eventSchema = z.object({ id: z.number(), created_at: z.string(), user: z.object({ username: z.string() }), state: z.string().optional(), action: z.string().optional(), label: z.object({ name: z.string(), color: z.string().optional() }).nullable().optional() });
        for (const type of ['state', 'label'] as const) {
          try {
            const events = await pages(`${endpoint(kind)}/${number}/resource_${type}_events`, eventSchema, {}, 1_000, undefined, refresh);
            for (const event of events.rows) {
              const eventKind = type === 'state' ? ({ closed: 'closed', reopened: 'reopened', merged: 'merged' } as const)[event.state as 'closed'] : event.action === 'add' ? 'labeled' : event.action === 'remove' ? 'unlabeled' : undefined;
              if (eventKind) result.events!.push({ id: `${type}-${event.id}`, kind: eventKind, actor: event.user.username, createdAt: event.created_at,
                ...(event.label ? { label: { name: event.label.name, ...(event.label.color ? { color: event.label.color.replace(/^#/, '') } : {}) } } : {}) } satisfies ForgeTimelineEvent);
            }
            result.truncated ||= !!events.next || events.truncated;
          } catch { result.truncated = true; result.reason = 'Some GitLab timeline activity could not be read.'; }
        }
        return result;
      } catch (error) { return { available: false, comments: [], reason: fail(error) }; }
    });
  }
  const { prMergeState } = createGitlabMerge(root, ref, { client, detail });
  async function prDiff(number: number, opts?: { refresh?: boolean }): Promise<ForgePrDiffResult> {
    return gitlabOperation(async () => {
      if (process.env.CEZ_DRY_RUN === '1') return mockGitlabPrDiff(ref, number);
      let found = false;
      try {
        const row = await detail('pr', number, opts?.refresh);
        found = true;
        const headSha = row.diff_refs?.head_sha ?? row.sha;
        if (!headSha) throw new GitlabApiError('GitLab merge request head is unavailable');
        const data = await pages(`merge_requests/${number}/diffs`, diffSchema, {}, 300, undefined, opts?.refresh);
        let truncated = !!data.next || data.truncated;
        const files = data.rows.map((file) => {
          const patch = file.diff;
          const tooLarge = file.too_large || file.collapsed || (patch !== undefined && Buffer.byteLength(patch) > 512 * 1024);
          const binary = patch?.startsWith('Binary files ') || patch?.startsWith('GIT binary patch');
          const unavailable = tooLarge ? 'too-large' as const : binary ? 'binary' as const : !patch ? 'not-provided' as const : undefined;
          if (tooLarge) truncated = true;
          return { path: file.new_path, ...(file.renamed_file ? { previousPath: file.old_path } : {}),
            status: file.new_file ? 'added' as const : file.deleted_file ? 'removed' as const : file.renamed_file ? 'renamed' as const : 'modified' as const,
            additions: patch?.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length ?? 0,
            deletions: patch?.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length ?? 0,
            ...(unavailable ? { patchUnavailableReason: unavailable } : { patch }), ...(tooLarge ? { truncated: true } : {}) };
        });
        const current = await detail('pr', number, true);
        if ((current.diff_refs?.head_sha ?? current.sha) !== headSha) throw new GitlabApiError('GitLab merge request head changed while reading changes; refresh');
        return { available: true, number, headSha, files, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0), truncated };
      } catch (error) { if (!found && error instanceof GitlabApiError && error.status === 404) throw new GithubPrNotFoundError(`Merge request !${number} not found`); return { available: false, reason: fail(error) }; }
    });
  }
  async function recentCreated(kind: Kind, sinceDate: string): Promise<ForgeRecentCreatedData> {
    return gitlabOperation(async () => {
      try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate) || !Number.isFinite(Date.parse(sinceDate))) throw new GitlabApiError('Invalid GitLab creation date');
        const result = await pages(endpoint(kind), gitlabItemSchema, { state: 'all', scope: 'all', created_after: `${sinceDate}T00:00:00Z`, order_by: 'created_at', sort: 'desc' }, 30);
        return { available: true, items: result.rows.map((row) => ({ number: row.iid, title: row.title, createdAt: row.created_at, url: gitlabItemUrl(ref, kind, row.iid) })), truncated: !!result.next || result.truncated };
      } catch (error) { return { available: false, items: [], reason: fail(error) }; }
    });
  }
  return { list, searchItems, checks, refStatuses, comments, prMergeState, prDiff, recentCreated, client, detail, pages };
}
