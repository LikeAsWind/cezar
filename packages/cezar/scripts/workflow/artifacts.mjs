import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

export const artifactDirectory = 'docs/superpowers';
export const artifactNames = ['run.json', 'request.md', 'probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json', 'route.json', 'validation-plan.json', 'environment-baseline.json', 'baseline.json', 'design.md', 'builder-review.md', 'question.md', 'clarification.md', 'ledger.md', 'plan.md', 'execution-input.json', 'execution.json', 'implementation.md', 'environment-verify.json', 'verify.json', 'verified.json', 'branch.diff', 'review.md', 'fix-before.diff', 'delivery.md', 'blocked.md', 'resume-message.md', 'last-failure.txt'];
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
const localDate = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
function inside(root, path) {
  const rel = relative(realpathSync.native(root), realpathSync.native(path));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Artifact path escapes the worktree');
}

const probeNames = new Set(['run.json', 'request.md', 'probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json', 'route.json']);
function paths(root, prefix, legacy = false, categorizedProbe = false) {
  const directory = join(root, legacy ? '.superpowers/probe' : artifactDirectory);
  const file = name => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error('Invalid artifact name');
    const category = name === 'design.md' ? 'specs' : name === 'plan.md' ? 'plans' : categorizedProbe && probeNames.has(name) ? 'probe' : '';
    const target = legacy ? join(directory, name) : join(directory, category, `${prefix}-${name}`);
    if (existsSync(dirname(target))) inside(root, dirname(target));
    try { if (lstatSync(target).isSymbolicLink()) throw new Error('Artifact file links are forbidden'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
  };
  return { directory, prefix, legacy, file, relative: name => relative(root, file(name)).replaceAll('\\', '/') };
}

export function newArtifactPaths(root, runId, date = new Date()) {
  if (!validId(runId) || Number.isNaN(date.getTime())) throw new Error('Invalid artifact identity');
  return paths(root, `${localDate(date)}-${runId}`, false, true);
}

/** Discover this run's persisted prefix; Continue across midnight never renames it. */
export function artifactPaths(root, runId) {
  if (!validId(runId)) throw new Error('Invalid artifact identity');
  const directory = join(root, artifactDirectory);
  const matches = [];
  for (const category of ['', 'probe']) {
    const dir = join(directory, category);
    if (!existsSync(dir)) continue;
    inside(root, dir);
    for (const name of readdirSync(dir)) if (new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${runId}-run\\.json$`).test(name)) matches.push({ name, category });
  }
  if (matches.length > 1) throw new Error('Multiple artifact identities for the same run');
  let result;
  if (matches[0]) result = paths(root, matches[0].name.slice(0, -'-run.json'.length), false, matches[0].category === 'probe');
  else if (existsSync(join(root, '.superpowers/probe/run.json'))) result = paths(root, '', true);
  else throw new Error('Run artifacts have not been initialized');
  const data = JSON.parse(readFileSync(result.file('run.json'), 'utf8'));
  if (data.runId !== runId || typeof data.root !== 'string' || relative(realpathSync.native(data.root), realpathSync.native(root)) !== '' || !result.legacy && data.artifactPrefix !== result.prefix) throw new Error('context belongs to a different run or worktree');
  inside(root, result.directory);
  if (!result.legacy) for (const category of ['probe', 'specs', 'plans']) {
    const path = join(result.directory, category);
    if (existsSync(path)) inside(root, path);
  }
  return result;
}

export const artifactPath = (root, runId, name) => artifactPaths(root, runId).file(name);
