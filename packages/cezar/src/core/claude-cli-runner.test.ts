import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import {
  buildClaudeArgs,
  CLAUDE_HEADLESS_GUIDANCE,
  ClaudeCliRunner,
  appendClaudeSystemPrompt,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.ts';
import type { UiEvent } from './ui-events.ts';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning its real stub binary through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | ((args: readonly string[]) => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (spawnHook.override) return spawnHook.override(Array.isArray(args[1]) ? args[1] : []);
      // Windows cannot execute a fixture's Node shebang directly.
      if (process.platform === 'win32' && typeof args[0] === 'string' && args[0].endsWith('.mjs')) {
        return actual.spawn(process.execPath, [args[0], ...(Array.isArray(args[1]) ? args[1] : [])], args[2]);
      }
      return actual.spawn(...args);
    },
  };
});

it('recovers a real stream-json API failure by resuming, preserving the node until the verdict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-retry-'));
  const bin = join(dir, 'retry.mjs');
  writeFileSync(bin, `
    import { createInterface } from 'node:readline';
    const resumed = process.argv.includes('--resume');
    const send = value => console.log(JSON.stringify(value));
    createInterface({ input: process.stdin }).on('line', () => {
      send({type:'system', subtype:'init', session_id:'existing-session', tools:[]});
      send({type:'assistant', message:{role:'assistant', content:[{type:'text', text:resumed ? 'CEZ:VERDICT ready' : 'API Error: 502 Upstream request failed'}]}});
      send({type:'result', subtype:resumed ? 'success' : 'error_during_execution',
        is_error:!resumed, result:resumed ? 'CEZ:VERDICT ready' : 'API Error: 502 Upstream request failed'});
    }).on('close', () => process.exit(0));
  `);
  try {
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const session = new ClaudeCliRunner({ bin }).startSession(
      { cwd: dir, userPrompt: 'work', sessionId: 'existing-session', timeoutMs: 15_000 },
      event => events.push(event),
      { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) },
    );
    expect((await session.result).text).toBe('CEZ:VERDICT ready');
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    expect(events.filter(e => e.type === 'turn-end')).toHaveLength(1);
    expect(events.filter(e => e.type === 'note' && e.message.includes('1/3'))).toHaveLength(1);
    expect(ui.filter(e => e.type === 'turn.completed' && e.stopReason === 'error')).toHaveLength(1);
    const turnIds = ui.filter(e => e.type === 'turn.started').map(e => e.turnId);
    expect(turnIds).toHaveLength(2);
    expect(new Set(turnIds).size).toBe(2);
    const messageIds = ui.flatMap(e => e.type === 'item.completed' && e.item.kind === 'message' ? [e.item.id] : []);
    expect(messageIds).toHaveLength(2);
    expect(new Set(messageIds).size).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

/**
 * The per-backend system-prompt delivery mechanism (spec §protocol v2
 * mapping table): claude gets `--append-system-prompt`, codex/opencode get
 * the prompt prepended to the opening user message (`prependSystemPrompt`,
 * shared by both runners).
 */
describe('buildClaudeArgs systemPrompt', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('spawns long system prompts through a file and cleans it when spawn fails', () => {
    const prompt = '原始探测指令\n'.repeat(10_000);
    let captured: readonly string[] = [];
    let file = '';
    let content = '';
    spawnHook.override = args => {
      captured = args;
      const index = args.indexOf('--append-system-prompt-file');
      if (index >= 0) {
        file = args[index + 1]!;
        content = readFileSync(file, 'utf8');
      }
      throw new Error('fixture spawn failure');
    };
    try {
      expect(() => new ClaudeCliRunner({ bin: 'claude' }).startSession({ cwd: process.cwd(), userPrompt: 'probe', systemPrompt: prompt })).toThrow('fixture spawn failure');
      expect(captured).toContain('--append-system-prompt-file');
      expect(captured.join(' ').length).toBeLessThan(8_000);
      expect(content).toBe(appendClaudeSystemPrompt(prompt));
      expect(existsSync(file)).toBe(false);
    } finally { spawnHook.override = null; }
  });

  it('emits --append-system-prompt with the exact text', () => {
    const args = buildClaudeArgs({ ...spec, systemPrompt: 'Extra rules.\n\n---\n\nContract.' });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(appendClaudeSystemPrompt('Extra rules.\n\n---\n\nContract.'));
  });

  it('always appends Claude-local headless denial guidance', () => {
    const args = buildClaudeArgs(spec);
    const idx = args.indexOf('--append-system-prompt');
    expect(args[idx + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
  });

  it('preserves caller instructions before the backend guidance', () => {
    expect(appendClaudeSystemPrompt('Caller rules.')).toBe(
      `Caller rules.\n\n---\n\n${CLAUDE_HEADLESS_GUIDANCE}`,
    );
  });

  it('uses the same guidance for a resumed call without changing resume args', () => {
    const initial = buildClaudeArgs({ ...spec, sessionId: 'session-1' });
    const resumed = buildClaudeArgs({ ...spec, sessionId: 'session-1', resume: true });
    expect(initial[initial.indexOf('--append-system-prompt') + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(resumed[resumed.indexOf('--append-system-prompt') + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(initial).toContain('--session-id');
    expect(resumed).toContain('--resume');
  });
});

describe('buildClaudeArgs output mode', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('runs in print mode, which both stream-json formats require', () => {
    expect(buildClaudeArgs(spec)).toContain('--print');
  });

  it('asks for partial messages so text streams as deltas', () => {
    expect(buildClaudeArgs(spec)).toContain('--include-partial-messages');
  });
});

describe('buildClaudeArgs approval gate', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('denies unapproved tools without prompting by default', () => {
    const args = buildClaudeArgs(spec, {});
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
  });

  it('enables Claude approval prompts only when explicitly requested', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });
});

describe('host probe policy', () => {
  it('keeps shell and writes unapproved unless the hook explicitly grants the call, including approval-gate mode', () => {
    const args = buildClaudeArgs({ userPrompt: 'probe', cwd: '/repo', probePolicy: { root: '/repo', runId: 'probe-run' }, allowedTools: ['Bash', 'Write', 'Agent'] }, { CEZ_APPROVAL_GATE: '1' });
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Write,Edit,Bash');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('mcp__*');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('.*');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('probe-policy.mjs');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('progress checkpoint');
    expect(buildClaudeArgs({ userPrompt: 'implement', cwd: '/repo', allowedTools: ['Bash'] })).not.toContain('--settings');
  });
});

/**
 * #703 — a session cezar tore down itself must not settle as an agent
 * failure. Every agent CLI installs its own stop-signal handler and exits
 * `128 + signal`, so the runner sees a NON-ZERO code for a teardown it
 * asked for (goal achieved → `end()`, or a user cancel → `interrupt()`).
 */
describe('isSignalTerminationExit', () => {
  it('recognizes the 128+signal codes a signalled CLI reports', () => {
    expect(isSignalTerminationExit(130)).toBe(true); // SIGINT
    expect(isSignalTerminationExit(137)).toBe(true); // SIGKILL
    expect(isSignalTerminationExit(143)).toBe(true); // SIGTERM
  });

  it('leaves genuine failures and clean exits alone', () => {
    for (const code of [0, 1, 2, 127, null]) {
      expect(isSignalTerminationExit(code)).toBe(false);
    }
  });
});

describe('a teardown cezar initiated', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url),
  );

  // Windows terminates the process instead of invoking a POSIX SIGTERM handler.
  it.skipIf(process.platform === 'win32')('settles the session instead of failing it when the CLI exits 143', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `signalChild`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('work done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      uiEvents.some((event) => event.type === 'turn.completed' && event.stopReason === 'error'),
    ).toBe(false);
    expect(uiEvents).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);
});

/**
 * #844 — the watchdogs used to ask `!child.killed` before escalating, but Node
 * sets `killed` the moment a signal is *delivered*. claude installs its own
 * SIGTERM handler, so the flag went true while the process ran on and the
 * SIGKILL that exists for exactly that case was never sent — one leaked CLI per
 * teardown. The escalation now follows real termination instead.
 */
describe('SIGTERM→SIGKILL escalation for a CLI that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4242,
      // Node's semantics: delivery flips `killed`; a CLI with its own handler
      // keeps running with `exitCode` still null.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it('escalates after end() even though Node already flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the wall-clock timeout path as well', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('keeps the timeout kill armed after stdout closes asynchronously', async () => {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({ userPrompt: 'probe', cwd: process.cwd() });
      void session.result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
      fake.exit(137);
      await session.result;
    } finally { vi.useRealTimers(); spawnHook.override = null; }
  });

  it('stops escalating once the CLI really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('stops accepting messages once the child has exited on its own', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      expect(session.open).toBe(true);
      fake.exit(1);

      expect(session.open).toBe(false);
      expect(session.sendMessage([{ type: 'text', text: 'are you there?' }])).toBe(false);
    });
  });
});

describe('prependSystemPrompt (codex/opencode delivery)', () => {
  it('prepends the prompt as a leading block of the first user message', () => {
    expect(prependSystemPrompt('Extra rules.', 'do it')).toBe('Extra rules.\n\n---\n\ndo it');
  });

  it('leaves the user prompt untouched when no systemPrompt is set', () => {
    expect(prependSystemPrompt(undefined, 'do it')).toBe('do it');
  });
});

describe('ClaudeCliRunner token usage', () => {
  it('counts the aggregate result usage without re-adding assistant-frame snapshots', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-token-usage-'));

    try {
      const result = await runner.run(
        {
          userPrompt: 'fix the login redirect',
          cwd,
          env: {
            CEZ_HANDOFF_FILE: '',
            CEZ_MOCK_ARGS_FILE: '',
            CEZ_TODOS_FILE: '',
          },
          sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
        },
        (event) => events.push(event),
      );

      // The mock emits four assistant usage snapshots before its aggregate
      // result usage (1,270 input + 185 output). Only the result is authoritative.
      expect(result.tokensUsed).toBe(1_455);
      expect(events.filter((event) => event.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 1_455 },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('ClaudeCliRunner private MCP (spec 2026-10-07-private-project-mcp)', () => {
  it('spawns with --mcp-config pointing at a 0600 file that is gone once the session ends', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-private-mcp-'));
    const argsFile = join(cwd, 'args.ndjson');
    try {
      await runner.run({
        userPrompt: 'do it',
        cwd,
        systemPrompt: 'Preserve the original workflow instructions.\n'.repeat(2_000),
        env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: argsFile, CEZ_TODOS_FILE: '' },
        allowedTools: ['Read'],
        mcpServers: [{ name: 'tracker', transport: 'stdio', command: 'tracker-mcp', args: [], env: { TOKEN: 's3cret' }, headers: {} }],
      });
      const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n')[0]!) as string[];
      const configPath = argv[argv.indexOf('--mcp-config') + 1]!;
      expect(argv).toContain('--mcp-config');
      expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,mcp__tracker');
      expect(argv.join(' ')).not.toContain('s3cret');
      expect(existsSync(configPath)).toBe(false);
      expect(argv).toContain('--append-system-prompt-file');
      expect(existsSync(argv[argv.indexOf('--append-system-prompt-file') + 1]!)).toBe(false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
