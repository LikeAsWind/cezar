import type { AutomationEvent, AutomationProviderCapabilities } from '@open-mercato/cezar-contract';
import { parseRemote } from '../git-remotes.ts';
import { resolveProjectForge } from '../server/forge/operations.ts';
import { knownGitlabHost } from '../server/forge/gitlab-hosts.ts';
import type { GitlabRepoRef } from '../server/forge/types.ts';

export type AutomationForgeSource =
  | { kind: 'github'; root: string; owner: string; repo: string }
  | { kind: 'gitlab'; root: string; ref: GitlabRepoRef };

/** The three GitHub review triggers the GitLab approval-snapshot poller does not support. */
const GITLAB_UNSUPPORTED_REVIEW_EVENTS = [
  'pull_request.reviewed',
  'pull_request.review_requested',
  'pull_request.rereview_requested',
] as const;

export function isGitlabReviewEvent(event: AutomationEvent): boolean {
  return (GITLAB_UNSUPPORTED_REVIEW_EVENTS as readonly string[]).includes(event);
}

/** The project's forge for automation purposes, resolved through the shared driver resolver. */
export async function resolveAutomationForge(root: string): Promise<AutomationForgeSource | null> {
  const { driver, remote } = await resolveProjectForge(root);
  const parsed = remote ? parseRemote(remote) : null;
  if (!driver || !parsed) return null;
  if (driver.kind === 'github') return { kind: 'github', root, owner: parsed.owner, repo: parsed.repo };
  const host = knownGitlabHost(parsed);
  if (!host && parsed.host !== 'gitlab.com') return null;
  return {
    kind: 'gitlab', root,
    ref: { host: host?.host ?? 'gitlab.com', projectPath: parsed.projectPath,
      webOrigin: host?.webOrigin ?? 'https://gitlab.com' },
  };
}

/** Capability metadata per provider: which events the poller can actually deliver. */
export function automationCapabilities(provider: 'github' | 'gitlab' | null): AutomationProviderCapabilities {
  const unsupportedEvents: Array<{ event: AutomationEvent; reason: string }> = [];
  if (provider === 'gitlab') {
    for (const event of GITLAB_UNSUPPORTED_REVIEW_EVENTS) {
      unsupportedEvents.push({
        event,
        reason: 'GitHub review semantics are unsupported on GitLab; use pull_request.approval_observed for retained individual approvals',
      });
    }
  } else if (provider === 'github') {
    unsupportedEvents.push({
      event: 'pull_request.approval_observed',
      reason: 'Approval snapshots are unsupported on GitHub; use pull_request.reviewed',
    });
  }
  const supportedEvents = (
    provider === 'github'
      ? ['pull_request.opened', 'issue.opened', 'issue.labeled', 'issue.unlabeled',
        'pull_request.reviewed', 'pull_request.review_requested', 'pull_request.rereview_requested'] as const
      : provider === 'gitlab'
        ? ['pull_request.opened', 'issue.opened', 'issue.labeled', 'issue.unlabeled', 'pull_request.approval_observed'] as const
        : [] as const
  );
  return {
    provider,
    supportedEvents: [...supportedEvents],
    unsupportedEvents,
    ...(provider === 'gitlab'
      ? {
          approvalObservation: {
            supported: true,
            reason: 'Detects individual approvals retained at a successful poll, not all approval rules. Approvals withdrawn between polls may be missed. Requires approved_at timestamps.',
          },
        }
      : {}),
  };
}

/**
 * The reason a definition's selected events are unsupported on THIS project's forge, or null.
 * A provider-less project (plain Git) is never rejected here — it keeps the existing
 * "no GitHub remote" degradation rather than failing to save.
 */
export function automationCapabilityIssue(provider: 'github' | 'gitlab' | null, events: AutomationEvent[]): string | null {
  if (provider === null) return null;
  const capabilities = automationCapabilities(provider);
  const unsupported = capabilities.unsupportedEvents.find((row) => events.includes(row.event));
  return unsupported ? `${unsupported.event} is unsupported: ${unsupported.reason}` : null;
}
