import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunSpec, AgentSession, SessionOptions } from './agent-runner.ts';
import { retryClaudeSession } from './claude-transport-retry.ts';

afterEach(() => vi.useRealTimers());

function harness(errors: string[], timeoutMs = 60_000) {
  const specs: AgentRunSpec[] = [];
  const events: AgentEvent[] = [];
  const ui: unknown[] = [];
  const pids: number[] = [];
  const launch = (spec: AgentRunSpec, emit?: (e: AgentEvent) => void, opts?: SessionOptions): AgentSession => {
    specs.push(spec);
    let open = true;
    const error = errors[specs.length - 1];
    const result = Promise.resolve().then(() => {
      emit?.({ type: 'session', sessionId: 'same-session' });
      emit?.({ type: 'token-usage', tokensUsed: 10 });
      if (error) emit?.({ type: 'error', message: error });
      opts?.onUiEvent?.({ type: 'turn.completed', turnId: 'turn', stopReason: error ? 'error' : 'end_turn' });
      emit?.({ type: 'turn-end' });
      emit?.({ type: 'done' });
      open = false;
      return { text: error ?? 'CEZ:VERDICT ready', toolCalls: [], tokensUsed: 10, sessionId: 'same-session' };
    });
    return { result, pid: 100 + specs.length, get open() { return open; }, sendMessage: () => open, end: () => { open = false; }, interrupt: () => { open = false; } };
  };
  const session = retryClaudeSession(launch, { cwd: '/worktree', userPrompt: 'original task', env: { ACCOUNT: 'fixed' }, timeoutMs }, e => events.push(e), { onUiEvent: e => ui.push(e), onProcessReplaced: pid => pids.push(pid) });
  return { session, specs, events, ui, pids };
}

describe('Claude transport recovery', () => {
  it('retries three times in the same session without publishing intermediate failures or turn ends', async () => {
    vi.useFakeTimers();
    const h = harness(Array(3).fill('API Error: 502 Upstream request failed'));
    await vi.runAllTimersAsync();
    expect((await h.session.result).text).toBe('CEZ:VERDICT ready');
    expect(h.specs).toHaveLength(4);
    expect(h.specs.slice(1).every(s => s.resume && s.sessionId === 'same-session' && s.cwd === '/worktree' && s.env?.ACCOUNT === 'fixed')).toBe(true);
    expect(h.specs[3]!.timeoutMs).toBeLessThan(60_000);
    expect(h.specs[1]!.userPrompt).not.toBe('original task');
    expect(h.events.filter(e => e.type === 'error')).toHaveLength(0);
    expect(h.events.filter(e => e.type === 'turn-end')).toHaveLength(1);
    expect(h.events.filter(e => e.type === 'done')).toHaveLength(1);
    expect(h.events.filter(e => e.type === 'token-usage').at(-1)).toEqual({ type: 'token-usage', tokensUsed: 40 });
    expect(h.ui).toHaveLength(4); // Failed API turns still account for their usage.
    expect(h.pids).toEqual([102, 103, 104]);
    expect(h.events.filter(e => e.type === 'note').map(e => e.message)).toEqual([
      expect.stringContaining('（1/3）'), expect.stringContaining('（2/3）'), expect.stringContaining('（3/3）'),
    ]);
  });

  it('publishes the final failure after retry exhaustion', async () => {
    vi.useFakeTimers();
    const h = harness(Array(8).fill('API Error: 503 Service unavailable'));
    await vi.runAllTimersAsync();
    await h.session.result;
    expect(h.specs).toHaveLength(4);
    expect(h.events.filter(e => e.type === 'error')).toEqual([{ type: 'error', message: 'API Error: 503 Service unavailable' }]);
  });

  it.each(['Not logged in · Please run /login', 'API Error: 401 unauthorized', 'API Error: 429 insufficient_quota', 'claude CLI timed out after 30m and was killed', 'tool reported HTTP 502', 'claude CLI exited with code 3221225794'])('does not retry %s', async error => {
    vi.useFakeTimers();
    const h = harness([error]);
    await vi.runAllTimersAsync();
    await h.session.result;
    expect(h.specs).toHaveLength(1);
    expect(h.events.some(e => e.type === 'error')).toBe(true);
  });

  it('cancels pending backoff immediately', async () => {
    vi.useFakeTimers();
    const h = harness(['API Error: 502 Upstream request failed']);
    await vi.advanceTimersByTimeAsync(0);
    h.session.interrupt();
    await h.session.result;
    await vi.runAllTimersAsync();
    expect(h.specs).toHaveLength(1);
    expect(h.events.some(e => e.type === 'error')).toBe(false);
  });

  it('does not extend a deadline to accommodate backoff', async () => {
    vi.useFakeTimers();
    const h = harness(['API Error: 502 Upstream request failed'], 1);
    await vi.runAllTimersAsync();
    await h.session.result;
    expect(h.specs).toHaveLength(1);
    expect(h.events.some(e => e.type === 'error')).toBe(true);
  });

  it('accepts user follow-ups and images during backoff and delivers them once on resume', async () => {
    vi.useFakeTimers();
    const h = harness(['API Error: 502 Upstream request failed']);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.open).toBe(true);
    expect(h.session.sendMessage([{ type: 'text', text: 'keep the release defaults' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'test' } }])).toBe(true);
    await vi.runAllTimersAsync();
    await h.session.result;
    expect(h.specs[1]!.userPrompt.match(/keep the release defaults/g)).toHaveLength(1);
    expect(h.specs[1]!.images).toHaveLength(1);
  });

  it('honors surfaced Retry-After and declines it when outside the remaining deadline', async () => {
    vi.useFakeTimers();
    const h = harness(['API Error: 429 overloaded; Retry-After: 20']);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.specs).toHaveLength(1);
    await vi.runAllTimersAsync();
    await h.session.result;
    expect(h.specs).toHaveLength(2);
    const expired = harness(['API Error: 503 unavailable; Retry-After: 120']);
    await vi.runAllTimersAsync();
    await expired.session.result;
    expect(expired.specs).toHaveLength(1);
  });
});
