# Task 8 report — explicit project routing (8A)

Baseline: started at `33f49fd`. The required scan was run before edits: 394 matching lines across 90 files. The scan results were classified as follows:

- Maintained contract and executable A behavior: current architecture prose in `AGENTS.md`, `CLAUDE.md`, `BACKWARD_COMPATIBILITY.md`, `docs/reference.md`, the English/Chinese READMEs; browser default-alias and legacy-flat selection behavior in `packages/web/src/routes.tsx` and `project-router.tsx`; bookmarklet generation; and unit/e2e expectations. Updated these to require a registered project ID or present project choices without changing the requested URL.
- Historical material retained: Task 8 design/spec/plans under `docs/superpowers/` and older dated specifications/changelog entries remain historical; they were not rewritten to claim the new behavior existed earlier.
- Intentional negative tests retained: the `/p/default` UI case now asserts that the slug is not resolved to a real project; API/client tests that assert absent project scope is rejected remain.
- B-side and neutral explicit-context hits retained: boot identity used to start/register/pin a server project, coordinator/agent-account behavior, optional legacy response fields, and test fixtures that merely name an explicit project ID were not changed. See the follow-on inventory below.

## 8A changes

- Removed single-project router guessing, the positive `/p/default` browser alias, and legacy flat project-page redirects. Unmatched/flat project paths now preserve the URL and offer registered project links.
- Bookmarklets require a project ID and always emit `/p/<id>/new`; flat saved URLs do not open a project composer implicitly.
- Updated route, resolver, bookmarklet, settings/skills, quick-list, smoke, and bookmarklet e2e expectations. Component-level project tests now use explicit fixture IDs and project-scoped API paths.
- Reconciled maintained architecture/docs and fixed `cockpit-address.ts` to require `CEZ_PROJECT_ID` for project CLI commands.
- The API inventory guard exposed 12 existing omissions (e2e, secrets, tracker, and run-history paths) in `BACKWARD_COMPATIBILITY.md` §2; these were added to the maintained route inventory.

## Verification

- RED/GREEN: route/resolver/bookmarklet tests failed against the previous routing behavior after expectations changed, then passed with the implementation update.
- Focused 8A route/resolver/bookmarklet/settings/skills/tester-army suites: 229 tests passed across 9 files. The retry-on-error case was also rerun individually after synchronizing on the enabled retry control: passed.
- Required guards: 27 tests passed across `bc-route-inventory`, `versioned-surface`, design guardian, and i18n coverage. The route inventory initially failed on 12 unlisted endpoints; it passed after documenting them.
- `npm run typecheck --workspace=@open-mercato/cezar-web`: passed.
- `git diff --check`: passed.

## Follow-on B inventory (not changed)

- `packages/cezar/src/workspace/boot.ts`, `src/index.ts`, `src/workspace/projects.ts`, and `src/workspace/projects-cli.ts` (and their tests): boot registration/identity and project-list pinning.
- `packages/cezar/src/automations/coordinator.ts` (and tests): pinned boot project lifecycle.
- `packages/cezar/src/server/server.ts`, `src/server/project-context.ts`, and server tests including `route-parity.test.ts`, `runs-index-api.test.ts`, `workspace-events.test.ts`, and `usage-scope.test.ts`: server construction/context/route aliases and boot-owned state.
- `packages/contract/src/health.ts` and `src/projects.ts`, with contract-pipeline fixtures: optional legacy boot-project fields.
- `packages/cezar/src/workspace/agent-accounts.ts`, `src/core/provider-auth.ts`, and their related tests: account/provider resolution against boot project context.
- `packages/web/src/api/client.ts`, `queries.ts`, `project-scope-context.tsx`, `global-events.tsx`, and dependent fixtures/tests still contain boot-scope behavior or historical model references. Their implementation semantics were not changed in 8A; a follow-on should classify them against the approved server/pinning decision before removal.

Remaining scan hits are intentional historical material, explicit negative tests, neutral project-ID fixtures/names, and the B inventory above. No B behavior was touched.

## Task 8B — remove server boot-project semantics

Baseline: started from cce424f, after the 8A browser/docs work. The 8B candidate inventory was classified before editing:

- Real boot privilege removed: initWorkspace registered/refreshed the launch directory; serve had a CEZ_SINGLE_PROJECT registration exception; the CLI could pin/hide its project list by launch ID; default was reserved from the project allocator; automation coordination preserved a synthetic pinned ID; and project settings could display/edit a synthetic unregistered launch-folder row.
- Real contract remnants removed: optional health.bootProject and projects[].unregistered response fields. Agent-profile selection now documents an explicit registered ID; default remains valid only when it is an actual registry ID.
- Already registry/context-based, retained: project route resolution and lazy ProjectContext construction use an explicit registered route ID; registry mutation, registration APIs, and project detail functionality remain. Agent-account realpath matching remains because it reconciles spelling variations of the same registered root, not a boot selection. CEZ_SINGLE_PROJECT remains a mutation/folder-browsing restriction and no longer seeds or identifies a project.
- Neutral names retained: test route IDs such as boot and coordinator fixture IDs remain where they are explicit test contexts. No mass rename was made.

### 8B changes

- initWorkspace(repoRoot?) now runs migrations only; repository-root context is passed only by the explicit headless run flow for migration import. serve always runs migrations without a repository root and never registers or selects its working directory.
- Removed shouldAutoRegisterProject, launch-ID list filtering, and the default allocator reservation. cez projects list reports the registry as-is, including in single-project mode; an empty registry gives an add-project instruction.
- Removed the automation coordinator's pinned-ID exemption and winner priority. It sweeps and schedules only registered project sources.
- Removed the optional contract fields, synthetic unregistered settings row, and UI behavior that treated the launch directory as addable-but-not-registered. Registered project settings and explicit Add remain.
- Updated server/workspace/UI comments and fixtures where they described launch-project behavior. Focused tests prove that default is accepted as a project only when explicitly registered.

### TDD and verification

- RED was observed before production changes: boot tests failed because initialization registered/refreshed a project; contract shape tests found both legacy fields; and CLI single-project listing hid the registry. Coordinator tests covered eviction of stale IDs. The agent-profile alias test also failed with 404 for default when that ID was not registered, confirming the alias had already ceased to be a real route behavior.
- GREEN: focused web contract/UI suites passed (145 tests); agent-profile/automation API suites passed (71 tests); contract/server parity and surface guards passed (21 tests); the single-project CLI registry-listing test passed; boot migration/registration behavior tests passed.
- npm run typecheck for @open-mercato/cezar-contract, @open-mercato/cezar, and @open-mercato/cezar-web passed.
- The broader focused filesystem test batches also encountered Windows-only environment failures: symlink creation returns EPERM, path casing differs between short and long user-profile names, and read-only directory permission tests do not behave as POSIX. These failures are outside the changed behavior; the CLI listing test was rerun alone and passed. No test was loosened for these environment-specific cases.

### Self-review and remaining scan hits

- Production scan (bootProjectId|bootProject|boot alias|boot project|boot-project|unregistered.*boot|boot.*unregistered|shouldAutoRegisterProject|pinned?: string) found no remaining positive boot-project selection, construction, registration, or coordinator behavior.
- Remaining source matches are explanatory negative statements (no implicit project / no health-derived alias), explicit migration compatibility language, and the registry-only removal UI's statement that serving does not re-register a folder. Historical Task 8 specifications and explicit fixture route IDs are unchanged.
- git diff --check is part of pre-commit verification; Task 8B is committed separately with subject refactor: remove boot project semantics.
