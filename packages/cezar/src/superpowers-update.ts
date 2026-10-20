import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, readdirSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import lockfile from 'proper-lockfile';
import { workflowGraphFileSchema, graphIssues } from './workflows/graph.ts';
import { superpowersBundleRefSchema, superpowersUpdateStateSchema, type SuperpowersUpdateState, type SuperpowersBundleRef } from '@open-mercato/cezar-contract';
import { cezarHomeDir, assertCezarHomeWriteIsSandboxed } from './paths.ts';
import { UNATTENDED_TEMPLATE } from './workflows/templates/unattended.ts';

export const BUILTIN_SUPERPOWERS_BUNDLE = fileURLToPath(new URL('./workflows/assets/superpowers/', import.meta.url));
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const base = () => join(cezarHomeDir(), 'superpowers');
const statePath = () => join(base(), 'state.json');
const validDigest = (digest: string) => /^[a-f0-9]{64}$/.test(digest);
const hostTemplate = () => JSON.stringify(UNATTENDED_TEMPLATE, null, 2) + '\n';
const isBuiltinBundle = (root: string) => resolve(root) === resolve(BUILTIN_SUPERPOWERS_BUNDLE);
export function snapshotPath(digest: string): string {
  if (!validDigest(digest)) throw new Error('Invalid bundle digest');
  return join(base(), 'snapshots', digest);
}
export class SuperpowersUpdateConflictError extends Error {}
type Manifest = { ref: SuperpowersBundleRef; files: Record<string, string> };
async function inventory(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir)).sort()) {
      const path = join(dir, entry), name = relative(root, path).replaceAll('\\', '/');
      if (!name.includes('/') && !['workflow.json', 'workflow.yaml', 'runtime.mjs', 'artifacts.mjs', 'context.md', 'provenance.json', 'skills', 'vendor', 'LICENSE'].includes(name)) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Links are forbidden: ${name}`);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) files[name] = hash(await readFile(path));
      else throw new Error(`Unsupported bundle entry: ${name}`);
    }
  }
  await walk(root);
  if (isBuiltinBundle(root)) files['workflow.json'] = hash(hostTemplate());
  return files;
}
const digestFiles = (files: Record<string, string>) => hash(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))));
async function reference(root: string, files: Record<string, string>): Promise<SuperpowersBundleRef> {
  const provenance = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8')) as { sources: { version: string; commit: string }[] };
  const source = provenance.sources[0];
  if (!source || !/^\d+\.\d+\.\d+$/.test(source.version) || !/^[a-f0-9]{40}$/.test(source.commit)) throw new Error('Invalid provenance');
  return { version: source.version, commit: source.commit, digest: digestFiles(files) };
}
function validateManifest(value: unknown, files: Record<string, string>, ref: SuperpowersBundleRef, digest: string): void {
  const manifest = value as Manifest;
  const parsed = superpowersBundleRefSchema.parse(manifest?.ref);
  if (!validDigest(digest) || ref.digest !== digest || parsed.digest !== digest || parsed.version !== ref.version || parsed.commit !== ref.commit || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || digestFiles(manifest.files) !== digest || JSON.stringify(Object.entries(manifest.files).sort()) !== JSON.stringify(Object.entries(files).sort())) throw new Error('Bundle manifest or content hash mismatch');
}
export async function verifyBundleSnapshot(root: string, digest: string): Promise<void> {
  const files = await inventory(root);
  if ((await lstat(join(root, 'manifest.json'))).isSymbolicLink()) throw new Error('Manifest links are forbidden');
  validateManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), files, await reference(root, files), digest);
}
export async function ensureBundleSnapshot(root = resolveSuperpowersBundle(), options: { hostWorkflow?: boolean } = {}): Promise<{ root: string; ref: SuperpowersBundleRef }> {
  const files = await inventory(root);
  if (options.hostWorkflow) {
    for (const name of Object.keys(files)) {
      if (['workflow.yaml', 'runtime.mjs', 'artifacts.mjs'].includes(name) || name.startsWith('vendor/runtime/')) delete files[name];
    }
    files['workflow.json'] = hash(hostTemplate());
  }
  const ref = await reference(root, files), destination = snapshotPath(ref.digest);
  assertCezarHomeWriteIsSandboxed(destination);
  try { await verifyBundleSnapshot(destination, ref.digest); return { root: destination, ref }; } catch { /* create or repair below */ }
  const temp = join(base(), `snapshot-${randomUUID()}`);
  await mkdir(temp, { recursive: true });
  try {
    for (const name of Object.keys(files)) {
      await mkdir(join(temp, name, '..'), { recursive: true });
      if (name === 'workflow.json' && (isBuiltinBundle(root) || options.hostWorkflow)) await writeFile(join(temp, name), hostTemplate());
      else await cp(join(root, name), join(temp, name));
    }
    await writeFile(join(temp, 'manifest.json'), JSON.stringify({ ref, files } satisfies Manifest));
    await verifyBundleSnapshot(temp, ref.digest);
    await mkdir(join(base(), 'snapshots'), { recursive: true });
    try { await rename(temp, destination); } catch (error) { await verifyBundleSnapshot(destination, ref.digest).catch(() => { throw error; }); }
    return { root: destination, ref };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export function resolveSuperpowersBundle(): string {
  try {
    const state = superpowersUpdateStateSchema.parse(JSON.parse(readFileSync(statePath(), 'utf8')));
    const root = snapshotPath(state.current.digest);
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry), name = relative(root, path).replaceAll('\\', '/');
        if (!name.includes('/') && !['workflow.json', 'workflow.yaml', 'runtime.mjs', 'artifacts.mjs', 'context.md', 'provenance.json', 'skills', 'vendor', 'LICENSE'].includes(name)) continue;
        const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error('Snapshot links are forbidden');
        if (stat.isDirectory()) walk(path); else if (stat.isFile()) files[name] = hash(readFileSync(path)); else throw new Error('Unsupported snapshot entry');
      }
    };
    walk(root);
    if (lstatSync(join(root, 'manifest.json')).isSymbolicLink()) throw new Error('Manifest links are forbidden');
    const source = JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8')).sources[0] as { version: string; commit: string };
    const ref = superpowersBundleRefSchema.parse({ version: source.version, commit: source.commit, digest: digestFiles(files) });
    validateManifest(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')), files, ref, state.current.digest);
    return root;
  } catch { return BUILTIN_SUPERPOWERS_BUNDLE; }
}

type Dependencies = { fetch?: typeof globalThis.fetch; now?: () => number };
export class SuperpowersUpdateService {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  constructor(dependencies: Dependencies = {}) { this.fetcher = dependencies.fetch ?? globalThis.fetch; this.now = dependencies.now ?? Date.now; }
  private async save(state: SuperpowersUpdateState): Promise<void> {
    const path = statePath(); assertCezarHomeWriteIsSandboxed(path); await mkdir(base(), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, path);
  }
  async snapshot(): Promise<SuperpowersUpdateState> {
    const current = await reference(BUILTIN_SUPERPOWERS_BUNDLE, await inventory(BUILTIN_SUPERPOWERS_BUNDLE));
    try {
      const state = superpowersUpdateStateSchema.parse(JSON.parse(await readFile(statePath(), 'utf8')));
      if (state.current.digest !== current.digest) {
        try { await verifyBundleSnapshot(snapshotPath(state.current.digest), state.current.digest); }
        catch { state.current = current; state.status = 'unavailable'; state.reason = 'Active snapshot unavailable; using packaged builtin bundle.'; }
      }
      return state;
    } catch { return { status: 'idle', current, previous: null, latest: null, staged: null, checkedAt: null, autoCheck: false, reason: 'Using packaged builtin bundle; update state absent or invalid.' }; }
  }
  private async locked(action: () => Promise<SuperpowersUpdateState>): Promise<SuperpowersUpdateState> {
    assertCezarHomeWriteIsSandboxed(base()); await mkdir(base(), { recursive: true });
    let release: () => Promise<void>;
    try { release = await lockfile.lock(base(), { realpath: false, retries: 0, stale: 60_000 }); } catch { throw new SuperpowersUpdateConflictError('Another Superpowers update is in progress'); }
    try { return await action(); } finally { await release(); }
  }
  private request(url: string, headers?: Record<string, string>): Promise<Response> {
    if (!/^https:\/\/(?:api\.github\.com\/repos\/obra\/superpowers\/|codeload\.github\.com\/obra\/superpowers\/)/.test(url)) throw new Error('Unofficial source');
    return this.fetcher(url, { headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  }
  async check(force = false): Promise<SuperpowersUpdateState> {
    return this.locked(async () => {
      const state = await this.snapshot();
      if (!force && state.checkedAt && this.now() - Date.parse(state.checkedAt) < 6 * 60 * 60 * 1000) return state;
      try {
        let etag = ''; try { etag = await readFile(join(base(), 'etag'), 'utf8'); } catch { /* no cache */ }
        const response = await this.request('https://api.github.com/repos/obra/superpowers/releases?per_page=100', etag ? { 'If-None-Match': etag } : {});
        if (response.status !== 304) {
          if (!response.ok) throw new Error(`GitHub check unavailable (${response.status})`);
          const releases = await response.json() as { tag_name: string; draft: boolean; prerelease: boolean }[];
          const latest = releases.filter(r => !r.draft && !r.prerelease && /^v?\d+\.\d+\.\d+$/.test(r.tag_name)).sort((a, b) => {
            const aa = a.tag_name.replace(/^v/, '').split('.').map(Number), bb = b.tag_name.replace(/^v/, '').split('.').map(Number);
            return (bb[0]! - aa[0]!) || (bb[1]! - aa[1]!) || (bb[2]! - aa[2]!);
          })[0];
          if (!latest) throw new Error('No stable official release found');
          const commitResponse = await this.request(`https://api.github.com/repos/obra/superpowers/commits/${encodeURIComponent(latest.tag_name)}`);
          if (!commitResponse.ok) throw new Error('Cannot resolve official release commit');
          const commit = (await commitResponse.json() as { sha: string }).sha;
          if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release commit');
          state.latest = { version: latest.tag_name.replace(/^v/, ''), tag: latest.tag_name, commit, url: `https://github.com/obra/superpowers/tree/${commit}` };
          if (response.headers.get('etag')) await writeFile(join(base(), 'etag'), response.headers.get('etag')!);
        }
        if (!state.latest) { await rm(join(base(), 'etag'), { force: true }); throw new Error('Conditional response has no cached release; retry a fresh check'); }
        const latestVersion = state.latest.version.split('.').map(Number), currentVersion = state.current.version.split('.').map(Number);
        const newer = latestVersion.findIndex((value, index) => value !== currentVersion[index]);
        state.checkedAt = new Date(this.now()).toISOString(); state.status = newer >= 0 && latestVersion[newer]! > currentVersion[newer]! ? 'available' : 'current'; delete state.reason;
      } catch (error) { state.status = 'unavailable'; state.checkedAt = new Date(this.now()).toISOString(); state.reason = String(error); }
      await this.save(state); return state;
    });
  }
  async stage(version: string): Promise<SuperpowersUpdateState> {
    return this.locked(async () => {
      const state = await this.snapshot(), latest = state.latest;
      if (!latest || latest.version !== version || !/^7\.\d+\.\d+$/.test(version)) throw new SuperpowersUpdateConflictError('Only the detected compatible v7 release can be staged');
      const temp = join(base(), `stage-${randomUUID()}`); await mkdir(temp, { recursive: true });
      try {
        const response = await this.request(`https://codeload.github.com/obra/superpowers/tar.gz/${latest.commit}`);
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const chunks: Buffer[] = []; let bytes = 0;
        if (!response.body) throw new Error('Empty archive response');
        for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('Archive exceeds download limit'); } chunks.push(Buffer.from(chunk)); }
        const archive = join(temp, 'source.tar.gz'); await writeFile(archive, Buffer.concat(chunks));
        const extracted = join(temp, 'source'); await mkdir(extracted);
        let unsafe = false, entries = 0, unpacked = 0;
        const parser = new tar.Parser({ strict: true, onReadEntry: entry => {
          entries++; unpacked += entry.size;
          const parts = entry.path.replaceAll('\\', '/').split('/');
          unsafe = entries > 10_000 || unpacked > 128 * 1024 * 1024 || entry.path.includes('\\') || entry.path.includes(':') || parts.includes('..') || entry.path.startsWith('/') || !['File', 'Directory'].includes(entry.type);
          if (unsafe) parser.abort(new Error('Unsafe archive entry'));
          else entry.resume();
        } });
        await pipeline(createReadStream(archive), parser);
        await tar.x({ file: archive, cwd: extracted, strip: 1, strict: true });
        const root = join(temp, 'bundle'); await cp(BUILTIN_SUPERPOWERS_BUNDLE, root, { recursive: true });
        await writeFile(join(root, 'workflow.json'), hostTemplate());
        await rm(join(root, 'vendor', 'superpowers'), { recursive: true, force: true });
        await mkdir(join(root, 'vendor', 'superpowers'), { recursive: true });
        await cp(join(extracted, 'skills'), join(root, 'vendor', 'superpowers', 'skills'), { recursive: true });
        await cp(join(extracted, 'LICENSE'), join(root, 'vendor', 'superpowers', 'LICENSE'));
        const old = await inventory(resolveSuperpowersBundle()), files = await inventory(root);
        const required = await inventory(BUILTIN_SUPERPOWERS_BUNDLE);
        // Every vendored role/template/helper used by the shipped workflow must remain available.
        for (const name of Object.keys(required).filter(name => name.startsWith('vendor/'))) if (!(name in files)) throw new Error(`Required upstream file missing: ${name}`);
        const workflow = workflowGraphFileSchema.parse(JSON.parse(await readFile(join(root, 'workflow.json'), 'utf8')));
        const issues = graphIssues(workflow); if (issues.length) throw new Error('Invalid workflow graph: ' + issues.join('; '));
        await writeFile(join(root, 'provenance.json'), JSON.stringify({ schemaVersion: 1, sources: [{ name: 'superpowers', version, commit: latest.commit, url: latest.url, license: 'MIT', source: 'official release archive, byte-identical skills directory' }], files: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('vendor/'))) }, null, 2));
        const snapshot = await ensureBundleSnapshot(root), final = await inventory(root);
        state.staged = { bundle: snapshot.ref, added: Object.keys(final).filter(n => !(n in old)), changed: Object.keys(final).filter(n => n in old && old[n] !== final[n]), removed: Object.keys(old).filter(n => !(n in final)), checks: ['Complete content hashes verified', 'Required roles, templates and helpers present', 'Workflow graph structurally valid', 'Upstream files copied verbatim; no scripts executed', 'Structural validation only; behavior has not been validated'] };
        state.status = 'ready'; delete state.reason; await this.save(state); return state;
      } catch (error) { state.status = 'error'; state.reason = String(error); await this.save(state); throw error; }
      finally { await rm(temp, { recursive: true, force: true }); }
    });
  }
  async activate(digest: string, reviewed: true): Promise<SuperpowersUpdateState> {
    return this.locked(async () => {
      const state = await this.snapshot();
      if (reviewed !== true || state.staged?.bundle.digest !== digest) throw new SuperpowersUpdateConflictError('Review the staged bundle before activation');
      await verifyBundleSnapshot(snapshotPath(digest), digest);
      await ensureBundleSnapshot(BUILTIN_SUPERPOWERS_BUNDLE);
      await verifyBundleSnapshot(snapshotPath(state.current.digest), state.current.digest);
      state.previous = state.current; state.current = state.staged.bundle; state.staged = null; state.status = 'current'; await this.save(state); return state;
    });
  }
  async rollback(): Promise<SuperpowersUpdateState> {
    return this.locked(async () => {
      const state = await this.snapshot(); if (!state.previous) throw new SuperpowersUpdateConflictError('No previous bundle');
      await verifyBundleSnapshot(snapshotPath(state.previous.digest), state.previous.digest);
      [state.current, state.previous] = [state.previous, state.current]; state.status = 'current'; await this.save(state); return state;
    });
  }
  async setAutoCheck(enabled: boolean): Promise<SuperpowersUpdateState> { return this.locked(async () => { const state = await this.snapshot(); state.autoCheck = enabled; await this.save(state); return state; }); }
  start(): () => void {
    const tick = async () => { try { if ((await this.snapshot()).autoCheck) await this.check(); } catch { /* boot remains available */ } };
    void tick(); const timer = setInterval(() => { void tick(); }, 6 * 60 * 60 * 1000); timer.unref(); return () => clearInterval(timer);
  }
}
