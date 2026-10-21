import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadWorkflows } from './load.ts';
import { discoverSkills } from '../skills.ts';
import { unattendedSkills, unattendedWorkflows } from './superpowers-bundle.ts';
import { graphIssues } from './graph.ts';

const roots: string[] = [];
it('routes probe evidence through host commands and conditions without an agent session', () => {
  const workflow = unattendedWorkflows()[0]!;
  const route = workflow.graph!.nodes.find(node => node.id === 'route');
  expect(route?.type).toBe('check');
  if (route?.type !== 'check') return;
  expect(route.command).toContain('workflow-action.mjs');
  expect(route.command).toMatch(/ route$/);
  expect(route.command).not.toContain('__');
  expect(workflow.graph!.nodes.find(node => node.id === 'design')).toMatchObject({ prompt: expect.stringContaining("rerun '") });
  const branch = workflow.graph!.nodes.find(node => node.id === 'route-fast');
  expect(branch).toMatchObject({ type: 'if', condition: { kind: 'output', ref: 'route.output', op: 'equals', value: 'fast' } });
  expect(workflow.graph!.edges).toEqual(expect.arrayContaining([
    { from: 'route.pass', to: 'route-fast' },
    { from: 'route.fail', to: 'blocked-report' },
    { from: 'route-fast.true', to: 'fast-plan' },
    { from: 'route-fast.false', to: 'design' },
  ]));
});
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'cezar-builtin-v7-'));
  roots.push(root);
  return root;
}

it('offers the complete unattended workflow in a project with no local workflow installation', async () => {
  const root = await project();
  await writeFile(join(root, 'pom.xml'), '<project/>');
  const { workflows, issues } = await loadWorkflows(root);
  expect(issues).toEqual([]);
  const workflow = workflows.find(w => w.name === unattendedWorkflows()[0]!.name);
  expect(workflow?.source).toBe('built-in');
  expect(workflow?.graph).toBeDefined();
  expect(graphIssues(workflow!.graph!)).toEqual([]);
  expect(workflow!.steps.filter(s => s.command).every(s => !s.command!.includes('__'))).toBe(true);
});

it('injects original role content directly, without an entry skill or adapter reads', async () => {
  const skills = unattendedSkills();
  const workflow = unattendedWorkflows()[0]!;
  expect(skills.some(s => s.name === 'cezar-unattended-v7')).toBe(false);
  for (const step of workflow.steps.filter(s => s.skill)) {
    expect(step.skill).not.toBe('cezar-unattended-v7');
    const skill = skills.find(s => s.name === step.skill)!;
    expect(skill).toBeDefined();
    const original = await readFile(skill.path, 'utf8');
    const roleBody = original.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    expect(skill.body.startsWith(roleBody)).toBe(true);
    expect(skill.body).toContain('orchestration exceptions');
    expect(skill.body).toContain('Independent builder review replaces interactive design approval');
    expect(step.prompt).not.toContain('adapters/');
    expect(step.prompt).not.toMatch(/__[A-Z_]+__/);
    expect(step.prompt).not.toContain('Read adapters');
    expect(skill.body).toContain('CEZ:VERDICT');
  }
  expect(workflow.steps.find(s => s.id === 'design')?.skill).toBe('superpowers:brainstorming');
  expect(workflow.steps.find(s => s.id === 'plan')?.skill).toBe('superpowers:writing-plans');
  expect(workflow.steps.find(s => s.id === 'execute-deep')?.skill).toBe('superpowers:subagent-driven-development');
  expect(workflow.steps.find(s => s.id === 'review')?.prompt).toContain('re-review-prompt.md');
});

it('preserves project workflow and skill overrides', async () => {
  const root = await project();
  await mkdir(join(root, '.ai/cezar/workflows'), { recursive: true });
  await mkdir(join(root, '.ai/cezar/skills/local-plan'), { recursive: true });
  await writeFile(join(root, '.ai/cezar/workflows/custom.yaml'), `name: ${unattendedWorkflows()[0]!.name}\nsteps:\n  - id: custom\n    prompt: local override\n`);
  await writeFile(join(root, '.ai/cezar/skills/local-plan/SKILL.md'), '---\nname: superpowers:writing-plans\n---\nLocal role override.\n');
  const workflow = (await loadWorkflows(root)).workflows.filter(w => w.name === unattendedWorkflows()[0]!.name);
  expect(workflow).toHaveLength(1);
  expect(workflow[0]?.source).toBe('file');
  expect((await discoverSkills(root)).find(s => s.name === 'superpowers:writing-plans')?.body).toContain('Local role override.');
});


it('loads the researched probe and reusable adjudicator directly as separate roles', () => {
  const skills = unattendedSkills();
  const workflow = unattendedWorkflows()[0]!;
  expect(workflow.steps.find(s => s.id === 'probe')?.skill).toBe('cezar:project-probe');
  expect(workflow.steps.find(s => s.id === 'adjudicator')?.skill).toBe('cezar:adjudicator');
  const probe = skills.find(s => s.name === 'cezar:project-probe')!;
  const judge = skills.find(s => s.name === 'cezar:adjudicator')!;
  expect(probe.path.replaceAll('\\', '/')).toMatch(/skills\/project-probe\/SKILL\.md$/);
  expect(judge.path.replaceAll('\\', '/')).toMatch(/skills\/adjudicator\/SKILL\.md$/);
  expect(probe.body).toContain('未知信息');
  expect(judge.body).toContain('信息不足');
});


it('packages project-probe as a self-contained standard skill without source narratives', async () => {
  const probe = unattendedSkills().find(s => s.name === 'cezar:project-probe')!;
  expect(probe.path.replaceAll('\\', '/')).toMatch(/skills\/project-probe\/SKILL\.md$/);
  const raw = await readFile(probe.path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)!;
  const metadata = parse(match[1]!);
  expect(metadata.name).toBe('project-probe');
  expect(metadata.description).toMatch(/^Use (when|before) /);
  expect(raw).not.toMatch(/auto-rd-harness|vendor|一手资料|沿用.*思路|本提示词根据/);
  expect(raw).toContain('调查流程');
  expect(raw).toContain('完成判定');
});


it('defines probe as impact discovery and a reusable file-context map, without generating acceptance criteria', () => {
  const probe = unattendedSkills().find(s => s.name === 'cezar:project-probe')!;
  expect(probe.body).not.toContain('给明确验收要求编号');
  expect(probe.body).not.toContain('将 AC 映射');
  expect(probe.body).toContain('影响范围');
  expect(probe.body).toContain('relevance');
  expect(probe.body).toContain('symbols');
  expect(probe.body).toContain('dependsOn');
  expect(probe.body).toContain('不生成澄清问卷或设计方案');
  expect(probe.body).toContain('不执行准备、编译或测试');
  expect(unattendedSkills().find(s => s.name === 'superpowers:writing-plans')?.body).toContain('Do not repeat a full tree traversal');
});


it('packages adjudicator as a standard skill aligned with probe context and frozen toolchains', async () => {
  const judge = unattendedSkills().find(s => s.name === 'cezar:adjudicator')!;
  expect(judge.path.replaceAll('\\', '/')).toMatch(/skills\/adjudicator\/SKILL\.md$/);
  const raw = await readFile(judge.path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)!;
  const metadata = parse(match[1]!);
  expect(metadata.name).toBe('adjudicator');
  expect(metadata.description).toEqual(expect.any(String));
  expect(metadata.description.trim().length).toBeGreaterThan(0);
  expect(raw).not.toMatch(/Superpowers|自定义角色|一手资料|参考.*项目/);
  for (const field of ['context-map.jsonl', 'targetVersion', 'buildVersion', 'runtimeVersion',
    'validation-plan.json', 'baseline.json', 'verify.json', 'environment.checks']) expect(raw).toContain(field);
  expect(raw).not.toContain('environment-baseline.json');
  expect(raw).not.toContain('environment-verify.json');
  expect(raw).toContain('已有 AC 或用户原始表述');
  expect(raw).toContain('## 输出与边界');
});
