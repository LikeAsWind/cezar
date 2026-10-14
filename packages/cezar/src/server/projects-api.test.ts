import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TAGS_MAX, PROJECT_TAG_MAX_LENGTH } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import {
  clearProjectProbeCache,
  registerProject,
  type ProjectListEntry,
} from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { workspaceConfigPath } from '../paths.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { CloneRunner } from './checkout.ts';
import {
  WorkspaceEventBus,
  createApp,
  type ProjectsResponse,
  type RegisterProjectResponse,
  type ServerDeps,
  type UpdateProjectResponse,
} from './server.ts';
import { testRuntime } from './runtime.testkit.ts';

/**
 * Multi-project workspace API (spec 2026-07-20-multi-project-workspace, step
 * 1.6): the `GET /api/v1/projects` registry listing and `/api/v1/health`'s
 * additive `projects` field — with the #431 guarantee that health (the one
 * CORS-open route) never carries a project's absolute root.
 *
 * `cez serve` is project-neutral (Tasks 2–3): there is no boot project, so
 * `GET /api/v1/projects` is `{ projects, projectsDir }` and health carries no
 * `bootProject`/`repoRoot`/`repo`/`forge`.
 */

interface HealthBody {
  version: string;
  checks: unknown[];
  defaultRunner?: string;
  capabilities: {
    localHandoff: boolean;
    followups: boolean;
    singleProject: boolean;
    automations: boolean;
    tokenMetrics: boolean;
    tokenUsageMetrics: boolean;
    costMetrics: boolean;
  };
  projects: { id: string; name: string }[];
}

describe('workspace projects API', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedSingleProject = process.env.CEZ_SINGLE_PROJECT;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-workspace-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-projects-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-projects-other-'));
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env.CEZ_SINGLE_PROJECT;
    process.env.CEZ_DRY_RUN = '1';
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedSingleProject === undefined) delete process.env.CEZ_SINGLE_PROJECT;
    else process.env.CEZ_SINGLE_PROJECT = savedSingleProject;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({
      runtime: testRuntime({ repoRoot, store, manager: {} as RunManager }),
      version: '0.0.0-test',
      ...over,
    });

  const getProjects = async (over: Partial<ServerDeps> = {}): Promise<ProjectsResponse> => {
    const res = await apiRequest(makeApp(over), '/api/v1/projects');
    expect(res.status).toBe(200);
    return (await res.json()) as ProjectsResponse;
  };

  /** The REGISTRY rows only — `GET /api/v1/projects` is exactly the registry. */
  const registeredIds = async (over: Partial<ServerDeps> = {}): Promise<string[]> =>
    (await getProjects(over)).projects.map((project) => project.id);

  const getHealth = async (over: Partial<ServerDeps> = {}): Promise<HealthBody> => {
    const res = await apiRequest(makeApp(over), '/api/v1/health');
    expect(res.status).toBe(200);
    return (await res.json()) as HealthBody;
  };

  describe('GET /api/v1/projects', () => {
    it('answers an empty registry with defaults — never a 404', async () => {
      const body = await getProjects();
      expect(body.projects).toEqual([]);
      expect(body.projectsDir).toBe('~/cezar/projects');
    });

    it('lists registered projects with root + status — no bootProject', async () => {
      const boot = await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      const body = await getProjects();
      expect(body.projects).toHaveLength(2);
      const byId = new Map(body.projects.map((p) => [p.id, p]));
      expect(byId.get(boot.id)).toMatchObject({
        id: boot.id,
        name: boot.name,
        root: boot.root,
        status: 'not-git',
        source: 'local',
      });
      expect(byId.get(other.id)).toMatchObject({
        id: other.id,
        root: other.root,
        status: 'not-git',
      });
      expect(body.projectsDir).toBe('~/cezar/projects');
    });

    it('reports a deleted root as missing', async () => {
      const other = await registerProject(otherRoot);
      rmSync(otherRoot, { recursive: true, force: true });
      clearProjectProbeCache();
      const body = await getProjects();
      expect(body.projects.find((p) => p.id === other.id)?.status).toBe('missing');
    });

    it('serializes a per-project maxParallel when set, and omits it when absent (2026-07-22)', async () => {
      await registerProject(repoRoot);
      await registerProject(otherRoot);
      await mergeWriteWorkspaceConfig((config) => {
        const entry = config.projects.find((p) => p.root !== realpathSync(repoRoot));
        if (entry) entry.maxParallel = 3;
      });
      const body = await getProjects();
      const byRoot = new Map(body.projects.map((p) => [p.root, p]));
      const other = body.projects.find((p) => p.root !== realpathSync(repoRoot));
      expect(other?.maxParallel).toBe(3);
      expect(byRoot.get(realpathSync(repoRoot))?.maxParallel).toBeUndefined();
    });
  });

  describe('single-project management guards', () => {
    it('refuses checkout before clone or registry side effects', async () => {
      let cloneCalls = 0;
      const cloneRunner: CloneRunner = async () => {
        cloneCalls += 1;
        return { ok: false, error: 'must not run' };
      };
      process.env.CEZ_SINGLE_PROJECT = '1';

      const res = await apiRequest(makeApp({ cloneRunner }), '/api/v1/projects/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'open-mercato/cezar' }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'single-project mode is enabled; adding projects is disabled',
      });
      expect(cloneCalls).toBe(0);
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
    });

    it('refuses filesystem browsing with the stable error', async () => {
      process.env.CEZ_SINGLE_PROJECT = '1';
      const res = await apiRequest(
        makeApp(),
        `/api/v1/fs/browse?path=${encodeURIComponent(otherRoot)}`,
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'single-project mode is enabled; folder browsing is disabled',
      });
    });
  });

  describe('POST /api/v1/projects — the folder-browser dialog (step 4.2)', () => {
    const post = async (body: unknown, over: Partial<ServerDeps> = {}) => {
      const res = await apiRequest(makeApp(over), '/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as RegisterProjectResponse & {
          error?: string;
        },
      };
    };

    it('refuses registration in single-project mode before registry or event side effects', async () => {
      const existing = await registerProject(repoRoot);
      const bus = new WorkspaceEventBus();
      const seen: string[] = [];
      bus.on((event) => seen.push(event));
      process.env.CEZ_SINGLE_PROJECT = '1';

      const { status, body } = await post({ root: otherRoot }, { runtime: testRuntime({ repoRoot, store, workspaceEvents: bus }) });

      expect(status).toBe(409);
      expect(body).toEqual({
        error: 'single-project mode is enabled; adding projects is disabled',
      });
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([
        existing.id,
      ]);
      expect(seen).toEqual([]);
    });

    it('registers a NON-GIT folder and answers the entry — the spec\'s "any folder works"', async () => {
      const { status, body } = await post({ root: otherRoot });
      expect(status).toBe(200);
      expect(body.project).toMatchObject({
        root: await realpath(otherRoot),
        status: 'not-git',
        source: 'local',
        name: basename(otherRoot),
      });
      expect(body.error).toBeUndefined();
      expect(body.project.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      const listed = await getProjects();
      expect(listed.projects.map((p) => p.id)).toContain(body.project.id);
    });

    it('registers a git repo as status ok and emits project-added once', async () => {
      mkdirSync(join(otherRoot, '.git'), { recursive: true });
      clearProjectProbeCache();
      const bus = new WorkspaceEventBus();
      const seen: { event: string; data: unknown }[] = [];
      bus.on((event, data) => seen.push({ event, data }));
      const { status, body } = await post({ root: otherRoot }, { runtime: testRuntime({ repoRoot, store, workspaceEvents: bus }) });
      expect(status).toBe(200);
      expect(body.project.status).toBe('ok');
      expect(seen).toEqual([{ event: 'project-added', data: { project: body.project } }]);
    });

    it('re-registering answers 409 with the EXISTING entry and emits nothing', async () => {
      const first = await registerProject(otherRoot);
      const bus = new WorkspaceEventBus();
      const seen: string[] = [];
      bus.on((event) => seen.push(event));
      const { status, body } = await post({ root: `${otherRoot}/` }, { runtime: testRuntime({ repoRoot, store, workspaceEvents: bus }) });
      expect(status).toBe(409);
      expect(body.project.id).toBe(first.id);
      expect(body.error).toContain(first.id);
      expect(seen).toEqual([]);
      expect(await registeredIds()).toEqual([first.id]);
    });

    it('400s a non-absolute path, a missing folder, a file, and a malformed body', async () => {
      const file = join(otherRoot, 'not-a-dir.txt');
      writeFileSync(file, 'x', 'utf8');
      for (const root of ['relative/path', join(otherRoot, 'nope'), file]) {
        const { status, body } = await post({ root });
        expect(status, root).toBe(400);
        expect(typeof body.error).toBe('string');
      }
      expect((await post({})).status).toBe(400);
      expect((await post({ root: '   ' })).status).toBe(400);
      expect(await registeredIds()).toEqual([]);
    });

    it('refuses $HOME itself — the dialog starts there and could otherwise add it', async () => {
      const { status, body } = await post({ root: '~' });
      expect(status).toBe(400);
      expect(body.error).toContain('home directory');
      expect(await registeredIds()).toEqual([]);
    });

    it('hosted mode: a folder outside browseRoot is refused, one inside is registered', async () => {
      const checkoutRoot = join(home, 'checkouts');
      const inside = join(checkoutRoot, 'app');
      mkdirSync(inside, { recursive: true });
      await mergeWriteWorkspaceConfig((config) => {
        config.browseRoot = checkoutRoot;
      });
      process.env.CEZ_REMOTE = '1';
      const refused = await post({ root: otherRoot });
      expect(refused.status).toBe(400);
      expect(refused.body.error).not.toContain(checkoutRoot);
      expect(await registeredIds()).toEqual([]);
      const allowed = await post({ root: await realpath(inside) });
      expect(allowed.status).toBe(200);
      expect(allowed.body.project.root).toBe(await realpath(inside));
    });

    it('hosted mode: an out-of-root path answers identically whether or not it exists', async () => {
      const checkoutRoot = join(home, 'checkouts');
      mkdirSync(checkoutRoot, { recursive: true });
      await mergeWriteWorkspaceConfig((config) => {
        config.browseRoot = checkoutRoot;
      });
      process.env.CEZ_REMOTE = '1';
      const exists = await post({ root: otherRoot });
      const absent = await post({ root: join(otherRoot, 'nope') });
      expect(exists.status).toBe(400);
      expect(absent).toEqual(exists);
      expect(absent.body.error).not.toContain('nope');
      expect(await registeredIds()).toEqual([]);
    });

    it('hosted mode: a missing folder INSIDE the root still says so, not "outside"', async () => {
      const checkoutRoot = join(home, 'checkouts');
      mkdirSync(checkoutRoot, { recursive: true });
      await mergeWriteWorkspaceConfig((config) => {
        config.browseRoot = checkoutRoot;
      });
      process.env.CEZ_REMOTE = '1';
      const typo = join(await realpath(checkoutRoot), 'my-porject');
      const answer = await post({ root: typo });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe(`no such folder: ${typo}`);
      expect(await registeredIds()).toEqual([]);
    });

    it('hosted mode: a symlink inside the root pointing out of it is refused', async () => {
      const checkoutRoot = join(home, 'checkouts');
      mkdirSync(checkoutRoot, { recursive: true });
      await mergeWriteWorkspaceConfig((config) => {
        config.browseRoot = checkoutRoot;
      });
      const escape = join(checkoutRoot, 'escape');
      symlinkSync(otherRoot, escape);
      process.env.CEZ_REMOTE = '1';
      const answer = await post({ root: escape });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe('folder is outside the browsable root');
      expect(await registeredIds()).toEqual([]);
    });
  });

  describe('DELETE /api/v1/projects/:projectId — Settings → Projects remove (step 4.4)', () => {
    const snapshot = (dir: string): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (current: string, prefix: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const child = join(current, entry.name);
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(child, rel);
          else out[rel] = readFileSync(child, 'utf8');
        }
      };
      walk(dir, '');
      return out;
    };

    const del = async (id: string, over: Partial<ServerDeps> = {}) => {
      const res = await apiRequest(makeApp(over), `/api/v1/projects/${id}`, {
        method: 'DELETE',
      });
      return {
        status: res.status,
        body: (await res.json()) as {
          error?: string;
          removed?: boolean;
          id?: string;
          runningTasks?: number;
        },
      };
    };

    it('refuses removal in single-project mode before registry or context side effects', async () => {
      const other = await registerProject(otherRoot);
      process.env.CEZ_SINGLE_PROJECT = '1';

      const { status, body } = await del(other.id);

      expect(status).toBe(409);
      expect(body).toEqual({
        error: 'single-project mode is enabled; removing projects is disabled',
      });
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([
        other.id,
      ]);
    });

    it('deregisters the project, emits project-removed, and leaves every file on disk untouched', async () => {
      mkdirSync(join(otherRoot, '.git'), { recursive: true });
      mkdirSync(join(otherRoot, '.ai/cezar/runs'), { recursive: true });
      writeFileSync(join(otherRoot, 'README.md'), '# keep me\n', 'utf8');
      writeFileSync(join(otherRoot, '.git/HEAD'), 'ref: refs/heads/main\n', 'utf8');
      writeFileSync(join(otherRoot, '.ai/cezar/runs.json'), '[]\n', 'utf8');
      clearProjectProbeCache();
      const other = await registerProject(otherRoot);
      const before = snapshot(otherRoot);

      const bus = new WorkspaceEventBus();
      const seen: { event: string; data: unknown }[] = [];
      bus.on((event, data) => seen.push({ event, data }));
      const { status, body } = await del(other.id, { runtime: testRuntime({ repoRoot, store, workspaceEvents: bus }) });

      expect(status).toBe(200);
      expect(body).toEqual({ removed: true, id: other.id });
      expect((await getProjects()).projects.map((p) => p.id)).not.toContain(other.id);
      expect(snapshot(otherRoot)).toEqual(before);
      expect(seen).toEqual([{ event: 'project-removed', data: { id: other.id } }]);
    });

    it('409s while the project has running tasks, and removes nothing', async () => {
      const other = await registerProject(otherRoot);
      const projects = (await getProjects()).projects;
      expect(projects.some((p) => p.id === other.id)).toBe(true);
      // No running tasks can be seeded through the app without a manager; a
      // removal that finds none must succeed.
      const allowed = await del(other.id);
      expect(allowed.status).toBe(200);
      expect((await getProjects()).projects.map((p) => p.id)).not.toContain(other.id);
    });

    it('404s an unknown id and a malformed one, without touching the registry', async () => {
      const other = await registerProject(otherRoot);
      for (const id of ['nope', 'Not%20A%20Slug', 'a'.repeat(120)]) {
        const { status, body } = await del(id);
        expect(status, id).toBe(404);
        expect(body.error, id).toContain('unknown project');
      }
      expect(await registeredIds()).toEqual([other.id]);
    });
  });

  describe('PATCH /api/v1/projects/:projectId — per-project maxParallel (2026-07-22)', () => {
    const countingSemaphore = () => {
      let refreshes = 0;
      const semaphore = new WorkspaceSemaphore({
        load: () => {
          refreshes += 1;
          return Promise.resolve({ maxParallel: 2, memoryLimitMb: null });
        },
      });
      return { semaphore, refreshes: () => refreshes };
    };

    const patch = async (id: string, body: unknown, over: Partial<ServerDeps> = {}) => {
      const res = await apiRequest(makeApp(over), `/api/v1/projects/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as UpdateProjectResponse & { error?: string },
      };
    };

    it('refuses edits in single-project mode before registry or semaphore side effects', async () => {
      const other = await registerProject(otherRoot);
      const before = readFileSync(workspaceConfigPath(), 'utf8');
      process.env.CEZ_SINGLE_PROJECT = '1';

      const { status, body } = await patch(other.id, { maxParallel: 1 });

      expect(status).toBe(409);
      expect(body).toEqual({
        error: 'single-project mode is enabled; editing projects is disabled',
      });
      expect(readFileSync(workspaceConfigPath(), 'utf8')).toBe(before);
    });

    it('sets the per-project value, persists it, and refreshes the semaphore', async () => {
      const other = await registerProject(otherRoot);
      const { semaphore, refreshes } = countingSemaphore();
      const { status, body } = await patch(other.id, { maxParallel: 1 }, { runtime: testRuntime({ repoRoot, store, semaphore }) });
      expect(status).toBe(200);
      expect(body.project.id).toBe(other.id);
      expect(body.project.maxParallel).toBe(1);
      const listed = await getProjects();
      expect(listed.projects.find((p) => p.id === other.id)?.maxParallel).toBe(1);
      expect(refreshes()).toBe(1);
    });

    it('clears the override when maxParallel is null (back to inherit)', async () => {
      await registerProject(otherRoot);
      await mergeWriteWorkspaceConfig((config) => {
        const entry = config.projects.find((p) => p.root !== realpathSync(repoRoot));
        if (entry) entry.maxParallel = 4;
      });
      const other = (await getProjects()).projects.find((p) => p.root !== realpathSync(repoRoot))!;
      expect(other.maxParallel).toBe(4);

      const { status, body } = await patch(other.id, { maxParallel: null });
      expect(status).toBe(200);
      expect(body.project.maxParallel).toBeUndefined();
      const listed = await getProjects();
      expect(listed.projects.find((p) => p.id === other.id)?.maxParallel).toBeUndefined();
    });

    it('rejects an out-of-range value with a 400 and persists nothing', async () => {
      const other = await registerProject(otherRoot);
      for (const bad of [{ maxParallel: 0 }, { maxParallel: 99 }, { maxParallel: 1.5 }, {}]) {
        const { status } = await patch(other.id, bad);
        expect(status, JSON.stringify(bad)).toBe(400);
      }
      expect((await getProjects()).projects.find((p) => p.id === other.id)?.maxParallel).toBeUndefined();
    });

    it('sets tags, normalized, and leaves maxParallel alone', async () => {
      await registerProject(otherRoot);
      await mergeWriteWorkspaceConfig((config) => {
        const entry = config.projects.find((p) => p.root !== realpathSync(repoRoot));
        if (entry) entry.maxParallel = 3;
      });
      const other = (await getProjects()).projects.find((p) => p.root !== realpathSync(repoRoot))!;

      const { status, body } = await patch(other.id, {
        tags: [' Storefront ', 'api', 'STOREFRONT'],
      });

      expect(status).toBe(200);
      expect(body.project.tags).toEqual(['api', 'Storefront']);
      expect(body.project.maxParallel).toBe(3);
      const listed = await getProjects();
      expect(listed.projects.find((p) => p.id === other.id)?.tags).toEqual(['api', 'Storefront']);
    });

    it('clears tags on null and on [], storing no key at all', async () => {
      const other = await registerProject(otherRoot);
      for (const cleared of [null, []]) {
        await patch(other.id, { tags: ['api'] });
        const { status, body } = await patch(other.id, { tags: cleared });
        expect(status, JSON.stringify(cleared)).toBe(200);
        expect(body.project.tags, JSON.stringify(cleared)).toBeUndefined();
        const raw = JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as {
          projects: { id: string; tags?: unknown }[];
        };
        expect(Object.keys(raw.projects.find((p) => p.id === other.id)!)).not.toContain('tags');
      }
    });

    it('leaves tags alone for a maxParallel-only body (the pre-tags client)', async () => {
      const other = await registerProject(otherRoot);
      await patch(other.id, { tags: ['storefront'] });
      const { status, body } = await patch(other.id, { maxParallel: 2 });
      expect(status).toBe(200);
      expect(body.project.tags).toEqual(['storefront']);
      expect(body.project.maxParallel).toBe(2);
    });

    it('rejects a tag list the registry could not hold, and persists nothing', async () => {
      const other = await registerProject(otherRoot);
      const bodies = [
        { tags: ['x'.repeat(PROJECT_TAG_MAX_LENGTH + 1)] },
        { tags: Array.from({ length: PROJECT_TAGS_MAX + 1 }, (_, i) => `t${i}`) },
        { tags: [''] },
        { tags: 'storefront' },
      ];
      for (const bad of bodies) {
        const { status } = await patch(other.id, bad);
        expect(status, JSON.stringify(bad)).toBe(400);
      }
      expect((await getProjects()).projects.find((p) => p.id === other.id)?.tags).toBeUndefined();
    });

    it('404s an unknown id and a malformed one, and rewrites nothing (read-first, like DELETE)', async () => {
      await registerProject(otherRoot);
      const before = readFileSync(workspaceConfigPath(), 'utf8');
      for (const id of ['nope', 'Not%20A%20Slug', 'a'.repeat(120)]) {
        const { status, body } = await patch(id, { maxParallel: 1 });
        expect(status, id).toBe(404);
        expect(body.error, id).toContain('unknown project');
      }
      expect(readFileSync(workspaceConfigPath(), 'utf8')).toBe(before);
    });
  });

  describe('GET /api/v1/health — additive projects', () => {
    it('enumerates registered projects and drops every deprecated repo field', async () => {
      const boot = await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      const body = await getHealth();
      // The exact key set: no `bootProject`, no `repoRoot`, no `repo`, no `forge`.
      expect(Object.keys(body).sort()).toEqual(
        [
          'capabilities',
          'checks',
          'defaultRunner',
          'projects',
          'version',
        ].sort(),
      );
      expect(body.version).toBe('0.0.0-test');
      expect(Array.isArray(body.checks)).toBe(true);
      expect(body.defaultRunner).toBe('claude');
      expect(body.capabilities).toEqual({
        localHandoff: true,
        followups: false,
        singleProject: false,
        automations: true,
        dispatch: true,
        tokenMetrics: true,
        tokenUsageMetrics: true,
        costMetrics: true,
      });
      expect(body.projects.map((p) => p.id).sort()).toEqual([boot.id, other.id].sort());
    });

    it('health project entries carry id + name ONLY — never root (#431)', async () => {
      await registerProject(repoRoot);
      await registerProject(otherRoot);
      const body = await getHealth();
      expect(body.projects.length).toBeGreaterThan(0);
      for (const entry of body.projects) {
        expect(Object.keys(entry).sort()).toEqual(['id', 'name']);
      }
    });

    it("regression: the health payload never contains another project's absolute root", async () => {
      await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      const raw = JSON.stringify(await getHealth());
      expect(raw).not.toContain(other.root);
      expect(raw).not.toContain(otherRoot);
    });

    it('degrades to projects:[] when nothing is registered', async () => {
      const body = await getHealth();
      expect(body.projects).toEqual([]);
    });
  });
});
