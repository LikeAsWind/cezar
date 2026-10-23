import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUILTIN_SUPERPOWERS_BUNDLE, resolveSuperpowersBundle } from '../superpowers-update.ts';
import { parse } from 'yaml';
import type { Skill } from '../skills.ts';
import { graphIssues, graphToSteps, workflowGraphFileSchema } from './graph.ts';
import type { WorkflowDef } from './types.ts';
import { bindWorkflowActions, workflowActionCommand, type WorkflowAction } from './workflow-actions.ts';
import { UNATTENDED_TEMPLATE } from './templates/unattended.ts';

// src/ and dist/ have the same depth; these assets also ship in the npm tarball.

let warned = false;
function unavailable(error: unknown): [] {
  if (!warned) {
    console.warn(`cezar: unattended workflow assets unavailable: ${error instanceof Error ? error.message : String(error)}`);
    warned = true;
  }
  return [];
}

export function unattendedWorkflows(bundle = resolveSuperpowersBundle()): WorkflowDef[] {
  try {
    const saved = join(bundle, 'workflow.json');
    if (existsSync(saved) || resolve(bundle) === resolve(BUILTIN_SUPERPOWERS_BUNDLE)) {
      const doc = workflowGraphFileSchema.parse(existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')) : structuredClone(UNATTENDED_TEMPLATE));
      bindWorkflowActions(doc.nodes);
      const issues = graphIssues(doc);
      if (issues.length) throw new Error(issues.join('; '));
      return [{ name: doc.name, description: doc.description, source: 'built-in', steps: graphToSteps(doc), graph: { nodes: doc.nodes, edges: doc.edges } }];
    }
    // Historical snapshots own their YAML, helpers and runtime. Never rewrite them.
    let yaml = readFileSync(join(bundle, 'workflow.yaml'), 'utf8');
    const hostActions = yaml.startsWith('# cezar-host-workflow: 1');
    const quote = (value: string) => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    const actionCommand = (action: WorkflowAction) => hostActions ? workflowActionCommand(action)
      : `${quote(process.execPath)} ${quote(join(bundle, 'runtime.mjs'))} ${action}`;
    for (const action of ['baseline', 'route', 'execution', 'verify', 'seal']) {
      const command = actionCommand(action as WorkflowAction);
      yaml = yaml.replaceAll(`command: __${action.toUpperCase()}_COMMAND__`, `command: ${JSON.stringify(command)}`);
    }
    yaml = yaml.replaceAll('__BUNDLE_DIRECTORY__', bundle.replaceAll('\\', '/'));
    const doc = workflowGraphFileSchema.parse(parse(yaml));
    bindWorkflowActions(doc.nodes);
    const context = readFileSync(join(bundle, 'context.md'), 'utf8');
    for (const node of doc.nodes) {
      if (node.type !== 'agent') continue;
      node.prompt = (node.prompt ?? '')
        .replaceAll('__INIT_COMMAND__', actionCommand('init'))
        .replaceAll('__ROUTE_COMMAND__', actionCommand('route'))
        .replaceAll('__REREVIEW_TEMPLATE__', readFileSync(join(bundle, 'vendor/superpowers/skills/subagent-driven-development/re-review-prompt.md'), 'utf8'))
        .replaceAll('__IMPLEMENTER_TEMPLATE__', readFileSync(join(bundle, 'vendor/superpowers/skills/subagent-driven-development/implementer-prompt.md'), 'utf8'))
        .replaceAll('vendor/superpowers/skills/', `${join(bundle, 'vendor/superpowers/skills').replaceAll('\\', '/')}/`);
      node.prompt = `${node.skill ? '' : context}
Pinned skill files: ${join(bundle, 'vendor/superpowers/skills')}
Bundle directory: ${bundle}

${node.prompt}`;
    }
    const problems = graphIssues(doc);
    if (problems.length) throw new Error(problems.join('; '));
    return [{ name: doc.name, description: doc.description, source: 'built-in',
      steps: graphToSteps(doc), graph: { nodes: doc.nodes, edges: doc.edges } }];
  } catch (error) { return unavailable(error); }
}

const roles = [
  ['cezar:project-probe', 'skills/project-probe/SKILL.md'],
  ['cezar:adjudicator', 'skills/adjudicator/SKILL.md'],
  ['superpowers:brainstorming', 'vendor/superpowers/skills/brainstorming/SKILL.md'],
  ['superpowers:builder-check', 'vendor/superpowers/skills/brainstorming/builder-check-prompt.md'],
  ['superpowers:writing-plans', 'vendor/superpowers/skills/writing-plans/SKILL.md'],
  ['superpowers:executing-plans', 'vendor/superpowers/skills/executing-plans/SKILL.md'],
  ['superpowers:subagent-driven-development', 'vendor/superpowers/skills/subagent-driven-development/SKILL.md'],
  ['superpowers:code-reviewer', 'vendor/superpowers/skills/requesting-code-review/code-reviewer.md'],
  ['superpowers:systematic-debugging', 'vendor/superpowers/skills/systematic-debugging/SKILL.md'],
  ['superpowers:verification-before-completion', 'vendor/superpowers/skills/verification-before-completion/SKILL.md'],
] as const;

/** Only exceptions relevant to this role accompany the unchanged upstream body. */
function roleHandoff(name: string): string {
  const common = `使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。`;
  const specific: Record<string, string> = {
    'cezar:project-probe': '宿主限制探测工具与时限。按节点输入维护四份探测产物；仅发现环境和验证入口，编译测试由后续宿主执行。',
    'cezar:adjudicator': '读取宿主注入的当前问题及引用证据，在最终回复中完整返回同 Q 编号和 origin 的答复。证据或需求授权不足则 blocked。',
    'superpowers:brainstorming': 'Independent builder review replaces interactive design approval：这是机器审核。需要需求授权的问题逐个交给独立裁决者，返回后核对答复；证据不足保持 blocked。',
    'superpowers:writing-plans': '设计或清晰的小任务原始需求是计划依据。计划使用注入的 plan.md 路径；执行方式已由工作流选择，无需询问人工。冻结验证约束纳入计划。',
    'superpowers:executing-plans': '使用当前工作树和冻结工具链；以官方 sdd-workspace 的 plan-path 定位账本和报告，恢复时复用它们及宿主检查点，不创建另一份 progress.md。按官方 task-done 完成任务，不增加逐任务审查。完成任务后停在最终全分支审查之前，由 cezar 验证并独立审查；保留计划工作目录供交付节点使用。需求阻塞可交裁决者。',
    'superpowers:subagent-driven-development': '使用官方逐任务派发与审查流程、原生报告和 ledger，以 sdd-workspace 的 plan-path 定位同一计划的工作目录。Task 审查包括未提交变更。完成任务后停在最终全分支审查之前，由 cezar 验证并独立审查；保留计划工作目录供交付节点使用。需求阻塞可交裁决者。',
    'superpowers:code-reviewer': '当前节点就是最终独立审查席位，只读并在回复中交付报告。完整 diff 包括未提交和新增文件；已有完整审查后的复查遵守官方 re-review 范围。',
    'superpowers:systematic-debugging': '只修复本任务引入的问题，依据实际失败和基线诊断；环境缺失或既有失败记录 blocked。保持冻结验证和目标版本约束。',
    'superpowers:verification-before-completion': '本节点核对宿主最新验证和独立审查，不代替失败检查宣布成功；交付后保留工作树进入人工 review。',
  };
  return `${common}\n${specific[name] ?? ''}`;
}

export function unattendedSkills(bundle = resolveSuperpowersBundle()): Skill[] {
  try {
    return roles.map(([name, file]) => {
      const path = join(bundle, file);
      const raw = readFileSync(path, 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
      const metadata = frontmatter ? parse(frontmatter[1]!) as { description?: string } : undefined;
      const original = frontmatter ? raw.slice(frontmatter[0].length) : raw;
      return { name, description: metadata?.description ?? `Pinned original role: ${name}`,
        body: `${original.replaceAll('vendor/superpowers/skills/', `${join(bundle, 'vendor/superpowers/skills').replaceAll('\\', '/')}/`)}

# cezar unattended orchestration exceptions

These workflow handoff exceptions override only the conflicting orchestration requirements above; all original role reasoning and review rules remain in force.

${roleHandoff(name)}

Pinned skill files: ${join(bundle, 'vendor/superpowers/skills')}
Bundle directory: ${bundle}`, path, source: 'builtin' };
    });
  } catch (error) { return unavailable(error); }
}
