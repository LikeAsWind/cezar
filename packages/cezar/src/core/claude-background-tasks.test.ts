import { describe, expect, it } from 'vitest';
import { ClaudeBackgroundTasks } from './claude-background-tasks.ts';

const call = (name: string, input: object, id = 'tool-1') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (metadata: object, id = 'tool-1', isError = false) => ({ type: 'user', tool_use_result: metadata, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'tool output' }] } });
const collected = (status = 'completed', id = 'bg-1') => ({ retrieval_status: 'success', task: { task_id: id, status, exitCode: 0 } });

describe('Claude background task evidence', () => {
  it('tracks automatic Bash backgrounding from native metadata, not assistant prose', () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'task bg-1 completed' }] } });
    expect(tasks.ids).toEqual([]);
    tasks.observe(call('Bash', { command: 'mvn test' }));
    expect(tasks.observe(result({ backgroundTaskId: 'bg-1' }))).toBe(true);
    expect(tasks.ids).toEqual(['bg-1']);
  });

  it.each(['completed', 'failed', 'stopped', 'killed'])('collects a matching terminal TaskOutput result: %s', status => {
    const tasks = new ClaudeBackgroundTasks(['bg-1']);
    tasks.observe(call('TaskOutput', { task_id: 'bg-1', block: true }));
    expect(tasks.observe(result(collected(status)))).toBe(true);
    expect(tasks.ids).toEqual([]);
  });

  it('retains work after a notification, incomplete result, error or unrelated task result', () => {
    const tasks = new ClaudeBackgroundTasks(['bg-1']);
    tasks.observe({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' });
    for (const [metadata, error] of [[collected('running'), false], [collected(), true], [collected('completed', 'other'), false], [{ retrieval_status: 'timeout' }, false]] as const) {
      tasks.observe(call('TaskOutput', { task_id: 'bg-1' }));
      tasks.observe(result(metadata, 'tool-1', error));
      expect(tasks.ids).toEqual(['bg-1']);
    }
  });

  it('tracks asynchronous agents while ignoring progress announcements and nested tools', () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe({ type: 'system', subtype: 'task_started', task_id: 'agent-1' });
    tasks.observe(call('Agent', { run_in_background: true }));
    tasks.observe(result({ isAsync: true, agentId: 'agent-2' }));
    tasks.observe({ ...result({ backgroundTaskId: 'nested' }), parent_tool_use_id: 'agent-tool' });
    expect(tasks.ids).toEqual(['agent-2']);
  });

  it('does not turn foreground Bash progress into an uncollectable background task', () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe(call('Bash', { command: 'mvn test', timeout: 600000 }));
    expect(tasks.observe({ type: 'system', subtype: 'task_started', task_id: 'b1g3xyile', tool_use_id: 'tool-1', task_type: 'local_bash' })).toBe(false);
    tasks.observe(result({ stdout: 'Tests run: 297, Failures: 0, Errors: 0, Skipped: 9', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }));
    expect(tasks.ids).toEqual([]);
  });

  it('recognizes foreground agent completion and explicit successful stop', () => {
    const tasks = new ClaudeBackgroundTasks(['agent-1', 'bg-1']);
    tasks.observe(call('Agent', {}));
    tasks.observe(result({ status: 'completed', agentId: 'agent-1' }));
    tasks.observe(call('TaskStop', { task_id: 'bg-1' }));
    tasks.observe(result({ task_id: 'bg-1' }));
    expect(tasks.ids).toEqual([]);
  });

  it('salvages unknown and malformed wire frames without inventing completion', () => {
    const tasks = new ClaudeBackgroundTasks(['bg-1']);
    for (const value of [null, [], {}, { message: { content: [null, {}, []] } }, { type: 'system', subtype: 'task_started', task_id: '../bad' }]) {
      expect(tasks.observe(value)).toBe(false);
    }
    expect(tasks.ids).toEqual(['bg-1']);
  });
});
