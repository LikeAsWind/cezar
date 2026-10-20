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

export function unattendedSkills(bundle = resolveSuperpowersBundle()): Skill[] {
  try {
    const context = readFileSync(join(bundle, 'context.md'), 'utf8');
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

${context}

Pinned skill files: ${join(bundle, 'vendor/superpowers/skills')}
Bundle directory: ${bundle}`, path, source: 'builtin' };
    });
  } catch (error) { return unavailable(error); }
}
