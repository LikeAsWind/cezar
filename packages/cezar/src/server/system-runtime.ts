import { ProviderAuthService } from '../core/provider-auth.ts';
import { cezarHomeDir } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { listProjects } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { ProjectContexts, type ProjectContextSource } from './project-context.ts';
import type { AutomationStore } from '../automations/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { ProviderRuntimeAuthObserver } from './provider-auth-runtime.ts';
import type { WorkspaceEventName } from './server.ts';

export interface WorkspaceEvents {
  emit(event: WorkspaceEventName, data: unknown): void;
  on(listener: (event: WorkspaceEventName, data: unknown) => void): () => void;
}

/** Manager factory seam (route tests): see `ProjectContextDeps.managerFactory`. */
export type ManagerFactory = (
  store: RunStore,
  root: string,
  opts: { semaphore: WorkspaceSemaphore; projectId: string },
) => RunManager;

export interface SystemRuntimeDeps {
  listProjects?: () => Promise<readonly ProjectContextSource[]>;
  openStore?: typeof RunStore.open;
  semaphore?: WorkspaceSemaphore;
  workspaceEvents?: WorkspaceEvents;
  providerAuth?: ProviderAuthService;
  providerRuntimeAuth?: ProviderRuntimeAuthObserver;
  contexts?: ProjectContexts;
  /** Shared automation store factory — the workspace automation coordinator's
   *  per-root store, so API mutations and scheduler reads never diverge. */
  automationStore?: (projectId: string, root: string) => AutomationStore;
  /** Manager factory seam (route tests): see `ProjectContextDeps.managerFactory`. */
  managerFactory?: ManagerFactory;
}

export interface SystemRuntime {
  semaphore: WorkspaceSemaphore;
  contexts: ProjectContexts;
  workspaceEvents: WorkspaceEvents;
  providerAuth: ProviderAuthService;
  providerRuntimeAuth: ProviderRuntimeAuthObserver;
  start(): Promise<void>;
  dispose(): void;
}

export function createSystemRuntime(deps: SystemRuntimeDeps = {}): SystemRuntime {
  const semaphore = deps.semaphore ?? new WorkspaceSemaphore();
  const workspaceEvents = deps.workspaceEvents ?? createWorkspaceEvents();
  const providerAuth = deps.providerAuth ?? new ProviderAuthService({ cwd: cezarHomeDir() });
  const providerRuntimeAuth = deps.providerRuntimeAuth ?? new ProviderRuntimeAuthObserver(
    providerAuth,
    (status) => workspaceEvents.emit('provider-status', status),
  );
  const contexts = deps.contexts ?? new ProjectContexts({
    listProjects: deps.listProjects ?? listProjects,
    openStore: deps.openStore,
    semaphore,
    automationStore: deps.automationStore,
    managerFactory: deps.managerFactory,
  });

  contexts.onStoreCreated((store) => providerRuntimeAuth.watch(store));

  return {
    semaphore,
    contexts,
    workspaceEvents,
    providerAuth,
    providerRuntimeAuth,
    async start() {
      await semaphore.refresh();
    },
    dispose() {
      contexts.disposeAll();
    },
  };
}

function createWorkspaceEvents(): WorkspaceEvents {
  const listeners = new Set<(event: WorkspaceEventName, data: unknown) => void>();
  return {
    emit(event, data) {
      for (const listener of [...listeners]) listener(event, data);
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
