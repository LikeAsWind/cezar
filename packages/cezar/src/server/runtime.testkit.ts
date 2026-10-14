import type { AutomationStore } from '../automations/store.ts';
import type { ProviderAuthService } from '../core/provider-auth.ts';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { ProjectContexts } from './project-context.ts';
import { createSystemRuntime, type SystemRuntime, type WorkspaceEvents } from './system-runtime.ts';

/**
 * Build a `SystemRuntime` for route tests (Tasks 2–3 removed the boot
 * store/manager/contexts/semaphore/workspaceEvents deps from `createApp`, so a
 * suite that used to inject `{ repoRoot, store, manager, … }` now injects one
 * `runtime`). The runtime's context map resolves ONE synthetic project over the
 * caller's temp `repoRoot`, reusing the caller's own `store`/`manager`/
 * `automationStore`/`semaphore`/`workspaceEvents` so seeded runs and captured
 * start-inputs stay observable.
 */
export interface TestRuntimeOptions {
  repoRoot?: string;
  store?: RunStore;
  manager?: RunManager;
  automationStore?: AutomationStore;
  semaphore?: WorkspaceSemaphore;
  workspaceEvents?: WorkspaceEvents;
  contexts?: ProjectContexts;
  providerAuth?: ProviderAuthService;
}

export function testRuntime(options: TestRuntimeOptions = {}): SystemRuntime {
  const { repoRoot, store, manager, automationStore, semaphore, workspaceEvents, contexts, providerAuth } = options;
  const runtimeContexts = contexts ?? new ProjectContexts({
    listProjects: async () =>
      repoRoot ? [{ id: 'boot', root: repoRoot, status: 'ok' as const }] : [],
    openStore: store ? () => store : undefined,
    managerFactory: manager ? () => manager : undefined,
    automationStore: automationStore ? () => automationStore : undefined,
    semaphore,
  });
  return createSystemRuntime({
    contexts: runtimeContexts,
    semaphore,
    workspaceEvents,
    providerAuth,
  });
}
