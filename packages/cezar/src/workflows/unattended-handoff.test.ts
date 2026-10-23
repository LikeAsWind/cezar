import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { newArtifactPaths } from '../../scripts/workflow/artifacts.mjs';
import { guardUnattendedCheck, guardUnattendedVerdict } from './unattended-guards.ts';
import { workflowActionCommand } from './workflow-actions.ts';
import { captureTree } from '../../scripts/workflow-action.mjs';
import { unattendedContext, unattendedUserUpdates } from './unattended-probe.ts';
import { unattendedRecoveryPoint } from './unattended-recovery.ts';
import { UNATTENDED_TEMPLATE } from './templates/unattended.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-handoff-')); roots.push(cwd);
  const runId = 'handoff-run', data = join(cwd, '.ai/cezar');
  const paths = newArtifactPaths(cwd, runId);
  for (const name of ['run.json', 'plan.md', 'route.json', 'routing-input.json']) await mkdir(dirname(paths.file(name)), { recursive: true });
  await writeFile(paths.file('run.json'), JSON.stringify({ runId, root: await realpath(cwd), artifactPrefix: paths.prefix }));
  await writeFile(paths.file('plan.md'), '# Plan\n\n### Task 1: feature\n- [ ] Step 1: test\n');
  const workspace = join(cwd, '.superpowers/sdd', `${paths.prefix}-plan`);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'plan-path'), paths.relative('plan.md'));
  await writeFile(join(workspace, 'progress.md'), `# SDD ledger — plan: ${paths.relative('plan.md')}\nTask 1: started\n`);
  return { cwd, runId, data, paths, workspace };
}

it('rejects a lower execution tier than the saved machine route', async () => {
  const f = await fixture(); await writeFile(f.paths.file('route.json'), JSON.stringify({ tier: 'deep' }));
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'fast-plan', 'fast')).rejects.toThrow(/route|tier/i);
});
it('rejects a stale route after planning discovers higher risk', async () => {
  const f = await fixture();
  await writeFile(f.paths.file('route.json'), '{"tier":"fast"}');
  await writeFile(f.paths.file('routing-input.json'), JSON.stringify({ likelyChangeFiles: ['src/a.java'], highRisk: true, crossModule: false, requirementsClear: true }));
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'fast-plan', 'fast')).rejects.toThrow(/route|tier/i);
});
it('rejects complete while official task steps or ledger tasks remain unfinished', async () => {
  const f = await fixture();
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'execute-deep-native', 'complete')).rejects.toThrow(/incomplete|unfinished/i);
});
it('resumes a shared native/SDD ledger without inventing a reviewer gate for native tasks', async () => {
  const f = await fixture();
  await writeFile(f.paths.file('plan.md'), '# Plan\n### Task 1: native\n- [x] Step 1\n### Task 2: SDD\n- [x] Step 1\n```markdown\n- [ ] sample checkbox, not work\n```\n');
  await writeFile(join(f.workspace, 'progress.md'), `# SDD ledger — plan: ${f.paths.relative('plan.md')}\nTask 1: complete (tests: native → passed)\nTask 2: complete (commits abc1234..def5678, review clean)\n`);
  await writeFile(join(f.workspace, 'task-2-report.md'), 'Implemented Task 2; tests passed; independent task review clean.');
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'execute-deep', 'complete')).resolves.toBeUndefined();
  await writeFile(join(f.workspace, 'plan-path'), 'docs/superpowers/plans/another-plan.md');
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'execute-deep', 'complete')).rejects.toThrow(/workspace missing/);
});
it('does not use an unrelated final report as a missing SDD task report', async () => {
  const f = await fixture();
  await writeFile(f.paths.file('plan.md'), '# Plan\n### Task 1: SDD\n- [x] Step 1\n### Task 2: SDD\n- [x] Step 1\n');
  await writeFile(join(f.workspace, 'progress.md'), `# SDD ledger — plan: ${f.paths.relative('plan.md')}\nTask 1: complete (review clean)\nTask 2: complete (review clean)\n`);
  for (const name of ['task-1-report.md', 'final-fix-report.md']) await writeFile(join(f.workspace, name), 'An unrelated report');
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'execute-deep', 'complete')).rejects.toThrow(/Task 2.*report/);
});
it('hands the current official ledger and fix report to review without copying the ledger', async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, 'final-fix-report.md'), 'current fix report');
  const text = await unattendedContext(f.cwd, f.runId, { graphState: { outputs: { review: { summary: 'previous review' }, fix: { summary: 'current fix report' } } } } as never, 'review', f.data);
  expect(text).toContain('.superpowers/sdd/');
  expect(text).toContain('progress.md');
  expect(text).toContain('final-fix-report.md');
  expect(text).not.toContain('current fix report');
  expect(text).not.toContain('Task 1: started');
});
it('does not let stale execution blockage override a later publication failure', () => {
  const state = { loops: {}, taken: ['execute-standard.blocked->blocked-report', 'seal.pass->publish-mr', 'publish-mr.failed->notify-publication-failed', 'notify-publication-failed.done->publication-failed'] };
  expect(unattendedRecoveryPoint(UNATTENDED_TEMPLATE, state)).toBe('publish-mr');
});

it('requires successful current verification and approved current review before delivery', async () => {
  const f = await fixture();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8' }).trim();
  git('init'); await writeFile(join(f.cwd, '.gitignore'), '.ai/\n.superpowers/\n');
  await writeFile(join(f.cwd, 'code.txt'), 'code'); git('add', 'code.txt', '.gitignore');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  await writeFile(f.paths.file('plan.md'), '# Plan\n### Task 1: feature\n- [x] Step 1: test\n');
  await writeFile(join(f.workspace, 'progress.md'), `# SDD ledger — plan: ${f.paths.relative('plan.md')}\nTask 1: complete (tests: node check.cjs → passed)\n`);
  await writeFile(f.paths.file('validation-plan.json'), '{}');
  await guardUnattendedCheck(f.data, f.runId, f.cwd, workflowActionCommand('baseline'), 'after');
  await writeFile(f.paths.file('verify.json'), '{"results":[{"exitCode":0}]}');
  await writeFile(f.paths.file('verified.json'), JSON.stringify({ runId: f.runId, tree: await captureTree(f.cwd, f.runId), diffHash: 'first' }));
  await guardUnattendedCheck(f.data, f.runId, f.cwd, workflowActionCommand('verify'), 'after');
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'deliver', 'ready', false, undefined, 'Delivery')).rejects.toThrow(/approved review/);
  await guardUnattendedVerdict(f.data, f.runId, f.cwd, 'review', 'approve', false, undefined, 'Reviewed the full branch, no blockers.');
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'deliver', 'ready', false, undefined, 'Delivery evidence')).resolves.toBeUndefined();
  await guardUnattendedCheck(f.data, f.runId, f.cwd, workflowActionCommand('verify'), 'before');
  await expect(guardUnattendedVerdict(f.data, f.runId, f.cwd, 'deliver', 'ready', false, undefined, 'Delivery')).rejects.toThrow(/ENOENT|current host verification/);
}, 30_000);

it('hands accepted user updates to fresh nodes once and preserves their order', async () => {
  const f = await fixture();
  const text = await unattendedContext(f.cwd, f.runId, { queuedMessages: [{ text: 'Keep production defaults' }] } as never, 'design', f.data, false, ['Keep production defaults', 'Use an explicit test profile']);
  expect(text.match(/Keep production defaults/g)).toHaveLength(1);
  expect(text.indexOf('Keep production defaults')).toBeLessThan(text.indexOf('Use an explicit test profile'));
});
it('preserves repeated user decisions and merges only the same queued/event message identity', () => {
  const events = ['Use Java 8', 'Use Java 11', 'Use Java 8'].map((text, index) => ({ type: 'user-message', text, seq: index + 1, ts: `2026-10-22T00:00:0${index}Z`, ...(index === 0 ? { messageId: 'same-message' } : {}) }));
  expect(unattendedUserUpdates({ queuedMessages: [{ id: 'same-message', text: 'Use Java 8', createdAt: events[0]!.ts }] } as never, events)).toEqual(['Use Java 8', 'Use Java 11', 'Use Java 8']);
});

it.each(['request-review', 'notify-wecom'])('recovers %s without rerunning code or publishing again', node => {
  expect(unattendedRecoveryPoint(UNATTENDED_TEMPLATE, { loops: {}, taken: [`${node}.failed->notification-failed`] })).toBe(node);
});
it.each(['plan', 'fast-plan'])('returns a failed scope check to %s to supply missing coverage', planner => {
  expect(unattendedRecoveryPoint(UNATTENDED_TEMPLATE, { loops: {}, taken: [`${planner}.fast->validation-scope`, 'validation-scope.fail->blocked-report'] })).toBe(planner);
});
