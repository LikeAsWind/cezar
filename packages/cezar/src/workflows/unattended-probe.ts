import { runFilePath } from '../runs/files.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { z } from 'zod';
import { superpowersBundleRefSchema } from '@open-mercato/cezar-contract';
import { snapshotPath } from '../superpowers-update.ts';
import { assertProbeSupport, PROBE_TIMEOUT_MS, probeVersionPrefix } from '../core/probe-policy.ts';
import type { AgentBackend, AgentRunSpec } from '../core/agent-runner.ts';
import { artifactNames, artifactPaths, artifactTopic } from '../../scripts/workflow/artifacts.mjs';
import { discoverJavaLocations } from './probe-tools.ts';
import { WORKFLOW_ACTION_SCRIPT } from './workflow-actions.ts';
import type { RunRecord } from '../runs/store.ts';
import { getHeadCommit } from '../server/git.ts';

const exec = promisify(execFile);
// Stage-local aliases keep later outputs and unrelated execution evidence out of the input.
export const stageArtifacts: Record<string, string[]> = {
  design: ['probe.md', 'context-map.jsonl', 'validation-plan.json', 'routing-input.json', 'design.md'],
  'fast-plan': ['probe.md', 'context-map.jsonl', 'validation-plan.json', 'routing-input.json', 'route.json', 'plan.md'],
  plan: ['design.md', 'context-map.jsonl', 'validation-plan.json', 'routing-input.json', 'route.json', 'plan.md'],
  adjudicator: ['probe.md', 'context-map.jsonl', 'validation-plan.json'],
  'execute-fast': ['plan.md', 'context-map.jsonl', 'validation-plan.json', 'routing-input.json', 'route.json'],
  'execute-standard': ['plan.md', 'context-map.jsonl', 'validation-plan.json', 'routing-input.json', 'route.json'],
  'execute-deep': ['plan.md', 'context-map.jsonl', 'validation-plan.json'],
  'execute-deep-native': ['plan.md', 'execution.json', 'context-map.jsonl', 'validation-plan.json'],
  review: ['design.md', 'plan.md', 'context-map.jsonl', 'verify.json', 'verified.json', 'branch.diff', 'fix-before.diff'],
  fix: ['plan.md', 'context-map.jsonl', 'baseline.json', 'verify.json', 'validation-plan.json', 'branch.diff', 'fix-before.diff'],
  deliver: ['verify.json', 'verified.json'],
};

/** Keep each path's purpose readable without a metadata envelope. */
export function artifactLabel(name: string, stage?: string): string {
  const labels: Record<string, string> = {
    'run.json': '任务与工作树信息',
    'probe.md': '需求背景与影响面',
    'context-map.jsonl': '源码定位地图',
    'environment.json': '工具链与验证入口草稿',
    'validation-plan.json': '编译测试命令与版本约束',
    'routing-input.json': '复杂度判断依据',
    'route.json': '当前复杂度档位',
    'design.md': '设计方案',
    'plan.md': '实现计划',
    'execution.json': '执行器选择及原因',
    'baseline.json': '修改前的检查结果',
    'verify.json': '当前验证结果与失败原因',
    'verified.json': '验证对应的变更凭据',
    'branch.diff': '本次任务完整代码差异',
    'fix-before.diff': '修复前代码差异',
  };
  const label = labels[name];
  if (!label) throw new Error(`Missing artifact purpose: ${name}`);
  if (name === 'plan.md' && stage?.startsWith('execute-')) return `${label}（执行前读取）`;
  if (name === 'validation-plan.json' && stage === 'adjudicator') return `${label}（环境问题时读取）`;
  return label;
}

export function artifactInstructions(cwd: string, runId: string, stage?: string, dataDir?: string): string {
  let paths;
  try { paths = artifactPaths(cwd, runId, dataDir ? join(dataDir, 'runs', runId) : undefined); }
  catch (error) {
    if (error instanceof Error && error.message === 'Run artifacts have not been initialized') return 'Run artifacts were not initialized. Report the failed initialization through CEZ_HANDOFF_FILE; never invent another run context.';
    throw error;
  }
  const names = stage ? ['run.json', ...(stageArtifacts[stage] ?? [])] : artifactNames;
  const isOutput = (name: string) => name === 'design.md' && stage === 'design'
    || name === 'plan.md' && (stage === 'fast-plan' || stage === 'plan')
    || name === 'fix-before.diff' && stage === 'fix';
  const optional = (name: string) => stage === 'review' && (name === 'design.md' || name === 'fix-before.diff');
  const inputs = names.filter(name => !isOutput(name));
  const outputs = names.filter(isOutput);
  const describe = (name: string) => {
    const present = existsSync(paths.file(name));
    const usage = isOutput(name)
      ? `${name === 'fix-before.diff' ? '本节点输出，修改前保存' : '本节点输出'}；${present ? name === 'fix-before.diff' ? '已存在，复用原始快照，不覆盖' : '已存在，读取后继续完善' : '尚未生成，直接创建，不预先读取'}`
      : optional(name) ? present ? '可选输入，按需读取' : '可选输入，未生成，无需读取' : '';
    return `${artifactLabel(name, stage)}${usage ? `（${usage}）` : ''}：${paths.relative(name)}`;
  };
  return `任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
${inputs.map(describe).join('\n')}${outputs.length ? `\n本节点输出：\n${outputs.map(describe).join('\n')}` : ''}
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。${names.includes('context-map.jsonl') ? '先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。' : ''}`;

}

/** Feed existing discovery and progress to the next role, rather than only naming files. */
export async function unattendedContext(cwd: string, runId: string, run?: Pick<RunRecord, 'branch' | 'steps' | 'graphState' | 'queuedMessages'>, stage?: string, dataDir?: string, resumingSession = false): Promise<string> {
  const paths = artifactPaths(cwd, runId, dataDir ? join(dataDir, 'runs', runId) : undefined);
  const identity = JSON.parse(await readFile(paths.file('run.json'), 'utf8'));
  if (identity.runId !== runId || identity.root !== await realpath(cwd)) throw new Error('Shared context belongs to another run or worktree');
  const read = async (name: string) => {
    try { return await readFile(paths.file(name), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  };
  const [mapText, environmentText, baselineText, verifyText, head, plan] = await Promise.all([
    !stage ? read('context-map.jsonl') : '', !stage ? read('validation-plan.json') : '',
    !stage ? read('baseline.json') : '', !stage ? read('verify.json') : '',
    !stage ? getHeadCommit(cwd) : undefined, !stage ? read('plan.md') : '',
  ]);
  const rows = mapText.trim() ? mapText.trim().split(/\r?\n/).map(line => JSON.parse(line) as unknown) : [];
  const relevant = (row: unknown) => typeof row === 'object' && row !== null && 'path' in row && typeof row.path === 'string' && plan.includes(row.path);
  rows.sort((a, b) => Number(relevant(b)) - Number(relevant(a)));
  const map: unknown[] = [];
  let size = 0;
  for (const row of rows) { size += JSON.stringify(row).length; if (size > 12_000) break; map.push(row); }
  const validation = (text: string) => {
    if (!text) return 'unavailable';
    const report = JSON.parse(text) as { results?: { spec?: { kind?: string }; exitCode?: number; classification?: string; testExecution?: { status: string; counts?: unknown }; diagnostics?: string }[] };
    return report.results?.map(result => ({ kind: result.spec?.kind, exitCode: result.exitCode, classification: result.classification,
      testExecution: result.spec?.kind === 'test' ? result.testExecution ?? { status: 'unverified (legacy exit-code-only result)' } : undefined, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) }));
  };
  const environment = environmentText ? JSON.parse(environmentText) as { toolchains?: unknown; blocked?: unknown } : {};
  const data = { ...(!stage ? { runId, branch: run?.branch, head } : {}),
    ...(!stage ? { map, omittedMapEntries: rows.length - map.length } : {}),
    ...(!stage ? { toolchains: environment.toolchains ?? [], environmentBlockers: environment.blocked ?? [], baseline: validation(baselineText) } : {}),
    ...(!stage ? { verification: validation(verifyText) } : {}),
    ...(stage && !(stage === 'adjudicator' && resumingSession) && run?.graphState?.outputs?.[stage] ? { checkpoint: run.graphState.outputs[stage] } : {}) };
  let questions;
  if (dataDir) {
    try { questions = JSON.parse(await readFile(runFilePath(dataDir, runId, '.unattended-question.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const decisions = questions?.history?.filter((entry: { origin: string; status: string }) => (entry.status === 'answered' && (stage === 'review' || stage === 'deliver') || entry.origin === stage)) ?? [];
  const clarification = stage === 'adjudicator'
    ? resumingSession && questions ? { ...questions, history: [] } : questions
    : decisions;
  const userUpdates = run?.queuedMessages?.map(message => message.text).filter(Boolean) ?? [];
  const shared = { ...data, ...(clarification && (!Array.isArray(clarification) || clarification.length) ? { clarification } : {}) };
  return [
    ...(userUpdates.length ? [`Persisted user updates for this task:\n${userUpdates.join('\n\n')}`] : []),
    ...(Object.keys(shared).length ? [`共享证据（reference data）：\n${JSON.stringify(shared, null, 2)}`] : []),
  ].join('\n\n');
}

/** A single selected JDK also reaches implementation's direct test commands. Never pick among different JDKs. */
export async function unattendedToolchainEnv(dataDir: string, runId: string, cwd: string, env: Record<string, string>): Promise<Record<string, string>> {
  let record;
  try { record = z.object({ schemaVersion: z.literal(1), runId: z.literal(runId), root: z.string(), plan: z.string() }).parse(JSON.parse(await readFile(runFilePath(dataDir, runId, '.unattended.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return env; throw error; }
  if (record.root !== await realpath(cwd)) throw new Error('toolchain plan belongs to another worktree');
  const plan = z.object({ toolchains: z.array(z.object({ execution: z.object({ javaHome: z.string().optional(), pathEntries: z.array(z.string()).default([]) }).optional() })).default([]) }).parse(JSON.parse(record.plan));
  const bindings = plan.toolchains.flatMap(tool => tool.execution ? [tool.execution] : []);
  const homes = [...new Set(bindings.flatMap(binding => binding.javaHome ? [binding.javaHome] : []))];
  if (new Set(bindings.map(binding => JSON.stringify(binding))).size > 1) return env;
  const selected = { ...env };
  const inheritedPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
    ?? Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const prefixes = [...new Set([...(homes[0] ? [join(homes[0], 'bin')] : []), ...bindings.flatMap(binding => binding.pathEntries)])];
  if (prefixes.length) {
    for (const key of Object.keys(selected)) if (key.toLowerCase() === 'path') delete selected[key];
    selected.PATH = [...prefixes, inheritedPath].filter(Boolean).join(delimiter);
  }
  if (homes[0]) {
    for (const key of Object.keys(selected)) if (key.toLowerCase() === 'java_home') delete selected[key];
    selected.JAVA_HOME = homes[0];
  }
  return selected;
}

export async function prepareUnattendedProbe(dataDir: string, runId: string, cwd: string, backend: AgentBackend, hostActions = false, title = 'task'): Promise<{ policy: NonNullable<AgentRunSpec['probePolicy']>; timeoutMs: number; instructions: string }> {
  const policy = { root: cwd, runId };
  assertProbeSupport(backend, policy);
  let script = WORKFLOW_ACTION_SCRIPT;
  if (!hostActions) {
    const pin = z.object({ schemaVersion: z.literal(1), ref: superpowersBundleRefSchema }).parse(JSON.parse(await readFile(runFilePath(dataDir, runId, '.superpowers.json'), 'utf8')));
    const root = snapshotPath(pin.ref.digest);
    script = existsSync(join(root, 'workflow.json')) ? WORKFLOW_ACTION_SCRIPT : join(root, 'runtime.mjs');
  }
  await exec(process.execPath, [script, 'init', artifactTopic(title)], {
    cwd, env: { ...process.env, CEZ_RUN_ID: runId, CEZ_TASK_ID: runId, CEZ_HANDOFF_FILE: runFilePath(dataDir, runId, '.handoff.md') }, timeout: 15_000, windowsHide: true,
  });
  const locations = await discoverJavaLocations();
  const paths = artifactPaths(cwd, runId, dataDir ? join(dataDir, 'runs', runId) : undefined);
  return { policy, timeoutMs: PROBE_TIMEOUT_MS, instructions: `执行已加载的 cezar:project-probe，完成需求影响面、源码地图和必要环境探测。不要进入设计或实现。

原始需求：读取 CEZ_HANDOFF_FILE 的 ## Goal。
任务身份：读取 ${paths.relative('run.json')}，确认当前任务与工作树一致。

仅维护本阶段四份产物：
- 影响面背景：${paths.relative('probe.md')}
- 源码地图：${paths.relative('context-map.jsonl')}
- 构建与测试环境：${paths.relative('environment.json')}
- 复杂度依据：${paths.relative('routing-input.json')}

宿主发现的工具位置：
${JSON.stringify(locations)}

根据项目证据选择对应工具链；只核对选定版本，不逐一尝试所有已安装版本。版本查询仅使用宿主允许的命令：
${probeVersionPrefix()} '<installed executable name or absolute path>' '<--version or -version or -v>' '<absolute Java home or empty string>'

遵守宿主工具边界，不执行编译、测试、安装或源码修改。相互独立的读取与搜索可并行，控制单次返回量，避免上下文过载；存在依赖的操作顺序执行，报告串行写入。恢复时复用已有产物，仅补充缺失或过期证据。

本阶段总时限为 30 分钟。必要证据齐备后立即保存并交接；关键环境或证据缺失则明确记录阻塞。

最终回复简述结论与缺口，最后一行只输出以下标记之一：
CEZ:VERDICT ready
CEZ:VERDICT blocked` };
}
