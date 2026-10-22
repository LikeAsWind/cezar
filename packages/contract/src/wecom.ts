import { z } from 'zod';

/** Write-only credential. Never include this URL in config responses or agent inputs. */
export const wecomWebhookUrlSchema = z.string().trim().max(512).regex(
  /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]+$/,
  'Use the HTTPS WeCom robot webhook URL',
);
const targets = {
  enabled: z.boolean(),
  mentionedUserIds: z.array(z.string().trim().min(1).max(64)).max(100),
  mentionedMobiles: z.array(z.string().trim().regex(/^\+?[0-9]{5,20}$/)).max(100),
};
export const wecomWebhookSettingsSchema = z.object({ configured: z.boolean(), ...targets });
export const wecomWebhookSettingsInputSchema = z.object({ ...targets, webhookUrl: wecomWebhookUrlSchema.optional() }).strict();
export type WecomWebhookSettings = z.infer<typeof wecomWebhookSettingsSchema>;
export type WecomWebhookSettingsInput = z.infer<typeof wecomWebhookSettingsInputSchema>;
export const wecomNotificationResultSchema = z.object({ sent: z.boolean() });
export type WecomNotificationResult = z.infer<typeof wecomNotificationResultSchema>;
