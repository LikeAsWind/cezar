import { join } from 'node:path';

const names: Record<string, string> = {
  '.ndjson': 'events.ndjson', '.handoff.md': 'handoff.md',
  '.superpowers.json': 'superpowers.json', '.unattended.json': 'unattended.json',
  '.unattended-question.json': 'unattended-question.json', '-images': 'images',
};

export function runDirectory(dataDir: string, runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run id');
  return join(dataDir, 'runs', runId);
}

/** Every task owns one directory, shared by all state readers and writers. */
export function runFilePath(dataDir: string, runId: string, suffix: string): string {
  const name = names[suffix];
  if (!name) throw new Error('Invalid run file suffix');
  return join(runDirectory(dataDir, runId), name);
}
