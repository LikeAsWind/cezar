# TAPD public-cloud API research

Research date: 2026-10-13. Scope: `www.tapd.cn` public cloud, classic story/bug APIs. This is an evidence note, not an implementation. No authenticated tenant was accessed; documented examples are not proof of the user's tenant permissions or configuration.

## Authentication and discovery

Use fixed `https://api.tapd.cn` upstream and HTTP Basic authentication with **API account/API password**, not a normal login password. The official guide's testauth example actually echoes the API password: never expose or log its response. Parse the `{status,info,data}` envelope; HTTP success alone does not establish API success (`status === 1` does). Commercial API access must be enabled by a company administrator. Credentials stay in the existing managed server-side connection store, never browser state, prompts, process.env, errors or telemetry.

Sources: [API configuration](https://open.tapd.cn/document/api-doc/API文档/API配置指引.html), [usage prerequisites](https://open.tapd.cn/document/api-doc/API文档/使用必读.html).

Two discovery APIs must not be conflated. `GET /workspaces/projects` requires **company_id**, returning the company's matching project collection without pagination; it is the proposed default, subject to the API account's actual permission. `GET /workspaces/user_participant_projects` instead requires **company_id and member nick**, returning a particular member's projects. API account name is not documented as the member nick; that alternative needs a separate user-provided nick. A site root cannot discover company/project IDs. `GET /workspaces/get_workspace_info?workspace_id=...` verifies a known project and returns name, category, company ID and normal/closed/suspend status. If company-wide discovery is denied, report that permission limitation; a manually supplied project ID can be verified as an explicit alternative, not a silently invented discovery result.

Sources: [company projects](https://open.tapd.cn/document/api-doc/API文档/api_reference/workspace/projects.html), [participant projects](https://open.tapd.cn/document/api-doc/API文档/api_reference/workspace/user_participant_projects.html), [workspace information](https://open.tapd.cn/document/api-doc/API文档/api_reference/workspace/get_workspace_info.html).

## List, detail, identity and filtering

`GET /stories` and `/bugs` require workspace_id. Detail is the same list endpoint filtered by id, not an assumed `/stories/:id`. Wrappers differ (`Story` versus `Bug`); title is name versus title. Preserve IDs as strings: documented IDs exceed JavaScript safe integer precision. Proposed internal item identity: `story:<full-id>` / `bug:<full-id>` within the bound workspace; never strip prefixes or derive one type from numeric shape.

Both list APIs accept status, label, created, modified and description filtering; title searches use name/title respectively. Story defaults to 30, maximum 200, and page begins at 1. Counts have separate endpoints. The verified story parameter table documents page/order, not a universal ID-cursor interface; use signed cezar cursors wrapping verified vendor page positions. A vendor ID-cursor strategy requires separate endpoint evidence and tenant validation, including compatible ordering. Do not blend two paginated upstream streams by merely concatenating one page of each: retain per-type positions/buffers and a deterministic merge order.

Sources: [stories](https://open.tapd.cn/document/api-doc/API文档/api_reference/story/get_stories.html), [bugs](https://open.tapd.cn/document/api-doc/API文档/api_reference/bug/get_bugs.html), [story count](https://open.tapd.cn/document/api-doc/API文档/api_reference/story/get_stories_count.html).

Label values in the official bug example are pipe-separated. Story create/update docs also specify pipes. This describes representation, **not AND semantics**. Enumerated query values separated by `|` mean OR. `;` is documented as AND only for multi-person queries. Special `CONTAINS<...>` is explicitly restricted to multi-select custom fields, not built-in label. For cezar's all-selected-label semantics, prefilter one label upstream and perform exact-set intersection locally, continuing bounded pages to fill a result page. If exhaustive evaluation exceeds a safety bound, return explicit partial/error semantics, never a falsely complete result.

Sources: [usage/query grammar](https://open.tapd.cn/document/api-doc/API文档/使用必读.html), [story labels](https://open.tapd.cn/document/api-doc/API文档/api_reference/story/add_story.html), [bug label representation](https://open.tapd.cn/document/api-doc/API文档/api_reference/bug/get_bugs.html).

Field metadata is available from `/stories/get_fields_info` and `/bugs/get_fields_info`; label options are named strings, unlike Jira/Linear opaque label IDs. Retain exact names; never comma-split arbitrary values. Readback fixtures must verify empty/trailing separators and encoding.

Sources: [story fields](https://open.tapd.cn/document/api-doc/API文档/api_reference/story/get_story_fields_info.html), [bug fields](https://open.tapd.cn/document/api-doc/API文档/api_reference/bug/get_bug_fields_info.html).

## Workflow status correctness

`/workflows/status_map` maps raw codes to names; it does not identify active or completed categories. `/workflows/last_steps` returns terminal statuses. Fetch both with system=story/bug and, for stories, workitem_type_id. The status-map documentation says this ID is required for story queries despite marking it optional in the table. Obtain types from story field metadata. Cache metadata by workspace/system/type, not just workspace. Two story types can use the same raw status code with different meaning; avoid flattening contradictory status categories. Unknown metadata should remain unknown rather than marking all statuses active. Parallel workflows distinguish status from step; do not treat a completed node as an ended item.

Sources: [status map](https://open.tapd.cn/document/api-doc/API文档/api_reference/workflow/get_workflow_status_map.html), [terminal states](https://open.tapd.cn/document/api-doc/API文档/api_reference/workflow/get_workflow_last_steps.html), [transitions/parallel workflows](https://open.tapd.cn/document/api-doc/API文档/api_reference/workflow/get_workflow_all_transitions.html).

## Automation event evidence

Creation events can come from items' immutable created timestamps and stable full IDs, fetched using created windows; don't synthesize them from first-seen records or last modified. Status events need history, not two polling snapshots: snapshots miss intermediate/repeated transitions.

`/story_changes` requires created day or story_id, maximum 100/page. Its example wrapper is `WorkitemChange`, with id, story_id, created, workitem_type_id and field_changes entries (`field`, `value_before`, `value_after`). `changes` is additionally JSON encoded; prefer validated field_changes. Filter actual status fields; change_summary is not a reliable substitute. `/bug_changes` requires created day or bug_id, maximum 200/page; wrapper `BugChange` includes id, bug_id, created, field, old_value/new_value. include_add_bug=1 can include creations, but creation detection should use the item endpoint consistently.

Sources: [story history](https://open.tapd.cn/document/api-doc/API文档/api_reference/story/get_story_changes.html), [bug history](https://open.tapd.cn/document/api-doc/API文档/api_reference/bug/get_bug_changes.html).

History endpoints specifically require day-formatted created queries; don't assume generic datetime range grammar applies. Enumerate touched calendar days, exhaust pages for each, exact-filter instants and deduplicate by workspace/type/history ID. For multiple status field changes in one history entry, add a stable field index/code to the event key. Persist completed-page progress when yielding near a soft deadline, but advance the final watermark only after the entire interval completes. Request/auth/source failures must not be converted to successful progress. Use overlapping windows to catch delayed rows, and existing no-backlog baseline behavior on enable/re-enable. Probe/document tenant history availability before advertising status-change support.

## Unverified or deliberately bounded claims

- Timestamp samples are `YYYY-MM-DD HH:mm:ss`, without offset. Checked official pages do not establish timezone. Do not use host-local Date parsing or silently treat them as UTC. Verify against a tenant item/history whose actual timestamp is known before enabling date-sensitive automation; proposed China-cloud timezone is Asia/Shanghai, explicitly an unverified assumption.
- Canonical detail web URLs were not established by the checked API docs. Common path patterns must be validated against an actual story and bug URL, including custom story types. Do not shorten full IDs heuristically.
- Description content may include rich HTML. Convert safely to Markdown/plain text with a parsed whitelist; strip scripts/events and dangerous URL schemes, retain code/list structure, cap size. Do not auto-download authenticated images or leak credentials to linked domains. This is a proposed security requirement, not a claim that the API always emits one format.
- The [official error guide](https://open.tapd.cn/document/api-doc/API文档/API错误码.html) documents 401 authentication, 404 invalid workspace, 422 parameters, 429 rate limits, and 500/502 overload. It gives a default 60 requests/minute and an account-specific 6000/10-minute example; the page was last updated in 2023, so treat the default as a conservative planning budget, not a guaranteed current entitlement. Retry-After behavior and envelope numeric failure mappings remain unverified. Bound timeout/concurrency/retries and cache metadata; history scans share the account budget with interactive reads.
- A [removed-bug example](https://open.tapd.cn/document/api-doc/API文档/api_reference/bug/get_removed_bugs.html) contains `/755/bugtrace/bugs/view?bug_id=1100000755500695186`, establishing that this historical bug URL shape uses the full ID. Its example host is internal `tiger.oa.com`, not proof of canonical current public-cloud URLs; validate `www.tapd.cn` paths against actual links before claiming stable story/bug navigation.
- No real credentials were supplied, so permissions, history retention, cursor compatibility on specific history endpoints, labels readback and custom workflow behavior still need fixtures/live acceptance. API docs contain contradictory examples (history calls omit the now-required selectors); implement stated requirements and test them rather than copying stale curl lines.
- Scope does not include lite-collaboration APIs, private deployment, state writes/comments, or webhooks. Matching current read-only adapters is not a promise of every TAPD platform feature.

## Acceptance probes before production use

Verify authenticated project discovery + direct project validation; story/bug detail and exact full-ID URL; >1-page lists and history; Unicode/all-label intersection; two story types sharing a raw status name; custom terminal state and parallel nodes; timestamp timezone and midnight-spanning lookback; repeated A→B→A→B transitions within one poll; delayed history; partial request failure with no checkpoint advance; credential redaction and hostile HTML. Offline fixtures can pin all of these once sanitized examples are available.
