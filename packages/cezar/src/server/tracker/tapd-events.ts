import { z } from 'zod';
import type { TrackerAssociation, TrackerAutomationEvent } from '@open-mercato/cezar-contract';
import { createEventScanner, type EventIssue } from './event-scan.ts';
import { TrackerRequestError } from './transport.ts';

export const tapdEventCapabilities: TrackerAutomationEvent[] = ['issue.opened'];

type TapdAssociation = {
  kind: 'tapd';
  source: { id: string; webUrl: string };
  externalId: string;
  externalName: string;
};
type TapdEventIssue = {
  id: string;
  key: string;
  title: string;
  url: string;
  createdAt: string;
  status: string;
  labels: string[];
};
export type TapdEventCandidate = {
  eventId: string;
  timestamp: string;
  tieBreaker: string;
  provider: 'tapd';
  event: 'issue.opened' | 'issue.status_changed';
  association: TapdAssociation;
  issueId: string;
  key: string;
  title: string;
  url: string;
  status: string;
  labels: string[];
  change: { fromId?: string; toId?: string };
};

export function mapTapdCreatedEvent(
  association: TapdAssociation,
  issue: TapdEventIssue,
): TapdEventCandidate {
  const eventId = JSON.stringify([
    'tapd', association.source.id, association.externalId, issue.id,
    'created', 'issue.opened',
  ]);
  return {
    eventId,
    timestamp: new Date(issue.createdAt).toISOString(),
    tieBreaker: eventId,
    provider: 'tapd',
    event: 'issue.opened',
    association,
    issueId: issue.id,
    key: issue.key,
    title: issue.title,
    url: issue.url,
    status: issue.status,
    labels: issue.labels,
    change: {},
  };
}

const localTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
const fieldChangeSchema = z.object({
  field: z.string(),
  value_before: z.union([z.string(), z.number()]).nullable().optional(),
  value_after: z.union([z.string(), z.number()]).nullable().optional(),
});
const storyChangesSchema = z.array(z.object({
  WorkitemChange: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    story_id: z.union([z.string(), z.number()]).transform(String),
    created: localTimestamp,
    workitem_type_id: z.union([z.string(), z.number()]).transform(String),
    field_changes: z.array(fieldChangeSchema),
  }),
}));
const bugChangesSchema = z.array(z.object({
  BugChange: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    bug_id: z.union([z.string(), z.number()]).transform(String),
    created: localTimestamp,
    field: z.string(),
    old_value: z.union([z.string(), z.number()]).nullable().optional(),
    new_value: z.union([z.string(), z.number()]).nullable().optional(),
  }),
}));

function wallTimeToIso(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('TAPD history timestamp is invalid.');
  const wanted = match.slice(1).map(Number);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const partsAt = (instant: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].map(Number);
  };
  const wallAsUtc = Date.UTC(...([wanted[0], wanted[1]! - 1, ...wanted.slice(2)] as [number, number, number, number, number, number]));
  let instant = wallAsUtc;
  for (let attempt = 0; attempt < 3; attempt++) {
    const shown = partsAt(instant);
    const shownAsUtc = Date.UTC(shown[0]!, shown[1]! - 1, shown[2]!, shown[3]!, shown[4]!, shown[5]!);
    instant += wallAsUtc - shownAsUtc;
  }
  if (partsAt(instant).some((part, index) => part !== wanted[index]))
    throw new Error('TAPD history timestamp is not representable in the configured timezone.');
  return new Date(instant).toISOString();
}

function eventCandidate(
  association: TapdAssociation,
  issue: TapdEventIssue,
  historyId: string,
  fieldIndex: number,
  timestamp: string,
  change: TapdEventCandidate['change'],
): TapdEventCandidate {
  const eventId = JSON.stringify([
    'tapd', association.source.id, association.externalId, issue.id,
    historyId, 'status', fieldIndex, 'issue.status_changed',
  ]);
  return {
    eventId,
    timestamp,
    tieBreaker: eventId,
    provider: 'tapd',
    event: 'issue.status_changed',
    association,
    issueId: issue.id,
    key: issue.key,
    title: issue.title,
    url: issue.url,
    status: change.toId ?? issue.status,
    labels: issue.labels,
    change,
  };
}

const value = (input: string | number | null | undefined) => input == null ? undefined : String(input);

export function mapTapdStoryChanges(
  association: TapdAssociation,
  issue: TapdEventIssue,
  raw: unknown,
  timeZone: string,
): TapdEventCandidate[] {
  return storyChangesSchema.parse(raw).flatMap(({ WorkitemChange: row }) => {
    if (row.story_id !== issue.key) throw new Error('TAPD story history belongs to another item.');
    return row.field_changes.flatMap((field, index) => field.field === 'status' ? [eventCandidate(
      association,
      issue,
      row.id,
      index,
      wallTimeToIso(row.created, timeZone),
      {
        ...(value(field.value_before) !== undefined ? { fromId: `story:${row.workitem_type_id}:${value(field.value_before)}` } : {}),
        ...(value(field.value_after) !== undefined ? { toId: `story:${row.workitem_type_id}:${value(field.value_after)}` } : {}),
      },
    )] : []);
  });
}

export function mapTapdBugChanges(
  association: TapdAssociation,
  issue: TapdEventIssue,
  raw: unknown,
  timeZone: string,
): TapdEventCandidate[] {
  return bugChangesSchema.parse(raw).flatMap(({ BugChange: row }) => {
    if (row.bug_id !== issue.key) throw new Error('TAPD bug history belongs to another item.');
    if (row.field !== 'status') return [];
    return [eventCandidate(
      association,
      issue,
      row.id,
      0,
      wallTimeToIso(row.created, timeZone),
      {
        ...(value(row.old_value) !== undefined ? { fromId: `bug:${value(row.old_value)}` } : {}),
        ...(value(row.new_value) !== undefined ? { toId: `bug:${value(row.new_value)}` } : {}),
      },
    )];
  });
}

export type TapdHistoryRequest = (
  itemType: 'story' | 'bug',
  day: string,
  page: number,
  signal: AbortSignal,
) => Promise<{ rows: unknown[]; hasMore: boolean }>;

/**
 * Status and label history stay gated until the vendor history encoding is verified against a
 * real account (spec 2026-10-13 §5): the mappers above are proven against documented envelopes
 * only, so `pollEvents` and this read refuse them instead of guessing.
 */
export const tapdHistoryLimitation =
  'TAPD history encoding has not been verified against the live API, so status and label change events are unavailable. Only issue creation events are offered.';

export function createTapdEventSource(
  association: TrackerAssociation,
  readIssues: (
    from: string,
    until: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ issues: EventIssue[]; cursor?: string }>,
): ReturnType<typeof createEventScanner> {
  // `issue.opened` polls never read history (the scanner skips `readHistory` for that filter),
  // so the gated read below must never execute; it exists to refuse any future event that would.
  return createEventScanner(association, readIssues, async () => {
    throw new TrackerRequestError('unavailable', tapdHistoryLimitation);
  });
}

type ScannedHistoryRow = {
  itemType: 'story' | 'bug';
  historyId: string;
  itemId: string;
  createdAt: string;
  raw: unknown;
};
const checkpointSchema = z.object({
  v: z.literal(1),
  itemType: z.enum(['story', 'bug']),
  timeZone: z.string(),
  from: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  page: z.number().int().positive(),
});

function localDay(instant: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function daysInWindow(from: number, until: number, timeZone: string): string[] {
  const days: string[] = [];
  for (let instant = from; instant <= until + 86_400_000; instant += 86_400_000) {
    const day = localDay(Math.min(instant, until), timeZone);
    if (days.at(-1) !== day) days.push(day);
    if (instant >= until) break;
  }
  return days;
}

function normalizeRow(itemType: 'story' | 'bug', raw: unknown, timeZone: string): ScannedHistoryRow {
  if (itemType === 'story') {
    const row = storyChangesSchema.element.parse(raw).WorkitemChange;
    return { itemType, historyId: row.id, itemId: row.story_id, createdAt: wallTimeToIso(row.created, timeZone), raw };
  }
  const row = bugChangesSchema.element.parse(raw).BugChange;
  return { itemType, historyId: row.id, itemId: row.bug_id, createdAt: wallTimeToIso(row.created, timeZone), raw };
}

export async function scanTapdHistory(input: {
  itemType: 'story' | 'bug';
  timeZone: string;
  from: string;
  until: string;
  overlapMs?: number;
  checkpoint?: string;
  request: TapdHistoryRequest;
  signal: AbortSignal;
  scanDeadlineAt?: number;
}): Promise<{ rows: ScannedHistoryRow[]; complete: boolean; checkpoint?: string }> {
  const from = Date.parse(input.from) - (input.overlapMs ?? 0);
  const until = Date.parse(input.until);
  if (!Number.isFinite(from) || !Number.isFinite(until) || from > until) throw new Error('TAPD history window is invalid.');
  const days = daysInWindow(from, until, input.timeZone);
  let dayIndex = 0;
  let page = 1;
  if (input.checkpoint) {
    const saved = checkpointSchema.parse(JSON.parse(input.checkpoint));
    if (saved.itemType !== input.itemType || saved.timeZone !== input.timeZone || saved.from !== input.from || saved.until !== input.until)
      throw new Error('TAPD history checkpoint belongs to another scan.');
    dayIndex = days.indexOf(saved.day);
    if (dayIndex < 0) throw new Error('TAPD history checkpoint is invalid.');
    page = saved.page;
  }
  const rows: ScannedHistoryRow[] = [];
  const seen = new Set<string>();
  let completedPages = 0;
  while (dayIndex < days.length) {
    input.signal.throwIfAborted();
    if (completedPages && input.scanDeadlineAt !== undefined && Date.now() >= input.scanDeadlineAt) {
      return {
        rows,
        complete: false,
        checkpoint: JSON.stringify({ v: 1, itemType: input.itemType, timeZone: input.timeZone, from: input.from, until: input.until, day: days[dayIndex], page }),
      };
    }
    const result = await input.request(input.itemType, days[dayIndex]!, page, input.signal);
    input.signal.throwIfAborted();
    completedPages++;
    for (const raw of result.rows) {
      const row = normalizeRow(input.itemType, raw, input.timeZone);
      const instant = Date.parse(row.createdAt);
      const identity = `${row.itemType}:${row.itemId}:${row.historyId}`;
      if (instant >= from && instant <= until && !seen.has(identity)) {
        seen.add(identity);
        rows.push(row);
      }
    }
    if (result.hasMore) page++;
    else { dayIndex++; page = 1; }
  }
  return { rows, complete: true };
}

