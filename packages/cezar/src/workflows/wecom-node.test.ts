import { beforeEach, expect, it, vi } from 'vitest';
const publish = vi.hoisted(() => vi.fn());
vi.mock('../server/forge/operations.ts', async original => ({ ...await original<typeof import('../server/forge/operations.ts')>(), createForgePr: publish }));
const send = vi.hoisted(() => vi.fn());
vi.mock('../notifications/wecom.ts', () => ({ sendWecomNotification: send }));
import { RunManager } from './run.ts';
const record = { title: 'Fix buffer return', pullRequestUrl: 'https://gitlab.example/g/r/-/merge_requests/7' };
beforeEach(() => send.mockReset());
function invoke(body?: string, taken: string[] = [], publication = false, error?: string) {
  const manager = Object.create(RunManager.prototype) as RunManager;
  Object.assign(manager, { projectId: 'project-a', repoRoot: 'C:/mock-project', dataDir: 'C:/mock-project/.ai/cezar', store: { getRun: () => ({ ...record, ...(publication ? { pullRequestUrl: undefined } : {}), steps: error ? [{ id: 'design', name: '设计与需求消歧', error }] : [], graphState: { taken } }), redactRunText: (_id: string, text: string) => text } });
  const outputs = new Map<string, Record<string, string | number>>();
  const note = vi.fn(), persist = vi.fn();
  const method = manager['runSystemNode'].bind(manager);
  return { outputs, note, persist, run: () => method('run1', {} as Parameters<typeof method>[1], publication ? { id: 'publish-mr', type: 'github.draft-pr' } : { id: 'notify', type: 'notify.wecom', ...(body ? { body } : {}) }, outputs, 'task', note, persist) };
}
it('includes the MR link and task title, persists acceptance and never puts credentials in the outputs', async () => {
  send.mockResolvedValue(true);
  const node = invoke();
  expect(await node.run()).toBe('done');
  expect(send).toHaveBeenCalledWith('project-a', expect.stringContaining(record.pullRequestUrl));
  expect(send).toHaveBeenCalledWith('project-a', expect.stringContaining(record.title));
  expect(node.outputs.get('notify')).toEqual({ status: 'sent' });
  expect(node.persist).toHaveBeenCalledOnce();
});
it('uses skipped for a disabled connection and failed for a rejection without retrying', async () => {
  send.mockResolvedValueOnce(false);
  expect(await invoke().run()).toBe('skipped');
  send.mockRejectedValueOnce(new Error('WeCom rejected the message (code 93000)'));
  const node = invoke();
  expect(await node.run()).toBe('failed');
  expect(node.outputs.get('notify')).toEqual({ status: 'failed', error: 'WeCom rejected the message (code 93000)' });
  expect(node.persist).toHaveBeenCalledOnce();
  expect(node.note).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger', message: expect.stringContaining('93000') }));
  expect(send).toHaveBeenCalledTimes(2);
});

it('includes reviewer assignment failure together with the already-created MR', async () => {
  send.mockResolvedValue(true);
  const node = invoke();
  node.outputs.set('request-review', { error: 'Reviewer account is not a project member' });
  expect(await node.run()).toBe('done');
  expect(send).toHaveBeenCalledWith('project-a', expect.stringContaining('审核人设置失败：Reviewer account is not a project member'));
  expect(send).toHaveBeenCalledWith('project-a', expect.stringContaining(record.pullRequestUrl));
});

it('sends the actual originating blocker even when the blocker-report command also failed', async () => {
 send.mockResolvedValue(true);
 const node = invoke('工作流阻塞\n任务：{{title}}\n原因：{{failure}}', ['verify.fail->blocked-report', 'blocked-report.fail->notify']);
 node.outputs.set('verify', { exitCode: 1, output: 'JDK 8 required; JDK 21 detected' });
 node.outputs.set('blocked-report', { output: 'secondary report error' });
 expect(await node.run()).toBe('done');
 expect(send).toHaveBeenCalledWith('project-a', expect.stringContaining('verify：JDK 8 required; JDK 21 detected'));
 expect(send.mock.calls[0]?.[1]).not.toContain('secondary report error');
});
it('uses publication errors and bounds long Unicode failure messages to the provider limit', async () => {
 send.mockResolvedValue(true);
 const node = invoke('推送或创建 MR 失败\n任务：{{title}}\n原因：{{failure}}', ['publish-mr.failed->notify']);
 node.outputs.set('publish-mr', { error: 'remote rejected: protected branch ' + '原因'.repeat(3000) });
 expect(await node.run()).toBe('done');
 const content = send.mock.calls[0]?.[1] as string;
 expect(content).toContain('remote rejected: protected branch');
 expect(content).toContain(record.title);
 expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(2048);
 expect(content).not.toContain('�');
});
it('sends a blocked verdict summary rather than an older recovered failure', async () => {
 send.mockResolvedValue(true);
 const node = invoke('原因：{{failure}}', ['probe.failed->retry', 'design.blocked->blocked-report', 'blocked-report.pass->notify']);
 node.outputs.set('probe', { error: 'old recovered error' });
 node.outputs.set('design', { verdict: 'blocked', summary: '需要确认接口的业务约束' });
 await node.run();
 expect(send).toHaveBeenCalledWith('project-a', '原因：design：需要确认接口的业务约束');
});

it('persists the actual forge publication error for the following notification node', async () => {
 publish.mockResolvedValue({ ok: false, error: 'git push rejected: permission denied' });
 const node = invoke(undefined, [], true);
 expect(await node.run()).toBe('failed');
 expect(node.outputs.get('publish-mr')).toEqual({ error: 'git push rejected: permission denied' });
 expect(node.persist).toHaveBeenCalledOnce();
});

it('prioritizes the actual step failure over accumulated commentary', async () => {
 send.mockResolvedValue(true);
 const node = invoke('原因：{{failure}}', ['design.failed->blocked-report', 'blocked-report.pass->notify'], false, 'Question response requires a Q-number and valid origin');
 node.outputs.set('design', { summary: 'design.md 不存在。'.repeat(500) });
 await node.run();
 expect(send).toHaveBeenCalledWith('project-a', '原因：设计与需求消歧：Question response requires a Q-number and valid origin');
});
