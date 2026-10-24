import { workflowClarificationSchema, type WorkflowClarification } from '@open-mercato/cezar-contract';
import { runFilePath } from '../runs/files.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { superpowersBundleRefSchema } from '@open-mercato/cezar-contract';
import { snapshotPath } from '../superpowers-update.ts';
import type { WorkflowGraph } from './graph.ts';
import { workflowActionOf } from './workflow-actions.ts';
import { artifactPath } from '../../scripts/workflow/artifacts.mjs';
import { officialWorkspace, requireCompletedPlan } from './unattended-ledger.ts';
import { assertValidationExtension, captureTree, routeDecision } from '../../scripts/workflow-action.mjs';
import { unattendedStage } from './unattended-roles.ts';

const trustedSchema = z.object({ schemaVersion: z.literal(1), runId: z.string(), root: z.string(), plan: z.string(), verified: z.string().optional(),
  review: z.object({ tree: z.string(), approved: z.boolean(), receipt: z.string() }).optional() });
const pinSchema = z.object({ schemaVersion: z.literal(1), ref: superpowersBundleRefSchema });
export function managedAction(dataDir: string, runId: string, command: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run id');
  const hostAction = workflowActionOf(command);
  if (hostAction && ['baseline', 'scope', 'execution', 'verify', 'seal'].includes(hostAction)) return hostAction;
  if (hostAction) return;
  let pin;
  try { pin = pinSchema.parse(JSON.parse(readFileSync(runFilePath(dataDir, runId, '.superpowers.json'), 'utf8'))); }
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
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

/** Host-private records protect against accidental worktree edits, not hostile same-user code. */
export async function guardUnattendedCheck(dataDir: string, runId: string, cwd: string, command: string, phase: 'before' | 'after'): Promise<void> {
  const action = await managedAction(dataDir, runId, command);
  if (!action || action === 'baseline' && phase === 'before' || action === 'seal' && phase === 'after') return;
  const path = runFilePath(dataDir, runId, '.unattended.json'), root = await realpath(cwd);
  let state: z.infer<typeof trustedSchema> | undefined;
  try { state = trustedSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (state && (state.runId !== runId || state.root !== root)) throw new Error('Trusted unattended state belongs to another run or worktree');
  const verifying = action === 'verify' && phase === 'before';
  if (verifying) {
    if (state) { delete state.verified; await saveRecord(path, state); }
    for (const name of ['verified.json', 'verify.json', 'branch.diff']) await rm(artifactPath(cwd, runId, name, join(dataDir, 'runs', runId)), { force: true });
  }
  const reject = async (error: unknown): Promise<never> => {
    if (verifying) await saveRecord(artifactPath(cwd, runId, 'verify.json', join(dataDir, 'runs', runId)), { runId, results: [], error: error instanceof Error ? error.message : String(error) });
    throw error;
  };
  const plan = await readFile(artifactPath(cwd, runId, 'validation-plan.json', join(dataDir, 'runs', runId)), 'utf8').catch(reject);
  if (!state && !(action === 'baseline' && phase === 'after')) return reject(new Error('Trusted baseline missing; rerun the baseline before verification'));
  if (state && state.plan !== plan) {
    if (action !== 'scope' || phase !== 'after') return reject(new Error('Frozen validation plan changed after baseline'));
    assertValidationExtension(JSON.parse(state.plan), JSON.parse(plan));
    state.plan = plan;
    delete state.verified;
    delete state.review;
  }
  state ??= { schemaVersion: 1, runId, root, plan };
  if (action === 'seal') {
    if (!state.verified || state.verified !== await readFile(artifactPath(cwd, runId, 'verified.json', join(dataDir, 'runs', runId)), 'utf8')) throw new Error('Host verification receipt missing or changed');
  } else if (phase === 'after') {
    if (action === 'verify') state.verified = await readFile(artifactPath(cwd, runId, 'verified.json', join(dataDir, 'runs', runId)), 'utf8');
    await mkdir(dirname(path), { recursive: true });
    await saveRecord(path, state);
  }
}

const relativePath = z.string().min(1).refine(path => !path.startsWith('/') && !path.includes('\\') && !path.includes(':') && !path.split('/').includes('..'));
const mapEntry = z.object({ schemaVersion: z.literal(1), stage: z.literal('probe'), path: relativePath, summary: z.string().trim().min(1), relevance: z.string().trim().min(1), symbols: z.array(z.string()), dependsOn: z.array(relativePath), confidence: z.enum(['high', 'medium', 'low']) });
const callers = ['design', 'fast-plan', 'plan', 'execute-fast', 'execute-standard', 'execute-deep', 'execute-deep-native', 'fix'];
const decisionSchema = z.object({ q: z.string(), origin: z.string(), text: z.string(), answer: z.string(), status: z.enum(['answered', 'blocked']) });
const questionSchema = z.object({ q: z.string(), origin: z.string(), text: z.string(), answered: z.boolean(), answer: z.string().optional(), history: z.array(decisionSchema).default([]) });

export async function adjudicationTurnInput(dataDir: string, runId: string, graph: WorkflowGraph, nodeId: string, returning = false, includeHistory = false): Promise<string> {
  const pending = questionSchema.parse(JSON.parse(await readFile(runFilePath(dataDir, runId, '.unattended-question.json'), 'utf8')));
  if (returning) {
    if (!pending.answered || !pending.answer || pending.origin !== nodeId) throw new Error('No matching adjudication answer for caller');
    return `裁决结果（${pending.q}，返回 ${pending.origin}）：\n${pending.answer}`;
  }
  const port = graph.edges.find(edge => edge.to === pending.origin && edge.from.startsWith(`${nodeId}.`))?.from.slice(nodeId.length + 1);
  if (pending.answered || !port || !graph.nodes.some(node => node.id === pending.origin && node.type === 'agent' && node.verdicts?.includes('question'))) throw new Error('No matching pending adjudication question or return edge');
  // Keep the authoritative full response for UI/history. Drop a preamble only
  // when the current question has an explicit heading; origin can precede its body.
  const lines = pending.text.replace(/\s*CEZ:VERDICT[ \t:=]+[\w-]+\s*$/, '').trim().split('\n');
  const start = lines.findIndex(line => {
    const number = /^\s*(?:#{1,6}\s*|\*{1,2})?Q-?(\d+)\b/.exec(line)?.[1];
    return number !== undefined && `Q-${number.padStart(3, '0')}` === pending.q;
  });
  const question = lines.slice(start >= 0 ? start : 0).filter(line => !/^origin:\s*[\w-]+\s*$/.test(line)).join('\n').trim();
  return [
    `当前问题：${pending.q}\norigin: ${pending.origin}\n返回节点：${pending.origin}`,
    question,
    ...(includeHistory && pending.history.length ? [`既有裁决：\n${pending.history.map(entry => entry.answer).join('\n\n')}`] : []),
    `答复保留 ${pending.q} 和独立一行 origin: ${pending.origin}；最后一行输出 CEZ:VERDICT ${port}，无法裁决时输出 CEZ:VERDICT blocked。`,
  ].join('\n\n');
}

/** Called only for graphs referencing the managed runtime, before accepting an agent verdict. */
export async function guardUnattendedVerdict(dataDir: string, runId: string, cwd: string, nodeId: string, verdict: string, executionStrategy = false, graph?: WorkflowGraph, response = ''): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run id');
  const stage = unattendedStage(graph, nodeId);
  const validCallers = graph ? graph.nodes.filter(candidate => candidate.type === 'agent' && candidate.verdicts?.includes('question')).map(candidate => candidate.id) : callers;
  const artifact = async (name: string) => {
    const text = await readFile(artifactPath(cwd, runId, name, join(dataDir, 'runs', runId)), 'utf8');
    if (!text.trim()) throw new Error(`Empty stage artifact: ${name}`);
    return text;
  };
  if (verdict === 'question' || stage === 'adjudicator') {
    const path = runFilePath(dataDir, runId, '.unattended-question.json');
    const text = response.replace(/\s*CEZ:VERDICT[ \t:=]+[\w-]+\s*$/, '').trim();
    const digits = /\bQ-?(\d+)\b/.exec(text)?.[1];
    const q = digits ? `Q-${digits.padStart(3, '0')}` : undefined, origin = /^origin:\s*([\w-]+)\s*$/m.exec(text)?.[1];
    if (!q || !origin || !validCallers.includes(origin)) throw new Error('Question response requires a Q-number and valid origin');
    let pending: z.infer<typeof questionSchema> | undefined;
    try { pending = questionSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (verdict === 'question') {
      if (origin !== nodeId) throw new Error('Question origin differs from its caller');
      if (pending?.answered && pending.q === q && pending.text === text) throw new Error('Question already answered; use the supplied decision or ask a specific new question');
      await saveRecord(path, { q, origin, text, answered: false, history: pending?.history ?? [] });
    } else {
      if (!pending || pending.answered || pending.q !== q || pending.origin !== origin) throw new Error('No matching pending question');
      const returnPort = graph?.edges.find(edge => edge.to === pending.origin && edge.from.startsWith(`${nodeId}.`))?.from.slice(nodeId.length + 1);
      if (verdict !== 'blocked' && verdict !== (returnPort ?? (pending.origin === 'design' ? 'answered' : pending.origin))) throw new Error('Adjudicator verdict differs from pending question origin');
      if (text.replace(q, '').replace(/^origin:.*$/m, '').trim().length < 10) throw new Error('Adjudicator must return the full answer and evidence');
      const status = verdict === 'blocked' ? 'blocked' : 'answered';
      await saveRecord(path, { ...pending, answered: status === 'answered', answer: text,
        history: [...pending.history, { q, origin, text: pending.text, answer: text, status }] });
    }
    return;
  }
  if (verdict === 'blocked') return;
  if (['fast', 'standard', 'deep'].includes(verdict)) {
    const route = z.object({ tier: z.enum(['fast', 'standard', 'deep']) }).parse(JSON.parse(await artifact('route.json')));
    if (route.tier !== verdict) throw new Error(`Verdict tier differs from machine route: ${route.tier}`);
    const current = routeDecision(JSON.parse(await artifact('routing-input.json')), route.tier);
    if (current.tier !== verdict) throw new Error(`Verdict tier differs from current routing evidence: ${current.tier}`);
  }
  if (verdict === 'complete' && (stage.startsWith('execute-') || nodeId.startsWith('execute-'))) {
    await requireCompletedPlan(cwd, artifactPath(cwd, runId, 'plan.md', join(dataDir, 'runs', runId)));
  }
  if (stage === 'deliver' && verdict === 'ready' || stage === 'review' && ['approve', 'changes'].includes(verdict)) {
    await requireCompletedPlan(cwd, artifactPath(cwd, runId, 'plan.md', join(dataDir, 'runs', runId)));
    await artifact('verify.json');
    const receiptText = await artifact('verified.json');
    const receipt = z.object({ runId: z.literal(runId), tree: z.string().regex(/^[a-f0-9]{40,64}$/) }).parse(JSON.parse(receiptText));
    if (!response.trim()) throw new Error('Review or delivery report missing');
    const trustedPath = runFilePath(dataDir, runId, '.unattended.json');
    const trusted = trustedSchema.parse(JSON.parse(await readFile(trustedPath, 'utf8')));
    if (trusted.runId !== runId || trusted.root !== await realpath(cwd) || trusted.verified !== receiptText || trusted.plan !== await artifact('validation-plan.json')) throw new Error('Review requires the current host verification receipt');
    if (await captureTree(cwd, runId, join(dataDir, 'runs', runId)) !== receipt.tree) throw new Error('Code changed since verification; review and delivery require current code');
    if (stage === 'deliver' && (!trusted.review?.approved || trusted.review.receipt !== receiptText)) throw new Error('Delivery requires approved review of current verification');
    if (stage === 'review') {
      const workspace = await officialWorkspace(cwd, artifactPath(cwd, runId, 'plan.md', join(dataDir, 'runs', runId)));
      if (trusted.review) await appendFile(join(workspace!, 'final-review.md'), `\n\n## Re-review\n\n${response}`);
      else await writeFile(join(workspace!, 'final-review.md'), response);
      trusted.review = { tree: receipt.tree, approved: verdict === 'approve', receipt: receiptText };
      await saveRecord(trustedPath, trusted);
    }
  }
  if (stage === 'fix' && verdict === 'fixed') {
    const workspace = await officialWorkspace(cwd, artifactPath(cwd, runId, 'plan.md', join(dataDir, 'runs', runId)));
    if (!workspace || !response.trim()) throw new Error('Fix requires official workspace and implementer report');
    await appendFile(join(workspace, 'final-fix-report.md'), `${response}\n`);
  }
  if (stage === 'probe' && verdict === 'ready') {
    const handoff = await readFile(runFilePath(dataDir, runId, '.handoff.md'), 'utf8');
    const goal = handoff.split(/^## Goal\s*$/m)[1]?.split(/^## Progress log\s*$/m)[0]?.trim();
    if (!goal) throw new Error('Original task is missing from handoff Goal');
  }
  const required: Record<string, string[]> = {
    'probe.ready': ['probe.md', 'context-map.jsonl', 'environment.json', 'routing-input.json'],
    'design.ready': ['design.md'],
  };
  if (['fast-plan', 'plan'].includes(stage) && ['fast', 'standard', 'deep'].includes(verdict)) required[`${stage}.${verdict}`] = ['plan.md'];
  if (executionStrategy && stage === 'plan' && verdict === 'deep') {
    const line = /^CEZ:EXECUTION (.+)$/m.exec(response)?.[1];
    if (!line) throw new Error('Deep plan requires observed execution capability in CEZ:EXECUTION JSON');
    const input = z.object({ schemaVersion: z.literal(1), tasksIndependent: z.boolean().nullable(), subagents: z.object({ available: z.boolean().nullable(), tool: z.string().nullable(), evidence: z.string().trim().min(1) }) }).parse(JSON.parse(line));
    await saveRecord(artifactPath(cwd, runId, 'execution.json', join(dataDir, 'runs', runId)), { input });
  }
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

/** Read the authoritative saved exchange for the append-only conversation event stream. */
export async function clarificationForEvent(dataDir: string, runId: string, graph: WorkflowGraph, answering = false): Promise<WorkflowClarification | undefined> {
 let saved: z.infer<typeof questionSchema>;
 try { saved = questionSchema.parse(JSON.parse(await readFile(runFilePath(dataDir, runId, '.unattended-question.json'), 'utf8'))); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
 const last = saved.history.at(-1);
 const settled = last?.q === saved.q && last.origin === saved.origin && last.text === saved.text;
 return workflowClarificationSchema.parse({
  q: saved.q, origin: saved.origin, originName: graph.nodes.find(node => node.id === saved.origin)?.name ?? saved.origin,
  round: saved.history.length + (settled ? 0 : 1), question: saved.text,
  ...(settled && saved.answer ? { answer: saved.answer } : {}),
  status: answering ? 'answering' : settled ? last.status : 'pending',
 });
}
