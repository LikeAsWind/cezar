import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RunStore } from './store.ts';
import { runDirectory, runFilePath } from './files.ts';
import { seedHandoffFile } from '../handoff.ts';

it('groups task history, handoff and private state and reopens the same history', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-run-files-'));
  try {
    const store = RunStore.open(root);
    const run = store.createRun({ title: 'Task', task: 'Original request', workflow: 'test', steps: [] });
    const event = store.appendEvent(run.id, { type: 'note', message: 'Saved event' });
    const handoff = seedHandoffFile(root, { ...run, task: 'Original request' });
    expect(handoff).toBe(join(root, 'runs', run.id, 'handoff.md'));
    expect(readFileSync(handoff, 'utf8')).toContain('Original request');
    expect(runFilePath(root, run.id, '.ndjson')).toBe(join(root, 'runs', run.id, 'events.ndjson'));
    writeFileSync(runFilePath(root, run.id, '.unattended.json'), '{}');
    store.flush();
    const reopened = RunStore.open(root, { keepLive: true });
    expect(reopened.readEvents(run.id).some(row => row.seq === event.seq && row.message === 'Saved event')).toBe(true);
    expect(reopened.deleteRun(run.id)).toBe(true);
    reopened.flush();
    expect(existsSync(runDirectory(root, run.id))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('uses only the new layout and rejects traversal identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-run-layout-'));
  try {
    mkdirSync(join(root, 'runs'));
    writeFileSync(join(root, 'runs', 'task.ndjson'), 'legacy');
    expect(runFilePath(root, 'task', '.ndjson')).toBe(join(root, 'runs/task/events.ndjson'));
    expect(() => runDirectory(root, '../outside')).toThrow('Invalid run id');
    expect(() => runFilePath(root, 'task', '/../outside')).toThrow('Invalid run file suffix');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
