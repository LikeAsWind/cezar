import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { superpowersBundleRefSchema } from '@open-mercato/cezar-contract';
import type { Skill } from '../skills.ts';
import { BUILTIN_SUPERPOWERS_BUNDLE, resolveSuperpowersBundle, ensureBundleSnapshot, snapshotPath, verifyBundleSnapshot } from '../superpowers-update.ts';
import { unattendedSkills, unattendedWorkflows } from './superpowers-bundle.ts';
import type { WorkflowDef } from './types.ts';
import { UNATTENDED_TEMPLATE } from './templates/unattended.ts';

const pinSchema = z.object({ schemaVersion: z.literal(1), ref: superpowersBundleRefSchema });

/** The private run lock is authoritative, including after a restart or bundle activation. */
export async function pinSuperpowersRun(dataDir: string, runId: string, workflow: WorkflowDef, skills: Skill[]): Promise<{ workflow: WorkflowDef; skills: Skill[] }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run id');
  const path = join(dataDir, 'runs', `${runId}.superpowers.json`);
  let pin: z.infer<typeof pinSchema> | undefined;
  try { pin = pinSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const builtin = workflow.source === 'built-in' && workflow.name === UNATTENDED_TEMPLATE.name;
  const roles = unattendedSkills();
  const serialized = JSON.stringify(workflow).replaceAll('\\\\', '/').replaceAll('\\', '/');
  const managedRoots = new Set([BUILTIN_SUPERPOWERS_BUNDLE, resolveSuperpowersBundle()]);
  for (const digest of serialized.match(/[a-f0-9]{64}/g) ?? []) {
    const candidate = snapshotPath(digest);
    if (serialized.includes(candidate.replaceAll('\\', '/'))) managedRoots.add(candidate);
  }
  const referencedRoot = [...managedRoots].find(candidate => serialized.includes(candidate.replaceAll('\\', '/').replace(/\/$/, '') + '/'));
  const referenced = new Set([
    ...workflow.steps.map(step => step.skill),
    ...(workflow.graph?.nodes.map(node => node.type === 'agent' ? node.skill : undefined) ?? []),
  ]);
  const isBundleSkill = (skill: Skill) => skill.source === 'builtin' && roles.some(role => role.name === skill.name && resolve(role.path) === resolve(skill.path));
  if (!pin && !builtin && !referencedRoot && !skills.some(skill => referenced.has(skill.name) && isBundleSkill(skill))) return { workflow, skills };
  let root: string;
  if (pin) {
    root = snapshotPath(pin.ref.digest);
    await verifyBundleSnapshot(root, pin.ref.digest);
  } else {
    const snapshot = await ensureBundleSnapshot(referencedRoot, { hostWorkflow: Boolean(builtin) });
    root = snapshot.root;
    pin = { schemaVersion: 1, ref: snapshot.ref };
    await mkdir(join(dataDir, 'runs'), { recursive: true });
    try { await writeFile(path, JSON.stringify(pin), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return pinSuperpowersRun(dataDir, runId, workflow, skills);
    }
  }
  const pinnedRoles = unattendedSkills(root);
  // User-authored skills keep precedence. Only bundle-owned built-ins are replaced.
  skills = skills.map(skill => isBundleSkill(skill) || (skill.source === 'builtin' && pinnedRoles.some(role => role.name === skill.name && resolve(role.path) === resolve(skill.path)))
    ? pinnedRoles.find(role => role.name === skill.name) ?? skill : skill);
  for (const role of pinnedRoles) {
    if (!skills.some(skill => skill.name === role.name)) skills = [...skills, role];
  }
  if (builtin) {
    const pinnedWorkflow = unattendedWorkflows(root).find(candidate => candidate.name === workflow.name);
    if (!pinnedWorkflow) throw new Error('Pinned Superpowers workflow unavailable');
    workflow = pinnedWorkflow;
  } else {
    // Saved user graphs retain every node and setting; only managed asset references move.
    const redirect = (value: unknown): unknown => {
      if (typeof value === 'string') {
        for (const from of managedRoots) {
          const normalized = from.replaceAll('\\', '/').replace(/\/$/, '');
          value = (value as string).replaceAll(normalized + '/', root.replaceAll('\\', '/') + '/')
            .replaceAll(normalized.replaceAll('/', '\\') + '\\', root + '\\');
        }
        return value;
      }
      if (Array.isArray(value)) return value.map(redirect);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redirect(item)]));
      return value;
    };
    workflow = redirect(workflow) as WorkflowDef;
  }
  return { workflow, skills };
}
