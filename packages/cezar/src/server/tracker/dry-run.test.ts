import { describe, expect, it } from 'vitest';
import { trackerCandidatesQuerySchema, trackerListQuerySchema, trackerSearchQuerySchema, trackerItemsResultSchema } from '@open-mercato/cezar-contract';
import { createDryTrackerClient } from './dry-run.ts';

for (const kind of ['jira', 'linear', 'tapd'] as const) describe(`${kind} offline fixture`, () => {
  it('reaches candidate 51 and preserves long handoff descriptions', async () => {
    const client = createDryTrackerClient(kind);
    const first = await client.listCandidates(trackerCandidatesQuerySchema.parse({ kind }));
    expect(first.available).toBe(true);
    if (!first.available) return;
    const next = await client.listCandidates(trackerCandidatesQuerySchema.parse({ kind, cursor: first.nextCursor }));
    expect(next.available && next.candidates[0]?.id).toBe('51');
    const associated = await client.resolveAssociation({ kind, externalId: '51', sourceId: first.source.id });
    if (!associated.available) throw new Error('fixture association failed');
    const driver = client.driver(associated.association);
    const list = await driver.listIssues(trackerListQuerySchema.parse({}));
    expect(trackerItemsResultSchema.safeParse(list).success).toBe(true);
    if (!list.available) throw new Error('fixture list failed');
    const secondId = kind === 'tapd' ? 'story:101048015100000002' : `${kind === 'jira' ? 'DEMO' : 'ENG'}51-2`;
    expect(list.items.find(row => row.id === secondId)?.bodyTruncated).toBe(true);
    const detailId = kind === 'jira' ? 'DEMO51-2' : kind === 'linear' ? 'ENG51-2' : 'story:101048015100000002';
    const detail = await driver.getItem(detailId);
    expect(detail.available && detail.item.body).toContain('Acceptance: preserve all requirements.');
    expect(detail.available && detail.item.bodyTruncated).toBe(false);
    const search = await driver.searchItems(trackerSearchQuerySchema.parse({ q: 'task 125' }));
    expect(search.available && search.items.length).toBe(1);
  });
  it('rejects forged and cross-project direct lookups', async () => {
    const client = createDryTrackerClient(kind);
    const webUrl = kind === 'jira' ? 'https://demo.atlassian.net' : kind === 'linear' ? 'https://linear.app/demo' : 'https://www.tapd.cn';
    const assoc = { kind, source: { id: `dry-${kind}`, webUrl }, externalId: '1', externalName: 'One' };
    const first = client.driver(assoc);
    const second = client.driver({ ...assoc, externalId: '2' });
    const id = kind === 'jira' ? 'DEMO1-1' : kind === 'linear' ? 'ENG1-1' : 'story:10104801100000001';
    expect(await first.getItem(id)).toMatchObject({ available: true });
    expect(await second.getItem(id)).toMatchObject({ available: false, code: 'not_found' });
    expect(await client.driver({ ...assoc, externalId: '9999' }).getItem(id)).toMatchObject({ available: false });
  });
  it('does not silently reuse a scope after a source change', async () => {
    const client = createDryTrackerClient(kind);
    const driver = client.driver({ kind, source: { id: 'other', webUrl: 'https://other.test' }, externalId: '1', externalName: 'Wrong' });
    expect(await driver.getItem('DEMO-1')).toMatchObject({ available: false, code: 'source_changed' });
  });
  if (kind === 'tapd') it('keeps story and bug fixture identities separate across multiple pages', async () => {
    const client = createDryTrackerClient(kind);
    const associated = await client.resolveAssociation({ kind, externalId: '51', sourceId: 'dry-tapd' });
    if (!associated.available) throw new Error('fixture association failed');
    const driver = client.driver(associated.association);
    const stories = await driver.listIssues(trackerListQuerySchema.parse({ state: 'all', itemType: 'story' }));
    const bugs = await driver.listIssues(trackerListQuerySchema.parse({ state: 'all', itemType: 'bug' }));
    expect(stories.available && stories.items[0]).toMatchObject({ id: 'story:101048015100000001', itemType: 'story', displayId: '101048015100000001' });
    expect(bugs.available && bugs.items[0]).toMatchObject({ id: 'bug:101048025100000001', itemType: 'bug', displayId: '101048025100000001' });
    expect(stories.available && stories.nextCursor).toBeTruthy();
    expect(bugs.available && bugs.nextCursor).toBeTruthy();
  });
});
