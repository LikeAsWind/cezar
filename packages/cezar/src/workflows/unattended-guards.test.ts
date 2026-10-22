import { runFilePath } from '../runs/files.ts';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { snapshotPath } from '../superpowers-update.ts';
import { guardUnattendedCheck, guardUnattendedVerdict } from './unattended-guards.ts';
import { newArtifactPaths } from '../../scripts/workflow/artifacts.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cez-unattended-guard-')); roots.push(root);
  const data = join(root, 'host'), cwd = join(root, 'worktree'), runId = 'test-run';
  const paths = newArtifactPaths(cwd, runId, new Date(), 'task', join(data, 'runs', runId));
  await mkdir(join(data, 'runs', runId), { recursive: true }); await mkdir(join(paths.directory, 'specs'), { recursive: true }); await mkdir(join(paths.directory, 'plans'), { recursive: true });
  await writeFile(runFilePath(data, runId, '.handoff.md'), '# Handoff\n\n## Goal\nOriginal task\n\n## Progress log\n');
  await mkdir(join(paths.directory, 'probe'), { recursive: true });
    await mkdir(join(paths.directory, 'logs'), { recursive: true });
  await mkdir(dirname(paths.file('run.json')), { recursive: true }); await writeFile(paths.file('run.json'), JSON.stringify({ runId, root: await realpath(cwd), artifactPrefix: paths.prefix }));
  await writeFile(runFilePath(data, runId, '.superpowers.json'), JSON.stringify({ schemaVersion: 1, ref: { version: '7.0.0', commit: 'b'.repeat(40), digest: 'a'.repeat(64) } }));
  const command = (action: string) => `'${process.execPath.replaceAll('\\', '/')}' '${snapshotPath('a'.repeat(64)).replaceAll('\\', '/')}/runtime.mjs' ${action}`;
  const path = paths.file;
  return { root, data, cwd, runId, command, path, guard: (action: string, phase: 'before' | 'after') => guardUnattendedCheck(data, runId, cwd, command(action), phase) };
}

it('keeps a host-owned validation plan and rejects changes before verification', async () => {
  const f = await fixture(); await writeFile(f.path('validation-plan.json'), '{"verify":["test"]}');
  await f.guard('baseline', 'after'); await expect(f.guard('verify', 'before')).resolves.toBeUndefined();
  await writeFile(f.path('validation-plan.json'), '{"verify":["skip"]}');
  await expect(f.guard('verify', 'before')).rejects.toThrow('validation plan');
});
it('does not trust an existing worktree plan when the private record is absent', async () => {
  const f = await fixture(); await writeFile(f.path('validation-plan.json'), '{}');
  await expect(f.guard('verify', 'before')).rejects.toThrow('baseline');
});
it('binds the verified receipt and plan through sealing', async () => {
  const f = await fixture(); await writeFile(f.path('validation-plan.json'), '{}'); await f.guard('baseline', 'after');
  await writeFile(f.path('verified.json'), '{"diffHash":"original"}'); await f.guard('verify', 'after');
  await expect(f.guard('seal', 'before')).resolves.toBeUndefined();
  await writeFile(f.path('verified.json'), '{"diffHash":"changed"}');
  await expect(f.guard('seal', 'before')).rejects.toThrow('verification receipt');
});
it('does not silently rebaseline an altered plan or affect unrelated commands', async () => {
  const f = await fixture(); await writeFile(f.path('validation-plan.json'), '{}'); await f.guard('baseline', 'after');
  await writeFile(f.path('validation-plan.json'), '{"changed":true}');
  await expect(f.guard('baseline', 'after')).rejects.toThrow('validation plan');
  await expect(guardUnattendedCheck(f.data, f.runId, f.cwd, 'npm test', 'before')).resolves.toBeUndefined();
  expect(await readFile(runFilePath(f.data, f.runId, '.unattended.json'), 'utf8')).not.toContain('changed');
});

it('requires real stage artifacts before accepting success', async () => {
  const f = await fixture();
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'design', 'ready')).rejects.toThrow();
  await writeFile(f.path('design.md'), '# Design\nExisting request and evidence.'); await writeFile(f.path('ledger.md'), '# Work ledger');
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'design', 'ready')).resolves.toBeUndefined();
});

it('preserves artifact and question contracts when agent nodes are renamed', async () => {
  const f = await fixture();
  const graph = { nodes: [
    { id: 'discover', type: 'agent' as const, skill: 'cezar:project-probe', verdicts: ['ready', 'blocked'] },
    { id: 'clarify', type: 'agent' as const, skill: 'superpowers:brainstorming', verdicts: ['ready', 'question'] },
    { id: 'judge', type: 'agent' as const, skill: 'cezar:adjudicator', verdicts: ['answered'] },
  ], edges: [{ from: 'judge.answered', to: 'clarify' }] };
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'discover', 'ready', false, graph)).rejects.toThrow();
  const question = '# Q-004\norigin: clarify\nWhich matching rule?';
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'clarify', 'question', false, graph, question)).resolves.toBeUndefined();
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'judge', 'answered', false, graph)).rejects.toThrow();
  const answer = '# Q-004\norigin: clarify\nanswered: exact matching, verified against the request';
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'judge', 'answered', false, graph, answer)).resolves.toBeUndefined();
});
it('rejects an incomplete context map rather than trusting probe ready', async () => {
  const f = await fixture();
  for (const file of ['probe.md']) await writeFile(f.path(file), '# Requirement evidence');
  for (const file of ['environment.json','routing-input.json']) await writeFile(f.path(file), '{}');
  await writeFile(f.path('context-map.jsonl'), JSON.stringify({ path: 'invented' }));
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'probe', 'ready')).rejects.toThrow();
});
it('requires context-map paths to locate existing files inside the task worktree', async () => {
  const f = await fixture();
  for (const file of ['probe.md']) await writeFile(f.path(file), '# Observed context');
  for (const file of ['environment.json', 'routing-input.json']) await writeFile(f.path(file), '{}');
  const entry = { schemaVersion: 1, stage: 'probe', path: 'query.java', summary: 'Query entry', relevance: 'Task input', symbols: [], dependsOn: [], confidence: 'high' };
  await writeFile(join(f.cwd, 'query.java'), 'class Query {}');
  await writeFile(f.path('context-map.jsonl'), JSON.stringify(entry));
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'probe', 'ready')).resolves.toBeUndefined();
  await writeFile(f.path('context-map.jsonl'), JSON.stringify({ ...entry, path: 'missing.java' }));
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'probe', 'ready')).rejects.toThrow();
});
it('requires the original handoff Goal instead of a duplicated request report', async () => {
  const f = await fixture();
  await writeFile(runFilePath(f.data, f.runId, '.handoff.md'), '# Handoff\n\n## Goal\n\n## Progress log\n');
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'probe', 'ready')).rejects.toThrow('handoff Goal');
});
it('persists full clarification responses without worktree question or ledger files', async () => {
  const f = await fixture();
  const question = '# Q-001\norigin: design\nWhich matching rule?';
  const answer = '# Q-001\norigin: design\n回答：使用精确匹配。\n依据：' + '原始需求明确要求精确匹配。'.repeat(500);
  await guardUnattendedVerdict(f.data, f.runId, f.cwd, 'design', 'question', false, undefined, question);
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'adjudicator', 'plan', false, undefined, answer)).rejects.toThrow('origin');
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'adjudicator', 'answered')).rejects.toThrow();
  await guardUnattendedVerdict(f.data, f.runId, f.cwd, 'adjudicator', 'answered', false, undefined, answer);
  const saved = JSON.parse(await readFile(runFilePath(f.data, f.runId, '.unattended-question.json'), 'utf8'));
  expect(saved.answer).toBe(answer);
  expect(saved.history[0]).toMatchObject({ q: 'Q-001', origin: 'design', status: 'answered', answer });
  await expect(readFile(f.path('question.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(f.path('clarification.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(f.path('ledger.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'design', 'question', false, undefined, question)).rejects.toThrow('already answered');
});
it('rejects a caller that labels a question as coming from another stage', async () => {
  const f = await fixture();
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'design', 'question', false, undefined, '# Q-002\norigin: plan\nWhat target?')).rejects.toThrow('origin');
});
