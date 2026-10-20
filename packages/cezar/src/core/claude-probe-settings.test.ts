import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildClaudeArgs } from './claude-cli-runner.ts';
import { writeClaudeProbeSettings } from './claude-probe-settings.ts';

it('preserves selected-account provider auth/model without restoring tool permissions or exposing credentials in argv', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-probe-auth-'));
  let file: ReturnType<typeof writeClaudeProbeSettings> = undefined;
  try {
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'fixture-auth', ANTHROPIC_BASE_URL: 'https://provider.invalid', ANTHROPIC_DEFAULT_OPUS_MODEL: 'provider-model', CLAUDE_CODE_DISABLE_ALL_HOOKS: '1', UNRELATED_SECRET: 'fixture-unrelated' },
      model: 'opus', apiKeyHelper: 'approved-account-helper', permissions: { defaultMode: 'bypassPermissions' }, hooks: { PreToolUse: [] }, mcpServers: { arbitrary: {} },
    }));
    const spec = { userPrompt: 'probe', cwd: root, env: { CLAUDE_CONFIG_DIR: root }, probePolicy: { root, runId: 'probe-run' } };
    const args = buildClaudeArgs(spec);
    file = writeClaudeProbeSettings(spec, args);
    expect(file).toBeDefined();
    const settings = JSON.parse(readFileSync(file!.path, 'utf8'));
    expect(settings.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'fixture-auth', ANTHROPIC_BASE_URL: 'https://provider.invalid', ANTHROPIC_DEFAULT_OPUS_MODEL: 'provider-model' });
    expect(settings.model).toBe('opus');
    expect(settings.apiKeyHelper).toBe('approved-account-helper');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('probe-policy.mjs');
    expect(settings.permissions).toBeUndefined();
    expect(settings.mcpServers).toBeUndefined();
    expect(args.join(' ')).not.toContain('fixture-auth');
    expect(args[args.indexOf('--settings') + 1]).toBe(file!.path);
    expect(writeClaudeProbeSettings({ userPrompt: 'normal', cwd: root }, [])).toBeUndefined();
    file!.cleanup(); file = undefined;
  } finally { file?.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
