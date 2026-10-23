import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';

/** Resolve the workspace owned by this plan using upstream sdd-workspace's marker.
 * Never adopt another plan's ledger or copy its contents into host state. */
export async function officialWorkspace(cwd: string, plan: string): Promise<string | undefined> {
  const base = join(cwd, '.superpowers/sdd');
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const identity = relative(cwd, plan).replaceAll('\\', '/');
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(base, entry.name);
    const physical = relative(await realpath(cwd), await realpath(directory));
    if (isAbsolute(physical) || physical.startsWith('..')) throw new Error('Official workspace escapes worktree');
    let marker;
    try { marker = (await readFile(join(directory, 'plan-path'), 'utf8')).trim().replaceAll('\\', '/'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (marker === identity) matches.push(directory);
  }
  if (matches.length > 1) throw new Error(`Multiple official workspaces own ${basename(plan)}`);
  return matches[0];
}

function outsideCode(text: string): string {
  let fence = '';
  return text.split(/\r?\n/).filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { fence = fence ? marker[0] === fence[0] && marker.length >= fence.length ? '' : fence : marker; return false; }
    return !fence;
  }).join('\n');
}
export async function requireCompletedPlan(cwd: string, planPath: string): Promise<void> {
  const plan = outsideCode(await readFile(planPath, 'utf8'));
  const tasks = [...plan.matchAll(/^#{1,6}\s+Task\s+(\d+)(?:\D|$)/gm)].map(match => match[1]!);
  if (!tasks.length || /^\s*-\s+\[ \]/m.test(plan)) throw new Error('Incomplete plan: unfinished task steps');
  const workspace = await officialWorkspace(cwd, planPath);
  if (!workspace) throw new Error('Official plan workspace missing; use upstream sdd-workspace');
  const ledger = outsideCode(await readFile(join(workspace, 'progress.md'), 'utf8'));
  const identity = relative(cwd, planPath).replaceAll('\\', '/');
  if (!ledger.split(/\r?\n/)[0]?.includes(identity)) throw new Error('Official ledger belongs to another plan');
  for (const task of tasks) {
    const completion = ledger.split('\n').find(line => new RegExp(`^(?:- )?Task ${task}: complete\\b`).test(line));
    if (!completion) throw new Error(`Incomplete official ledger: Task ${task} unfinished`);
    if (!/tests:|review clean|\d+ parked/.test(completion)) throw new Error(`Incomplete completion evidence for Task ${task}`);
    if (/review clean|\d+ parked/.test(completion)) {
      // Batch dispatch may share one report, but must explicitly name that
      // relationship per task. A final report is never an implicit substitute.
      const shared = new RegExp(`^(?:- )?Task ${task}: report: ([a-zA-Z0-9_.-]+\\.md)$`, 'm').exec(ledger)?.[1];
      const report = join(workspace, shared ?? `task-${task}-report.md`);
      const text = await readFile(report, 'utf8').catch(error => {
        if (error.code === 'ENOENT') throw new Error(`Incomplete Task ${task} report`); throw error;
      });
      if (!text.trim()) throw new Error(`Empty Task ${task} report`);
    }
  }
}
