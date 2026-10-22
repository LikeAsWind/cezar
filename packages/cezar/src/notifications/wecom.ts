import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { wecomWebhookSettingsInputSchema, type WecomWebhookSettings, type WecomWebhookSettingsInput } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

const defaults = (): WecomWebhookSettingsInput => ({ enabled: false, mentionedUserIds: [], mentionedMobiles: [] });
const file = (projectId: string) => join(cezarHomeDir(), 'notification-connections', 'projects', createHash('sha256').update(projectId).digest('hex'), 'wecom.json');
function readSettings(projectId: string): WecomWebhookSettingsInput {
  try { return wecomWebhookSettingsInputSchema.parse(JSON.parse(readFileSync(file(projectId), 'utf8'))); }
  catch { return defaults(); }
}
const publicSettings = ({ webhookUrl, ...settings }: WecomWebhookSettingsInput): WecomWebhookSettings => ({ ...settings, configured: Boolean(webhookUrl) });
export function getWecomSettings(projectId: string): WecomWebhookSettings { return publicSettings(readSettings(projectId)); }
function mergeSettings(projectId: string, input: WecomWebhookSettingsInput): WecomWebhookSettingsInput {
  const saved = readSettings(projectId);
  const next = { ...saved, ...wecomWebhookSettingsInputSchema.parse(input) };
  if (!input.webhookUrl) next.webhookUrl = saved.webhookUrl;
  if (next.enabled && !next.webhookUrl) throw new Error('Configure the WeCom webhook before enabling notifications');
  return next;
}
export function saveWecomSettings(projectId: string, input: WecomWebhookSettingsInput): WecomWebhookSettings {
  const next = mergeSettings(projectId, input);
  atomicWriteJsonSync(file(projectId), next);
  return publicSettings(next);
}
const replySchema = z.object({ errcode: z.number().int() });
async function send(settings: WecomWebhookSettingsInput, content: string): Promise<boolean> {
  if (!settings.enabled || !settings.webhookUrl || process.env.CEZ_DRY_RUN === '1') return false;
  if (Buffer.byteLength(content, 'utf8') > 2048) throw new Error('WeCom text exceeds 2048 UTF-8 bytes');
  let response: Response;
  try {
    response = await fetch(settings.webhookUrl, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content, mentioned_list: settings.mentionedUserIds, mentioned_mobile_list: settings.mentionedMobiles } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error('WeCom request failed; check connectivity and the saved webhook'); }
  if (!response.ok) throw new Error(`WeCom returned HTTP ${response.status}`);
  const reply = replySchema.safeParse(await response.json().catch(() => null));
  if (!reply.success) throw new Error('WeCom returned an invalid response');
  if (reply.data.errcode !== 0) throw new Error(`WeCom rejected the message (code ${reply.data.errcode})`);
  return true;
}
export function sendWecomNotification(projectId: string, content: string): Promise<boolean> { return send(readSettings(projectId), content); }
export function testWecomNotification(projectId: string, input: WecomWebhookSettingsInput): Promise<boolean> {
  const settings = mergeSettings(projectId, input);
  if (!settings.webhookUrl) throw new Error('Configure the WeCom webhook before testing');
  return send({ ...settings, enabled: true }, '企业微信通知测试：请确认消息可见，且指定成员收到 @ 提醒。');
}
