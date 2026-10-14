import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secretsListSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { listProjects, registerProject } from '../workspace/projects.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';
import { testRuntime } from './runtime.testkit.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('secrets API (spec 2026-10-10-project-secrets-vault-options)', () => {
  let root: string;
  let store: RunStore;
  let secrets: SecretStore;
  let contexts: ProjectContexts;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-secrets-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    secrets = new SecretStore(process.env, { keychain: async () => null });
    contexts = new ProjectContexts({
      listProjects,
      openStore: () => store,
      managerFactory: () => ({ isActive: () => false, dispose: () => {} }) as unknown as RunManager,
    });
  });
  afterEach(() => {
    contexts.disposeAll();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = async () => {
    // Register FIRST, then build the context, so the scoped route resolves the
    // real registry slug against the same live store the secret file is keyed by.
    const project = await registerProject(root);
    await contexts.context(project.id);
    return {
      id: project.id,
      instance: createApp({ runtime: testRuntime({ contexts }), version: 'test', secrets }),
    };
  };
  const put = (body: unknown): RequestInit => ({
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('stores a project secret, answers metadata only, and deletes it', async () => {
    const { id, instance } = await app();
    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/E2E_KEY`, put({ value: 'secret-value-123' }))).status).toBe(204);
    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/LLM_KEY`, put({ value: 'llm-value-123', audiences: ['cezar'] }))).status).toBe(204);

    const response = await apiRequest(instance, `/api/v1/p/${id}/secrets`);
    expect(response.status).toBe(200);
    const text = await response.text();
    // The value never comes back, in any form.
    expect(text).not.toMatch(/secret-value-123|llm-value-123/);
    const body = secretsListSchema.parse(JSON.parse(text));
    expect(body.keyBackend).toBe('file');
    expect(body.secrets.map((s) => [s.name, s.audiences])).toEqual([['E2E_KEY', ['checks']], ['LLM_KEY', ['cezar']]]);
    const raw = readFileSync(join(root, 'home', 'secrets', `${id}.json`), 'utf8');
    expect(raw).toContain('"E2E_KEY"');
    expect(raw).not.toContain('secret-value-123');

    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/E2E_KEY`, { method: 'DELETE' })).status).toBe(204);
    // A DIFFERENT project's scope never sees or deletes this project's secret.
    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/E2E_KEY`, { method: 'DELETE' })).status).toBe(404);
    expect(secretsListSchema.parse(await (await apiRequest(instance, `/api/v1/p/${id}/secrets`)).json()).secrets.map((s) => s.name)).toEqual(['LLM_KEY']);
  });

  it('keeps workspace secrets apart from the project\'s, single-mount', async () => {
    const { id, instance } = await app();
    expect((await apiRequest(instance, '/api/v1/workspace/secrets/SHARED', put({ value: 'workspace-value-123' }))).status).toBe(204);
    const listed = secretsListSchema.parse(await (await apiRequest(instance, '/api/v1/workspace/secrets')).json());
    expect(listed.secrets.map((s) => s.name)).toEqual(['SHARED']);
    expect(secretsListSchema.parse(await (await apiRequest(instance, `/api/v1/p/${id}/secrets`)).json()).secrets).toEqual([]);
    expect((await apiRequest(instance, `/api/v1/p/${id}/workspace/secrets`)).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/workspace/secrets/SHARED', { method: 'DELETE' })).status).toBe(204);
    expect((await apiRequest(instance, '/api/v1/workspace/secrets/SHARED', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses a bad name, value or audience with a 400 naming the reason', async () => {
    const { id, instance } = await app();
    for (const [name, reason] of [
      ['CEZ_RUN_ID', 'reserved'],
      ['PATH', 'refused'],
      ['DYLD_INSERT_LIBRARIES', 'refused'],
      ['lower', 'uppercase'],
    ] as const) {
      const response = await apiRequest(instance, `/api/v1/p/${id}/secrets/${name}`, put({ value: 'x' }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(reason);
    }
    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/KEY`, put({ value: 'a\nB=b' }))).status).toBe(400);
    // An empty value is refused here too: the CLI and the cockpit both refuse it, and storing
    // an empty string would shadow the server's own variable of that name instead of reading as unset.
    const empty = await apiRequest(instance, `/api/v1/p/${id}/secrets/KEY`, put({ value: '' }));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain('not empty');
    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/KEY`, put({ value: 'x'.repeat(16 * 1024 + 1) }))).status).toBe(400);
    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/KEY`, put({ value: 42 }))).status).toBe(400);
    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/KEY`, put({ value: 'ok', audiences: [] }))).status).toBe(400);
    expect((await apiRequest(instance, `/api/v1/p/${id}/secrets/KEY`, put({ value: 'ok', audiences: ['agents'] }))).status).toBe(400);
    expect(secretsListSchema.parse(await (await apiRequest(instance, `/api/v1/p/${id}/secrets`)).json()).secrets).toEqual([]);
  });

  it('refuses project writes for an unknown project, and still serves the workspace', async () => {
    const instance = createApp({ runtime: testRuntime({ contexts }), version: 'test', secrets });
    // An id the registry does not hold 404s before any store is touched (no
    // synthetic "boot" project exists to refuse — Tasks 2–3 removed that 409).
    expect((await apiRequest(instance, '/api/v1/p/no-such-project/secrets/KEY', put({ value: 'value' }))).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/workspace/secrets/KEY', put({ value: 'value' }))).status).toBe(204);
  });
});
