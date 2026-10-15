import { missingCockpitMessage } from './cockpit-address.ts';

const COMMANDS = {
  'cez runs': {
    example: 'cez runs list',
    insideTask: 'this cockpit did not give the task an address. Read your own task tree with `cez task list` instead, or stop and report that the cockpit is unreachable.',
  },
  'cez task': {
    example: 'cez task tree <run id>',
    insideTask: 'this command only works inside a task run by a cockpit with dispatch on (it is on by default; CEZ_DISPATCH=0 turns it off). Do not substitute sub-agents or do the delegated work yourself: stop and report that dispatch is unavailable.',
  },
  'cez automation': {
    example: 'cez automation list',
    insideTask: 'this command only works inside a task run by a cockpit with automations on. Do not substitute a cron job, a GitHub Action or a polling script: stop and report that automations are unavailable.',
  },
};

export class CliProjectContextError extends Error {}

export function resolveCliProjectContext(
  env: { CEZ_API_URL?: string; CEZ_PROJECT_ID?: string; CEZ_TASK_ID?: string },
  command: keyof typeof COMMANDS,
): { apiUrl: string; projectId: string; apiBase: string } {
  const apiUrl = env.CEZ_API_URL?.trim().replace(/\/+$/, '');
  if (!apiUrl) throw new CliProjectContextError(missingCockpitMessage({ command, ...COMMANDS[command] }, env));
  const projectId = env.CEZ_PROJECT_ID?.trim();
  if (!projectId) throw new CliProjectContextError(`${command}: CEZ_PROJECT_ID is required; run \`cezar projects\` and select a project id`);
  return { apiUrl, projectId, apiBase: `${apiUrl}/api/v1/p/${encodeURIComponent(projectId)}` };
}
