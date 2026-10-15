/** The version prefix shared by workspace and project API paths. */
export const API_PREFIX = '/api/v1';

/** Address a project explicitly; callers supply a project-relative route. */
export function projectApiPath(projectId: string, path: string): string {
  if (projectId === '') throw new Error('projectId is required');
  const relative = path.replace(/^\/+/, '');
  return `${API_PREFIX}/p/${encodeURIComponent(projectId)}${relative ? `/${relative}` : ''}`;
}

/** A persisted asset URL names its owning project and encodes each path segment. */
export function runAssetPath(projectId: string, runId: string, filename: string): string {
  return projectApiPath(projectId, `/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(filename)}`);
}
