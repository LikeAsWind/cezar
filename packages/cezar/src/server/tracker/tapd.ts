import { z } from 'zod';
import type {
  TrackerAssociation, TrackerAssociationInput, TrackerAssociationResult, TrackerCandidatesQuery,
  TrackerCandidatesResult, TrackerItem, TrackerItemResult, TrackerItemsResult, TrackerIteration,
  TrackerIterationsResult, TrackerListQuery, TrackerSearchQuery, TrackerSource,
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

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
// A single filtered read may scan this many upstream pages before yielding a
// continuation. Test-only override keeps the bound honest without 4,000 fixture rows.
const maximumScanPages = positiveInt(process.env.CEZ_TAPD_MAX_SCAN_PAGES, 20);
// A read stops scanning early once it has made this many upstream requests; the
// result is flagged scan-incomplete so the UI offers Continue scanning rather
// than presenting a partial filtered page as ordinary pagination (spec §4/§5).
// Read per call (not snapshotted) so a test can drive the budget via the env var.
function scanPageRequestLimit(): number {
  return positiveInt(process.env.CEZ_TAPD_SCAN_PAGE_LIMIT, 4);
}

const numericId = z.string().regex(/^\d+$/).max(64);
// List/detail responses only need these fields; TAPD's full row (custom_field_1..50
// etc.) is large enough that a single `limit=200` stories page can exceed the shared
// 2 MiB transport cap. Restrict to what the adapter maps so an ordinary list cannot
// trip the limit, and the detailed description is still fetched for item detail.
const storyFields = 'id,workspace_id,workitem_type_id,name,description,creator,created,modified,status,label,iteration_id';
const bugFields = 'id,workspace_id,title,description,reporter,creator,created,modified,status,label,iteration_id';
const workspaceSchema = z.object({
  id: numericId,
  name: z.string().min(1),
  status: z.string().optional(),
}).passthrough();
const workspaceRowSchema = z.union([workspaceSchema, z.object({ Workspace: workspaceSchema }).passthrough()]);
const storySchema = z.object({
  id: numericId, workspace_id: numericId, workitem_type_id: numericId, name: z.string(),
  description: z.string().nullish(), creator: z.string().nullish(), created: z.string(), modified: z.string(),
  status: z.string(), label: z.string().nullish(), iteration_id: z.string().nullish().optional(),
}).passthrough();
const bugSchema = z.object({
  id: numericId, workspace_id: numericId, title: z.string(), description: z.string().nullish(),
  reporter: z.string().nullish(), creator: z.string().nullish(), created: z.string(), modified: z.string(),
  status: z.string(), label: z.string().nullish(), iteration_id: z.string().nullish().optional(),
}).passthrough();
const storyRowSchema = z.object({ Story: storySchema }).passthrough();
const bugRowSchema = z.object({ Bug: bugSchema }).passthrough();

const iterationSchema = z.object({
  id: numericId, name: z.string().min(1),
  startdate: z.string().nullish().optional(), enddate: z.string().nullish().optional(),
  status: z.string().optional(),
}).passthrough();
const iterationRowSchema = z.object({ Iteration: iterationSchema }).passthrough();

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
  return new TrackerRequestError('source_changed', 'The saved TAPD connection no longer matches the configured token. Reconnect the project.');
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

function mapItem(raw: RawItem, type: ItemType, association: TrackerAssociation, timeZone: string, maximum: number, status = raw.status, iterations?: ReadonlyMap<string, TrackerIteration>): TrackerItem {
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
  const iterationId = raw.iteration_id && raw.iteration_id !== '0' ? raw.iteration_id : undefined;
  return {
    kind: 'issue', id, displayId: raw.id, itemType: type, title, author: author ?? 'Unknown',
    createdAt: zonedTimestamp(raw.created, timeZone), updatedAt: zonedTimestamp(raw.modified, timeZone),
    labels: labels(raw.label), ...body, url, status,
    ...(iterationId ? { iteration: iterations?.get(iterationId) ?? { id: iterationId, name: iterationId } } : {}),
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
  config: { accessToken: string; timeZone: string },
  fetcher: typeof fetch = fetch,
): TrackerProvider {
  const http = new TrackerHttp(fetcher);
  const cache = new ResultCache<CachedResult>(200, 60_000);
  const authorization = `Bearer ${config.accessToken}`;
  const currentSource: TrackerSource = { id: 'tapd', webUrl: webOrigin };
  let nick: string | undefined;

  const request = async (path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> => {
    const query = new URLSearchParams(params);
    query.set('s', 'mcp');
    return parseEnvelope(await http.json(`${apiOrigin}${path}?${query}`, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: authorization, Via: 'mcp' },
    }, signal));
  };

  const currentNick = async (signal: AbortSignal): Promise<string> => {
    if (nick) return nick;
    // `request` already unwraps the envelope to `data`, and the live `users/info`
    // returns the user object directly (nick/id/name/current_company_id), not wrapped in `User`.
    const parsed = z.object({ nick: z.string().min(1) }).passthrough().safeParse(
      await request('/users/info', {}, signal),
    );
    if (!parsed.success) return invalidResponse();
    nick = parsed.data.nick;
    return nick;
  };

  const verifyWorkspace = async (workspaceId: string, signal: AbortSignal): Promise<z.infer<typeof workspaceSchema>> => {
    const row = parseWorkspace(await request('/workspaces/get_workspace_info', { workspace_id: workspaceId }, signal));
    if (row.id !== workspaceId) return invalidResponse();
    if (row.status === 'closed' || row.status === 'suspend') throw sourceChanged();
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
        const rows = parseWorkspaceCollection(await request('/workspaces/user_participant_projects', { nick: await currentNick(signal) }, signal));
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
    const loadIterations = async (signal: AbortSignal): Promise<ReadonlyMap<string, TrackerIteration>> => {
      const parsed = z.array(iterationRowSchema).safeParse(await request('/iterations', { workspace_id: association.externalId, limit: '200', page: '1' }, signal));
      if (!parsed.success) return invalidResponse();
      const rows = parsed.data.map(row => row.Iteration);
      // The iteration view lists only the current year and only non-terminal iterations;
      // completed (`done`) iterations are historical and stay out of the picker/groups.
      // The iteration's own startdate is the year signal — a 2025 week that merely ends in
      // early 2026 is still last year's iteration.
      const year = String(new Date().getFullYear());
      return new Map(rows
        .filter(row => row.status !== 'done' && (!row.startdate || row.startdate.startsWith(year)))
        .map(row => [row.id, { id: row.id, name: row.name, ...(row.startdate ? { start: row.startdate } : {}), ...(row.enddate ? { end: row.enddate } : {}) }]));
    };

    const workflow = async (type: ItemType, workitemTypeId: string | undefined, signal: AbortSignal) => {
      if (type === 'story' && workitemTypeId === undefined) return invalidResponse();
      const params = {
        workspace_id: association.externalId,
        system: type,
        ...(workitemTypeId === undefined ? {} : { workitem_type_id: workitemTypeId }),
      };
      const statusMap = z.record(z.string(), z.string()).safeParse(await request('/workflows/status_map', params, signal));
      // `last_steps` returns an object keyed by terminal status code (not an array).
      const terminalRaw = z.record(z.string(), z.string()).safeParse(await request('/workflows/last_steps', params, signal));
      if (!statusMap.success || !terminalRaw.success) return invalidResponse();
      const terminal = Object.keys(terminalRaw.data);
      if (terminal.length === 0 || terminal.some(status => statusMap.data[status] === undefined)) return invalidResponse();
      return { names: statusMap.data, terminal: new Set(terminal) };
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
            type, state: query.state, labels: query.labels ?? [], iterationId: query.iterationId ?? '', ...('q' in query ? { q: query.q } : {}), limit: query.limit,
          };
          let { page, offset } = parsePosition(decodeCursor(cursorScope, query.cursor));
          const items: TrackerItem[] = [];
          const wantedLabels = query.labels ?? [];
          const search = 'q' in query ? query.q.toLocaleLowerCase() : undefined;
          // The iteration view needs names on each row and, when a specific iteration is
          // selected, an upstream filter so the scan is bounded to that iteration's items.
          const iterations = await loadIterations(signal);
          const workflows = new Map<string, Awaited<ReturnType<typeof workflow>>>();
          let scannedPages = 0;
          let upstreamFinished = false;
          let budgetExhausted = false;
          while (items.length < query.limit && scannedPages < maximumScanPages && !budgetExhausted) {
            const rows = parseItems(type, await request(type === 'story' ? '/stories' : '/bugs', {
              workspace_id: association.externalId, page: String(page), limit: String(vendorPageSize), order: 'modified desc',
              fields: type === 'story' ? storyFields : bugFields,
              ...(wantedLabels[0] ? { label: wantedLabels[0] } : {}),
              ...(query.iterationId ? { iteration_id: query.iterationId } : {}),
            }, signal));
            scannedPages++;
            budgetExhausted = scannedPages >= scanPageRequestLimit();
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
              const matchesIteration = query.iterationId === undefined || (raw.iteration_id ?? '0') === query.iterationId;
              if (wantedLabels.every(label => rawLabels.includes(label)) && matchesSearch && active && matchesIteration) {
                items.push(mapItem(raw, type, association, config.timeZone, 8_000, metadata?.names[raw.status] ?? raw.status, iterations));
              }
            }
            if (offset < rows.length) break;
            if (rows.length < vendorPageSize) { upstreamFinished = true; break; }
            page++;
            offset = 0;
          }
          const truncated = !upstreamFinished;
          // A page cut off by the soft scan budget while upstream still had rows is a
          // partial filtered scan, not a complete result — the UI must offer Continue
          // scanning instead of pretending pagination is ordinary (spec 2026-10-13 §4/§5).
          // Reaching the end of the upstream collection clears the flag even if the
          // budget was also hit: the scan is complete, not partial.
          const scanIncomplete = !upstreamFinished && (budgetExhausted || (scannedPages >= maximumScanPages && items.length < query.limit));
          return {
            available: true, items, truncated,
            ...(truncated ? { nextCursor: encodeCursor(cursorScope, JSON.stringify({ page, offset })) } : {}),
            ...(scanIncomplete ? { scanIncomplete: true } : {}),
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
          const rows = parseItems(type, await request(type === 'story' ? '/stories' : '/bugs', { workspace_id: association.externalId, id: vendorId, fields: type === 'story' ? storyFields : bugFields }, signal));
          const raw = rows.find(row => row.id === vendorId);
          if (!raw) throw new TrackerRequestError('not_found', 'The requested TAPD item was not found in this workspace.');
          const iterations = await loadIterations(signal);
          return { available: true, item: mapItem(raw, type, association, config.timeZone, 60_000, undefined, iterations) };
        }, true) as Promise<TrackerItemResult>);
      } catch (error) { return lookupFailure(error); }
    };

    return {
      association,
      async updateStatus(id, statusName) {
        try {
          return await runOperation(async signal => {
            const match = /^story:(\d{1,64})$/.exec(id);
            if (!match) throw new TrackerRequestError('invalid_response', 'TAPD status updates require an associated story ID.');
            const vendorId = match[1]!;
            await checkAssociation(association, signal);
            const read = async () => {
              const rows = parseItems('story', await request('/stories', { workspace_id: association.externalId, id: vendorId, fields: storyFields }, signal));
              const row = rows.find(item => item.id === vendorId);
              if (!row || row.workspace_id !== association.externalId) throw new TrackerRequestError('invalid_response', 'The associated TAPD story could not be confirmed.');
              return row as Story;
            };
            const story = await read();
            const metadata = await workflow('story', story.workitem_type_id, signal);
            const matches = Object.entries(metadata.names).filter(([, name]) => name === statusName);
            if (matches.length !== 1) throw new TrackerRequestError('invalid_response', `TAPD status “${statusName}” must resolve to exactly one workflow status.`);
            const status = matches[0]![0];
            if (story.status !== status) {
              if (metadata.terminal.has(story.status)) throw new TrackerRequestError('invalid_response', 'The TAPD story is already completed; its status was not changed.');
              const body = new URLSearchParams({ workspace_id: association.externalId, id: vendorId, status });
              try {
                parseEnvelope(await http.json(`${apiOrigin}/stories?s=mcp`, {
                  method: 'POST', headers: { Accept: 'application/json', Authorization: authorization, Via: 'mcp', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
                }, signal));
              } finally { cache.clear(); }
              if ((await read()).status !== status) throw new TrackerRequestError('invalid_response', 'TAPD did not confirm the requested status; inspect the story before retrying.');
            }
            return { available: true as const, id, status, statusName };
          });
        } catch (error) {
          const failure = requestFailure(error);
          return failure.code === 'not_found' || failure.code === 'invalid_cursor' ? { available: false as const, code: 'invalid_response' as const, reason: failure.reason } : failure;
        }
      },
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
              fields: itemType === 'story' ? storyFields : bugFields,
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
      listIterations: async (): Promise<TrackerIterationsResult> => {
        try {
          return await runOperation(async signal => {
            await checkAssociation(association, signal);
            const iterations = [...(await loadIterations(signal)).values()]
              .sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''));
            return { available: true, iterations };
          });
        } catch (error) { return collectionFailure(error); }
      },
    };
  };

  return { kind: 'tapd', listCandidates, resolveAssociation, driver, clearCache: () => cache.clear() };
}
