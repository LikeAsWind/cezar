import { describe, expect, it } from 'vitest';
import { automationCapabilities, automationCapabilityIssue, isGitlabReviewEvent } from './forge-capabilities.ts';

describe('automationCapabilities', () => {
  it('reports GitHub review events as supported and approval_observed as unsupported', () => {
    const capabilities = automationCapabilities('github');
    expect(capabilities.supportedEvents).toContain('pull_request.reviewed');
    expect(capabilities.supportedEvents).not.toContain('pull_request.approval_observed');
    expect(capabilities.unsupportedEvents).toContainEqual({
      event: 'pull_request.approval_observed',
      reason: expect.stringContaining('GitHub'),
    });
    expect(capabilities.approvalObservation).toBeUndefined();
  });

  it('reports the three review triggers unsupported on GitLab and approval_observed supported', () => {
    const capabilities = automationCapabilities('gitlab');
    for (const event of ['pull_request.reviewed', 'pull_request.review_requested', 'pull_request.rereview_requested'] as const) {
      expect(capabilities.unsupportedEvents).toContainEqual({ event, reason: expect.stringContaining('GitLab') });
      expect(capabilities.supportedEvents).not.toContain(event);
    }
    expect(capabilities.supportedEvents).toEqual(['pull_request.opened', 'issue.opened', 'issue.labeled', 'issue.unlabeled', 'pull_request.approval_observed']);
    expect(capabilities.approvalObservation).toEqual({ supported: true, reason: expect.stringContaining('approved_at') });
  });

  it('supports the existing creation and resource-label event family on GitLab', () => {
    const capabilities = automationCapabilities('gitlab');
    for (const event of ['pull_request.opened', 'issue.opened', 'issue.labeled', 'issue.unlabeled'] as const) {
      expect(capabilities.unsupportedEvents.some(row => row.event === event)).toBe(false);
      expect(capabilities.supportedEvents).toContain(event);
    }
  });

  it('reports no supported events for a provider-less project', () => {
    expect(automationCapabilities(null).supportedEvents).toEqual([]);
    expect(automationCapabilities(null).unsupportedEvents).toEqual([]);
  });
});

describe('automationCapabilityIssue', () => {
  it('rejects each GitLab review trigger with a reason, and passes approval_observed', () => {
    for (const event of ['pull_request.reviewed', 'pull_request.review_requested', 'pull_request.rereview_requested'] as const) {
      expect(automationCapabilityIssue('gitlab', [event])).toContain(`${event} is unsupported`);
    }
    expect(automationCapabilityIssue('gitlab', ['pull_request.approval_observed'])).toBeNull();
    expect(automationCapabilityIssue('gitlab', ['issue.opened'])).toBeNull();
  });

  it('rejects approval_observed on GitHub and passes the review triggers', () => {
    expect(automationCapabilityIssue('github', ['pull_request.approval_observed'])).toContain('unsupported');
    expect(automationCapabilityIssue('github', ['pull_request.reviewed'])).toBeNull();
  });

  it('never rejects a provider-less project (plain Git degrades, not fails)', () => {
    expect(automationCapabilityIssue(null, ['pull_request.reviewed'])).toBeNull();
  });
});

describe('isGitlabReviewEvent', () => {
  it('names exactly the three unsupported review triggers', () => {
    expect(isGitlabReviewEvent('pull_request.reviewed')).toBe(true);
    expect(isGitlabReviewEvent('pull_request.review_requested')).toBe(true);
    expect(isGitlabReviewEvent('pull_request.rereview_requested')).toBe(true);
    expect(isGitlabReviewEvent('pull_request.approval_observed')).toBe(false);
    expect(isGitlabReviewEvent('issue.opened')).toBe(false);
  });
});
