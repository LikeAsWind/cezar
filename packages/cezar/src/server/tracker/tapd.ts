import { z } from 'zod';
import type {
  TrackerAssociation, TrackerAssociationInput, TrackerAssociationResult, TrackerCandidatesQuery,
  TrackerCandidatesResult, TrackerItem, TrackerItemResult, TrackerItemsResult, TrackerListQuery,
  TrackerSearchQuery, TrackerSource,
} from '@open-mercato/cezar-contract';
import { descriptionBody } from './adf.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { tapdEventCapabilities, tapdHistoryLimitation, createTapdEventSource } from './tapd-events.ts';
import { tapdHtmlMarkdown } from './tapd-html.ts';
import { ResultCache, TrackerHttp, TrackerRequestError, requestFailure, runOperation } from './transport.ts';
import type { EventPollInput } from './event-scan.ts';
import type { TrackerDriver, TrackerProvider } from './types.ts';

const apiOrigin = 'https://api.tapd.cn';
const webOrigin = 'https://www.tapd.cn';
const vendorPageSize = 200;
const maximumScanPages = 20;
const numericId = z.string().regex(/^\d+$/).max(64);
const workspaceSchema = z.object({
  id: numericId,
  name: z.string().min(1),
  company_id: numericId,
}).passthrough();
const workspaceRowSchema = z.union([workspaceSchema, z.object({ Workspace: workspaceSchema }).passthrough()]);
const storySchema = z.object({
  id: numericId, workspace_id: numericId, workitem_type_id: numericId, name: z.string(),
  description: z.string().nullish(), creator: z.string().nullish(), created: z.string(), modified: z.string(),
  status: z.string(), label: z.string().nullish(),
}).passthrough();
const bugSchema = z.object({
  id: numericId, workspace_id: numericId, title: z.string(), description: z.string().nullish(),
  reporter: z.string().nullish(), creator: z.string().nullish(), created: z.string(), modified: z.string(),
  status: z.string(), label: z.string().nullish(),
}).passthrough();
const storyRowSchema = z.object({ Story: storySchema }).passthrough();
const bugRowSchema = z.object({ Bug: bugSchema }).passthrough();

type ItemType = 'story' | 'bug';
type Story = z.infer<typeof storySchema>;
type Bug = z.infer<typeof bugSchema>;
type RawItem = Story | Bug;
type CachedResult = TrackerCandidatesResult | TrackerAssociationResult | TrackerItemsResult | TrackerItemResult;

function invalidResponse(): never {
  throw new TrackerRequestError('invalid_response', 'TAPD returned an invalid response. Try again later.');
}

function parseEnvelope(value: unknown): unknown {
  const envelope = z.object({ status: z.union([z.literal(0), z.literal(1)]), data: z.unknown(), info: z.unknown().optional() }).passthrough().safeParse(value);
  if (!envelope.success || envelope.data.status !== 1) return invalidResponse();
  return envelope.data.data;
}

function collectionFailure(error: unknown): Extract<TrackerCandidatesResult | TrackerItemsResult, { available: false }> {
  const failure = requestFailure(error);
  return failure.code === 'not_found'
    ? { available: false, code: 'unavailable', reason: 'TAPD could not serve this collection. Try again later.' }
    : failure;
}

function lookupFailure(error: unknown): Extract<TrackerAssociationResult | TrackerItemResult, { available: false }> {
  const failure = requestFailure(error);
  return failure.code === 'invalid_cursor'
    ? { available: false, code: 'invalid_response', reason: 'TAPD returned an invalid response. Try again later.' }
    : failure;
}

function sourceChanged(): TrackerRequestError {
  return new TrackerRequestError('source_changed', 'The saved TAPD company no longer matches the configured credentials. Reconnect the project.');
}

function parseWorkspace(value: unknown): z.infer<typeof workspaceSchema> {
  const wrapped = z.object({ Workspace: workspaceSchema }).passthrough().safeParse(value);
  if (wrapped.success) return wrapped.data.Workspace;
  const direct = workspaceSchema.safeParse(value);
  if (!direct.success) return invalidResponse();
  return direct.data;
}

function parseWorkspaceCollection(value: unknown): z.infer<typeof workspaceSchema>[] {
  const parsed = z.array(workspaceRowSchema).safeParse(value);
  if (!parsed.success) return invalidResponse();
  return parsed.data.map(row => parseWorkspace(row));
}

function parseItems(type: ItemType, value: unknown): RawItem[] {
  const parsed = (type === 'story' ? z.array(storyRowSchema) : z.array(bugRowSchema)).safeParse(value);
  if (!parsed.success) return invalidResponse();
  return type === 'story'
    ? (parsed.data as z.infer<typeof storyRowSchema>[]).map(row => row.Story)
    : (parsed.data as z.infer<typeof bugRowSchema>[]).map(row => row.Bug);
}

function labels(raw: string | null | undefined): string[] {
  return raw ? raw.split('|').filter(label => label.length > 0) : [];
}

function zonedTimestamp(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return invalidResponse();
  const wanted = match.slice(1).map(Number);
  let instant = Date.UTC(wanted[0]!, wanted[1]! - 1, wanted[2]!, wanted[3]!, wanted[4]!, wanted[5]!);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const difference = Date.UTC(wanted[0]!, wanted[1]! - 1, wanted[2]!, wanted[3]!, wanted[4]!, wanted[5]!) - represented;
    instant += difference;
    if (difference === 0) return new Date(instant).toISOString();
  }
  return invalidResponse();
}

function mapItem(raw: RawItem, type: ItemType, association: TrackerAssociation, timeZone: string, maximum: number, status = raw.status): TrackerItem {
  if (raw.workspace_id !== association.externalId) {
    throw new TrackerRequestError('not_found', 'The requested TAPD item was not found in this workspace.');
  }
  const converted = tapdHtmlMarkdown(raw.description ?? '');
  const body = descriptionBody(converted.body, maximum, converted.unsupportedContent);
  const title = type === 'story' ? (raw as Story).name : (raw as Bug).title;
  const author = type === 'story' ? (raw as Story).creator : (raw as Bug).reporter ?? (raw as Bug).creator;
  const id = `${type}:${raw.id}`;
  const url = type === 'story'
    ? `${webOrigin}/${encodeURIComponent(association.externalId)}/prong/stories/view/${encodeURIComponent(raw.id)}`
    : `${webOrigin}/${encodeURIComponent(association.externalId)}/bugtrace/bugs/view?bug_id=${encodeURIComponent(raw.id)}`;
  return {
    kind: 'issue', id, displayId: raw.id, itemType: type, title, author: author ?? 'Unknown',
    createdAt: zonedTimestamp(raw.created, timeZone), updatedAt: zonedTimestamp(raw.modified, timeZone),
    labels: labels(raw.label), ...body, url, status,
  };
}

function parsePosition(value: string | undefined): { page: number; offset: number } {
  if (value === undefined) return { page: 1, offset: 0 };
  try {
    const parsed = z.object({ page: z.number().int().positive(), offset: z.number().int().nonnegative().max(vendorPageSize) }).strict().parse(JSON.parse(value));
    return parsed;
  } catch {
    throw new TrackerRequestError('invalid_cursor', 'This TAPD result page expired. Start the search again.');
  }
}

function parsePage(value: string | undefined): number {
  if (value === undefined) return 1;
  try {
    return z.object({ page: z.number().int().positive() }).strict().parse(JSON.parse(value)).page;
  } catch {
    throw new TrackerRequestError('invalid_cursor', 'This TAPD result page expired. Start the search again.');
  }
}

export function createTapdClient(
  config: { companyId: string; apiUser: string; apiPassword: string; timeZone: string },
  fetcher: typeof fetch = fetch,
): TrackerProvider {
  const http = new TrackerHttp(fetcher);
  const cache = new ResultCache<CachedResult>(200, 60_000);
  const authorization = `Basic ${Buffer.from(`${config.apiUser}:${config.apiPassword}`, 'utf8').toString('base64')}`;
  const currentSource: TrackerSource = { id: `tapd-company:${config.companyId}`, webUrl: webOrigin };

  const request = async (path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> => {
    const query = new URLSearchParams(params);
    return parseEnvelope(await http.json(`${apiOrigin}${path}?${query}`, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: authorization },
    }, signal));
  };

  const verifyWorkspace = async (workspaceId: string, signal: AbortSignal): Promise<z.infer<typeof workspaceSchema>> => {
    const row = parseWorkspace(await request('/workspaces/get_workspace_info', { workspace_id: workspaceId }, signal));
    if (row.id !== workspaceId) return invalidResponse();
    if (row.company_id !== config.companyId) throw sourceChanged();
    return row;
  };

  const checkAssociation = async (association: TrackerAssociation, signal: AbortSignal): Promise<void> => {
    if (association.kind !== 'tapd' || association.source.id !== currentSource.id || association.source.webUrl !== currentSource.webUrl || !/^\d+$/.test(association.externalId)) throw sourceChanged();
    await verifyWorkspace(association.externalId, signal);
  };

  const listCandidates = async (query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult> => {
    try {
      return await runOperation(async signal => {
        if (query.kind !== 'tapd') throw sourceChanged();
        const scope = { kind: 'tapd', source: currentSource, operation: 'candidates', q: query.q ?? '', limit: query.limit };
        const position = decodeCursor(scope, query.cursor);
        const offset = position === undefined ? 0 : Number(position);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new TrackerRequestError('invalid_cursor', 'This TAPD project page expired. Start the search again.');
        const rows = parseWorkspaceCollection(await request('/workspaces/projects', { company_id: config.companyId }, signal));
        if (rows.some(row => row.company_id !== config.companyId)) throw sourceChanged();
        const term = query.q?.toLocaleLowerCase();
        const matching = term ? rows.filter(row => row.name.toLocaleLowerCase().includes(term) || row.id === query.q) : rows;
        const candidates = matching.slice(offset, offset + query.limit).map(row => ({ id: row.id, name: row.name }));
        const truncated = offset + candidates.length < matching.length;
        return { available: true, source: currentSource, candidates, truncated, ...(truncated ? { nextCursor: encodeCursor(scope, String(offset + candidates.length)) } : {}) };
      });
    } catch (error) { return collectionFailure(error); }
  };

  const resolveAssociation = async (input: TrackerAssociationInput): Promise<TrackerAssociationResult> => {
    try {
      return await runOperation(async signal => {
        if (input.kind !== 'tapd' || input.sourceId !== currentSource.id || !/^\d+$/.test(input.externalId)) throw sourceChanged();
        const row = await verifyWorkspace(input.externalId, signal);
        return { available: true, association: { kind: 'tapd', source: currentSource, externalId: row.id, externalName: row.name } };
      });
    } catch (error) { return lookupFailure(error); }
  };

  const driver = (association: TrackerAssociation): TrackerDriver => {
    const workflow = async (type: ItemType, workitemTypeId: string | undefined, signal: AbortSignal) => {
      if (type === 'story' && workitemTypeId === undefined) return invalidResponse();
      const params = {
        workspace_id: association.externalId,
        system: type,
        ...(workitemTypeId === undefined ? {} : { workitem_type_id: workitemTypeId }),
      };
      const statusMap = z.record(z.string(), z.string()).safeParse(await request('/workflows/status_map', params, signal));
      const terminal = z.array(z.string()).safeParse(await request('/workflows/last_steps', params, signal));
      if (!statusMap.success || !terminal.success || terminal.data.length === 0
        || terminal.data.some(status => statusMap.data[status] === undefined)) return invalidResponse();
      return { names: statusMap.data, terminal: new Set(terminal.data) };
    };

    const readItems = async (query: TrackerListQuery | TrackerSearchQuery): Promise<TrackerItemsResult> => {
      try {
        const type = query.itemType ?? 'story';
        const { refresh: _refresh, ...cacheQuery } = query;
        const key = JSON.stringify(['tapd', currentSource.id, association.externalId, 'items', cacheQuery]);
        return await runOperation(signal => cache.get(key, async () => {
          await checkAssociation(association, signal);
          const cursorScope = {
            kind: 'tapd', source: currentSource, operation: 'items', externalId: association.externalId,
            type, state: query.state, labels: query.labels ?? [], ...('q' in query ? { q: query.q } : {}), limit: query.limit,
          };
          let { page, offset } = parsePosition(decodeCursor(cursorScope, query.cursor));
          const items: TrackerItem[] = [];
          const wantedLabels = query.labels ?? [];
          const search = 'q' in query ? query.q.toLocaleLowerCase() : undefined;
          const workflows = new Map<string, Awaited<ReturnType<typeof workflow>>>();
          let scannedPages = 0;
          let upstreamFinished = false;
          while (items.length < query.limit && scannedPages < maximumScanPages) {
            const rows = parseItems(type, await request(type === 'story' ? '/stories' : '/bugs', {
              workspace_id: association.externalId, page: String(page), limit: String(vendorPageSize), order: 'modified desc',
              ...(wantedLabels[0] ? { label: wantedLabels[0] } : {}),
            }, signal));
            if (query.state === 'active') {
              for (const raw of rows) {
                const workitemTypeId = type === 'story' ? (raw as Story).workitem_type_id : undefined;
                const workflowKey = workitemTypeId ?? 'bug';
                if (!workflows.has(workflowKey)) workflows.set(workflowKey, await workflow(type, workitemTypeId, signal));
              }
            }
            while (offset < rows.length && items.length < query.limit) {
              const raw = rows[offset++]!;
              const rawLabels = labels(raw.label);
              const title = type === 'story' ? (raw as Story).name : (raw as Bug).title;
              const matchesSearch = !search || raw.id === search || title.toLocaleLowerCase().includes(search) || (raw.description ?? '').toLocaleLowerCase().includes(search);
              const metadata = workflows.get(type === 'story' ? (raw as Story).workitem_type_id : 'bug');
              if (query.state === 'active' && metadata?.names[raw.status] === undefined) return invalidResponse();
              const active = query.state !== 'active' || (metadata !== undefined && !metadata.terminal.has(raw.status));
              if (wantedLabels.every(label => rawLabels.includes(label)) && matchesSearch && active) {
                items.push(mapItem(raw, type, association, config.timeZone, 8_000, metadata?.names[raw.status] ?? raw.status));
              }
            }
            if (offset < rows.length) break;
            if (rows.length < vendorPageSize) { upstreamFinished = true; break; }
            page++;
            offset = 0;
            scannedPages++;
          }
          const truncated = !upstreamFinished;
          return {
            available: true, items, truncated,
            ...(truncated ? { nextCursor: encodeCursor(cursorScope, JSON.stringify({ page, offset })) } : {}),
          };
        }, query.refresh === '1') as Promise<TrackerItemsResult>);
      } catch (error) { return collectionFailure(error); }
    };

    const getItem = async (id: string): Promise<TrackerItemResult> => {
      try {
        const match = /^(story|bug):(\d{1,64})$/.exec(id);
        if (!match) throw new TrackerRequestError('not_found', 'The requested TAPD item was not found in this workspace.');
        const type = match[1] as ItemType;
        const vendorId = match[2]!;
        return await runOperation(signal => cache.get(JSON.stringify(['tapd', currentSource.id, association.externalId, 'item', id]), async () => {
          await checkAssociation(association, signal);
          const rows = parseItems(type, await request(type === 'story' ? '/stories' : '/bugs', { workspace_id: association.externalId, id: vendorId }, signal));
          const raw = rows.find(row => row.id === vendorId);
          if (!raw) throw new TrackerRequestError('not_found', 'The requested TAPD item was not found in this workspace.');
          return { available: true, item: mapItem(raw, type, association, config.timeZone, 60_000) };
        }, true) as Promise<TrackerItemResult>);
      } catch (error) { return lookupFailure(error); }
    };

    return {
      association,
      async automationOptions(query) {
        if (query?.cursor) throw new TrackerRequestError('invalid_cursor', 'This options catalog has no next page.');
        return runOperation(async signal => {
          await checkAssociation(association, signal);
          return {
            events: tapdEventCapabilities,
            limitations: [tapdHistoryLimitation],
            statuses: [],
            labels: [],
            ...(query?.itemType ? { itemType: query.itemType } : {}),
          };
        });
      },
      async pollEvents(input: EventPollInput) {
        if (input.event && input.event !== 'issue.opened') throw new TrackerRequestError('unavailable', tapdHistoryLimitation);
        return runOperation(async deadline => {
          const scanDeadlineAt = Date.now() + 8_000;
          const signal = AbortSignal.any([input.signal, deadline]);
          await checkAssociation(association, signal);
          const itemType = input.itemType ?? 'story';
          // Discovery rides `order=created desc`: `modified` drifts after creation and would
          // fabricate opened events for old items (spec 2026-10-13 §5). An absent event
          // filter must not fabricate status candidates either, so history stays gated and
          // only `issue.opened` polls reach the scanner.
          const pollInput = { ...input, event: 'issue.opened' as const, itemType, signal, scanDeadlineAt };
          const scope = { kind: 'tapd', source: currentSource, operation: 'events', externalId: association.externalId, itemType };
          return createTapdEventSource(association, async (from, _until, cursor, pageSignal) => {
            const page = parsePage(decodeCursor(scope, cursor));
            const rows = parseItems(itemType, await request(itemType === 'story' ? '/stories' : '/bugs', {
              workspace_id: association.externalId, page: String(page), limit: String(vendorPageSize), order: 'created desc',
            }, pageSignal));
            if (rows.some(raw => raw.workspace_id !== association.externalId)) throw sourceChanged();
            const issues = rows.map(raw => {
              const title = itemType === 'story' ? (raw as Story).name : (raw as Bug).title;
              return {
                id: `${itemType}:${raw.id}`,
                key: raw.id,
                title,
                createdAt: zonedTimestamp(raw.created, config.timeZone),
                url: itemType === 'story'
                  ? `${webOrigin}/${encodeURIComponent(association.externalId)}/prong/stories/view/${encodeURIComponent(raw.id)}`
                  : `${webOrigin}/${encodeURIComponent(association.externalId)}/bugtrace/bugs/view?bug_id=${encodeURIComponent(raw.id)}`,
                status: raw.status,
                labels: labels(raw.label),
              };
            });
            const fromInstant = Date.parse(from);
            const reachedBeforeWindow = issues.length > 0 && issues.every(issue => Date.parse(issue.createdAt) < fromInstant);
            const more = rows.length === vendorPageSize && !reachedBeforeWindow;
            return { issues, ...(more ? { cursor: encodeCursor(scope, JSON.stringify({ page: page + 1 })) } : {}) };
          }).poll(pollInput);
        }).catch(error => {
          if (error instanceof z.ZodError) throw new TrackerRequestError('invalid_response', 'Tracker returned incomplete automation event data.');
          throw error;
        });
      },
      listIssues: readItems,
      searchItems: readItems,
      getItem,
    };
  };

  return { kind: 'tapd', listCandidates, resolveAssociation, driver, clearCache: () => cache.clear() };
}
