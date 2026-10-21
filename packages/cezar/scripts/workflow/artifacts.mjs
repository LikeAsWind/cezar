import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

export const artifactDirectory = 'docs/superpowers';
export const artifactNames = ['run.json', 'probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json', 'route.json', 'validation-plan.json', 'baseline.json', 'design.md', 'question.md', 'clarification.md', 'ledger.md', 'plan.md', 'execution-input.json', 'execution.json', 'verify.json', 'verified.json', 'branch.diff', 'fix-before.diff'];
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
const localDate = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
function inside(root, path) {
  const rel = relative(realpathSync.native(root), realpathSync.native(path));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Artifact path escapes the worktree');
}

const probeNames = new Set(['run.json', 'probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json', 'route.json']);
function paths(root, prefix) {
  const directory = join(root, artifactDirectory);
  const file = name => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error('Invalid artifact name');
    const category = name === 'design.md' ? 'specs' : name === 'plan.md' ? 'plans' : probeNames.has(name) ? 'probe' : 'logs';
    const target = join(directory, category, `${prefix}-${name}`);
    if (existsSync(dirname(target))) inside(root, dirname(target));
    try { if (lstatSync(target).isSymbolicLink()) throw new Error('Artifact file links are forbidden'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
  };
  return { directory, prefix, topic: prefix.slice(11), date: prefix.slice(0, 10), file, relative: name => relative(root, file(name)).replaceAll('\\', '/') };
}

export function artifactTopic(title = 'task') {
  const text = String(title).split(/\r?\n/)[0].replace(/^(?:\/[\w:-]+\s+)+/, '').replace(/^Work on tracker ticket\s*\[[^\]]+\]\s*:\s*/i, '').replace(/^【[^】]+】\s*/, '');
  return Array.from(text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')).slice(0, 40).join('').replace(/-+$/g, '') || 'task';
}

export function newArtifactPaths(root, runId, date = new Date(), title = 'task') {
  if (!validId(runId) || Number.isNaN(date.getTime())) throw new Error('Invalid artifact identity');
  const topic = artifactTopic(title);
  for (let index = 1; ; index++) {
    const result = paths(root, `${localDate(date)}-${topic}${index === 1 ? '' : `-${index}`}`);
    if (!artifactNames.some(name => existsSync(result.file(name))) && !existsSync(join(result.directory, 'logs', `${result.prefix}-tasks`))) return result;
  }
}

/** Discover this run's persisted prefix; Continue across midnight never renames it. */
export function artifactPaths(root, runId) {
  if (!validId(runId)) throw new Error('Invalid artifact identity');
  const directory = join(root, artifactDirectory);
  const matches = [];
  const probe = join(directory, 'probe');
  if (existsSync(probe)) {
    inside(root, probe);
    for (const name of readdirSync(probe)) {
      if (!/^\d{4}-\d{2}-\d{2}-[\p{L}\p{N}-]+-run\.json$/u.test(name)) continue;
      const path = join(probe, name);
      if (lstatSync(path).isSymbolicLink()) throw new Error('Artifact file links are forbidden');
      let data;
      try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
      if (data.runId === runId) matches.push(name.slice(0, -'-run.json'.length));
    }
  }
  if (matches.length > 1) throw new Error('Multiple artifact identities for the same run');
  if (!matches[0]) throw new Error('Run artifacts have not been initialized');
  const result = paths(root, matches[0]);
  const data = JSON.parse(readFileSync(result.file('run.json'), 'utf8'));
  if (data.runId !== runId || typeof data.root !== 'string' || relative(realpathSync.native(data.root), realpathSync.native(root)) !== '' || data.artifactPrefix !== result.prefix) throw new Error('context belongs to a different run or worktree');
  inside(root, result.directory);
  for (const category of ['probe', 'specs', 'plans', 'logs']) {
    const path = join(result.directory, category);
    if (existsSync(path)) inside(root, path);
  }
  return result;
}

export const artifactPath = (root, runId, name) => artifactPaths(root, runId).file(name);
