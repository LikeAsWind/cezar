import { z } from 'zod';

export const superpowersVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const superpowersBundleRefSchema = z.object({
  version: superpowersVersionSchema,
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SuperpowersBundleRef = z.infer<typeof superpowersBundleRefSchema>;

export const superpowersUpdateStateSchema = z.object({
  status: z.enum(['idle', 'checking', 'available', 'staging', 'ready', 'current', 'unavailable', 'error']),
  current: superpowersBundleRefSchema,
  previous: superpowersBundleRefSchema.nullable(),
  latest: z.object({ version: superpowersVersionSchema, tag: z.string(), commit: z.string().regex(/^[a-f0-9]{40}$/), url: z.string().url() }).nullable(),
  staged: z.object({
    bundle: superpowersBundleRefSchema,
    added: z.array(z.string()), changed: z.array(z.string()), removed: z.array(z.string()),
    checks: z.array(z.string()),
  }).nullable(),
  checkedAt: z.string().nullable(),
  autoCheck: z.boolean(),
  reason: z.string().optional(),
});
export type SuperpowersUpdateState = z.infer<typeof superpowersUpdateStateSchema>;

export const superpowersEmptyRequestSchema = z.object({}).strict();
export const superpowersStageRequestSchema = z.object({ version: superpowersVersionSchema }).strict();
export const superpowersActivateRequestSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) }).strict();
export const superpowersAutoCheckRequestSchema = z.object({ autoCheck: z.boolean() }).strict();
