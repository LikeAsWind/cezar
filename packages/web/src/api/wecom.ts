import { wecomWebhookSettingsSchema, wecomNotificationResultSchema, type WecomWebhookSettingsInput } from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'

export async function getWecomSettings(projectId: string, signal?: AbortSignal) {
  return wecomWebhookSettingsSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].notifications.wecom.$get({ param: { projectId } }, { init: { signal } }), '/notifications/wecom'))
}
export async function saveWecomSettings(projectId: string, input: WecomWebhookSettingsInput) {
  return wecomWebhookSettingsSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].notifications.wecom.$put({ param: { projectId }, json: input }), '/notifications/wecom'))
}
export async function testWecomSettings(projectId: string, input: WecomWebhookSettingsInput) {
  return wecomNotificationResultSchema.parse(await unwrap(await cez.api.v1.p[':projectId'].notifications.wecom.test.$post({ param: { projectId }, json: input }), '/notifications/wecom/test'))
}
