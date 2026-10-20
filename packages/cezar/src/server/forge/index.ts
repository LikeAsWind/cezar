import { parseRemote } from '../../git-remotes.ts';
import type { RepoInfo } from '../git.ts';
import { createGithubDriver } from './github.ts';
import { createGitlabDriver } from './gitlab.ts';
import { knownGitlabHost } from './gitlab-hosts.ts';
import type { ForgeDriver, ForgeKind } from './types.ts';

/**
 * Forge resolution (cockpit-ui redesign spec §"Forge-driver seam"): map the
 * selected remote to a driver (spec 2026-10-16-gitlab-forge-parity).
 * Workspace health carries no project forge identity.
 */

export { parseRemote, type ParsedRemote } from '../../git-remotes.ts';

/** GitLab additionally resolves instances discovered from glab's local metadata. */
const FORGE_HOSTS: Record<string, ForgeKind> = { 'github.com': 'github' };

/**
 * Which forge a remote URL belongs to, without building a driver (#698): the
 * registry's per-project probe warms local host metadata before classification.
 * This synchronous path never shells out or probes a remote.
 */
export function forgeKindOfRemote(remote: string | undefined): ForgeKind | null {
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed) return null;
  return FORGE_HOSTS[parsed.host]
    ?? (parsed.host === 'gitlab.com' || knownGitlabHost(parsed) ? 'gitlab' : null);
}

/**
 * A remote's web root — `https://github.com/owner/repo` — or null for anything not on a known
 * forge host.
 *
 * Built from the PARSED remote, never by string-editing the raw one, and that is the point: a
 * remote may carry credentials (`https://user:token@github.com/o/r.git`), and this is a value the
 * cockpit renders and links to. Rebuilding it from `{host, owner, repo}` leaves nothing to leak.
 */
export function forgeWebRoot(remote: string | undefined): string | null {
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed) return null;
  if (FORGE_HOSTS[parsed.host] === 'github') return `https://${parsed.host}/${parsed.owner}/${parsed.repo}`;
  const host = knownGitlabHost(parsed);
  const origin = host?.webOrigin ?? (parsed.host === 'gitlab.com' ? 'https://gitlab.com' : null);
  return origin ? `${origin}/${parsed.projectPath}` : null;
}

/** Remote host → driver | null, using previously warmed local host metadata. */
export function resolveForge(repoInfo: RepoInfo | null): ForgeDriver | null {
  if (!repoInfo?.remote) return null;
  const parsed = parseRemote(repoInfo.remote);
  if (!parsed) return null;
  if (FORGE_HOSTS[parsed.host] === 'github') {
    return createGithubDriver(repoInfo.root, { owner: parsed.owner, repo: parsed.repo });
  }
  const host = knownGitlabHost(parsed);
  if (host || parsed.host === 'gitlab.com') {
    return createGitlabDriver(repoInfo.root, { host: host?.host ?? 'gitlab.com', projectPath: parsed.projectPath,
      webOrigin: host?.webOrigin ?? 'https://gitlab.com' });
  }
  return null;
}

export type { ForgeDriver, ForgeAvailability, ForgeItem, ForgeKind, ForgePrStatus, ForgeRefKind, GitlabRepoRef } from './types.ts';
