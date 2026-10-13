import { describe, expect, it, vi } from 'vitest';
import { createTapdClient } from './tapd.ts';

const workspaceId = '10104802';
const source = { id: 'tapd', webUrl: 'https://www.tapd.cn' };
const association = { kind: 'tapd' as const, source, externalId: workspaceId, externalName: '示例项目' };

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function userInfo(): unknown {
  return { status: 1, data: { nick: 'me' }, info: 'success' };
}
function workspaceInfo(id: string = workspaceId, name: string = '示例项目', extra: Record<string, unknown> = {}): unknown {
  return { status: 1, data: { Workspace: { id, name, ...extra } }, info: 'success' };
}

function story(id: string, overrides: Record<string, unknown> = {}) {
  return { Story: {
    id, workspace_id: workspaceId, workitem_type_id: '1010104801000022091', name: `Unicode 需求 ${id}`,
    description: '<p>Acceptance</p>', creator: 'test', created: '2026-10-13 08:00:00',
    modified: '2026-10-13 09:00:00', status: 'planning', label: 'backend|urgent', ...overrides,
  } };
}

function bug(id: string, overrides: Record<string, unknown> = {}) {
  return { Bug: {
    id, workspace_id: workspaceId, title: `缺陷 ${id}`, description: '<p>Steps</p>', reporter: 'tester',
    created: '2026-10-13 08:00:00', modified: '2026-10-13 09:00:00', status: 'new', label: '', ...overrides,
  } };
}

function client(fetcher: typeof fetch) {
  return createTapdClient({ accessToken: 'synthetic-tapd-token', timeZone: 'Asia/Shanghai' }, fetcher);
}

describe('createTapdClient', () => {
  it('discovers the user\'s workspaces over fixed-origin Bearer-authenticated GET requests', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.tapd.cn');
      expect(url.searchParams.get('s')).toBe('mcp');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-tapd-token');
      expect(new Headers(init?.headers).get('via')).toBe('mcp');
      if (url.pathname === '/users/info') return json(userInfo());
      expect(url.pathname).toBe('/workspaces/user_participant_projects');
      expect(url.searchParams.get('nick')).toBe('me');
      return json({ status: 1, data: [{ id: workspaceId, name: '示例项目' }], info: 'success' });
    });

    const result = await client(fetcher).listCandidates({ kind: 'tapd', limit: 50 });
    expect(result).toEqual({ available: true, source, candidates: [{ id: workspaceId, name: '示例项目' }], truncated: false });
  });

  it('rejects a closed or suspended workspace', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(workspaceInfo(workspaceId, '示例项目', { status: 'closed' })));
    const result = await client(fetcher).resolveAssociation({ kind: 'tapd', sourceId: source.id, externalId: workspaceId });
    expect(result).toMatchObject({ available: false, code: 'source_changed' });
  });

  it('scans complete vendor pages to satisfy AND labels and keeps type in the cursor scope', async () => {
    const first = Array.from({ length: 200 }, (_, index) => story(String(1000 + index), { label: 'backend' }));
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/workspaces/get_workspace_info') return json(workspaceInfo());
      if (url.pathname === '/iterations') return json({ status: 1, data: [] });
      expect(url.pathname).toBe('/stories');
      expect(url.searchParams.get('workspace_id')).toBe(workspaceId);
      expect(url.searchParams.get('limit')).toBe('200');
      return json({ status: 1, data: url.searchParams.get('page') === '1'
        ? first
        : [story('9999'), ...Array.from({ length: 199 }, (_, index) => story(String(20_000 + index), { label: 'backend' }))] });
    });
    const driver = client(fetcher).driver(association);
    const result = await driver.listIssues({ limit: 1, state: 'all', labels: ['backend', 'urgent'], itemType: 'story' });
    expect(result.available && result.items.map(item => item.id)).toEqual(['story:9999']);
    expect(result.available && result.items[0]?.createdAt).toBe('2026-10-13T00:00:00.000Z');

    if (!result.available || !result.nextCursor) throw new Error('expected cursor');
    const wrongType = await driver.listIssues({ limit: 1, state: 'all', labels: ['backend', 'urgent'], itemType: 'bug', cursor: result.nextCursor });
    expect(wrongType).toMatchObject({ available: false, code: 'invalid_cursor' });
  });

  it('flags a page cut off by the scan budget as incomplete and resumes from its cursor', async () => {
    process.env.CEZ_TAPD_SCAN_PAGE_LIMIT = '1';
    try {
    const first = [story('1', { label: 'backend|urgent' }), ...Array.from({ length: 199 }, (_, index) => story(String(100 + index), { label: 'backend' }))];
    const pages = ['1', '2'];
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/workspaces/get_workspace_info') return json(workspaceInfo());
      if (url.pathname === '/iterations') return json({ status: 1, data: [] });
      expect(url.pathname).toBe('/stories');
      const page = url.searchParams.get('page') ?? '1';
      expect(pages).toContain(page);
      pages.splice(pages.indexOf(page), 1);
      return json({ status: 1, data: page === '1' ? first : [story('2', { label: 'backend|urgent' })] });
    });
    const driver = client(fetcher).driver(association);
    const result = await driver.listIssues({ limit: 2, state: 'all', labels: ['backend', 'urgent'] });
    // The budget is one page per call: upstream had more rows, so the page is a partial scan.
    expect(result).toMatchObject({ available: true, truncated: true, scanIncomplete: true });
    expect(result.available && result.items.map(item => item.id)).toEqual(['story:1']);
    if (!result.available || !result.nextCursor) throw new Error('expected cursor');
    const resumed = await driver.listIssues({ limit: 2, state: 'all', labels: ['backend', 'urgent'], cursor: result.nextCursor });
    expect(resumed.available && !resumed.truncated ? resumed.items.map(item => item.id) : null).toEqual(['story:2']);
    // Upstream finished on the resume page: the completed page carries no scan-incomplete flag.
    expect(resumed.available && 'scanIncomplete' in resumed).toBe(false);
    expect(pages).toEqual([]);
    } finally { delete process.env.CEZ_TAPD_SCAN_PAGE_LIMIT; }
  });

  it('uses typed IDs and rejects a foreign-workspace detail response', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/workspaces/get_workspace_info') return json(workspaceInfo());
      if (url.pathname === '/iterations') return json({ status: 1, data: [] });
      expect(url.pathname).toBe('/bugs');
      expect(url.searchParams.get('id')).toBe('1234567890123456789');
      return json({ status: 1, data: [bug('1234567890123456789', { workspace_id: '999' })] });
    });
    const result = await client(fetcher).driver(association).getItem('bug:1234567890123456789');
    expect(result).toMatchObject({ available: false, code: 'not_found' });
  });

  it('uses type-specific workflow metadata instead of guessing active status', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/workspaces/get_workspace_info') return json(workspaceInfo());
      if (url.pathname === '/iterations') return json({ status: 1, data: [] });
      if (url.pathname === '/stories') return json({ status: 1, data: [story('1'), story('2', { status: 'done' })] });
      if (url.pathname === '/workflows/status_map') {
        expect(url.searchParams.get('system')).toBe('story');
        expect(url.searchParams.get('workitem_type_id')).toBe('1010104801000022091');
        return json({ status: 1, data: { planning: '规划中', done: '已完成' } });
      }
      if (url.pathname === '/workflows/last_steps') return json({ status: 1, data: { done: '已完成' } });
      throw new Error(`unexpected ${url}`);
    });
    const result = await client(fetcher).driver(association).listIssues({ limit: 50, state: 'active', labels: [], itemType: 'story' });
    expect(result.available && result.items).toMatchObject([{ id: 'story:1', status: '规划中' }]);
  });

  it('withholds active filtering when terminal workflow metadata is incomplete', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/workspaces/get_workspace_info') return json(workspaceInfo());
      if (url.pathname === '/iterations') return json({ status: 1, data: [] });
      if (url.pathname === '/stories') return json({ status: 1, data: [story('1')] });
      if (url.pathname === '/workflows/status_map') return json({ status: 1, data: {} });
      if (url.pathname === '/workflows/last_steps') return json({ status: 1, data: [] });
      throw new Error(`unexpected ${url}`);
    });
    const result = await client(fetcher).driver(association).listIssues({ limit: 50, state: 'active', labels: [], itemType: 'story' });
    expect(result).toMatchObject({ available: false, code: 'invalid_response' });
  });

  it('revalidates full detail and caps converted HTML at 60,000 characters', async () => {
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/workspaces/get_workspace_info') return json(workspaceInfo());
      if (url.pathname === '/iterations') return json({ status: 1, data: [] });
      reads++;
      return json({ status: 1, data: [story('123', { description: `<p>${'x'.repeat(60_010 + reads)}</p>` })] });
    });
    const driver = client(fetcher).driver(association);
    const first = await driver.getItem('story:123');
    const second = await driver.getItem('story:123');
    expect(reads).toBe(2);
    expect(first.available && first.item).toMatchObject({ id: 'story:123', displayId: '123', itemType: 'story', bodyTruncated: true });
    expect(second.available && second.item.body.length).toBe(60_000);
  });

  it.each([
    ['business failure', () => json({ status: 0, data: [], info: 'password=must-not-leak' }), 'invalid_response'],
    ['malformed envelope', () => json({ status: 1, data: [{ Story: { id: 1 } }] }), 'invalid_response'],
    ['unauthorized', () => json({}, 401), 'unauthorized'],
    ['throttled', () => json({}, 429, { 'retry-after': '7' }), 'rate_limited'],
  ])('maps %s to a controlled failure', async (_name, response, code) => {
    const result = await client(vi.fn<typeof fetch>(async () => response())).listCandidates({ kind: 'tapd', limit: 50 });
    expect(result).toMatchObject({ available: false, code });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('does no network I/O during construction or driver creation', () => {
    const fetcher = vi.fn<typeof fetch>();
    client(fetcher).driver(association);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('advertises only verified automation events and echoes the requested item type', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/workspaces/get_workspace_info');
      return json(workspaceInfo());
    });
    const driver = client(fetcher).driver(association);
    const options = await driver.automationOptions!({ itemType: 'bug' });
    expect(options.events).toEqual(['issue.opened']);
    expect(options.statuses).toEqual([]);
    expect(options.labels).toEqual([]);
    expect(options.itemType).toBe('bug');
    expect(options.limitations.join(' ')).toContain('history');
    expect(options.limitations.join(' ')).toContain('has not been verified');
    await expect(driver.automationOptions!({ cursor: 'unexpected' })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('rejects status events and discovers created items through the event scanner', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/workspaces/get_workspace_info') return json(workspaceInfo());
      if (url.pathname === '/iterations') return json({ status: 1, data: [] });
      expect(url.pathname).toBe('/stories');
      expect(url.searchParams.get('order')).toBe('created desc');
      return json({ status: 1, data: [story('42'), story('7', { created: '2026-10-12 07:00:00' })], info: 'success' });
    });
    const driver = client(fetcher).driver(association);
    const signal = new AbortController().signal;
    await expect(driver.pollEvents!({ baselineAt: '2026-10-13T00:00:00.000Z', limit: 25, signal, event: 'issue.status_changed' }))
      .rejects.toMatchObject({ code: 'unavailable' });

    const page = await driver.pollEvents!({ baselineAt: '2026-10-12T22:30:00.000Z', limit: 25, signal });
    expect(page.complete).toBe(true);
    expect(page.candidates.map(event => event.eventId)).toEqual(page.candidates.map(event => event.tieBreaker));
    expect(page.candidates).toEqual([expect.objectContaining({
      provider: 'tapd', event: 'issue.opened', issueId: 'story:42', key: '42', title: 'Unicode 需求 42',
      url: 'https://www.tapd.cn/10104802/prong/stories/view/42', status: 'planning', labels: ['backend', 'urgent'],
      timestamp: '2026-10-13T00:00:00.000Z', association,
    })]);
  });

  it('resets the event checkpoint when the item type changes', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/workspaces/get_workspace_info') return json(workspaceInfo());
      if (url.pathname === '/iterations') return json({ status: 1, data: [] });
      expect(url.pathname).toBe('/stories');
      return json({ status: 1, data: [], info: 'success' });
    });
    const driver = client(fetcher).driver(association);
    const signal = new AbortController().signal;
    const input = { baselineAt: '2026-10-12T00:00:00.000Z', limit: 25, signal };
    const storyPoll = await driver.pollEvents!({ ...input, event: 'issue.opened', itemType: 'story' });
    expect(storyPoll.complete).toBe(true);
    await expect(driver.pollEvents!({ ...input, event: 'issue.opened', itemType: 'bug', checkpoint: storyPoll.checkpoint }))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
    // An absent itemType is the story default, so its checkpoint survives.
    const resumed = await driver.pollEvents!({ ...input, event: 'issue.opened', checkpoint: storyPoll.checkpoint });
    expect(resumed.complete).toBe(true);
  });
});
