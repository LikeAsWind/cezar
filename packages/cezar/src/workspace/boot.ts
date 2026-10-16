import { runMigrations } from './migrations.ts';

/**
 * Run pending workspace migrations. Migration failures degrade to the
 * in-memory workspace defaults; they never prevent serving or a headless run.
 * The launch directory is only migration input for the repo-scoped `run`
 * command and is never registered or selected as a workspace project.
 */
export async function initWorkspace(repoRoot?: string): Promise<void> {
  try {
    await runMigrations({ repoRoot: repoRoot ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] workspace registry unavailable (${message}) — continuing without it`);
  }
}
