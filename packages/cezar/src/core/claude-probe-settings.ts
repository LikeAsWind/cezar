import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunSpec } from './agent-runner.ts';

/** Isolate tool policy without dropping the selected account's provider configuration.
 * Never put auth material into argv, prompts or logs. */
export function writeClaudeProbeSettings(spec: AgentRunSpec, args: string[]): { path: string; cleanup: () => void } | undefined {
  if (!spec.probePolicy) return;
  const index = args.indexOf('--settings');
  if (index < 0) throw new Error('Probe policy settings are missing');
  const policy = JSON.parse(args[index + 1]!);
  const directory = spec.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read the selected Claude account settings for probe'); }
  const providerFlags = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
  const sourceEnv = settings.env && typeof settings.env === 'object' ? settings.env as Record<string, unknown> : {};
  const cloud = providerFlags.some(key => sourceEnv[key] === '1');
  const env = Object.fromEntries(Object.entries(sourceEnv).filter(([key, value]) => typeof value === 'string'
    && (key.startsWith('ANTHROPIC_') || providerFlags.includes(key) || key === 'API_TIMEOUT_MS'
      || cloud && /^(AWS_|GOOGLE_|CLOUD_ML_|AZURE_)/.test(key))));
  const auth = Object.fromEntries(['model', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod', 'forceLoginOrgUUID']
    .filter(key => typeof settings[key] === 'string').map(key => [key, settings[key]]));
  const temporary = mkdtempSync(join(tmpdir(), 'cez-probe-settings-'));
  const path = join(temporary, 'settings.json');
  try {
    writeFileSync(path, JSON.stringify({ ...auth, env, ...policy }), { mode: 0o600 });
    args[index + 1] = path;
    return { path, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}
