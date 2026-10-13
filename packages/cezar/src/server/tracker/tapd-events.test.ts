import { expect, it, vi } from 'vitest';
import {
  mapTapdBugChanges,
  mapTapdCreatedEvent,
  mapTapdStoryChanges,
  scanTapdHistory,
  type TapdHistoryRequest,
} from './tapd-events.ts';
import { createEventScanner } from './event-scan.ts';

const association = {
  kind: 'tapd' as const,
  source: { id: 'tapd', webUrl: 'https://www.tapd.cn' },
  externalId: '10104802',
  externalName: 'Example',
};
const story = {
  id: 'story:1010104801124922063',
  key: '1010104801124922063',
  title: 'Story',
  url: 'https://www.tapd.cn/10104802/prong/stories/view/1010104801124922063',
  createdAt: '2026-10-12T23:59:00.000Z',
  status: 'done',
  labels: [],
};
const bug = {
  ...story,
  id: 'bug:1010104801124922064',
  key: '1010104801124922064',
  title: 'Bug',
};

it('maps creation from the immutable created timestamp rather than modified state', () => {
  const itemWithModifiedSnapshot = {
    ...story,
    createdAt: '2026-10-13T00:00:00.000Z',
    modifiedAt: '2026-10-13T09:00:00.000Z',
  };
  const event = mapTapdCreatedEvent(association, itemWithModifiedSnapshot);

  expect(event.event).toBe('issue.opened');
  expect(event.timestamp).toBe('2026-10-13T00:00:00.000Z');
  expect(event.eventId).toContain('created');
});

it('maps every repeated story status transition with stable history and field identities', () => {
  const rows = [
    ['h-1', 'todo', 'doing'],
    ['h-2', 'doing', 'todo'],
    ['h-3', 'todo', 'doing'],
  ].map(([id, before, after]) => ({
    WorkitemChange: {
      id,
      story_id: story.key,
      workitem_type_id: 'type-7',
      created: '2026-10-13 08:00:00',
      field_changes: [{ field: 'status', value_before: before, value_after: after }],
    },
  }));

  const events = mapTapdStoryChanges(association, story, rows, 'Asia/Shanghai');

  expect(events.map((event) => event.change)).toEqual([
    { fromId: 'story:type-7:todo', toId: 'story:type-7:doing' },
    { fromId: 'story:type-7:doing', toId: 'story:type-7:todo' },
    { fromId: 'story:type-7:todo', toId: 'story:type-7:doing' },
  ]);
  expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
  expect(events[0]?.timestamp).toBe('2026-10-13T00:00:00.000Z');
});

it('ignores description-only story history and gives multiple status fields stable indexes', () => {
  const events = mapTapdStoryChanges(association, story, [{
    WorkitemChange: {
      id: 'h-1', story_id: story.key, workitem_type_id: 'type-7', created: '2026-10-13 08:00:00',
      field_changes: [
        { field: 'description', value_before: 'a', value_after: 'b' },
        { field: 'status', value_before: 'todo', value_after: 'doing' },
        { field: 'status', value_before: 'doing', value_after: 'done' },
      ],
    },
  }], 'Asia/Shanghai');

  expect(events).toHaveLength(2);
  expect(events[0]?.eventId).not.toBe(events[1]?.eventId);
});

it('maps only bug status rows and keeps bug status identity separate from stories', () => {
  const events = mapTapdBugChanges(association, bug, [
    { BugChange: { id: 'b-1', bug_id: bug.key, created: '2026-10-13 08:00:00', field: 'description', old_value: 'a', new_value: 'b' } },
    { BugChange: { id: 'b-2', bug_id: bug.key, created: '2026-10-13 08:00:01', field: 'status', old_value: 'todo', new_value: 'done' } },
  ], 'Asia/Shanghai');

  expect(events).toHaveLength(1);
  expect(events[0]?.change).toEqual({ fromId: 'bug:todo', toId: 'bug:done' });
  expect(events[0]?.eventId).toContain('b-2');
});

it('enumerates local calendar days across UTC midnight and exhausts every page', async () => {
  const calls: Array<{ day: string; page: number }> = [];
  const request: TapdHistoryRequest = async (_type, day, page) => {
    calls.push({ day, page });
    return { rows: [], hasMore: page === 1 };
  };

  const result = await scanTapdHistory({
    itemType: 'story', timeZone: 'Asia/Shanghai',
    from: '2026-10-12T15:59:59.000Z', until: '2026-10-13T16:00:01.000Z',
    request, signal: new AbortController().signal,
  });

  expect(calls).toEqual([
    { day: '2026-10-12', page: 1 }, { day: '2026-10-12', page: 2 },
    { day: '2026-10-13', page: 1 }, { day: '2026-10-13', page: 2 },
    { day: '2026-10-14', page: 1 }, { day: '2026-10-14', page: 2 },
  ]);
  expect(result.complete).toBe(true);
});

it('exact-filters late overlapping rows and deduplicates stable history identities', async () => {
  const result = await scanTapdHistory({
    itemType: 'bug', timeZone: 'Asia/Shanghai',
    from: '2026-10-13T00:00:00.000Z', until: '2026-10-13T01:00:00.000Z', overlapMs: 120_000,
    request: async () => ({ rows: [
      { BugChange: { id: 'too-old', bug_id: bug.key, created: '2026-10-13 07:57:59', field: 'status', old_value: 'a', new_value: 'b' } },
      { BugChange: { id: 'late', bug_id: bug.key, created: '2026-10-13 07:59:00', field: 'status', old_value: 'a', new_value: 'b' } },
      { BugChange: { id: 'late', bug_id: bug.key, created: '2026-10-13 07:59:00', field: 'status', old_value: 'a', new_value: 'b' } },
      { BugChange: { id: 'too-new', bug_id: bug.key, created: '2026-10-13 09:00:01', field: 'status', old_value: 'b', new_value: 'c' } },
    ], hasMore: false }),
    signal: new AbortController().signal,
  });

  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.historyId).toBe('late');
});

it('resumes after the last completed page when the soft budget expires', async () => {
  vi.useFakeTimers();
  try {
    const request: TapdHistoryRequest = async (_type, _day, page) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { rows: [], hasMore: page < 3 };
    };
    const pending = scanTapdHistory({
      itemType: 'story', timeZone: 'Asia/Shanghai',
      from: '2026-10-13T00:00:00.000Z', until: '2026-10-13T00:01:00.000Z',
      request, scanDeadlineAt: Date.now() + 15, signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(30);
    const first = await pending;
    expect(first.complete).toBe(false);
    expect(JSON.parse(first.checkpoint!)).toMatchObject({ day: '2026-10-13', page: 3 });

    const resumedPages: number[] = [];
    const resumed = await scanTapdHistory({
      itemType: 'story', timeZone: 'Asia/Shanghai',
      from: '2026-10-13T00:00:00.000Z', until: '2026-10-13T00:01:00.000Z', checkpoint: first.checkpoint,
      request: async (_type, _day, page) => { resumedPages.push(page); return { rows: [], hasMore: false }; },
      signal: new AbortController().signal,
    });
    expect(resumedPages).toEqual([3]);
    expect(resumed.complete).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('propagates page failures without returning a successful checkpoint', async () => {
  await expect(scanTapdHistory({
    itemType: 'bug', timeZone: 'Asia/Shanghai',
    from: '2026-10-13T00:00:00.000Z', until: '2026-10-13T01:00:00.000Z',
    request: async () => { throw new Error('upstream failed'); },
    signal: new AbortController().signal,
  })).rejects.toThrow('upstream failed');
});

it('keeps the event-source fingerprint identical for absent and undefined item types', async () => {
  const generic = {
    kind: 'jira' as const,
    source: { id: 'cloud', webUrl: 'https://example.atlassian.net' },
    externalId: 'P', externalName: 'Project',
  };
  const scanner = createEventScanner(generic, async () => ({ issues: [] }), async () => ({ events: [] }));
  const input = { baselineAt: '2026-10-13T00:00:00.000Z', limit: 10, signal: new AbortController().signal };
  const withoutKey = JSON.parse((await scanner.poll(input)).checkpoint).fingerprint;
  const withUndefined = JSON.parse((await scanner.poll({ ...input, itemType: undefined })).checkpoint).fingerprint;
  expect(withUndefined).toBe(withoutKey);
});

