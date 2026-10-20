import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { testRuntime } from './runtime.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * GitLab automation capability enforcement (spec 2026-10-16-gitlab-forge-parity): the three GitHub
 * review triggers must be rejected at create/update/enable/check on a GitLab project, while the
 * same definitions still pass on a GitHub project and saved definitions stay readable.
 */
describe('automation API — GitLab review triggers are unsupported', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cezar-automation-gitlab-'));
    home = mkdtempSync(join(tmpdir(), 'cezar-automation-gitlab-home-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_AUTOMATIONS = '1';
    // A real git repo whose only remote is gitlab.com, so resolveProjectForge classifies it gitlab.
    await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    await run('git', ['remote', 'add', 'origin', 'git@gitlab.com:group/sub/project.git'], { cwd: root });
    writeFileSync(join(root, 'readme.md'), 'x');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'init'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.CEZ_HOME;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
  });

  const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reviewPoll = { name: 'Review PRs', events: ['pull_request.reviewed'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}' } };

  it('the automations list reports providerCapabilities.provider=gitlab (a warmed self-managed host)', async () => {
    // A glab config that maps an SSH alias to a self-managed instance; classification relies on
    // the warmed host metadata, not gitlab.com hard-coding.
    const glabDir = mkdtempSync(join(tmpdir(), 'cezar-automation-glab-'));
    writeFileSync(join(glabDir, 'config.yml'), 'hosts:\n  code.example.net:\n    ssh_host: ssh.example.net\n');
    await run('git', ['remote', 'set-url', 'origin', 'git@ssh.example.net:group/sub/project.git'], { cwd: root });
    const savedGlab = process.env.GLAB_CONFIG_DIR;
    process.env.GLAB_CONFIG_DIR = glabDir;
    try {
      const app = createApp({ runtime: testRuntime({ repoRoot: root, store, manager: {} as RunManager }), version: 'test' });
      const response = await apiRequest(app, '/api/v1/p/boot/automations');
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).providerCapabilities.provider).toBe('gitlab');
    } finally {
      rmSync(glabDir, { recursive: true, force: true });
      if (savedGlab === undefined) delete process.env.GLAB_CONFIG_DIR;
      else process.env.GLAB_CONFIG_DIR = savedGlab;
    }
  });

  it.each(['pull_request.reviewed', 'pull_request.review_requested', 'pull_request.rereview_requested'])(
    'rejects %s at create on a GitLab project',
    async (event) => {
      const app = createApp({ runtime: testRuntime({ repoRoot: root, store, manager: {} as RunManager }), version: 'test' });
      const response = await apiRequest(app, '/api/v1/p/boot/automations', json({ ...reviewPoll, events: [event] }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error).toContain(`${event} is unsupported`);
    },
  );

  it('accepts pull_request.approval_observed on a GitLab project', async () => {
    const app = createApp({ runtime: testRuntime({ repoRoot: root, store, manager: {} as RunManager }), version: 'test' });
    const response = await apiRequest(app, '/api/v1/p/boot/automations', json({ ...reviewPoll, events: ['pull_request.approval_observed'] }));
    expect(response.status).toBe(201);
  });

  it('re-baselines an edited enabled GitLab definition while retaining approval identities', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const definition = automationStore.create({ ...reviewPoll, enabled: true, events: ['pull_request.approval_observed'] }, 'edited');
    automationStore.setState(definition.id, () => ({ approvalBaseline: { retained: '2026-10-15T00:00:00Z' }, approvalBaselineAt: '2026-10-15T00:00:00Z' }));
    const app = createApp({ runtime: testRuntime({ repoRoot: root, store, manager: {} as RunManager, automationStore }), version: 'test' });
    const response = await apiRequest(app, '/api/v1/p/boot/automations/edited', json({ ...reviewPoll, enabled: true, expectedRevision: definition.revision, events: ['pull_request.approval_observed'], name: 'Edited' }, 'PUT'));
    expect(response.status).toBe(200);
    expect(automationStore.state('edited')?.approvalBaselineAt).toBeUndefined();
    expect(automationStore.state('edited')?.approvalBaseline).toEqual({ retained: '2026-10-15T00:00:00Z' });
  });

  it.each(['same', 'project-changed', 'host-changed', 'unsupported'] as const)('retries GitLab receipts only on their original supported source (%s)', async scenario => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const definition = automationStore.create({ ...reviewPoll, events: [scenario === 'unsupported' ? 'pull_request.reviewed' : 'pull_request.approval_observed'], task: { prompt: 'p', checkout: 'pr-head', steps: [{ id: 'check', name: 'Check', command: 'git status' }] } }, 'retry-mr');
    const candidate = { eventId: 'gitlab.com:group/sub/project:42:r:2026-10-16T10:00:00Z',
      event: scenario === 'unsupported' ? 'pull_request.reviewed' as const : 'pull_request.approval_observed' as const,
      timestamp: '2026-10-16T10:00:00Z', tieBreaker: 'r', repo: 'group/sub/project', nodeId: 'group/sub/project:42',
      number: 42, title: 'MR', url: 'https://gitlab.com/group/sub/project/-/merge_requests/42', author: 'a', assignees: [], labels: [] };
    const receipt = automationStore.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId: candidate.eventId, candidate })!;
    automationStore.appendReceipt({ ...receipt, status: 'launch-error', error: 'temporary read failure' });
    if (scenario === 'project-changed') await run('git', ['remote', 'set-url', 'origin', 'git@gitlab.com:other/project.git'], { cwd: root });
    if (scenario === 'host-changed') candidate.url = 'https://other.example/group/sub/project/-/merge_requests/42';
    if (scenario === 'host-changed') automationStore.appendReceipt({ ...receipt, candidate, status: 'launch-error' });
    let started = false;
    const manager = { startRun: () => { started = true; return store.createRun({ title: 'retry', workflow: 'w', task: 'x', steps: [] }); } } as unknown as RunManager;
    const app = createApp({ runtime: testRuntime({ repoRoot: root, store, manager, automationStore }), version: 'test' });
    vi.stubEnv('CEZ_DRY_RUN', '1');
    try {
      const response = await apiRequest(app, `/api/v1/p/boot/automation-log/${receipt.receiptId}/retry`, { method: 'POST' });
      expect(response.status).toBe(scenario === 'same' ? 202 : 409);
      expect(started).toBe(scenario === 'same');
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects a review trigger at update, enable and check, and keeps a saved definition readable', async () => {
    // Seed a saved definition selecting a review trigger (as a GitHub-era file might carry).
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const seeded = automationStore.create({ name: 'Saved', events: ['pull_request.reviewed'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'p' } }, 'saved-review');
    const app = createApp({ runtime: testRuntime({ repoRoot: root, store, manager: {} as RunManager, automationStore }), version: 'test' });

    // Readable, never silently another trigger.
    const detail = await apiRequest(app, '/api/v1/p/boot/automations/saved-review');
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as any).automation.events).toEqual(['pull_request.reviewed']);

    // Update to (still) a review trigger is refused.
    const update = await apiRequest(app, '/api/v1/p/boot/automations/saved-review', json({ ...reviewPoll, expectedRevision: seeded.revision }, 'PUT'));
    expect(update.status).toBe(400);

    // Enable is refused.
    const enable = await apiRequest(app, '/api/v1/p/boot/automations/saved-review/enable', { method: 'POST' });
    expect(enable.status).toBe(400);

    // Check (preview) is refused.
    const check = await apiRequest(app, '/api/v1/p/boot/automations/saved-review/check', json({ mode: 'preview' }));
    expect(check.status).toBe(400);
  });
});

describe('automation API — GitHub review triggers still pass', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cezar-automation-github-'));
    home = mkdtempSync(join(tmpdir(), 'cezar-automation-github-home-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_AUTOMATIONS = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/project.git'], { cwd: root });
    writeFileSync(join(root, 'readme.md'), 'x');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'init'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.CEZ_HOME;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
  });

  const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('accepts the review triggers and rejects approval_observed', async () => {
    const app = createApp({ runtime: testRuntime({ repoRoot: root, store, manager: {} as RunManager }), version: 'test' });
    const review = await apiRequest(app, '/api/v1/p/boot/automations', json({ name: 'Review', events: ['pull_request.reviewed'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'p' } }));
    expect(review.status).toBe(201);
    const approval = await apiRequest(app, '/api/v1/p/boot/automations', json({ name: 'Approval', events: ['pull_request.approval_observed'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'p' } }));
    expect(approval.status).toBe(400);
  });

  it('preserves GitHub retry identity across canonical capitalization and a trailing slash', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const definition = automationStore.create({ name: 'GitHub retry', events: ['issue.opened'], task: { prompt: 'p', steps: [{ id: 'check', name: 'Check', command: 'git status' }] } }, 'retry-gh');
    const candidate = { eventId: 'gh-event', event: 'issue.opened' as const, timestamp: '2026-10-16T10:00:00Z', tieBreaker: 'i', repo: 'Acme/Project', nodeId: 'I', number: 7,
      title: 'Issue', url: 'https://github.com/Acme/Project/issues/7/', author: 'a', assignees: [], labels: [] };
    const receipt = automationStore.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId: candidate.eventId, candidate })!;
    automationStore.appendReceipt({ ...receipt, status: 'launch-error' });
    const manager = { startRun: () => store.createRun({ title: 'retry', workflow: 'w', task: 'x', steps: [] }) } as unknown as RunManager;
    const app = createApp({ runtime: testRuntime({ repoRoot: root, store, manager, automationStore }), version: 'test' });
    const response = await apiRequest(app, `/api/v1/p/boot/automation-log/${receipt.receiptId}/retry`, { method: 'POST' });
    expect(response.status).toBe(202);
  });
});
