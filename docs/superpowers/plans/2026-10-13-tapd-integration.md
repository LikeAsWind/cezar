# TAPD Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add public-cloud standard-project TAPD as a third issue-tracker provider with story/bug tabs, correct filtering, detail handoff, and evidence-gated event automation.

**Architecture:** Implement the existing TrackerProvider seam and reuse generic project routes, credentials, watch, composer and automation engine. One local project binds one TAPD workspace; story/bug are explicit query dimensions, not separate credential providers. Persist only validated identities and signed pagination positions; preserve Jira/Linear behavior.

**Tech Stack:** TypeScript, Zod, Hono, React, TanStack Query, Vitest/node:test. Use a maintained server-side HTML parser as a direct dependency of the server workspace if none is already directly declared; do not render vendor HTML or use regex as an HTML sanitizer.

**Spec:** `.ai/specs/2026-10-13-tapd-integration-design.md`; official evidence: `.ai/specs/2026-10-13-tapd-api-research.md`.

## Global Constraints

- Work on `codex/tapd-integration`; no remote push, PR, merge or live TAPD writes as part of implementation.
- Public cloud standard story/bug APIs only. Fixed vendor API origin `https://api.tapd.cn`; no credentials routed to custom origins or linked media.
- Construction, boot and health must cause no TAPD network requests. Use only project-local managed credentials; never mutate process.env.
- Preserve `kind: 'issue'` and old request defaults; add optional fields instead of replacing existing contracts.
- Lists are capped at 8,000 description characters, details at 60,000, task prompts at 100,000. Loss disclosure requires acknowledgment.
- Numeric vendor IDs remain strings. Internal identity is `story:<full-id>` or `bug:<full-id>`; verify type and workspace for every lookup.
- Every selected label must match (AND); Active must use actual vendor terminal statuses and workitem type. No silently incomplete first-page filtering.
- Vendor times without an offset require a verified/explicit project timezone, not host-local Date.parse. Automation capability is withheld when timestamps/history cannot be verified.
- All added UI has Chinese and English text; user content and execution prompts retain their source identity.
- Offline fixtures are synthetic unless explicitly sourced from sanitized real responses. Report real versus mocked verification separately.
- Previously observed Windows POSIX test failures are not passes; run relevant tests and report unrelated environment failures separately.

## Task 1: Typed connection and type isolation

**Files:** Modify `packages/contract/src/tracker.ts`, `packages/cezar/src/server/tracker/connection-env.ts`, `packages/web/src/lib/tracker-providers.ts`; test `packages/cezar/src/server/tracker/connection-env.test.ts` and contract consumers.

**Interfaces:** Add `TrackerKind` value `tapd`. Add `tapd` credentials with `companyId`, `apiUser`, `apiPassword`, and an explicitly selected vendor `timeZone` if real evidence cannot establish it. Add optional `itemType: 'story' | 'bug'` to tracker list/search/watch inputs, and optional display metadata to TrackerItem. Existing Jira/Linear requests remain unchanged.

- [ ] Write failing storage/contract tests. Use literal credentials, never actual secrets:

```ts
const record = {
  id: randomUUID(), projectRoot: '/tmp/tapd-project',
  credentials: { kind: 'tapd' as const, companyId: '10104801', apiUser: 'test-api', apiPassword: 'synthetic#=password', timeZone: 'Asia/Shanghai' },
};
expect(decodeConnectionEnv(encodeConnectionEnv(record))).toEqual(record);
expect(trackerWatchInputSchema.safeParse({ association: { kind: 'tapd', source: { id: 'tapd-company:10104801', webUrl: 'https://www.tapd.cn' }, externalId: '10104802', externalName: 'Example' }, query: '', state: 'active', labels: [], itemType: 'bug' }).success).toBe(true);
```

Also test apiUser colon/control rejection, invalid company ID, invalid timezone, unknown dotenv keys, mixed provider keys, secret-only manual edits and revision invalidation. Preserve existing Jira/Linear digest byte order.

- [ ] Run `npm test -- packages/cezar/src/server/tracker/connection-env.test.ts --maxWorkers=2`, confirm TAPD fails for unsupported credentials rather than test syntax.
- [ ] Add finite Zod variants and explicit three-way credential codec branches. Managed keys: `TAPD_COMPANY_ID`, `TAPD_API_USER`, `TAPD_API_PASSWORD`, `TAPD_TIME_ZONE`. Preserve previous format version and old strict inventories. Keep timezone nonsecret but revision-bound.
- [ ] Add TAPD metadata with translated scope terminology. Register a credential-free TAPD dry fixture in `dry-run.ts`; story and bug rows must have distinct typed IDs, over 50 rows and lossy/long detail fixtures. Do not map every non-Jira branch to Linear.
- [ ] Run storage and dry-run tests. Typecheck failures from the newly exhaustive enum identify remaining registration/automation sites; resolve them in Tasks 2/4 before declaring this task integrated.

## Task 2: Read-only adapter with correct pages and content

**Files:** Create `packages/cezar/src/server/tracker/tapd.ts`, `tapd.test.ts`, `tapd-html.ts`, `tapd-html.test.ts`; modify `tracker/index.ts` and only the server package manifest/lock if a parser dependency is needed.

**Interfaces:** `createTapdClient(config, fetcher): TrackerProvider`, where config is the TAPD credential variant without `kind`. Consume TrackerHttp, ResultCache, runOperation, requestFailure and signed cursors. HTML converter returns `{ body: string; unsupportedContent: boolean }`, then descriptionBody applies existing caps.

- [ ] Write a protocol-aware fetch fixture that checks fixed URL, GET method, Basic auth, query scope and response envelope. Use official shapes:

```ts
const story = { id: '1010104801124922063', workspace_id: '10104801', workitem_type_id: '1010104801000022091', name: 'Unicode 需求', description: '<p>Acceptance</p>', creator: 'test', created: '2026-10-13 08:00:00', modified: '2026-10-13 09:00:00', status: 'planning', label: 'backend|urgent' };
const response = new Response(JSON.stringify({ status: 1, data: [{ Story: story }], info: 'success' }), { headers: { 'content-type': 'application/json' } });
```

Test empty vs unauthorized, HTTP 200 business failure, malformed schema, foreign workspace, expired/cross-type cursors, label AND match after an entire nonmatching page, Unicode, duplicate boundary IDs, full detail freshness, over-cap body, redirects and cooldown.

- [ ] Run the new tests and confirm the adapter is absent, then add implementation using explicit GET paths: `/workspaces/projects`, `/workspaces/get_workspace_info`, `/stories`, `/bugs`, `/workflows/status_map`, `/workflows/last_steps`, and verified story-type metadata. Workspace lookup revalidates `company_id` before accepting association or reads.
- [ ] Validate envelope success with `status === 1`; never pass `info` or authentication-test payload to UI/logs. Avoid `/quickstart/testauth` unless its entire password-echoing payload can be discarded. Bound metadata reads by the same operation deadline and cache generation.
- [ ] Implement signed per-type page/row-position cursors. Prefer upstream filters; for label AND or type-specific Active filtering, scan further pages server-side until a displayed page fills or the upstream finishes. Persist safe scan continuation when the soft budget runs out. If no existing response field correctly represents scan-incomplete status, add a bounded optional field in the contract and explicit Continue scanning UI; never return a completed empty result.
- [ ] Keep search semantics honest: ID search is exact; title and description searches must not be combined as AND while labeled full-text OR. Implement explicit search-field selection if the vendor cannot express the expected union without a new multi-stream query.
- [ ] Map status per workspace/system/workitem type. Read `last_steps` for terminal codes; unsupported or missing metadata produces a controlled failure rather than guessed Active status. Decode pipe-delimited labels only after fixture validation; preserve exact names and reject ambiguous unsafe filter syntax.
- [ ] Implement parsed HTML whitelist conversion retaining paragraphs, lists, code, tables and safe links. Scripts/events/unsafe links are omitted and flagged. Images and rich embeds are not downloaded and require loss disclosure. Test hostile HTML, entity encoding, deep nesting, fences, long tables and length limits.
- [ ] Register the factory in `tracker/index.ts`. Validate candidate search over the complete bounded project collection and sign pagination offsets; reject truncated vendor response instead of pretending discovery finished. Rerun Jira/Linear adapter tests alongside TAPD.

## Task 3: Settings, browser and handoff parity

**Files:** Modify `routes/settings/tracker-section.tsx`, `routes/tracker/tracker.tsx`, `api/client.ts`, `api/queries.ts`, `api/tracker-watch.ts`, `server/tracker/watch.ts`, `lib/tracker-task.ts` where necessary; extend existing tests and `lib/i18n/zh-CN.json`.

**Interfaces:** Add optional itemType to browser request params and watch inputs. For TAPD, default list type is story; deep-link typed ID selects the correct resource. Browser query keys and watch normalized identity include type. The generic API routes remain the only route family.

- [ ] Write a settings test selecting TAPD and posting typed credentials, asserting GET never contains them and the password clears after failure/save/cancel/project switch.
- [ ] Write a route test switching story→bug with one workspace, confirming separate HTTP queries and keys; a delayed story response cannot populate the bug list. Changing type resets paging and selected labels, while per-ID instruction drafts cannot cross types.
- [ ] Write a handoff regression against actual `extractTaskRefs`: `tracker ticket [bug:1010104801124922063]` must not become a GitHub issue reference. Legitimate GitHub references in user text remain unchanged. Verify long detail, acknowledgment and final user instruction order.
- [ ] Implement translated form fields API account, API password, company ID and explicit timezone; do not ask for ordinary website password. Show API prerequisite help without embedding secrets in links.
- [ ] Implement story/bug tabs, type-aware requests and watch checks. Preserve the 60-second visible first-page checks, Load more/Show changes semantics and no periodic full-detail refresh.
- [ ] Use verified canonical public story/bug URLs. Before live validation, mark URL compatibility unverified in handoff docs instead of claiming tested links; do not shorten long IDs.
- [ ] Run `npm test -- packages/web/src/routes/settings/tracker-section.test.tsx packages/web/src/routes/tracker packages/web/src/lib/tracker-task.test.ts packages/cezar/src/server/tracker/watch.test.ts --maxWorkers=2 --testTimeout=15000`. Run scoped API/contract parity and isolation tests.

## Task 4: Automation capability and history scanner

**Files:** Create `server/tracker/tapd-events.ts` and its tests; modify `server/tracker/event-scan.ts`, `types.ts`, `agent-credentials.ts`, `automations/event-source.ts`, `types.ts`, `task-template.ts`, automation options/trigger contract and editor/CLI consumers.

**Interfaces:** Extend provider enums exhaustively and add type to event input/options/trigger. `pollEvents(input): Promise<PollPage<TrackerEventCandidate>>` preserves scanner semantics. `automationOptions` returns only proven events and explicit limitations. Type change resets the event-source baseline.

- [ ] Write tests for immutable creation, A→B→A→B within one polling interval, description-only history, type-scoped status IDs, midnight-spanning day scans, two-page histories, late indexing overlap, page failure and soft-budget resume. Fixtures use documented WorkitemChange and BugChange envelopes with stable IDs and explicit validated time conversion.
- [ ] Run new tests red. Implement separate story and bug history mappers: `/story_changes` field_changes entries versus `/bug_changes` field/old_value/new_value. Scan the required calendar dates and all pages; filter exact UTC instants; never derive status transitions from modified or current state.
- [ ] Persist successful page progress on budget yield; advance watermark only after the interval completes. Source/auth/cancel failure cannot masquerade as successful partial progress. Compose event identity from provider/company/workspace/type/item/history/field; no numeric coercion.
- [ ] Reuse TrackerPoller requiredLabels AND and targetStatusIds filtering. Give type-specific states compound identity when raw codes collide. Maintain preview no-launch behavior, enable current-time baseline, receipts, definition edits, pause/re-enable and checkpoint recovery.
- [ ] Add capability gates: creation requires trustworthy timestamps and page discovery; status requires complete history evidence; label transitions remain unavailable without verified history encoding. Synthetic mapper tests alone must not unlock unsupported capabilities.
- [ ] Replace two-provider ternaries in the options editor, environment resolver and task-template hints with exhaustive provider handling. Only a captured, revalidated automation connection may provide `TAPD_API_USER`/`TAPD_API_PASSWORD`/company/timezone to its agent. Manual handoff stays credential-free. Add both secrets to known-secret redaction paths; no credential fallback on rotation.
- [ ] Run tracker/automation option, poller, receipt, project-isolation and credentials/redaction tests. Test old Jira/Linear saved definitions without type fields.

## Task 5: Verification, documentation and live acceptance

**Files:** Update `docs/issue-trackers.md`, `docs/adding-issue-tracker.md`, README feature notes and dry-run fixtures/tests. No live project is a test fixture.

- [ ] Document actual implemented search semantics, scan-incomplete continuation, API permissions, project category, timezone configuration, loss disclosure and event limitations. Document only capabilities the adapter advertises.
- [ ] Run `npm run typecheck`, focused tracker/contract/automation/UI regression, `npm run build`, `npm run check:pack`; separately report Windows POSIX baseline failures without weakening assertions.
- [ ] Test the real local UI with synthetic credentials in an isolated CEZ_HOME/dry-run instance: configure, bind, switch types, search, load more, read details, handoff draft, disconnect; verify Chinese labels and no browser secret persistence. Never create an actual paid agent task during UI validation.
- [ ] With user-provided credentials entered through Settings, perform authorized read-only probes: workspace/company, one story and bug, more than one page, exact links, label readback, terminal metadata and known timestamp. Do not create records or enable real automations without separate user authorization.
- [ ] Record offline vs live results. If tenant access is unavailable, deliver implementation with explicit unverified capabilities; do not mark status-event parity complete. Leave changes on the feature branch for review; do not push or merge without user request.

## Execution checks

- [ ] Every Task 1–4 regression demonstrates red before implementation.
- [ ] Each new query dimension travels through contract, client, cache key, watch identity and event baseline, not just the visible tabs.
- [ ] No non-Jira→Linear fallthrough remains for TAPD credentials, labels, automation templates or dry-run registration.
- [ ] No TODO/TBD implementation placeholders, silent unsupported filters, guessed terminal states, raw HTML rendering or host-local timestamp parsing.
- [ ] No actual credentials, authenticated upstream payloads or real user state included in fixtures, logs or commits.
