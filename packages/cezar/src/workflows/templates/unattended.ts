import type { WorkflowGraphFile } from '../graph.ts';

/** Canonical built-in template. Snapshot serialization is owned by the host. */
export const UNATTENDED_TEMPLATE: WorkflowGraphFile = {
  version: 2,
  name: 'unattended',
  description: 'Superpowers；自动探测目标项目环境与验证命令，按复杂度走三档无人值守链路，交付到 review。',
  nodes: [
    {
      id: 'start',
      type: 'start',
    },
    {
      id: 'probe',
      type: 'agent',
      name: '需求与项目环境探测',
      skill: 'cezar:project-probe',
      prompt: `The host initializes this run before launch. Perform only the supplied project-probe role and obey the host tool boundary and deadline. Discover commands, never compile/test or repair the environment during probe.
Original task (save verbatim in request.md):
{{task}}`,
      verdicts: ['ready', 'blocked'],
    },
    {
      id: 'baseline',
      type: 'check',
      name: '项目编译与测试基线',
      command: 'cezar workflow-action baseline',
    },
    {
      id: 'route',
      type: 'check',
      name: '按探测证据选择复杂度',
      command: 'cezar workflow-action route',
    },
    {
      id: 'route-fast',
      type: 'if',
      name: '简单任务直接规划，其余进入设计',
      condition: {
        kind: 'output',
        ref: 'route.output',
        op: 'equals',
        value: 'fast',
      },
    },
    {
      id: 'fast-plan',
      type: 'agent',
      name: '轻量计划',
      skill: 'superpowers:writing-plans',
      prompt: `Fill its original header, Global Constraints, Review Focus, Files, Interfaces, checkboxes, exact signatures/tests and verification steps from the actual approved-by-machine design. Save to context plan.md (the user's workflow supplies this path override). For fast, request.md is the spec; a single well-specified task is sufficient. Do not expand fast into speculative architecture.

Self-review using the upstream checklist. Carry AGENTS.md's default-path guarantees and relevant workspace/API boundaries into Global Constraints. Its interactive execution-method handoff is replaced by the route: fast/standard native; deep SDD. The next cezar node is already the selected executor.

Recheck routing-input.json against the planned file set and risk; rerun cezar workflow-action route and return its actual tier. A larger tier enters design/SDD as wired. Before leaving standard's complete plan stage, a fast result is retained as standard (update route.json through the host action with standard as the previous tier, not by hand editing the tier). In practice this node is reached only after a standard/deep route or an upgrade. If the plan cannot be made unambiguous, blocked.


Current node:
This is the fast branch; write the smallest complete plan using the upstream format. Return the actual route tier.

If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: fast-plan, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.`,
      verdicts: ['fast', 'standard', 'deep', 'blocked', 'question'],
    },
    {
      id: 'design',
      type: 'agent',
      name: '设计与需求消歧',
      skill: 'superpowers:brainstorming',
      prompt: `Use the supplied original brainstorming skill to clarify the stored request one question at a time. The respondent is the separate adjudicator node, not the human and not yourself. Read request.md, probe.md, relevant context-map.jsonl rows, clarification.md when present, and actual source as needed.

If an answer is needed, write exactly one pending question with a stable Q-number to question.md: the question, why it matters, and any relevant evidence paths. Preserve prior questions/answers in clarification.md. Do not answer your own question, batch several questions, invent user preferences, or use CEZ:ASK. End this turn with CEZ:VERDICT question; cezar runs the adjudicator and returns here with the answer.

On re-entry, read the recorded answer and cited sources, incorporate it, and continue the original brainstorming conversation/playback. Reject an answer that conflicts with the request or lacks necessary evidence; ask a specific follow-up or return blocked. Previously answered questions without new contradictory evidence must not be asked again. A material product choice absent from the request and evidence stays blocked.

When clarification and playback are complete, write design.md using the original format. Distinguish explicit requirements, evidence-backed rulings and reversible builder choices. Mark resolved requirementsClear in routing-input.json and rerun cezar workflow-action route if scope changed, never downgrading the route. Keep ledger.md up to date. Return ready only when no question remains unresolved. cezar supplies the independent builder check next; do not dispatch it yourself or write product code.

Previous builder feedback (may require another question through the same adjudicator):
{{nodes.builder.summary}}
Latest adjudicator response (empty on first entry):
{{nodes.adjudicator.summary}}

If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: design, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.`,
      verdicts: ['ready', 'question', 'blocked'],
    },
    {
      id: 'clarification-round',
      type: 'loop',
      name: '最多八轮按需裁决',
      max: 8,
    },
    {
      id: 'adjudicator',
      type: 'agent',
      name: '按需需求与技术裁决',
      prompt: 'Answer only the pending question.md using the supplied adjudicator role. Its origin must be one of: design, fast-plan, plan, execute-fast, execute-standard, execute-deep, execute-deep-native, fix. Do not choose a different caller. After recording the answer, return CEZ:VERDICT answered for origin design, or CEZ:VERDICT <origin> for any other allowed caller. If origin is missing/invalid, the question is unresolved, or evidence/authority is insufficient, return CEZ:VERDICT blocked. The graph returns to the caller; never perform its task yourself.',
      verdicts: ['answered', 'fast-plan', 'plan', 'execute-fast', 'execute-standard', 'execute-deep', 'execute-deep-native', 'fix', 'blocked'],
      skill: 'cezar:adjudicator',
    },
    {
      id: 'builder',
      type: 'agent',
      name: '独立设计可实现性检查',
      skill: 'superpowers:builder-check',
      prompt: `Use the supplied original builder template with [DOMAIN] = software engineer and [DOCUMENT_PATH] = the host artifact map's design.md path under docs/superpowers/specs/.

Return the original question report, followed by approve for "nothing important left", changes for answerable design gaps, or blocked for an unsafely unanswerable requirement. One design revision is wired by cezar; no human approval is implied. This node is read-only.


Current node:
Use the original builder-check-prompt.md; judge the current design in a fresh context.`,
      verdicts: ['approve', 'changes', 'blocked'],
    },
    {
      id: 'design-retry',
      type: 'loop',
      name: '一次设计修订',
      max: 1,
    },
    {
      id: 'plan',
      type: 'agent',
      name: '完整实现计划',
      skill: 'superpowers:writing-plans',
      prompt: `Fill its original header, Global Constraints, Review Focus, Files, Interfaces, checkboxes, exact signatures/tests and verification steps from the actual approved-by-machine design. Save to context plan.md (the user's workflow supplies this path override). For fast, request.md is the spec; a single well-specified task is sufficient. Do not expand fast into speculative architecture.

Self-review using the upstream checklist. Carry AGENTS.md's default-path guarantees and relevant workspace/API boundaries into Global Constraints. Its interactive execution-method handoff is replaced by the route: fast/standard native; deep SDD. The next cezar node is already the selected executor.

Recheck routing-input.json against the planned file set and risk; rerun cezar workflow-action route and return its actual tier. A larger tier enters design/SDD as wired. Before leaving standard's complete plan stage, a fast result is retained as standard (update route.json through the host action with standard as the previous tier, not by hand editing the tier). In practice this node is reached only after a standard/deep route or an upgrade. If the plan cannot be made unambiguous, blocked.


Current node:
Use writing-plans verbatim and the checked design. Recheck route before returning standard or deep; never downgrade.

Before returning deep, write execution-input.json: schemaVersion: 1, tasksIndependent: true/false/null based on the plan's actual dependencies, subagents: {available: true/false/null, tool: observed tool name or null, evidence: concrete observation or the specific unavailable/unknown capability}. Never infer dispatch capability from a backend brand or claim a tool you cannot see. The next host command chooses SDD only when tasks are independent and a real dispatch tool is available; otherwise deep retains its risk constraints and runs native.

If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: plan, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.`,
      verdicts: ['standard', 'deep', 'blocked', 'question'],
    },
    {
      id: 'execute-fast',
      type: 'agent',
      name: '轻量 native 执行',
      skill: 'superpowers:executing-plans',
      prompt: `Apply the selected execution skill to plan.md and the current tier.

Also read the upstream TDD and verification-before-completion skills as the executor requires. Apply their ledger, pre-flight, task-brief, evidence and bounded repair procedures. Keep role templates verbatim while filling only their documented placeholders. Do not replace combined v7 task review with invented role prompts. Use the actual selected model inventory for explicit worker model selection and escalation; record choices and capability failures.

Use plan.md as the plan identity. Original helpers create their own per-plan .superpowers/sdd directory; keep its original ledger and copy references/progress into this workflow's ledger.md for other nodes. Preserve reports instead of deleting the plan's workspace. Task reviews must see the whole task delta, including uncommitted files if commits were deferred under the shared unattended handoff rules; generate an equivalent diff package rather than passing an empty commit range.

If findings expand scope, update the context map/routing inputs and rerun cezar workflow-action route BEFORE continuing beyond the current tier. Return standard/deep for a genuine upgrade and preserve completed task ledger rows so replanning does not redo them. deep stays deep. Do not use arbitrary tier changes as retries.

Write implementation.md with original task report paths, ledger path, actual test/TDD evidence, outstanding findings and task base/head/worktree ranges. All tasks complete is not a final whole-branch approval: stop before the upstream final review seat and return complete so host verification and the independent cezar reviewer execute. Return blocked for an unresolved original stop condition, missing capability, or load-bearing open issue; do not route those as complete.


Current node:
Tier fast; execute the plan through the original executing-plans skill. Return before its final review seat.

If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: execute-fast, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.`,
      verdicts: ['complete', 'standard', 'deep', 'blocked', 'question'],
    },
    {
      id: 'execute-standard',
      type: 'agent',
      name: '标准 native 执行',
      skill: 'superpowers:executing-plans',
      prompt: `Apply the selected execution skill to plan.md and the current tier.

Also read the upstream TDD and verification-before-completion skills as the executor requires. Apply their ledger, pre-flight, task-brief, evidence and bounded repair procedures. Keep role templates verbatim while filling only their documented placeholders. Do not replace combined v7 task review with invented role prompts. Use the actual selected model inventory for explicit worker model selection and escalation; record choices and capability failures.

Use plan.md as the plan identity. Original helpers create their own per-plan .superpowers/sdd directory; keep its original ledger and copy references/progress into this workflow's ledger.md for other nodes. Preserve reports instead of deleting the plan's workspace. Task reviews must see the whole task delta, including uncommitted files if commits were deferred under the shared unattended handoff rules; generate an equivalent diff package rather than passing an empty commit range.

If findings expand scope, update the context map/routing inputs and rerun cezar workflow-action route BEFORE continuing beyond the current tier. Return standard/deep for a genuine upgrade and preserve completed task ledger rows so replanning does not redo them. deep stays deep. Do not use arbitrary tier changes as retries.

Write implementation.md with original task report paths, ledger path, actual test/TDD evidence, outstanding findings and task base/head/worktree ranges. All tasks complete is not a final whole-branch approval: stop before the upstream final review seat and return complete so host verification and the independent cezar reviewer execute. Return blocked for an unresolved original stop condition, missing capability, or load-bearing open issue; do not route those as complete.


Current node:
Tier standard; execute the plan through the original executing-plans skill. Return before its final review seat.

If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: execute-standard, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.`,
      verdicts: ['complete', 'deep', 'blocked', 'question'],
    },
    {
      id: 'execution-route',
      type: 'check',
      name: '按任务依赖与能力选择执行器',
      command: 'cezar workflow-action execution',
    },
    {
      id: 'execution-sdd',
      type: 'if',
      name: '独立任务且具备派发能力',
      condition: {
        kind: 'output',
        ref: 'execution-route.output',
        op: 'equals',
        value: 'sdd',
      },
    },
    {
      id: 'execute-deep-native',
      type: 'agent',
      name: '复杂任务 native 执行（保留高风险约束）',
      skill: 'superpowers:executing-plans',
      prompt: `Tier deep, native fallback. Read execution.json and record why SDD was not selected. Apply the original executing-plans skill to plan.md in this context, with all deep risk and target-version constraints intact. Read the original TDD and verification skills. Do not pretend per-task subagents or independent task reviews ran. Keep ledger.md and implementation.md with actual tests, findings and report paths. Stop before final whole-branch review; cezar runs host verification and the independent reviewer next. Never downgrade the risk tier or weaken the frozen validation plan.

If a specific unresolved question blocks progress, write one question.md with a Q-number and origin: execute-deep-native, evidence and the single question; return question. On re-entry read clarification.md and resume completed work from the ledger. Return blocked when evidence or authority is insufficient.`,
      verdicts: ['complete', 'question', 'blocked'],
    },
    {
      id: 'execute-deep',
      type: 'agent',
      name: '复杂 SDD 逐任务实现与审查',
      skill: 'superpowers:subagent-driven-development',
      prompt: `Apply the selected execution skill to plan.md and the current tier.

Also read the upstream TDD and verification-before-completion skills as the executor requires. Apply their ledger, pre-flight, task-brief, evidence and bounded repair procedures. Keep role templates verbatim while filling only their documented placeholders. Do not replace combined v7 task review with invented role prompts. Use the actual selected model inventory for explicit worker model selection and escalation; record choices and capability failures.

Use plan.md as the plan identity. Original helpers create their own per-plan .superpowers/sdd directory; keep its original ledger and copy references/progress into this workflow's ledger.md for other nodes. Preserve reports instead of deleting the plan's workspace. Task reviews must see the whole task delta, including uncommitted files if commits were deferred under the shared unattended handoff rules; generate an equivalent diff package rather than passing an empty commit range.

If findings expand scope, update the context map/routing inputs and rerun cezar workflow-action route BEFORE continuing beyond the current tier. Return standard/deep for a genuine upgrade and preserve completed task ledger rows so replanning does not redo them. deep stays deep. Do not use arbitrary tier changes as retries.

Write implementation.md with original task report paths, ledger path, actual test/TDD evidence, outstanding findings and task base/head/worktree ranges. All tasks complete is not a final whole-branch approval: stop before the upstream final review seat and return complete so host verification and the independent cezar reviewer execute. Return blocked for an unresolved original stop condition, missing capability, or load-bearing open issue; do not route those as complete.


Current node:
Tier deep; use original subagent-driven-development and its implementer/task-reviewer/re-review templates. Return before its final whole-branch review seat.

If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: execute-deep, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.`,
      verdicts: ['complete', 'blocked', 'question'],
    },
    {
      id: 'upgrade',
      type: 'loop',
      name: '最多两次升档',
      max: 2,
    },
    {
      id: 'verify',
      type: 'check',
      name: '目标项目完整交付验证',
      command: 'cezar workflow-action verify',
    },
    {
      id: 'review',
      type: 'agent',
      name: '独立全分支审查或限定复查',
      skill: 'superpowers:code-reviewer',
      prompt: `This node IS the upstream executor's final review seat. It is independent of the implementation sessions and read-only. Read \`verified.json\`, \`verify.json\`, their logs, request/design/plan, implementation evidence and branch.diff. Verification ran for the current diff; reports are claims to inspect, not automatic approval.

If the node prompt contains no prior review, apply the supplied original code-reviewer template. Fill DESCRIPTION from the task, PLAN_OR_REQUIREMENTS with the file paths, BASE_SHA from run.json and HEAD_SHA from current HEAD. branch.diff is the complete base-to-worktree view, including staged/unstaged and new files; use it in addition to the original commit-range instructions when HEAD does not include the work. Preserve the original whole-branch scope, "declined to judge" section and severity rubric.

If a prior whole-branch review is supplied, use the original re-review template below instead of the first-review template with its actual prior findings, fix report and fix delta. Read the whole current branch.diff to locate the fix, but restrict new findings to fix-induced breakage as that template requires. There is no prior full review when an earlier host verification failed; after that repair this node MUST perform the first full review, never a scoped-only substitute.

Return the original reviewer report in the final response. Append approve only with no open correctness/requirement/security/verification blocker. changes requests the one final fix. blocked is for unavailable evidence or an original stop condition. Minor deferrals stay visible and do not justify scope expansion. Do not modify any file to save your report; cezar stores this response for the fixer/delivery coordinator.


Original re-review template (use only when a prior whole-branch review exists):
Read the original subagent-driven-development/re-review-prompt.md from the pinned skill files directory supplied with the selected skill; use that original template verbatim with its documented placeholders filled.

Current node:
A missing prior review requires a FULL first whole-branch review.
Prior review (empty on first entry):
{{nodes.review.summary}}
`,
      verdicts: ['approve', 'changes', 'blocked'],
    },
    {
      id: 'final-retry',
      type: 'loop',
      name: '一次最终返修',
      max: 1,
    },
    {
      id: 'fix',
      type: 'agent',
      name: '修复本次变更引入的问题',
      skill: 'superpowers:systematic-debugging',
      prompt: `Use the original implementer role with its placeholders filled from the current plan, actual final findings/failed command, this worktree and implementation.md (append the fix report).

The only task is fixing Critical/Important findings or verification failures caused by this task's changes. First diagnose against probe/baseline evidence. Pre-existing failures or missing infrastructure produce blocked with evidence, not opportunistic unrelated fixes. Preserve the exact previous review findings and the pre-fix task diff under context/fix-before.diff, so the scoped reviewer can identify the real repair delta. Read-only reviewers never repair; this node is the designated implementer.

Apply the original test/TDD/self-review/report contract, save the report and return fixed only when the targeted checks pass. cezar runs the complete host verification again and chooses full first review versus scoped re-review from prior review presence. This is one repair round across the final verification/review loop; it may resume after adjudication without starting another repair round. No nested helpers or self-appointed reviewers.


Original implementer template:
Read the original subagent-driven-development/implementer-prompt.md from the pinned skill files directory supplied with the selected skill; use that original template verbatim with its documented placeholders filled.

Current node:
and use the original implementer template plus systematic-debugging.
Verification output:
{{nodes.verify.output}}
Review findings (may be empty if no review has happened):
{{nodes.review.summary}}


If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: fix, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.`,
      verdicts: ['fixed', 'blocked', 'question'],
    },
    {
      id: 'deliver',
      type: 'agent',
      name: '整理验证证据与裁决',
      skill: 'superpowers:verification-before-completion',
      prompt: `Reconcile the host verify.json/verified.json and logs, independent approved review in the node input, task ledger and all acceptance criteria. This replaces upstream finishing-a-development-branch and workspace deletion; preserve evidence and leave cezar to present review.

Write delivery.md: requirement-to-evidence mapping, changed files, actual commands/results, rulings with reason/cost, deferred minors, known limitations, run/base/current HEAD and report locations. Do not edit source or run commits/push/PR/merge. Missing or mismatched evidence means blocked. Return ready only when the evidence supports the claim; the host seal node checks that the diff has not changed after verification.


Current node:
Read verification-before-completion before any success claim.
Approved independent review:
{{nodes.review.summary}}
`,
      verdicts: ['ready', 'blocked'],
    },
    {
      id: 'seal',
      type: 'check',
      name: '核对验证后代码未变',
      command: 'cezar workflow-action seal',
    },
    {
      id: 'blocked-report',
      type: 'agent',
      name: '记录阻塞并结束',
      prompt: `This is result packaging, not a new development role. Read available context, latest last-failure.txt, host baseline/verify logs and the ledger. Write blocked.md with the concrete failed stage, evidence, completed work, unresolved requirements/findings, setup or user action required, and a resumable next step. If initialization never succeeded, identify that instead of inventing a baseline or overwriting another run's context. Save a blocker in CEZ_HANDOFF_FILE when the context directory cannot safely be used.

Return recorded; the graph then ends failed. A recorded blocker is never success. Do not start a repair loop or wait indefinitely for a reply.


Current node:
Record the actual blocker and preserve evidence; this stage never repairs or claims success.`,
      verdicts: ['recorded'],
    },
    {
      id: 'done',
      type: 'end',
      name: '交付给人工 review',
      status: 'success',
    },
    {
      id: 'stopped',
      type: 'end',
      name: '阻塞或返修耗尽',
      status: 'failed',
    },
  ],
  edges: [
    {
      from: 'start.next',
      to: 'probe',
    },
    {
      from: 'probe.ready',
      to: 'baseline',
    },
    {
      from: 'probe.blocked',
      to: 'blocked-report',
    },
    {
      from: 'probe.failed',
      to: 'blocked-report',
    },
    {
      from: 'baseline.pass',
      to: 'route',
    },
    {
      from: 'baseline.fail',
      to: 'blocked-report',
    },
    {
      from: 'route.pass',
      to: 'route-fast',
    },
    {
      from: 'route.fail',
      to: 'blocked-report',
    },
    {
      from: 'route-fast.true',
      to: 'fast-plan',
    },
    {
      from: 'route-fast.false',
      to: 'design',
    },
    {
      from: 'fast-plan.fast',
      to: 'execute-fast',
    },
    {
      from: 'fast-plan.standard',
      to: 'upgrade',
    },
    {
      from: 'fast-plan.deep',
      to: 'upgrade',
    },
    {
      from: 'fast-plan.blocked',
      to: 'blocked-report',
    },
    {
      from: 'fast-plan.failed',
      to: 'blocked-report',
    },
    {
      from: 'design.ready',
      to: 'builder',
    },
    {
      from: 'design.blocked',
      to: 'blocked-report',
    },
    {
      from: 'design.failed',
      to: 'blocked-report',
    },
    {
      from: 'builder.approve',
      to: 'plan',
    },
    {
      from: 'builder.changes',
      to: 'design-retry',
    },
    {
      from: 'builder.blocked',
      to: 'blocked-report',
    },
    {
      from: 'builder.failed',
      to: 'blocked-report',
    },
    {
      from: 'design-retry.repeat',
      to: 'design',
    },
    {
      from: 'design-retry.exhausted',
      to: 'blocked-report',
    },
    {
      from: 'plan.standard',
      to: 'execute-standard',
    },
    {
      from: 'plan.deep',
      to: 'execution-route',
    },
    {
      from: 'execution-route.pass',
      to: 'execution-sdd',
    },
    {
      from: 'execution-route.fail',
      to: 'blocked-report',
    },
    {
      from: 'execution-sdd.true',
      to: 'execute-deep',
    },
    {
      from: 'execution-sdd.false',
      to: 'execute-deep-native',
    },
    {
      from: 'execute-deep-native.complete',
      to: 'verify',
    },
    {
      from: 'execute-deep-native.question',
      to: 'clarification-round',
    },
    {
      from: 'execute-deep-native.blocked',
      to: 'blocked-report',
    },
    {
      from: 'execute-deep-native.failed',
      to: 'blocked-report',
    },
    {
      from: 'plan.blocked',
      to: 'blocked-report',
    },
    {
      from: 'plan.failed',
      to: 'blocked-report',
    },
    {
      from: 'execute-fast.complete',
      to: 'verify',
    },
    {
      from: 'execute-fast.standard',
      to: 'upgrade',
    },
    {
      from: 'execute-fast.deep',
      to: 'upgrade',
    },
    {
      from: 'execute-fast.blocked',
      to: 'blocked-report',
    },
    {
      from: 'execute-fast.failed',
      to: 'blocked-report',
    },
    {
      from: 'execute-standard.complete',
      to: 'verify',
    },
    {
      from: 'execute-standard.deep',
      to: 'upgrade',
    },
    {
      from: 'execute-standard.blocked',
      to: 'blocked-report',
    },
    {
      from: 'execute-standard.failed',
      to: 'blocked-report',
    },
    {
      from: 'execute-deep.complete',
      to: 'verify',
    },
    {
      from: 'execute-deep.blocked',
      to: 'blocked-report',
    },
    {
      from: 'execute-deep.failed',
      to: 'blocked-report',
    },
    {
      from: 'upgrade.repeat',
      to: 'design',
    },
    {
      from: 'upgrade.exhausted',
      to: 'blocked-report',
    },
    {
      from: 'verify.pass',
      to: 'review',
    },
    {
      from: 'verify.fail',
      to: 'final-retry',
    },
    {
      from: 'review.approve',
      to: 'deliver',
    },
    {
      from: 'review.changes',
      to: 'final-retry',
    },
    {
      from: 'review.blocked',
      to: 'blocked-report',
    },
    {
      from: 'review.failed',
      to: 'blocked-report',
    },
    {
      from: 'final-retry.repeat',
      to: 'fix',
    },
    {
      from: 'final-retry.exhausted',
      to: 'blocked-report',
    },
    {
      from: 'fix.fixed',
      to: 'verify',
    },
    {
      from: 'fix.blocked',
      to: 'blocked-report',
    },
    {
      from: 'fix.failed',
      to: 'blocked-report',
    },
    {
      from: 'deliver.ready',
      to: 'seal',
    },
    {
      from: 'deliver.blocked',
      to: 'blocked-report',
    },
    {
      from: 'deliver.failed',
      to: 'blocked-report',
    },
    {
      from: 'seal.pass',
      to: 'done',
    },
    {
      from: 'seal.fail',
      to: 'blocked-report',
    },
    {
      from: 'blocked-report.recorded',
      to: 'stopped',
    },
    {
      from: 'blocked-report.failed',
      to: 'stopped',
    },
    {
      from: 'design.question',
      to: 'clarification-round',
    },
    {
      from: 'clarification-round.repeat',
      to: 'adjudicator',
    },
    {
      from: 'clarification-round.exhausted',
      to: 'blocked-report',
    },
    {
      from: 'adjudicator.answered',
      to: 'design',
    },
    {
      from: 'adjudicator.blocked',
      to: 'blocked-report',
    },
    {
      from: 'adjudicator.failed',
      to: 'blocked-report',
    },
    {
      from: 'fast-plan.question',
      to: 'clarification-round',
    },
    {
      from: 'plan.question',
      to: 'clarification-round',
    },
    {
      from: 'execute-fast.question',
      to: 'clarification-round',
    },
    {
      from: 'execute-standard.question',
      to: 'clarification-round',
    },
    {
      from: 'execute-deep.question',
      to: 'clarification-round',
    },
    {
      from: 'fix.question',
      to: 'clarification-round',
    },
    {
      from: 'adjudicator.fast-plan',
      to: 'fast-plan',
    },
    {
      from: 'adjudicator.plan',
      to: 'plan',
    },
    {
      from: 'adjudicator.execute-fast',
      to: 'execute-fast',
    },
    {
      from: 'adjudicator.execute-standard',
      to: 'execute-standard',
    },
    {
      from: 'adjudicator.execute-deep',
      to: 'execute-deep',
    },
    {
      from: 'adjudicator.execute-deep-native',
      to: 'execute-deep-native',
    },
    {
      from: 'adjudicator.fix',
      to: 'fix',
    },
  ],
};
