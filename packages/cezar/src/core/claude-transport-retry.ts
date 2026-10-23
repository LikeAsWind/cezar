import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentSession, SessionOptions, ContentBlock, AgentToolCallRecord } from './agent-runner.ts';

const MAX_RETRIES = 3;

// Only backend API errors qualify. A tool's output mentioning HTTP 502 is not
// evidence that inference failed, and quota/auth failures need intervention.
function retryDelay(message: string, attempt: number): number | undefined {
  if (!/^API Error:\s*(?:(?:408|429|500|502|503|504|529)\b|Connection error\b|Request timed out\b)/i.test(message.trim())) return;
  if (/insufficient.quota|billing|credit.balance|usage.limit|quota.exceeded/i.test(message)) return;
  const retryAfter = /retry-after:\s*(\d+(?:\.\d+)?)/i.exec(message);
  const delay = Math.max(1_000 * 2 ** attempt, retryAfter ? Number(retryAfter[1]) * 1_000 : 0) + Math.floor(Math.random() * 250);
  // Node clamps overflowing timer delays to 1ms, which would violate Retry-After.
  return Number.isFinite(delay) && delay <= 2_147_483_647 ? delay : undefined;
}

/** Claude's SDK has already exhausted its HTTP retries when it emits a result
 * error. Recover the persisted conversation, never replay the opening task.
 * Codex owns its own transport recovery; this wrapper is Claude-only. */
export function retryClaudeSession(
  launch: (spec: AgentRunSpec, emit?: (event: AgentEvent) => void, opts?: SessionOptions) => AgentSession,
  spec: AgentRunSpec,
  emit?: (event: AgentEvent) => void,
  opts: SessionOptions = {},
): AgentSession {
  const started = Date.now();
  let sessionId = spec.sessionId ?? randomUUID();
  let active: AgentSession | undefined;
  let stopped = false;
  let finished = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = spec.pendingBackgroundTaskIds;
  let totalTokens = 0;
  let recovering = false;
  let queued: ContentBlock[] = [];
  const toolCalls: AgentToolCallRecord[] = [];
  const stop = (method: 'end' | 'interrupt' | 'hardStop') => {
    stopped = true;
    if (timer) clearTimeout(timer);
    wake?.();
    if (method === 'hardStop') (active?.hardStop ?? active?.interrupt)?.call(active);
    else active?.[method]();
  };
  const remaining = () => spec.timeoutMs && spec.timeoutMs > 0 ? spec.timeoutMs - (Date.now() - started) : undefined;

  const startAttempt = (attempt: number) => {
    const state: { error?: string; tokens: number } = { tokens: 0 };
    const left = remaining();
    const nextSpec: AgentRunSpec = {
      ...spec, sessionId, pendingBackgroundTaskIds: pending,
      ...(left !== undefined ? { timeoutMs: Math.max(1, left) } : {}),
      ...(attempt ? {
        resume: true,
        images: queued.filter(block => block.type === 'image'),
        userPrompt: 'The inference API failed temporarily. Continue the interrupted task from this conversation and existing work. Check completed tool results before acting; do not repeat completed commands or restart the task. Preserve the required final handoff.'
          + queued.filter(block => block.type === 'text').map(block => `\n\nUser follow-up during recovery:\n${block.text}`).join(''),
      } : {}),
    };
    active = launch(nextSpec, event => {
      if (event.type === 'session') sessionId = event.sessionId;
      if (event.type === 'error') {
        state.error ??= event.message;
        const delay = attempt < MAX_RETRIES ? retryDelay(state.error, attempt) : undefined;
        const budget = remaining();
        recovering = delay !== undefined && (budget === undefined || delay < budget);
        // Settle this process before resuming its persisted session.
        active?.end();
        return;
      }
      if (event.type === 'done' || (event.type === 'turn-end' && state.error)) return;
      if (event.type === 'token-usage') {
        state.tokens = event.tokensUsed;
        emit?.({ ...event, tokensUsed: totalTokens + state.tokens });
      } else emit?.(event);
    }, {
      ...opts,
      onBackgroundTasks: ids => { pending = ids; opts.onBackgroundTasks?.(ids); },
    });
    queued = [];
    recovering = false;
    if (attempt && active.pid !== undefined) opts.onProcessReplaced?.(active.pid);
    return Object.assign(state, { session: active });
  };
  // Preserve startSession's synchronous spawn-error contract.
  let current = startAttempt(0);
  const result = (async (): Promise<AgentRunResult> => {
    let last: AgentRunResult = { text: '', toolCalls: [], tokensUsed: 0, sessionId };
    for (let attempt = 0; ; attempt++) {
      let thrown: unknown;
      try {
        last = await current.session.result;
        sessionId = last.sessionId ?? sessionId;
        toolCalls.push(...last.toolCalls);
        current.tokens = last.tokensUsed;
      } catch (failure) {
        thrown = failure;
        current.error ??= failure instanceof Error ? failure.message : String(failure);
      }
      totalTokens += current.tokens;
      const { error } = current;
      const delay = error && attempt < MAX_RETRIES ? retryDelay(error, attempt) : undefined;
      const budget = remaining();
      if (!stopped && delay !== undefined && (budget === undefined || delay < budget)) {
        emit?.({ type: 'note', message: `推理接口暂时失败，${Math.ceil(delay / 1_000)} 秒后重试（${attempt + 1}/${MAX_RETRIES}），保留当前会话与节点。` });
        await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, delay); });
        wake = undefined;
        timer = undefined;
        const afterWait = remaining();
        if (!stopped && (afterWait === undefined || afterWait > 0)) {
          try { current = startAttempt(attempt + 1); }
          catch (failure) {
            finished = true;
            emit?.({ type: 'error', message: failure instanceof Error ? failure.message : String(failure) });
            emit?.({ type: 'done' });
            throw failure;
          }
          continue;
        }
      }
      finished = true;
      if (queued.length && !stopped) emit?.({ type: 'note', message: '接口恢复未成功，等待中的用户补充未能送达代理。' });
      if (error && !stopped) {
        emit?.({ type: 'error', message: error });
      }
      emit?.({ type: 'done' });
      if (thrown && !stopped) throw thrown;
      return { ...last, toolCalls, tokensUsed: totalTokens, sessionId };
    }
  })();
  return {
    result,
    get pid() { return active?.pid; },
    get open() { return !stopped && !finished && (recovering || !!timer || active?.open === true); },
    sendMessage: (content: ContentBlock[]) => {
      if (stopped || finished) return false;
      if (recovering || timer) { queued.push(...content); return true; }
      return active?.sendMessage(content) ?? false;
    },
    end: () => stop('end'),
    interrupt: () => stop('interrupt'),
    hardStop: () => stop('hardStop'),
  };
}
