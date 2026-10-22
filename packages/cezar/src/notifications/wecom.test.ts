import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getWecomSettings, saveWecomSettings, sendWecomNotification, testWecomNotification } from './wecom.ts';
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cez-wecom-')); vi.stubEnv('CEZ_HOME', home); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(home, { recursive: true, force: true }); });
const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key';
const input = { enabled: true, webhookUrl: url, mentionedUserIds: ['member1'], mentionedMobiles: ['13800138000'] };
it('stores credentials privately, returns no URL, and preserves the URL on settings-only updates', () => {
  expect(getWecomSettings('project-a')).toEqual({ configured: false, enabled: false, mentionedUserIds: [], mentionedMobiles: [] });
  expect(saveWecomSettings('project-a', input)).toEqual({ configured: true, enabled: true, mentionedUserIds: ['member1'], mentionedMobiles: ['13800138000'] });
  saveWecomSettings('project-a', { ...input, webhookUrl: undefined, mentionedUserIds: [] });
  expect(JSON.stringify(getWecomSettings('project-a'))).not.toContain('test-key');
});
it('sends text mentions and MR link through the configured robot, checking the business result', async () => {
  saveWecomSettings('project-a', input);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' })));
  vi.stubGlobal('fetch', fetcher);
  expect(await sendWecomNotification('project-a', 'Task ready\nhttps://gitlab.example/group/repo/-/merge_requests/1')).toBe(true);
  const [target, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(target).toBe(url);
  expect(init.redirect).toBe('error');
  expect(JSON.parse(init.body as string)).toEqual({ msgtype: 'text', text: { content: expect.stringContaining('merge_requests/1'), mentioned_list: ['member1'], mentioned_mobile_list: ['13800138000'] } });
});
it('never calls the network when disabled or in dry-run mode', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect(await sendWecomNotification('project-a', 'ready')).toBe(false);
  saveWecomSettings('project-a', input); vi.stubEnv('CEZ_DRY_RUN', '1');
  expect(await sendWecomNotification('project-a', 'ready')).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects HTTP-200 business failures and redacts transport errors without retrying', async () => {
  saveWecomSettings('project-a', input);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ errcode: 93000, errmsg: 'secret ' + url })));
  vi.stubGlobal('fetch', fetcher);
  await expect(sendWecomNotification('project-a', 'ready')).rejects.toThrow('93000');
  fetcher.mockImplementation(async () => { throw new Error(url); });
  await expect(sendWecomNotification('project-a', 'ready')).rejects.toThrow('WeCom request failed');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('tests unsaved settings without replacing the saved connection', async () => {
  saveWecomSettings('project-a', input);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"errcode":0}')));
  await testWecomNotification('project-a', { ...input, webhookUrl: url.replace('test-key', 'draft-key') });
  expect(await readFile(join(home, 'notification-connections', 'projects', createHash('sha256').update('project-a').digest('hex'), 'wecom.json'), 'utf8')).toContain('test-key');
});

it('isolates project credentials and mention targets without a global fallback', async () => {
 saveWecomSettings('project-a', input);
 expect(getWecomSettings('project-b')).toMatchObject({ configured: false, enabled: false, mentionedMobiles: [] });
 const fetcher = vi.fn(async () => new Response('{"errcode":0}'));
 vi.stubGlobal('fetch', fetcher);
 expect(await sendWecomNotification('project-b', 'ready')).toBe(false);
 expect(fetcher).not.toHaveBeenCalled();
 saveWecomSettings('project-b', { ...input, webhookUrl: url.replace('test-key', 'other-key'), mentionedMobiles: ['13900139000'] });
 await testWecomNotification('project-b', { enabled: true, mentionedUserIds: [], mentionedMobiles: ['13900139000'] });
 expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toContain('other-key');
 const payload = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
 expect(payload.text.content).toBe('企业微信通知测试：请确认消息可见，且指定成员收到 @ 提醒。');
 expect(payload.text.mentioned_mobile_list).toEqual(['13900139000']);
 expect(getWecomSettings('project-a').mentionedMobiles).toEqual(input.mentionedMobiles);
});
