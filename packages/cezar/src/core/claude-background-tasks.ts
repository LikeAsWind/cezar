/** Tracks CLI-reported background work until its result is explicitly collected.
 * Assistant prose and a completion notification alone are not exit evidence. */
export class ClaudeBackgroundTasks {
  private readonly pending: Set<string>;
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>();

  constructor(ids: readonly string[] = []) {
    this.pending = new Set(ids);
  }

  get ids(): string[] { return [...this.pending]; }

  observe(value: unknown): boolean {
    const message = object(value);
    if (!message) return false;
    const before = this.ids.join('\n');
    // Nested agents' internal commands belong to that agent, not this session.
    if (message.parent_tool_use_id) return false;
    // task_started is also progress for FOREGROUND tools. Register only tool
    // results that actually hand work back as backgroundTaskId/isAsync.
    const body = object(message.message);
    const blocks = Array.isArray(body?.content) ? body.content : [];
    for (const value of blocks) {
      const block = object(value);
      if (!block) continue;
      if (message.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.tools.set(block.id, { name: block.name, input: object(block.input) ?? {} });
      }
      if (message.type !== 'user' || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const tool = this.tools.get(block.tool_use_id);
      this.tools.delete(block.tool_use_id);
      if (block.is_error) continue;
      const result = object(message.tool_use_result) ?? object(message.toolUseResult);
      if (!result) continue;
      if (tool?.name === 'Bash') this.add(result.backgroundTaskId);
      if ((tool?.name === 'Agent' || tool?.name === 'Task') && result.isAsync === true) this.add(result.agentId);
      if ((tool?.name === 'Agent' || tool?.name === 'Task') && result.status === 'completed' && typeof result.agentId === 'string') {
        this.pending.delete(result.agentId);
      }
      const task = object(result.task);
      if (tool?.name === 'TaskOutput' && result.retrieval_status === 'success' && task &&
          ['completed', 'failed', 'stopped', 'killed'].includes(String(task.status))) {
        // Correlate with the requested id: unrelated results cannot discharge work.
        if (typeof task.task_id === 'string' && task.task_id === tool.input.task_id) this.pending.delete(task.task_id);
      }
      if (tool?.name === 'TaskStop' && typeof result.task_id === 'string' && result.task_id === tool.input.task_id) {
        this.pending.delete(result.task_id);
      }
    }
    return before !== this.ids.join('\n');
  }

  private add(value: unknown): void {
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) this.pending.add(value);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function collectBackgroundTasksInstruction(ids: readonly string[]): string {
  return `Background task results remain uncollected: ${ids.join(', ')}. Stay in this session and use TaskOutput with blocking wait to collect their terminal status and exit results before handing off. A completion notification alone is not verification. If an old task is unavailable, inspect its output and running process before deciding whether rerunning is safe; otherwise report a concrete blocker. Do not declare completion from an unknown result.`;
}
