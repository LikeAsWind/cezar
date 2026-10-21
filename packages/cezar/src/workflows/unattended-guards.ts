import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { superpowersBundleRefSchema } from '@open-mercato/cezar-contract';
import { snapshotPath } from '../superpowers-update.ts';
import type { WorkflowGraph } from './graph.ts';
import { workflowActionOf } from './workflow-actions.ts';
import { artifactPath } from '../../scripts/workflow/artifacts.mjs';

const trustedSchema = z.object({ schemaVersion: z.literal(1), runId: z.string(), root: z.string(), plan: z.string(), verified: z.string().optional() });
const pinSchema = z.object({ schemaVersion: z.literal(1), ref: superpowersBundleRefSchema });
function managedAction(dataDir: string, runId: string, command: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run id');
  const hostAction = workflowActionOf(command);
  if (hostAction && ['baseline', 'execution', 'verify', 'seal'].includes(hostAction)) return hostAction;
  if (hostAction) return;
  let pin;
  try { pin = pinSchema.parse(JSON.parse(readFileSync(join(dataDir, 'runs', `${runId}.superpowers.json`), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const runtime = join(snapshotPath(pin.ref.digest), 'runtime.mjs').replaceAll('\\', '/');
  const normalized = command.replaceAll('\\', '/');
  if (!normalized.includes(`'${runtime}'`) && !normalized.includes(`"${runtime}"`)) return;
  return ['baseline', 'execution', 'verify', 'seal'].find(action => normalized.endsWith(` ${action}`));
}

export function isUnattendedGraph(dataDir: string, runId: string, graph: WorkflowGraph): boolean {
  if (graph.nodes.some(node => node.type === 'check' && workflowActionOf(node.command) === 'verify')) return true;
  const verify = graph.nodes.find(node => node.id === 'verify' && node.type === 'check');
  return verify?.type === 'check' && managedAction(dataDir, runId, verify.command) === 'verify';
}

async function saveRecord(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

/** Host-private records protect against accidental worktree edits, not hostile same-user code. */
export async function guardUnattendedCheck(dataDir: string, runId: string, cwd: string, command: string, phase: 'before' | 'after'): Promise<void> {
  const action = await managedAction(dataDir, runId, command);
  if (!action || action === 'baseline' && phase === 'before' || action === 'seal' && phase === 'after') return;
  const path = join(dataDir, 'runs', `${runId}.unattended.json`), root = await realpath(cwd);
  let state: z.infer<typeof trustedSchema> | undefined;
  try { state = trustedSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (state && (state.runId !== runId || state.root !== root)) throw new Error('Trusted unattended state belongs to another run or worktree');
  const plan = await readFile(artifactPath(cwd, runId, 'validation-plan.json'), 'utf8');
  if (!state && !(action === 'baseline' && phase === 'after')) throw new Error('Trusted baseline missing; rerun the baseline before verification');
  if (state && state.plan !== plan) throw new Error('Frozen validation plan changed after baseline');
  state ??= { schemaVersion: 1, runId, root, plan };
  if (action === 'seal') {
    if (!state.verified || state.verified !== await readFile(artifactPath(cwd, runId, 'verified.json'), 'utf8')) throw new Error('Host verification receipt missing or changed');
  } else if (phase === 'after') {
    if (action === 'verify') state.verified = await readFile(artifactPath(cwd, runId, 'verified.json'), 'utf8');
    await mkdir(join(dataDir, 'runs'), { recursive: true });
    await saveRecord(path, state);
  }
}

const relativePath = z.string().min(1).refine(path => !path.startsWith('/') && !path.includes('\\') && !path.includes(':') && !path.split('/').includes('..'));
const mapEntry = z.object({ schemaVersion: z.literal(1), stage: z.literal('probe'), path: relativePath, summary: z.string().trim().min(1), relevance: z.string().trim().min(1), symbols: z.array(z.string()), dependsOn: z.array(relativePath), confidence: z.enum(['high', 'medium', 'low']) });
const callers = ['design', 'fast-plan', 'plan', 'execute-fast', 'execute-standard', 'execute-deep', 'execute-deep-native', 'fix'];
const questionSchema = z.object({ q: z.string(), origin: z.string(), text: z.string(), previous: z.string(), answered: z.boolean() });

/** Called only for graphs referencing the managed runtime, before accepting an agent verdict. */
export async function guardUnattendedVerdict(dataDir: string, runId: string, cwd: string, nodeId: string, verdict: string, executionStrategy = false, graph?: WorkflowGraph): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run id');
  const node = graph?.nodes.find(candidate => candidate.id === nodeId);
  const roleStages: Record<string, string> = {
    'cezar:project-probe': 'probe', 'cezar:adjudicator': 'adjudicator',
    'superpowers:brainstorming': 'design', 'superpowers:writing-plans': 'plan',
    'superpowers:executing-plans': 'execute-native', 'superpowers:subagent-driven-development': 'execute-sdd',
    'superpowers:systematic-debugging': 'fix', 'superpowers:verification-before-completion': 'deliver',
  };
  const stage = node?.type === 'agent' && node.skill
    ? node.skill === 'superpowers:writing-plans' && node.verdicts?.includes('fast') ? 'fast-plan' : roleStages[node.skill] ?? nodeId
    : nodeId;
  const validCallers = graph ? graph.nodes.filter(candidate => candidate.type === 'agent' && candidate.verdicts?.includes('question')).map(candidate => candidate.id) : callers;
  const artifact = async (name: string) => {
    const text = await readFile(artifactPath(cwd, runId, name), 'utf8');
    if (!text.trim()) throw new Error(`Empty stage artifact: ${name}`);
    return text;
  };
  if (verdict === 'question' || stage === 'adjudicator' && verdict !== 'blocked') {
    const path = join(dataDir, 'runs', `${runId}.unattended-question.json`);
    const text = await artifact('question.md'), q = /\bQ-\d+\b/.exec(text)?.[0], origin = /^origin:\s*([\w-]+)\s*$/m.exec(text)?.[1];
    if (!q || !origin || !validCallers.includes(origin)) throw new Error('Question requires a Q-number and valid origin');
    let pending: z.infer<typeof questionSchema> | undefined;
    try { pending = questionSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (verdict === 'question') {
      if (origin !== nodeId) throw new Error('Question origin differs from its caller');
      if (pending?.answered && pending.q === q && pending.text === text) throw new Error('Question already answered; read clarification.md or write a specific new question');
      let previous = '';
      try { previous = await readFile(artifactPath(cwd, runId, 'clarification.md'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await saveRecord(path, { q, origin, text, previous, answered: false });
    } else {
      if (!pending || pending.answered || pending.q !== q || pending.text !== text) throw new Error('No matching pending question');
      const returnPort = graph?.edges.find(edge => edge.to === pending.origin && edge.from.startsWith(`${nodeId}.`))?.from.slice(nodeId.length + 1);
      if (verdict !== (returnPort ?? (pending.origin === 'design' ? 'answered' : pending.origin))) throw new Error('Adjudicator verdict differs from pending question origin');
      const clarification = await artifact('clarification.md'), ledger = await artifact('ledger.md');
      const appended = clarification.slice(pending.previous.length);
      if (!clarification.startsWith(pending.previous) || !appended.includes(q) || !appended.includes(origin) || !appended.includes('answered') || !ledger.includes(q)) throw new Error('Adjudicator must append an answered record and update the ledger for this question');
      await saveRecord(path, { ...pending, answered: true });
    }
    return;
  }
  if (verdict === 'blocked') return;
  if (stage === 'probe' && verdict === 'ready') {
    const handoff = await readFile(join(dataDir, 'runs', `${runId}.handoff.md`), 'utf8');
    const goal = handoff.split(/^## Goal\s*$/m)[1]?.split(/^## Progress log\s*$/m)[0]?.trim();
    if (!goal) throw new Error('Original task is missing from handoff Goal');
  }
  const required: Record<string, string[]> = {
    'probe.ready': ['probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json'],
    'design.ready': ['design.md', 'ledger.md'],
    'deliver.ready': ['ledger.md'],
  };
  if (['fast-plan', 'plan'].includes(stage) && ['fast', 'standard', 'deep'].includes(verdict)) required[`${stage}.${verdict}`] = ['plan.md', 'ledger.md'];
  if (executionStrategy && stage === 'plan' && verdict === 'deep') required['plan.deep']!.push('execution-input.json');
  if (stage.startsWith('execute-') && verdict === 'complete' || stage === 'fix' && verdict === 'fixed') required[`${stage}.${verdict}`] = ['ledger.md'];
  for (const name of required[`${stage}.${verdict}`] ?? []) {
    const text = await artifact(name);
    if (name === 'context-map.jsonl') for (const line of text.trim().split(/\r?\n/)) {
      const entry = mapEntry.parse(JSON.parse(line));
      const target = await realpath(join(cwd, entry.path)), inside = relative(await realpath(cwd), target);
      if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside) || !(await stat(target)).isFile()) throw new Error(`Context map does not locate a worktree file: ${entry.path}`);
    }
    else if (name.endsWith('.json')) z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  }
}
