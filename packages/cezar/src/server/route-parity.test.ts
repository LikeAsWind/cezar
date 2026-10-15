import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, projectRouteManifest, type ProjectRouteInfo } from './server.ts';
import { testRuntime } from './runtime.testkit.ts';

/**
 * Explicit project scoping (Tasks 2–3): project routes answer ONLY under
 * `/api/v1/p/:projectId/<path>`. There is no unscoped alias bound to a boot
 * project, so `/api/v1/runs` and `/p/default/*` 404; an
 * unknown id is 404 and a registered project whose folder is gone is 409.
 */

describe('explicit project scoping (scoped-only routes)', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedSingleProject = process.env.CEZ_SINGLE_PROJECT;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;
  const savedDispatch = process.env.CEZ_DISPATCH;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: Hono;
  let alpha: string;
  let runId: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-parity-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-parity-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-parity-other-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env.CEZ_SINGLE_PROJECT;
    process.env.CEZ_AUTOMATIONS = '1';
    process.env.CEZ_DISPATCH = '1';
    process.env.CEZ_DRY_RUN = '1';
    for (const root of [repoRoot, otherRoot]) {
      mkdirSync(join(root, '.ai/cezar'), { recursive: true });
      writeFileSync(join(root, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    }
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    runId = store.createRun({
      title: 'parity',
      workflow: 'quick-task',
      task: 'parity',
      steps: [],
    }).id;
    contexts = new ProjectContexts({ listProjects });
    alpha = (await registerProject(repoRoot)).id;
    app = createApp({
      runtime: testRuntime({ repoRoot, store, manager: { isActive: () => false } as unknown as import('../workflows/run.ts').RunManager, contexts }),
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    // Tear the built contexts down BEFORE removing the temp dirs: the managers
    // hold the store's timers/handles, and a Windows rmSync races them.
    contexts.disposeAll();
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* EPERM race */ }
    }
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedSingleProject === undefined) delete process.env.CEZ_SINGLE_PROJECT;
    else process.env.CEZ_SINGLE_PROJECT = savedSingleProject;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
    if (savedDispatch === undefined) delete process.env.CEZ_DISPATCH;
    else process.env.CEZ_DISPATCH = savedDispatch;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  it('exports a manifest that covers the whole project-route table', () => {
    const manifest = projectRouteManifest(app);
    const keys = new Set(manifest.map((r) => `${r.method} ${r.path}`));
    expect(manifest.length).toBeGreaterThanOrEqual(50);
    for (const expected of [
      'GET /launch-key',
      'GET /events',
      'GET /runs/:id/events',
      'GET /runs/:id/history',
      'GET /runs/:id/history-context',
      'POST /runs',
      'POST /runs/archive-finished',
      'PUT /ui-state',
      'PUT /config',
      'GET /agent-config',
      'GET /agent-config/:id',
      'PUT /agent-config/:id',
      'DELETE /runs/:id',
      'PATCH /runs/:id',
      'POST /todos/:id/start',
      'GET /repo/commit/:sha',
    ]) {
      expect(keys, expected).toContain(expected);
    }
    // Workspace-level routes must NOT be mirrored under /api/v1/p/.
    for (const workspaceOnly of [
      'GET /health',
      'GET /projects',
      'POST /projects',
      'GET /fs/browse',
      'GET /workspace/runs-index',
      'GET /workspace/host-usage',
      'GET /workspace/agent-profiles',
    ]) {
      expect(keys, workspaceOnly).not.toContain(workspaceOnly);
    }
  });

  it('serves project routes only under an explicit registered id', async () => {
    const scoped = await apiRequest(app, `/api/v1/p/${alpha}/runs`);
    expect(scoped.status).toBe(200);
    // Its own (empty) store — the run above lives in the boot-era store, not the registry's.
    expect(await scoped.json()).toEqual([]);

    for (const path of ['/runs', '/launch-key', '/config', '/agent-config', '/workflows']) {
      const unscoped = await apiRequest(app, `/api/v1${path}`);
      expect(unscoped.status, path).toBe(404);
    }
  });

  it('never resolves default when two projects exist', async () => {
    await registerProject(otherRoot);
    const res = await apiRequest(app, '/api/v1/p/default/runs');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown project: default' });
  });

  it('rejects default even with one usable project', async () => {
    const res = await apiRequest(app, '/api/v1/p/default/runs');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown project: default' });
  });

  it.each([
    ['/api/v1/projects/default', 'PATCH', { tags: ['test'] }],
    ['/api/v1/workspace/agent-profiles/selection', 'PUT', { projectId: 'default', provider: 'claude', profileId: null }],
    ['/api/v1/workspace/skills-update?projectId=default', 'GET', undefined],
    ['/api/v1/projects/default', 'DELETE', undefined],
  ] as const)('rejects default for %s (%s)', async (path, method, body) => {
    const res = await apiRequest(app, path, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    expect(res.status, `${method} ${path}`).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown project: default' });
  });

  it('unknown and malformed project ids answer 404 {error}', async () => {
    for (const url of ['/api/v1/p/no-such-project/runs', '/api/v1/p/no-such-project/events']) {
      const res = await apiRequest(app, url);
      expect(res.status, url).toBe(404);
      expect(await res.json()).toEqual({
        error: 'unknown project: no-such-project',
      });
    }
    const malformed = await apiRequest(app, '/api/v1/p/Bad_Id/runs');
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({
      error: 'unknown project: Bad_Id',
    });
  });

  it('a registered project whose folder is gone answers 409 {error}', async () => {
    const other = await registerProject(otherRoot);
    rmSync(otherRoot, { recursive: true, force: true });
    clearProjectProbeCache();
    const res = await apiRequest(app, `/api/v1/p/${other.id}/runs`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `project folder not found: ${other.id}`,
    });
  });

  it('a non-boot project builds lazily and answers with its own state', async () => {
    const other = await registerProject(otherRoot);
    expect(contexts.peek(other.id)).toBeUndefined();
    const runs = await apiRequest(app, `/api/v1/p/${other.id}/runs`);
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual([]);
    expect(contexts.peek(other.id)).toBeDefined();
    const otherKey = (
      (await (await apiRequest(app, `/api/v1/p/${other.id}/launch-key`)).json()) as {
        key: string;
      }
    ).key;
    expect(otherKey).not.toBe('');
  });
});
