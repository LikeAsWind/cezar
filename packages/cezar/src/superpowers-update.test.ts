import { describe, it, expect } from 'vitest';
import { BUILTIN_SUPERPOWERS_BUNDLE, ensureBundleSnapshot, verifyBundleSnapshot, SuperpowersUpdateService } from './superpowers-update.ts';
describe('superpowers update', () => {
  it('creates and verifies a complete builtin snapshot without networking', async () => {
    const service = new SuperpowersUpdateService({ fetch: async () => { throw new Error('unexpected network'); } });
    expect((await service.snapshot()).autoCheck).toBe(false);
    const snapshot = await ensureBundleSnapshot(BUILTIN_SUPERPOWERS_BUNDLE);
    await expect(verifyBundleSnapshot(snapshot.root, snapshot.ref.digest)).resolves.toBeUndefined();
  }, 180_000);
});

import { afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let oldHome = process.env.CEZ_HOME;
let homes: string[] = [];
afterEach(async () => { process.env.CEZ_HOME = oldHome; await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function isolated() { const path = await mkdtemp(join(tmpdir(), 'cez-superpowers-')); homes.push(path); process.env.CEZ_HOME = path; return path; }
it('keeps offline checks nonfatal, caches failures and rejects undetected staging', async () => {
  await isolated(); let calls = 0;
  const service = new SuperpowersUpdateService({ fetch: async () => { calls++; throw new Error('offline'); } });
  expect((await service.check()).status).toBe('unavailable');
  await service.check(); expect(calls).toBe(1);
  await expect(service.stage('7.1.0')).rejects.toThrow('detected');
}, 180_000);
it('uses conditional requests and never stages a new major', async () => {
  await isolated(); let calls = 0;
  const service = new SuperpowersUpdateService({ fetch: async (_url, options) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify([{ tag_name: 'v8.0.0', draft: false, prerelease: false }]), { headers: { etag: 'release-tag' } });
    if (calls === 2) return Response.json({ sha: 'a'.repeat(40) });
    expect((options?.headers as Record<string,string>)['If-None-Match']).toBe('release-tag');
    return new Response(null, { status: 304 });
  } });
  expect((await service.check()).latest?.version).toBe('8.0.0');
  await service.check(true); expect(calls).toBe(3);
  await expect(service.stage('8.0.0')).rejects.toThrow('compatible');
}, 180_000);
it('rejects changed snapshot content', async () => {
  await isolated(); const result = await ensureBundleSnapshot();
  await writeFile(join(result.root, 'workflow.json'), 'tampered');
  await expect(verifyBundleSnapshot(result.root, result.ref.digest)).rejects.toThrow('hash');
}, 180_000);
import * as tar from 'tar';
it('stages complete upstream files, requires review, activates and rolls back', async () => {
  const home = await isolated();
  const archive = join(home, 'release.tgz');
  await tar.c({ gzip: true, file: archive, cwd: join(BUILTIN_SUPERPOWERS_BUNDLE, 'vendor') }, ['superpowers']);
  const bytes = await readFile(archive);
  const service = new SuperpowersUpdateService({ fetch: async url => {
    if (String(url).includes('/releases?')) return Response.json([{ tag_name: 'v7.0.1', draft: false, prerelease: false }]);
    if (String(url).includes('/commits/')) return Response.json({ sha: 'b'.repeat(40) });
    return new Response(bytes);
  } });
  const builtin = (await service.snapshot()).current;
  await service.check(); const staged = await service.stage('7.0.1');
  expect(staged.staged?.checks.join(' ')).toContain('Structural validation only');
  const digest = staged.staged!.bundle.digest;
  expect((await service.activate(digest, true)).current.digest).toBe(digest);
  expect((await service.rollback()).current.digest).toBe(builtin.digest);
  expect(await readFile(join(BUILTIN_SUPERPOWERS_BUNDLE, 'provenance.json'), 'utf8')).toContain('7.0.0');
}, 180_000);
it('refuses a concurrent mutation while an official check is running', async () => {
  await isolated(); let entered!: () => void; let finish!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const service = new SuperpowersUpdateService({ fetch: async () => { entered(); await release; return new Response(null, { status: 429 }); } });
  const checking = service.check(); await waiting;
  await expect(service.setAutoCheck(true)).rejects.toThrow('in progress');
  finish(); expect((await checking).status).toBe('unavailable');
}, 180_000);
it('preserves builtin and reports failed archives without activating them', async () => {
  await isolated();
  const service = new SuperpowersUpdateService({ fetch: async url => {
    if (String(url).includes('/releases?')) return Response.json([{ tag_name: 'v7.0.2', draft: false, prerelease: false }]);
    if (String(url).includes('/commits/')) return Response.json({ sha: 'c'.repeat(40) });
    return new Response('invalid tar');
  } });
  const builtin = (await service.snapshot()).current; await service.check();
  await expect(service.stage('7.0.2')).rejects.toThrow();
  const state = await service.snapshot(); expect(state.status).toBe('error'); expect(state.current).toEqual(builtin);
}, 180_000);

it.each(['../escape', 'repo/skills/../../escape', 'repo/skills/file:stream'])('rejects unsafe archive path %s', async path => {
  await isolated();
  const header = new tar.Header({ path, size: 1, mode: 0o644, type: 'File' }); header.encode();
  const body = Buffer.concat([header.block!, Buffer.from('x'), Buffer.alloc(511 + 1024)]);
  const service = new SuperpowersUpdateService({ fetch: async url => {
    if (String(url).includes('/releases?')) return Response.json([{ tag_name: 'v7.0.3', draft: false, prerelease: false }]);
    if (String(url).includes('/commits/')) return Response.json({ sha: 'd'.repeat(40) });
    return new Response(body);
  } });
  await service.check(); await expect(service.stage('7.0.3')).rejects.toThrow('Unsafe archive');
}, 180_000);
it.each(['missing', 'invalid', 'wrong-ref', 'wrong-files'])('rejects %s snapshot manifests', async kind => {
  await isolated(); const result = await ensureBundleSnapshot();
  const path = join(result.root, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (kind === 'missing') await rm(path);
  else if (kind === 'invalid') await writeFile(path, '{');
  else { if (kind === 'wrong-ref') manifest.ref.commit = 'e'.repeat(40); else delete manifest.files['workflow.json']; await writeFile(path, JSON.stringify(manifest)); }
  await expect(verifyBundleSnapshot(result.root, result.ref.digest)).rejects.toThrow();
}, 180_000);
it('rejects archive links without creating filesystem links', async () => {
  await isolated();
  const header = new tar.Header({ path: 'repo/skills/link', linkpath: '../../../escape', size: 0, mode: 0o777, type: 'SymbolicLink' }); header.encode();
  const body = Buffer.concat([header.block!, Buffer.alloc(1024)]);
  const service = new SuperpowersUpdateService({ fetch: async url => {
    if (String(url).includes('/releases?')) return Response.json([{ tag_name: 'v7.0.4', draft: false, prerelease: false }]);
    if (String(url).includes('/commits/')) return Response.json({ sha: 'e'.repeat(40) });
    return new Response(body);
  } });
  await service.check(); await expect(service.stage('7.0.4')).rejects.toThrow('Unsafe archive');
}, 180_000);
it('reports unavailable and clears an orphaned ETag after a 304 without cached latest', async () => {
  const home = await isolated(); const service = new SuperpowersUpdateService({ fetch: async () => new Response(null, { status: 304 }) });
  await service.setAutoCheck(false); await writeFile(join(home, 'superpowers', 'etag'), 'orphan');
  const state = await service.check(true); expect(state.status).toBe('unavailable'); expect(state.latest).toBeNull();
  await expect(readFile(join(home, 'superpowers', 'etag'))).rejects.toThrow();
}, 180_000);
