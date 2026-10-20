export interface ArtifactPaths {
  directory: string;
  prefix: string;
  legacy: boolean;
  file(name: string): string;
  relative(name: string): string;
}
export const artifactDirectory: string;
export const artifactNames: string[];
export function newArtifactPaths(root: string, runId: string, date?: Date): ArtifactPaths;
export function artifactPaths(root: string, runId: string): ArtifactPaths;
export function artifactPath(root: string, runId: string, name: string): string;
