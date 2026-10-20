import { fileURLToPath } from 'node:url';

export const WORKFLOW_ACTION_SCRIPT = fileURLToPath(new URL('../../scripts/workflow-action.mjs', import.meta.url));
const actions = ['init', 'route', 'execution', 'baseline', 'verify', 'seal'] as const;
export type WorkflowAction = typeof actions[number];
const quote = (value: string) => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
/** Host installation paths, independent of the target project's tools or skill bundle. */
export function workflowActionCommand(action: WorkflowAction): string {
  return `${quote(process.execPath)} ${quote(WORKFLOW_ACTION_SCRIPT)} ${action}`;
}
/** Exact commands only: never classify a shell suffix as a trusted action. */
export function workflowActionOf(command: string): WorkflowAction | undefined {
  const cli = /^(?:cezar|cez|cezar-cli|cezar-run)[ \t]+workflow-action[ \t]+([a-z]+)$/.exec(command)?.[1];
  return actions.find(action => command === workflowActionCommand(action) || cli === action);
}

/** Bind portable YAML commands to this installation, including copies loaded from disk. */
export function bindWorkflowActions(nodes: { type: string; command?: string; prompt?: string }[]): void {
  for (const node of nodes) {
    if (node.type === 'check' && node.command) {
      const action = workflowActionOf(node.command);
      if (action) node.command = workflowActionCommand(action);
    }
    if (node.type === 'agent' && node.prompt) {
      node.prompt = node.prompt.replace(/\b(?:cezar|cez|cezar-cli|cezar-run)[ \t]+workflow-action[ \t]+(init|route|execution|baseline|verify|seal)\b/g,
        (_match, action: WorkflowAction) => workflowActionCommand(action));
    }
  }
}
