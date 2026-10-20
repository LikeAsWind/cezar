import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { GitlabRepoRef } from './types.ts';
import { gitlabConfigRevision, readGitlabHosts } from './gitlab-hosts.ts';

export const GITLAB_BUDGET = { requests: 20, deadlineMs: 15_000, responseBytes: 4 * 1024 * 1024,
  operationBytes: 8 * 1024 * 1024, pages: 10, items: 1_000, concurrency: 4 } as const;
type Budget = { deadline: number; requests: number; bytes: number; configRevision?: string };
const operation = new AsyncLocalStorage<Budget>();
const instances = new Map<string, { active: number; waiters: Array<() => void>; cooldown: number }>();
const execute = promisify(execFile);
export type GitlabCommandRunner = (args: string[], options: { cwd: string; timeout: number; maxBuffer: number; input?: string }) => Promise<string>;
const command: GitlabCommandRunner = async (args, options) => {
  if (process.env.CEZ_DRY_RUN === '1') throw new GitlabApiError('GitLab API is unavailable in dry run');
  const { input, ...limits } = options;
  if (input === undefined) return (await execute('glab', args, { ...limits, encoding: 'utf8', windowsHide: true })).stdout;
  return new Promise<string>((resolve, reject) => {
    const child = execFile('glab', args, { ...limits, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr })); else resolve(stdout);
    });
    // Process launch/timeout errors are reported by execFile; an early pipe close must not crash Node.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
};

export class GitlabApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
const publicReasons = new Set([
  'GitLab API is unavailable in dry run', 'Invalid GitLab request identity', 'GitLab operation deadline exceeded',
  'GitLab operation budget exhausted', 'GitLab response size budget exhausted', 'GitLab rate limit cooldown is active',
  'Invalid GitLab continuation token', 'Invalid or incompatible GitLab continuation token',
  'GitLab continuation position no longer exists; refresh the list', 'Invalid GitLab pagination header',
  'Unsafe GitLab continuation target', 'Incompatible GitLab continuation filters', 'Invalid GitLab continuation page',
  'GitLab reference batch was truncated', 'GitLab merge request head is unavailable',
  'GitLab merge request head changed while reading changes; refresh', 'Invalid GitLab creation date',
  'GitLab configuration changed; reload the view', 'GitLab request timed out; retry the operation', 'GitLab request failed',
]);
export function gitlabReason(error: unknown, ref: GitlabRepoRef): string {
  const message = error instanceof Error ? error.message : '';
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(ref.host) ? ref.host : 'gitlab.com';
  if (/ENOENT|not found.*glab|glab CLI not found/i.test(message)) return `glab CLI not found — install it and run \`glab auth login --hostname ${host}\``;
  if (error instanceof GitlabApiError) {
    if (error.status === 401 || error.status === 403 || message === 'GitLab access denied') return `GitLab access denied — check permissions and run \`glab auth login --hostname ${host}\``;
    if (publicReasons.has(message)) return message;
    if (error.status && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) return `GitLab API returned ${error.status}`;
    if (/^GitLab CI for merge request !\d+ is unreadable or does not match its head$/.test(message)) return 'GitLab CI is unreadable or does not match the merge request head';
    if (/^Approval requirements for GitLab merge request !\d+ could not be read$/.test(message)) return 'Approval requirements for the GitLab merge request could not be read';
  }
  return 'GitLab returned invalid or unreadable data';
}
function retryAfterDeadline(value?: string): number {
  const now = Date.now();
  const numeric = /^\d+$/.test(value ?? '') ? now + Number(value) * 1_000 : Number.NaN;
  const deadline = Number.isFinite(numeric) ? numeric : Date.parse(value ?? '');
  return Math.max(now + 1_000, Number.isFinite(deadline) ? deadline : now + 60_000);
}
export function gitlabOperation<T>(work: () => Promise<T>): Promise<T> {
  if (operation.getStore()) return work();
  return operation.run({ deadline: Date.now() + GITLAB_BUDGET.deadlineMs, requests: 0, bytes: 0 }, work);
}
export function gitlabRemainingMs(): number {
  const remaining = (operation.getStore()?.deadline ?? Date.now() + GITLAB_BUDGET.deadlineMs) - Date.now();
  if (remaining <= 0) throw new GitlabApiError('GitLab operation deadline exceeded');
  return remaining;
}

export type GitlabApiOptions = { method?: 'GET' | 'POST' | 'PUT'; fields?: Record<string, string | number | boolean | number[]>; refresh?: boolean };
export type GitlabPage<T> = { data: T; headers: Record<string, string> };

/** All requests, including nested hydrations, spend the same operation budget. */
export function createGitlabApi(root: string, ref: GitlabRepoRef, run: GitlabCommandRunner = command) {
  const baseIdentity = [ref.host, ref.webOrigin ?? `https://${ref.host}`, ref.projectPath, root, process.env.PATH];
  let revision = gitlabConfigRevision();
  let initialized = false;
  const instance = instances.get(ref.host) ?? { active: 0, waiters: [], cooldown: 0 };
  instances.set(ref.host, instance);
  const cache = new Map<string, { at: number; value: GitlabPage<unknown> }>();
  const pending = new Map<string, Promise<GitlabPage<unknown>>>();
  const epochs = new Map<string, number>();
  const changed = () => new GitlabApiError('GitLab configuration changed; reload the view');
  async function ensureCurrent(): Promise<void> {
    await readGitlabHosts();
    const current = gitlabConfigRevision();
    const budget = operation.getStore();
    if (budget?.configRevision !== undefined && budget.configRevision !== current) throw changed();
    if (initialized && current !== revision) { cache.clear(); pending.clear(); throw changed(); }
    revision = current; initialized = true;
    if (budget) budget.configRevision = current;
  }
  async function request<T>(path: string, schema: z.ZodType<T>, opts: GitlabApiOptions = {}, instanceUsers = false): Promise<GitlabPage<T>> {
    return gitlabOperation(async () => {
      await ensureCurrent();
      const budget = operation.getStore()!;
      if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(ref.host) || !ref.projectPath || /[?#\\]/.test(ref.projectPath) ||
          /^(?:https?:|\/)|(?:^|\/)\.\.(?:\/|$)/.test(path)) throw new GitlabApiError('Invalid GitLab request identity');
      const method = opts.method ?? 'GET';
      const resource = path.split(/[/?]/)[0]!;
      const epoch = epochs.get(resource) ?? 0;
      const key = JSON.stringify([baseIdentity, revision, path, method, opts.fields, instanceUsers]);
      const hit = cache.get(key);
      if (method === 'GET' && !opts.refresh && hit && Date.now() - hit.at < 15_000) {
        return { data: schema.parse(hit.value.data), headers: hit.value.headers };
      }
      const inflight = method === 'GET' ? pending.get(key) : undefined;
      if (inflight) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const value = await Promise.race([inflight, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new GitlabApiError('GitLab operation deadline exceeded')), Math.max(1, budget.deadline - Date.now()));
          })]);
          await ensureCurrent();
          return { data: schema.parse(value.data), headers: value.headers };
        } finally { clearTimeout(timer); }
      }
      const task = (async () => {
        if (instance.cooldown > Date.now()) throw new GitlabApiError('GitLab rate limit cooldown is active', 429);
        if (budget.requests >= GITLAB_BUDGET.requests || Date.now() >= budget.deadline) throw new GitlabApiError('GitLab operation budget exhausted');
        budget.requests++;
        if (instance.active >= GITLAB_BUDGET.concurrency) {
          await new Promise<void>((resolve, reject) => {
            const wake = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { const index = instance.waiters.indexOf(wake); if (index >= 0) instance.waiters.splice(index, 1); reject(new GitlabApiError('GitLab operation deadline exceeded')); }, Math.max(1, budget.deadline - Date.now()));
            instance.waiters.push(wake);
          });
        } else instance.active++;
        try {
          const remaining = budget.deadline - Date.now();
          if (remaining <= 0) throw new GitlabApiError('GitLab operation deadline exceeded');
          if (instance.cooldown > Date.now()) throw new GitlabApiError('GitLab rate limit cooldown is active', 429);
          const endpoint = instanceUsers ? path : `projects/${encodeURIComponent(ref.projectPath)}${path ? `/${path}` : ''}`;
          const args = ['api', '--hostname', ref.host, '--method', method, '--include', endpoint];
          const input = opts.fields === undefined ? undefined : JSON.stringify(opts.fields);
          if (input !== undefined) {
            const inputBytes = Buffer.byteLength(input);
            budget.bytes += inputBytes;
            if (inputBytes > GITLAB_BUDGET.responseBytes || budget.bytes > GITLAB_BUDGET.operationBytes) throw new GitlabApiError('GitLab response size budget exhausted');
            args.push('--input', '-', '--header', 'Content-Type: application/json');
          }
          let output: string;
          try { output = await run(args, { cwd: root, timeout: remaining, maxBuffer: GITLAB_BUDGET.responseBytes, ...(input === undefined ? {} : { input }) }); }
          catch (error) {
            if (error instanceof GitlabApiError) throw error;
            const failure = error as { stdout?: string; stderr?: string; message?: string; code?: string; killed?: boolean };
            const text = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message ?? ''}`;
            const status = Number(/(?:HTTP\/\S+\s+|\bHTTP\s+)(\d{3})\b/i.exec(text)?.[1]) || undefined;
            const retry = /^retry-after:[ \t]*([^\r\n]+)/im.exec(`${failure.stdout ?? ''}\n${failure.stderr ?? ''}`)?.[1];
            if (status === 429) instance.cooldown = retryAfterDeadline(retry);
            if (status) throw new GitlabApiError(`GitLab API returned ${status}`, status);
            if (failure.code === 'ENOENT' || /\bENOENT\b/.test(text)) throw new GitlabApiError('glab CLI not found');
            if (failure.code === 'ETIMEDOUT' || failure.killed || /\btimeout|timed out|ETIMEDOUT\b/i.test(text)) throw new GitlabApiError('GitLab request timed out; retry the operation');
            if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(text)) throw new GitlabApiError('GitLab response size budget exhausted');
            if (/unauthorized|authentication|forbidden/i.test(text)) throw new GitlabApiError('GitLab access denied');
            throw new GitlabApiError('GitLab request failed');
          }
          await ensureCurrent();
          const bytes = Buffer.byteLength(output);
          budget.bytes += bytes;
          if (bytes > GITLAB_BUDGET.responseBytes || budget.bytes > GITLAB_BUDGET.operationBytes) throw new GitlabApiError('GitLab response size budget exhausted');
          const headers: Record<string, string> = {};
          let body = output;
          const match = /^HTTP\/\S+\s+(\d+)[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n/.exec(output);
          if (match) {
            for (const line of match[2]!.split(/\r?\n/)) { const colon = line.indexOf(':'); if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim(); }
            body = output.slice(match[0].length);
            const status = Number(match[1]);
            if (status === 429) {
              instance.cooldown = retryAfterDeadline(headers['retry-after']);
            }
            if (status >= 400) throw new GitlabApiError(`GitLab API returned ${status}`, status);
          }
          const value = { data: schema.parse(JSON.parse(body)), headers };
          if (method === 'GET' && epoch === (epochs.get(resource) ?? 0)) { cache.set(key, { at: Date.now(), value }); while (cache.size > 300) cache.delete(cache.keys().next().value!); }
          return value;
        } finally {
          const wake = instance.waiters.shift();
          if (wake) wake(); else instance.active--;
        }
      })();
      if (method === 'GET') pending.set(key, task);
      try { return await task; } finally { if (pending.get(key) === task) pending.delete(key); }
    });
  }
  return { page: request, async api<T>(path: string, schema: z.ZodType<T>, opts?: GitlabApiOptions): Promise<T> { return (await request(path, schema, opts)).data; },
    async users<T>(username: string, schema: z.ZodType<T>): Promise<T> {
      const path = `users?${new URLSearchParams({ username, per_page: '100' })}`;
      return (await request(path, schema, { refresh: true }, true)).data;
    },
    async version(): Promise<{ enterprise?: boolean }> {
      return (await request('version', z.object({ enterprise: z.boolean().optional() }), { refresh: true }, true)).data;
    },
    ensureCurrent, get generation() { return revision; }, isCurrent: () => revision === gitlabConfigRevision(),
    invalidate(kind?: 'issue' | 'pr', number?: number) {
      const resource = kind === 'issue' ? 'issues' : kind === 'pr' ? 'merge_requests' : undefined;
      const matches = (key: string) => {
        const path = (JSON.parse(key) as unknown[])[2] as string;
        return !resource || path.startsWith(`${resource}?`) || path === resource ||
          path.startsWith(`${resource}/${number ?? ''}`) && (number === undefined || /^($|[/?])/.test(path.slice(`${resource}/${number}`.length)));
      };
      if (resource) epochs.set(resource, (epochs.get(resource) ?? 0) + 1);
      else for (const name of new Set(['', 'issues', 'merge_requests', ...epochs.keys()])) epochs.set(name, (epochs.get(name) ?? 0) + 1);
      for (const key of cache.keys()) if (matches(key)) cache.delete(key);
      for (const key of pending.keys()) if (matches(key)) pending.delete(key);
    }, get identity() { return JSON.stringify([...baseIdentity, revision]); } };
}

const clients = new Map<string, ReturnType<typeof createGitlabApi>>();
export function gitlabClient(root: string, ref: GitlabRepoRef) {
  const key = JSON.stringify([root, ref, gitlabConfigRevision(), process.env.PATH]);
  let client = clients.get(key);
  if (!client) { client = createGitlabApi(root, ref); clients.set(key, client); while (clients.size > 100) clients.delete(clients.keys().next().value!); }
  return client;
}
export async function gitlabApi<T>(root: string, ref: GitlabRepoRef, path: string, schema: z.ZodType<T>, options?: GitlabApiOptions): Promise<T> {
  return gitlabClient(root, ref).api(path, schema, options);
}
