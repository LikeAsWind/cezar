import { fileURLToPath } from 'node:url';
import type { AgentBackend, AgentRunSpec } from './agent-runner.ts';

export const PROBE_TIMEOUT_MS = 8 * 60_000;
export const PROBE_POLICY_SCRIPT = fileURLToPath(new URL('../../scripts/probe-policy.mjs', import.meta.url));
const quote = (value: string) => {
  if (/[\r\n\0'"`$%!^&|<>]/.test(value)) throw new Error('Probe policy paths contain unsupported shell characters');
  return `'${value.replaceAll('\\', '/')}'`;
};
export const probeVersionPrefix = () => `${quote(process.execPath)} ${quote(PROBE_POLICY_SCRIPT)} version`;

/** A backend must opt in to enforcing this policy; tool allowlists are not portable. */
export function assertProbeSupport(backend: AgentBackend, policy: AgentRunSpec['probePolicy']): void {
  if (policy && backend !== 'claude' && backend !== 'claude-cli') throw new Error(`Backend ${backend} cannot enforce the project-probe tool boundary. Select Claude for the probe node; other stages may retain their selected backend.`);
}

export function claudeProbeArgs(policy: NonNullable<AgentRunSpec['probePolicy']>): string[] {
  const command = `${quote(process.execPath)} ${quote(PROBE_POLICY_SCRIPT)} hook ${quote(policy.root)} ${quote(policy.runId)} ${quote(String(Date.now()))}`;
  return ['--tools', 'Read,Glob,Grep,Write,Edit,Bash', '--disallowedTools', 'mcp__*,Agent,Task,Skill',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--settings', JSON.stringify({ disableAllHooks: false, hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 10 }] }] } })];
}
