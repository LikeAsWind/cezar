import type { WorkflowGraphFile } from '../graph.ts';

// Host execution conventions supplement, rather than modify, upstream skills.
const IMPLEMENTATION_EXECUTION = `Preserve the full build/test output in the mapped logs directory and retain the original process exit code. Read summaries from that saved log afterward; do not pipe the running build through grep/head or another filter that discards diagnostics or masks failure. Record the exact command, selected toolchain, log path, exit code and test counts in ledger.md.
Use the backend's background-task status/completion tools for long commands when available. Do not add fixed long sleep commands to wait for a build; if background status is unavailable, use the command tool's bounded wait and inspect its result. Never start a duplicate build while the previous one is still running.
After each plan Task completes, update ledger.md with its Task number, completed changes, actual verification evidence and next unfinished step. Keep partial work and test failures distinct from completed Tasks. Before rerunning a command on recovery, inspect the latest ledger, existing background-task status, saved logs and test reports; reuse completed evidence only while relevant code and toolchain remain unchanged. If completion cannot be established, report uncertainty and rerun the required check safely. Continue from unfinished work, without repeating completed Tasks or relaxing final verification.`;

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
Read the original task from CEZ_HANDOFF_FILE / ## Goal. Do not copy it into a separate artifact. Use up to three independent native tool calls per batch; preserve dependencies and serialize report writes.`,
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
      prompt: `Fill its original header, Global Constraints, Review Focus, Files, Interfaces, checkboxes, exact signatures/tests and verification steps from the actual approved-by-machine design. Save to context plan.md (the user's workflow supplies this path override). For fast, the original Goal in CEZ_HANDOFF_FILE is the spec; a single well-specified task is sufficient. Do not expand fast into speculative architecture.

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
      prompt: `Use the supplied original brainstorming skill to clarify the stored request one question at a time. The respondent is the separate adjudicator node, not the human and not yourself. Read CEZ_HANDOFF_FILE / ## Goal, probe.md, relevant context-map.jsonl rows, clarification.md when present, and actual source as needed.

Before asking, use the original skill's three piles: Answered already — incorporate the answer from the request, recorded rulings or project evidence; Minor — settle reversible technical details yourself and mark them as your call in design.md; Theirs — only decisions that change what gets built and require missing requirement authority go to the adjudicator. A technical choice is not automatically a clarification question. Do not invent product preferences or override recorded rulings.

If an answer from the Theirs pile is needed, write exactly one pending question with a stable Q-number and origin: design to question.md: the question, why it matters, and any relevant evidence paths. Preserve prior questions/answers in clarification.md. Do not answer that authority-dependent question yourself, batch several questions, or use CEZ:ASK. End this turn with CEZ:VERDICT question; cezar runs the adjudicator and returns here with the answer.

On re-entry, read the recorded answer and cited sources, incorporate it, and continue the original brainstorming conversation/playback. Reject an answer that conflicts with the request or lacks necessary evidence; ask a specific follow-up or return blocked. Previously answered questions without new contradictory evidence must not be asked again. A material product choice absent from the request and evidence stays blocked.

When clarification and playback are complete, write design.md using the original format and perform the original skill's builder check using its adjacent builder-check-prompt.md and a fresh subagent. Without a subagent tool, read the document as that builder yourself, as the original skill directs. Sort the resulting questions into the original three piles, incorporate existing answers, settle minor decisions, and route only the Theirs pile to the adjudicator. Update the design after the answers; do not start an additional review loop. On recovery, reuse a completed builder check and address its recorded feedback rather than dispatching it again.

Distinguish explicit requirements, evidence-backed rulings and reversible builder choices. Mark resolved requirementsClear in routing-input.json and rerun cezar workflow-action route if scope changed, never downgrading the route. Keep ledger.md up to date. Return ready only after completing the original builder-check follow-up and resolving material questions; the next node is writing-plans under the existing unattended approval policy. Never claim human approval or write product code in this stage.

For a recovered older task, read the latest builder feedback in the host handoff Resume notes and ledger.md before proceeding. Reuse the completed check and resolve those findings; do not repeat it. Historical blocked reports do not supersede later review evidence.
Latest adjudicator response (empty on first entry):
{{nodes.adjudicator.summary}}`,
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
      id: 'plan',
      type: 'agent',
      name: '完整实现计划',
      skill: 'superpowers:writing-plans',
      prompt: `Fill its original header, Global Constraints, Review Focus, Files, Interfaces, checkboxes, exact signatures/tests and verification steps from the actual approved-by-machine design. Save to context plan.md (the user's workflow supplies this path override). For fast, the original Goal in CEZ_HANDOFF_FILE is the spec; a single well-specified task is sufficient. Do not expand fast into speculative architecture.

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

Use plan.md as the plan identity. Original helpers create their own per-plan .superpowers/sdd directory; keep its original ledger and record references/progress in this workflow's ledger.md for other nodes. Preserve reports instead of deleting the plan's workspace. Task reviews must see the whole task delta, including uncommitted files if commits were deferred under the shared unattended handoff rules; generate an equivalent diff package rather than passing an empty commit range.

If findings expand scope, update the context map/routing inputs and rerun cezar workflow-action route BEFORE continuing beyond the current tier. Return standard/deep for a genuine upgrade and preserve completed task ledger rows so replanning does not redo them. deep stays deep. Do not use arbitrary tier changes as retries.

Record original task report paths, actual test/TDD evidence, outstanding findings and task base/head/worktree ranges in ledger.md; return a concise implementation summary as the node response. Do not create a duplicate host implementation report. All tasks complete is not a final whole-branch approval: stop before the upstream final review seat and return complete so host verification and the independent cezar reviewer execute. Return blocked for an unresolved original stop condition, missing capability, or load-bearing open issue; do not route those as complete.


Current node:
Tier fast; execute the plan through the original executing-plans skill. Return before its final review seat.

If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: execute-fast, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.

${IMPLEMENTATION_EXECUTION}`,
      verdicts: ['complete', 'standard', 'deep', 'blocked', 'question'],
    },
    {
      id: 'execute-standard',
      type: 'agent',
      name: '标准 native 执行',
      skill: 'superpowers:executing-plans',
      prompt: `Apply the selected execution skill to plan.md and the current tier.

Also read the upstream TDD and verification-before-completion skills as the executor requires. Apply their ledger, pre-flight, task-brief, evidence and bounded repair procedures. Keep role templates verbatim while filling only their documented placeholders. Do not replace combined v7 task review with invented role prompts. Use the actual selected model inventory for explicit worker model selection and escalation; record choices and capability failures.

Use plan.md as the plan identity. Original helpers create their own per-plan .superpowers/sdd directory; keep its original ledger and record references/progress in this workflow's ledger.md for other nodes. Preserve reports instead of deleting the plan's workspace. Task reviews must see the whole task delta, including uncommitted files if commits were deferred under the shared unattended handoff rules; generate an equivalent diff package rather than passing an empty commit range.

If findings expand scope, update the context map/routing inputs and rerun cezar workflow-action route BEFORE continuing beyond the current tier. Return standard/deep for a genuine upgrade and preserve completed task ledger rows so replanning does not redo them. deep stays deep. Do not use arbitrary tier changes as retries.

Record original task report paths, actual test/TDD evidence, outstanding findings and task base/head/worktree ranges in ledger.md; return a concise implementation summary as the node response. Do not create a duplicate host implementation report. All tasks complete is not a final whole-branch approval: stop before the upstream final review seat and return complete so host verification and the independent cezar reviewer execute. Return blocked for an unresolved original stop condition, missing capability, or load-bearing open issue; do not route those as complete.


Current node:
Tier standard; execute the plan through the original executing-plans skill. Return before its final review seat.

If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: execute-standard, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.

${IMPLEMENTATION_EXECUTION}`,
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
      timeoutMs: 90 * 60_000,
      name: '复杂任务 native 执行（保留高风险约束）',
      skill: 'superpowers:executing-plans',
      prompt: `Tier deep, native fallback. Read execution.json and record why SDD was not selected. Apply the original executing-plans skill to plan.md in this context, with all deep risk and target-version constraints intact. Read the original TDD and verification skills. Do not pretend per-task subagents or independent task reviews ran. Keep actual tests, findings and original report paths in ledger.md; return the implementation summary as the node response. Stop before final whole-branch review; cezar runs host verification and the independent reviewer next. Never downgrade the risk tier or weaken the frozen validation plan.

If a specific unresolved question blocks progress, write one question.md with a Q-number and origin: execute-deep-native, evidence and the single question; return question. On re-entry read clarification.md and resume completed work from the ledger. Return blocked when evidence or authority is insufficient.

${IMPLEMENTATION_EXECUTION}`,
      verdicts: ['complete', 'question', 'blocked'],
    },
    {
      id: 'execute-deep',
      type: 'agent',
      timeoutMs: 90 * 60_000,
      name: '复杂 SDD 逐任务实现与审查',
      skill: 'superpowers:subagent-driven-development',
      prompt: `Apply the selected execution skill to plan.md and the current tier.

Also read the upstream TDD and verification-before-completion skills as the executor requires. Apply their ledger, pre-flight, task-brief, evidence and bounded repair procedures. Keep role templates verbatim while filling only their documented placeholders. Do not replace combined v7 task review with invented role prompts. Use the actual selected model inventory for explicit worker model selection and escalation; record choices and capability failures.

Use plan.md as the plan identity. Original helpers create their own per-plan .superpowers/sdd directory; keep its original ledger and record references/progress in this workflow's ledger.md for other nodes. Preserve reports instead of deleting the plan's workspace. Task reviews must see the whole task delta, including uncommitted files if commits were deferred under the shared unattended handoff rules; generate an equivalent diff package rather than passing an empty commit range.

If findings expand scope, update the context map/routing inputs and rerun cezar workflow-action route BEFORE continuing beyond the current tier. Return standard/deep for a genuine upgrade and preserve completed task ledger rows so replanning does not redo them. deep stays deep. Do not use arbitrary tier changes as retries.

Record original task report paths, actual test/TDD evidence, outstanding findings and task base/head/worktree ranges in ledger.md; return a concise implementation summary as the node response. Do not create a duplicate host implementation report. All tasks complete is not a final whole-branch approval: stop before the upstream final review seat and return complete so host verification and the independent cezar reviewer execute. Return blocked for an unresolved original stop condition, missing capability, or load-bearing open issue; do not route those as complete.


Current node:
Tier deep; use original subagent-driven-development and its implementer/task-reviewer/re-review templates. Return before its final whole-branch review seat.

If a specific unresolved requirement or technical decision prevents this stage from continuing, write one question.md with a stable Q-number, origin: execute-deep, an existing AC if available (otherwise the relevant original request fragment), the single question, why it blocks progress, and relevant evidence paths. Return CEZ:VERDICT question to call the shared adjudicator. Read clarification.md on re-entry, validate its answer against the actual requirement/source, and resume this stage without repeating completed work. Unsupported product intent remains blocked; adjudication cannot reduce scope or verification. Do not ask the human directly in the normal unattended path.

${IMPLEMENTATION_EXECUTION}`,
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
      prompt: `This node IS the upstream executor's final review seat. It is independent of the implementation sessions and read-only. Read \`verified.json\`, \`verify.json\`, their logs, request/design/plan, ledger evidence, original task reports and branch.diff. Verification ran for the current diff; reports are claims to inspect, not automatic approval.

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
      prompt: `Use the original implementer role with its placeholders filled from the current plan, actual final findings/failed command, this worktree and ledger.md (record fix evidence and return the original fix report as the node response).

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

Return the delivery summary as this node response: requirement-to-evidence mapping, changed files, actual commands/results, rulings with reason/cost, deferred minors, known limitations, run/base/current HEAD and report locations. Reuse ledger.md and original reports; do not create a duplicate delivery.md. Do not edit source or run commits/push/PR/merge. Missing or mismatched evidence means blocked. Return ready only when the evidence supports the claim; the host seal node checks that the diff has not changed after verification.


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
      type: 'check',
      name: '记录阻塞并结束',
      command: 'cezar workflow-action blocked',
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
      to: 'plan',
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
      from: 'blocked-report.pass',
      to: 'stopped',
    },
    {
      from: 'blocked-report.fail',
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
