import type { ProjectContext } from './project-context.ts';
import { Hono } from 'hono';
import { wecomWebhookSettingsInputSchema, wecomWebhookSettingsSchema, wecomNotificationResultSchema } from '@open-mercato/cezar-contract';
import { getWecomSettings, saveWecomSettings, testWecomNotification } from '../notifications/wecom.ts';
import { jsonZodValidator } from './validators.ts';

export const wecomNotificationRoutes = () => new Hono<{ Variables: { project: ProjectContext } }>()
  .get('/notifications/wecom', c => c.json(wecomWebhookSettingsSchema.parse(getWecomSettings(c.get('project').id))))
  .put('/notifications/wecom', jsonZodValidator(wecomWebhookSettingsInputSchema, { message: 'Invalid WeCom settings' }), c => {
    try { return c.json(wecomWebhookSettingsSchema.parse(saveWecomSettings(c.get('project').id, c.req.valid('json')))); }
    catch { return c.json({ error: 'Could not save WeCom settings; check the webhook and home directory permissions' }, 400); }
  })
  .post('/notifications/wecom/test', jsonZodValidator(wecomWebhookSettingsInputSchema, { message: 'Invalid WeCom settings' }), async c => {
    try { return c.json(wecomNotificationResultSchema.parse({ sent: await testWecomNotification(c.get('project').id, c.req.valid('json')) })); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'WeCom test failed' }, 400); }
  });
