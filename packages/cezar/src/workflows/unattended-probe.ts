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
import { artifactNames, artifactPaths } from '../../scripts/workflow/artifacts.mjs';
import { discoverJavaLocations } from './probe-tools.ts';
import { WORKFLOW_ACTION_SCRIPT } from './workflow-actions.ts';

const exec = promisify(execFile);
export function artifactInstructions(cwd: string, runId: string): string {
  let paths;
  try { paths = artifactPaths(cwd, runId); }
  catch (error) {
    if (error instanceof Error && error.message === 'Run artifacts have not been initialized') return 'Run artifacts were not initialized. Report the failed initialization through CEZ_HANDOFF_FILE; never invent another run context.';
    throw error;
  }
  return `This run's artifact map (repository-relative paths):\n${JSON.stringify(Object.fromEntries(artifactNames.map(name => [name, paths.relative(name)])), null, 2)}\nAll short artifact names in role instructions are logical aliases for these exact paths. Never write a bare probe.md/plan.md or invent another date prefix. Read this run's run.json to confirm identity. Publish formal task/subagent reports under docs/superpowers/${paths.prefix}-tasks/ and reference them from implementation.md/ledger.md. Original upstream helpers may keep their private transient workspace; publish their reports here without altering vendored helpers.`;
}

/** A single selected JDK also reaches implementation's direct test commands. Never pick among different JDKs. */
export async function unattendedToolchainEnv(dataDir: string, runId: string, cwd: string, env: Record<string, string>): Promise<Record<string, string>> {
  let record;
  try { record = z.object({ schemaVersion: z.literal(1), runId: z.literal(runId), root: z.string(), plan: z.string() }).parse(JSON.parse(await readFile(join(dataDir, 'runs', `${runId}.unattended.json`), 'utf8'))); }
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

export async function prepareUnattendedProbe(dataDir: string, runId: string, cwd: string, backend: AgentBackend, hostActions = false): Promise<{ policy: NonNullable<AgentRunSpec['probePolicy']>; timeoutMs: number; instructions: string }> {
  const policy = { root: cwd, runId };
  assertProbeSupport(backend, policy);
  let script = WORKFLOW_ACTION_SCRIPT;
  if (!hostActions) {
    const pin = z.object({ schemaVersion: z.literal(1), ref: superpowersBundleRefSchema }).parse(JSON.parse(await readFile(join(dataDir, 'runs', `${runId}.superpowers.json`), 'utf8')));
    const root = snapshotPath(pin.ref.digest);
    script = existsSync(join(root, 'workflow.json')) ? WORKFLOW_ACTION_SCRIPT : join(root, 'runtime.mjs');
  }
  await exec(process.execPath, [script, 'init'], {
    cwd, env: { ...process.env, CEZ_RUN_ID: runId, CEZ_TASK_ID: runId }, timeout: 15_000, windowsHide: true,
  });
  const locations = await discoverJavaLocations();
  return { policy, timeoutMs: PROBE_TIMEOUT_MS, instructions: `Host initialized this run's dated discovery artifacts under docs/superpowers/probe/. Do not run init again. ${artifactInstructions(cwd, runId)}\nUse Read/Glob/Grep to investigate; Write/Edit only the mapped request.md, probe.md, context-map.jsonl, environment.json and routing-input.json. Host-discovered installed Java/Maven locations (paths only, versions still require a version query): ${JSON.stringify(locations)}. Use these observed locations before any guess; do not recursively scan installation directories. Grep must name a specific file or module subdirectory; root-wide Grep and external Glob are rejected. After two minutes, further source reads require saved nonempty probe.md and context-map.jsonl; write evidence-backed partial reports before continuing, never fabricate entries. The only Bash command permitted is exactly:\n${probeVersionPrefix()} '<installed executable name or absolute path>' '<--version or -version or -v>' '<absolute Java home or empty string>'\nUse single quotes exactly, one call at a time, no cd, exports, redirects, chaining or project wrappers. Paths containing shell metacharacters are unsupported. Each query stops after 15 seconds. No compile/test/setup/download/copy/delegation. Record uncertainty and external blockers without trying to repair them. This stage has an 8 minute wall-clock limit; complete reports and hand off rather than trying to make tests pass.` };
}
