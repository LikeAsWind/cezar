import type { EventPollInput } from './event-scan.ts';
import type { TrackerAutomationEvent, TrackerIterationsResult } from '@open-mercato/cezar-contract';
import type { TrackerEventCandidate, PollPage } from '../../automations/event-source.ts';
import type {
  TrackerKind, TrackerAssociation, TrackerAssociationInput, TrackerAssociationResult,
  TrackerCandidatesQuery, TrackerCandidatesResult, TrackerListQuery, TrackerSearchQuery,
  TrackerItemsResult, TrackerItemResult,
} from '@open-mercato/cezar-contract';

export interface TrackerClient {
  readonly kind: TrackerKind;
  listCandidates(query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult>;
  resolveAssociation(input: TrackerAssociationInput): Promise<TrackerAssociationResult>;
}
export interface TrackerDriver {
  readonly association: TrackerAssociation;
  /** `itemType` echoes the requested TAPD resource type; absent for single-type providers. */
  automationOptions?: (query?: { search?: string; cursor?: string; itemType?: 'story' | 'bug' }) => Promise<{ events: TrackerAutomationEvent[]; limitations: string[]; statuses: { id: string; name: string }[]; labels: { id: string; name: string }[]; itemType?: 'story' | 'bug' }>;
  pollEvents?: (input: EventPollInput) => Promise<PollPage<TrackerEventCandidate>>;
  listIssues(query: TrackerListQuery): Promise<TrackerItemsResult>;
  searchItems(query: TrackerSearchQuery): Promise<TrackerItemsResult>;
  getItem(id: string): Promise<TrackerItemResult>;
  /** TAPD-only: the workspace's iteration catalog for the iteration view. */
  listIterations?: () => Promise<TrackerIterationsResult>;
}

/** Complete compiled-in provider seam. Construction must perform no network I/O. */
export interface TrackerProvider extends TrackerClient {
  driver(association: TrackerAssociation): TrackerDriver;
  clearCache(): void;
}
