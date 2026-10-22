import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

export const artifactDirectory = 'docs/superpowers';
export const artifactNames = ['run.json', 'probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json', 'route.json', 'validation-plan.json', 'baseline.json', 'design.md', 'plan.md', 'execution.json', 'verify.json', 'verified.json', 'branch.diff', 'fix-before.diff'];
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
const localDate = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
function inside(root, path) {
  const rel = relative(realpathSync.native(root), realpathSync.native(path));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Artifact path escapes the worktree');
}

const documentNames = new Set(['probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json', 'design.md', 'plan.md']);
export function runArtifactsDirectory(root, runId, hostDirectory) {
  if (!validId(runId)) throw new Error('Invalid artifact identity');
  if (hostDirectory) return hostDirectory;
  const handoff = process.env.CEZ_HANDOFF_FILE;
  if (handoff && handoff.replaceAll('\\', '/').endsWith(`/runs/${runId}/handoff.md`)) return dirname(handoff);
  return join(root, '.ai/cezar/runs', runId);
}
function paths(root, prefix, runId, hostDirectory) {
  const directory = join(root, artifactDirectory);
  const stateDirectory = runArtifactsDirectory(root, runId, hostDirectory);
  const file = name => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error('Invalid artifact name');
    if (!documentNames.has(name)) return join(stateDirectory, name);
    const category = name === 'design.md' ? 'specs' : name === 'plan.md' ? 'plans' : 'probe';
    const target = join(directory, category, `${prefix}-${name}`);
    if (existsSync(dirname(target))) inside(root, dirname(target));
    try { if (lstatSync(target).isSymbolicLink()) throw new Error('Artifact file links are forbidden'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
  };
  return { directory, stateDirectory, prefix, topic: prefix.slice(11), date: prefix.slice(0, 10), file, relative: name => relative(root, file(name)).replaceAll('\\', '/') };
}

export function artifactTopic(title = 'task') {
  const text = String(title).split(/\r?\n/)[0].replace(/^(?:\/[\w:-]+\s+)+/, '').replace(/^Work on tracker ticket\s*\[[^\]]+\]\s*:\s*/i, '').replace(/^【[^】]+】\s*/, '');
  return Array.from(text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')).slice(0, 40).join('').replace(/-+$/g, '') || 'task';
}

export function newArtifactPaths(root, runId, date = new Date(), title = 'task', hostDirectory) {
  if (!validId(runId) || Number.isNaN(date.getTime())) throw new Error('Invalid artifact identity');
  const topic = artifactTopic(title);
  for (let index = 1; ; index++) {
    const result = paths(root, `${localDate(date)}-${topic}${index === 1 ? '' : `-${index}`}`, runId, hostDirectory);
    if (!existsSync(join(root, '.ai/cezar/artifact-topics', result.prefix)) && ![...documentNames].some(name => existsSync(result.file(name))) && !existsSync(join(result.directory, 'logs', `${result.prefix}-tasks`))) return result;
  }
}

/** Discover this run's persisted prefix; Continue across midnight never renames it. */
export function artifactPaths(root, runId, hostDirectory) {
  const stateDirectory = runArtifactsDirectory(root, runId, hostDirectory);
  const identity = join(stateDirectory, 'run.json');
  if (!existsSync(identity)) throw new Error('Run artifacts have not been initialized');
  const data = JSON.parse(readFileSync(identity, 'utf8'));
  if (data.runId !== runId || typeof data.root !== 'string' || relative(realpathSync.native(data.root), realpathSync.native(root)) !== '' || !/^\d{4}-\d{2}-\d{2}-[\p{L}\p{N}-]+$/u.test(data.artifactPrefix)) throw new Error('context belongs to a different run or worktree');
  for (const category of ['probe', 'specs', 'plans']) {
    const path = join(root, artifactDirectory, category);
    if (existsSync(path)) inside(root, path);
  }
  return paths(root, data.artifactPrefix, runId, stateDirectory);
}

export const artifactPath = (root, runId, name, hostDirectory) => artifactPaths(root, runId, hostDirectory).file(name);
