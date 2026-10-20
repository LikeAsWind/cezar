import { z } from 'zod';
import type { AutomationRuntimeState } from '@open-mercato/cezar-contract';
import { gitlabOperation, type GitlabCommandRunner } from '../server/forge/gitlab-api.ts';
import { gitlabConfigRevision } from '../server/forge/gitlab-hosts.ts';
import { createGitlabReads } from '../server/forge/gitlab-read.ts';
import { gitlabApprovalsSchema, gitlabItemSchema, gitlabItemUrl } from '../server/forge/gitlab-normalize.ts';
import type { GitlabRepoRef } from '../server/forge/types.ts';
import { automationCapabilityIssue } from './forge-capabilities.ts';
import { matchesFilters, type GithubCandidate, type GithubPollResult } from './github-poller.ts';
import type { GithubAutomationDefinition } from './types.ts';

export const GITLAB_APPROVAL_EVENT = 'pull_request.approval_observed';
export function gitlabApprovalKey(ref: GitlabRepoRef, iid: number, approverId: string, approvedAt: string): string {
  return `${ref.host}:${ref.projectPath}:${iid}:${approverId}:${approvedAt}`;
}
type Scan = NonNullable<AutomationRuntimeState['gitlabScan']>;
export interface GitlabPollOptions {
  since?: string;
  maxRecords?: number;
  approvalBaseline?: Record<string, string>;
  baselineAt?: string;
  initializing?: boolean;
  scan?: Scan;
}
export interface GitlabPollResult extends GithubPollResult {
  approvalBaseline?: Record<string, string>;
  unsupported?: string;
  noBaseline?: string;
  scan?: Scan;
  partial?: boolean;
  initializedAt?: string;
}
export interface GitlabPollerOptions { ref: GitlabRepoRef; root: string; run?: GitlabCommandRunner }
const labelEventSchema = z.object({
  id: z.number().int().positive(), created_at: z.string().datetime({ offset: true }),
  action: z.enum(['add', 'remove']), label: z.object({ name: z.string() }).nullable(),
});

/** Each tick commits one bounded scan chunk. A failed chunk consumes no observations. */
export class GitlabPoller {
  constructor(private readonly options: GitlabPollerOptions) {}

  async poll(definition: GithubAutomationDefinition, options: GitlabPollOptions = {}): Promise<GitlabPollResult> {
    const issue = automationCapabilityIssue('gitlab', definition.events);
    if (issue) return { candidates: [], truncated: false, pages: 0, unsupported: issue };
    const { ref, root, run } = this.options;
    const reads = createGitlabReads(root, ref, run);
    return gitlabOperation(async () => {
      await reads.client.ensureCurrent();
      const scope = JSON.stringify([ref.host, ref.webOrigin, ref.projectPath, gitlabConfigRevision(), definition.revision, definition.events, definition.filters]);
      const prior = options.scan?.scope === scope ? options.scan : undefined;
      const initializing = prior?.initializing ?? options.initializing ?? options.approvalBaseline === undefined;
      const since = prior?.since ?? options.since ?? new Date(Date.now() - definition.filters.lookbackDays * 86_400_000).toISOString();
      const baseline = { ...options.approvalBaseline };
      const candidates: GithubCandidate[] = [];
      let pages = 0;
      let unsupported: string | undefined;
      const kinds: Scan['kind'][] = [];
      if (definition.events.some(event => event.startsWith('pull_request.'))) kinds.push('merge_requests');
      if (definition.events.some(event => event.startsWith('issue.'))) kinds.push('issues');
      let scan: Scan | undefined;
      const start = prior ? kinds.indexOf(prior.kind) : 0;
      const accept = (candidate: GithubCandidate, approval = false) => {
        if (initializing && approval) return;
        if (approval ? options.baselineAt && candidate.timestamp <= options.baselineAt : since && candidate.timestamp < since) return;
        if (definition.events.includes(candidate.event) && matchesFilters(candidate, definition)) candidates.push(candidate);
      };
      try {
        for (const kind of kinds.slice(Math.max(0, start))) {
          const isMr = kind === 'merge_requests';
          const snapshot = isMr && definition.events.includes(GITLAB_APPROVAL_EVENT);
          const labels = !isMr && definition.events.some(event => event === 'issue.labeled' || event === 'issue.unlabeled');
          // At most 16 snapshot hydrations + two lists + one label page, within 20 requests.
          const limit = Math.min(options.maxRecords ?? definition.filters.maxRecords, snapshot ? 16 : labels ? 1 : 18);
          const cursor = kind === prior?.kind ? prior.cursor : undefined;
          const list = await reads.pages(kind, gitlabItemSchema,
            { state: 'all', scope: 'all', order_by: 'created_at', sort: 'asc' }, limit, cursor, true, 1);
          pages++;
          for (const row of list.rows) {
            const base = {
              repo: ref.projectPath, nodeId: `${ref.host}:${ref.projectPath}:${kind}:${row.iid}`,
              number: row.iid, title: bounded(row.title, 500), url: gitlabItemUrl(ref, isMr ? 'pr' : 'issue', row.iid),
              author: row.author?.username ?? '?', assignees: (row.assignees ?? []).map(user => user.username),
              labels: row.labels.map(label => typeof label === 'string' ? label : label.name),
            };
            const opened = isMr ? 'pull_request.opened' : 'issue.opened';
            accept({ ...base, event: opened, eventId: `${base.nodeId}:opened`, timestamp: row.created_at, tieBreaker: `${kind}:${row.iid}:opened` });
            if (snapshot) {
              const approvals = await reads.client.api(`${kind}/${row.iid}/approvals`, gitlabApprovalsSchema, { refresh: true });
              for (const approval of approvals.approved_by ?? []) {
                if (!approval.approved_at || Number.isNaN(Date.parse(approval.approved_at))) {
                  unsupported = 'GitLab approval snapshots omit approved_at timestamps; pull_request.approval_observed is unsupported here.';
                  continue;
                }
                const approver = String(approval.user.id ?? approval.user.username);
                const key = gitlabApprovalKey(ref, row.iid, approver, approval.approved_at);
                if (!(key in baseline)) accept({ ...base, event: GITLAB_APPROVAL_EVENT, eventId: key,
                  timestamp: approval.approved_at, tieBreaker: approver, reviewer: approval.user.username }, true);
                baseline[key] = approval.approved_at;
              }
            }
            if (labels) {
              const labelCursor = kind === prior?.kind ? prior.labelCursor : undefined;
              const events = await reads.pages(`${kind}/${row.iid}/resource_label_events`, labelEventSchema, {}, 100, labelCursor, true, 1);
              pages++;
              for (const event of events.rows) {
                if (!event.label) continue;
                accept({ ...base, event: event.action === 'add' ? 'issue.labeled' : 'issue.unlabeled',
                  eventId: `${base.nodeId}:label:${event.id}`, tieBreaker: String(event.id), timestamp: event.created_at, changedLabel: event.label.name });
              }
              if (events.next) {
                scan = { scope, kind, cursor, labelCursor: events.next, initializing, since };
                break;
              }
            }
          }
          if (scan) break;
          if (list.next) { scan = { scope, kind, cursor: list.next, initializing, since }; break; }
        }
      } catch {
        return { candidates: [], truncated: true, pages, partial: true,
          approvalBaseline: options.approvalBaseline, scan: options.scan };
      }
      const last = [...candidates].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.tieBreaker.localeCompare(b.tieBreaker)).at(-1);
      return { candidates, truncated: !!scan, pages, approvalBaseline: baseline, scan,
        ...(!scan && last ? { cursor: { timestamp: last.timestamp, tieBreaker: last.tieBreaker } } : {}),
        ...(unsupported ? { unsupported } : {}),
        ...(initializing ? { noBaseline: 'Establishing the GitLab approval baseline; retained approvals are not launched.', ...(!scan ? { initializedAt: new Date().toISOString() } : {}) } : {}),
      };
    });
  }
}

function bounded(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}
