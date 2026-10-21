import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { TrackerConnections } from './server/tracker/connections.ts';
import {
  trackerAssociationSchema,
  trackerSourceSchema,
  type TrackerAssociation,
  type TrackerKind,
} from '@open-mercato/cezar-contract';

const persistedSchema = trackerAssociationSchema.extend({ source: trackerSourceSchema.passthrough() }).passthrough();

const mutationQueues = new Map<string, Promise<void>>();

async function projectConnection(dataDir: string, store: TrackerConnections) {
  if (basename(dataDir) !== 'cezar' || basename(dirname(dataDir)) !== '.ai') return null;
  const root = dirname(dirname(dataDir));
  const record = await store.read(root);
  return record ? { root, store, record } : null;
}

function associationPath(dataDir: string): string {
  return join(dataDir, 'tracker.json');
}

async function serializeMutation<T>(dataDir: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(dataDir) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  mutationQueues.set(dataDir, tail);
  await previous.catch(() => undefined);
  try {
    return await lockedMutation(dataDir, mutation);
  } finally {
    release();
    if (mutationQueues.get(dataDir) === tail) mutationQueues.delete(dataDir);
  }
}

/** Filesystem lease shared by independent cockpits, including read/merge and clear. */
async function lockedMutation<T>(dataDir: string, mutation: () => Promise<T>): Promise<T> {
  await fs.mkdir(dataDir, { recursive: true });
  const lock = join(dataDir, 'tracker-association.lock');
  const owner = join(lock, String(process.pid));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      try { await fs.writeFile(owner, '', { flag: 'wx', mode: 0o600 }); }
      catch (error) { await fs.rmdir(lock).catch(() => undefined); throw error; }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) throw error;
      const stat = await fs.lstat(lock).catch(() => null);
      if (!stat) continue;
      const owners = await fs.readdir(lock).catch(() => []);
      if (owners.length === 1 && /^[1-9][0-9]*$/.test(owners[0]!)) {
        try { process.kill(Number(owners[0]), 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // Unlink elects one reaper; contenders cannot remove a replacement lease.
            try { await fs.unlink(join(lock, owners[0]!)); await fs.rmdir(lock); } catch {}
          }
        }
      } else if (owners.length === 0 && Date.now() - stat.mtimeMs > 60_000) {
        await fs.rmdir(lock).catch(() => undefined);
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await mutation(); }
  finally {
    // A cleanup failure must not turn a committed replacement into a reported failure.
    await fs.unlink(owner).catch(() => undefined);
    await fs.rmdir(lock).catch(() => undefined);
  }
}

/** Credential-bound selections survive disposable project state; explicit disconnects win. */
export async function readTrackerAssociation(dataDir: string, store = new TrackerConnections()): Promise<TrackerAssociation | null> {
  const connection = await projectConnection(dataDir, store);
  if (connection) {
    const saved = await connection.store.association(connection.root, connection.record.id);
    if (saved !== undefined) return saved;
  }
  try {
    const raw: unknown = JSON.parse(await fs.readFile(associationPath(dataDir), 'utf8'));
    const parsed = trackerAssociationSchema.strip().extend({ source: trackerSourceSchema.strip() }).safeParse(raw);
    if (!parsed.success) return null;
    if (connection && parsed.data.connectionId === connection.record.id && parsed.data.kind === connection.record.credentials.kind) {
      await connection.store.saveAssociation(connection.root, connection.record.id, parsed.data);
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/** Save credential-bound selections outside the checkout; tracker.json remains a local cache. */
export async function writeTrackerAssociation(
  dataDir: string,
  association: TrackerAssociation,
  store = new TrackerConnections(),
): Promise<boolean> {
  const parsed = persistedSchema.safeParse(association);
  if (!parsed.success) return false;
  return serializeMutation(dataDir, async () => {
    const connection = await projectConnection(dataDir, store);
    const bound = connection && parsed.data.connectionId === connection.record.id && parsed.data.kind === connection.record.credentials.kind;
    const saved = bound ? await connection.store.saveAssociation(connection.root, connection.record.id, parsed.data) : false;
    if (bound && !saved) return false;
    const path = associationPath(dataDir);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      const previous = await fs.readFile(path, 'utf8').then(text => persistedSchema.parse(JSON.parse(text))).catch(() => null);
      const merged = { ...previous, ...parsed.data, source: { ...previous?.source, ...parsed.data.source } };
      await fs.writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, path);
      return true;
    } catch {
      await fs.unlink(temporary).catch(() => undefined);
      return saved;
    }
  }).catch(() => false);
}

/** Idempotent removal; missing state is already the requested result. */
export async function clearTrackerAssociation(dataDir: string, store = new TrackerConnections()): Promise<boolean> {
  return serializeMutation(dataDir, async () => {
    const connection = await projectConnection(dataDir, store);
    if (connection && !await connection.store.saveAssociation(connection.root, connection.record.id, null)) return false;
    try {
      await fs.unlink(associationPath(dataDir));
      return true;
    } catch (error) {
      return !!connection || error instanceof Error && 'code' in error && error.code === 'ENOENT';
    }
  }).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT');
}

/** Cheap local classification for project lists; never contacts a provider. */
export async function classifyTracker(dataDir: string): Promise<TrackerKind | undefined> {
  return (await readTrackerAssociation(dataDir))?.kind;
}
