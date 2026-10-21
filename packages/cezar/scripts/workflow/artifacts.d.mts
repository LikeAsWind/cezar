export interface ArtifactPaths {
  directory: string;
  prefix: string;
  topic: string;
  date: string;
  file(name: string): string;
  relative(name: string): string;
}
export const artifactDirectory: string;
export const artifactNames: string[];
export function artifactTopic(title?: string): string;
export function newArtifactPaths(root: string, runId: string, date?: Date, title?: string): ArtifactPaths;
export function artifactPaths(root: string, runId: string): ArtifactPaths;
export function artifactPath(root: string, runId: string, name: string): string;
