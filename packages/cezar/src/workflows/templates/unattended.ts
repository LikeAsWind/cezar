import type { WorkflowGraphFile } from '../graph.ts';

// Only host handoff conventions belong here; execution procedures stay in upstream skills.
const QUESTION = (origin: string) => `需要裁决时，在最终回复中给出一个完整阻塞问题、稳定 Q 编号、独立一行 origin: ${origin} 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。`;
const IMPLEMENTATION_EXECUTION = `每个 Task 审核通过后，将 plan.md 中对应任务标记为 [x]；未审核或审核未通过不得勾选。测试证据及审查报告仍记录在 progress.md 和原生报告中。构建输出不另存全量日志，最终回复报告命令、版本、退出码、测试数量和必要失败诊断。
完成所有 Task 后返回 complete。`;

/** Canonical built-in template. Snapshot serialization is owned by the host. */
export const UNATTENDED_TEMPLATE: WorkflowGraphFile = {
  version: 2,
  name: 'unattended',
  description: 'Superpowers；自动探测目标项目环境与验证命令，按复杂度走三档无人值守链路，通过后创建 Draft MR 并请求审核。',
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
      prompt: '执行已加载的 cezar:project-probe，完成需求影响面、源码地图和必要环境探测。不要进入设计或实现。',
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
      prompt: `执行已加载的 writing-plans，按原始需求编写最小完整计划，保存 plan.md。原始需求作为本分支的规格；复用 probe.md 和源码地图中的证据。
按官方格式自查，并将项目约束与实际验证入口纳入计划。核对 routing-input.json 与计划影响面，运行 cezar workflow-action route，返回实际 fast/standard/deep；不以升档代替重试。
${QUESTION('fast-plan')}`,
      verdicts: ['fast', 'standard', 'deep', 'blocked', 'question'],
    },
    {
      id: 'design',
      type: 'agent',
      name: '设计与需求消歧',
      skill: 'superpowers:brainstorming',
      prompt: `执行已加载的 brainstorming，结合原始需求和 probe.md 完成澄清与设计，保存 design.md。
恢复时复用已完成的 builder check 及反馈。
必要问题解决并完成 builder check 后返回 ready。遵守 validation-plan.json 的目标版本约束。范围变化时更新 routing-input.json 并运行 cezar workflow-action route，不降档。最终回复说明设计进度和未完成检查。
${QUESTION('design')}`,
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
      prompt: `执行已加载的 adjudicator，仅回答宿主注入的当前问题，最终回复完整给出 Q 编号、独立一行 origin、回答、依据及不确定性，由宿主持久化并显示在会话和图节点输出中。
按 origin 返回调用者：design 返回 answered；fast-plan、plan、execute-fast、execute-standard、execute-deep、execute-deep-native、fix 返回对应 origin。origin 无效或证据、授权不足则 blocked。`,
      verdicts: ['answered', 'fast-plan', 'plan', 'execute-fast', 'execute-standard', 'execute-deep', 'execute-deep-native', 'fix', 'blocked'],
      skill: 'cezar:adjudicator',
    },
    {
      id: 'plan',
      type: 'agent',
      name: '完整实现计划',
      skill: 'superpowers:writing-plans',
      prompt: `执行已加载的 writing-plans，以 design.md 为依据保存完整 plan.md，按官方格式自查，纳入项目约束和实际验证入口。
根据计划影响面更新 routing-input.json，运行 cezar workflow-action route，保留至少 standard，返回 standard 或 deep，不降档。
返回 deep 前，在最终回复中单独一行输出 CEZ:EXECUTION 后跟 JSON：{"schemaVersion":1,"tasksIndependent":true/false/null,"subagents":{"available":true/false/null,"tool":"实际工具名或 null","evidence":"实际观察或缺失说明"}}。宿主保存证据并选择执行器。
${QUESTION('plan')}`,
      verdicts: ['standard', 'deep', 'blocked', 'question'],
    },
    {
      id: 'execute-fast',
      type: 'agent',
      name: '轻量 native 执行',
      skill: 'superpowers:executing-plans',
      prompt: `执行已加载的 executing-plans，完成 plan.md 中 fast 档任务。
范围超出当前档时更新源码地图和 routing-input.json，运行 cezar workflow-action route，返回 standard/deep 并保留已完成工作。
${IMPLEMENTATION_EXECUTION}
${QUESTION('execute-fast')}`,
      verdicts: ['complete', 'standard', 'deep', 'blocked', 'question'],
    },
    {
      id: 'execute-standard',
      type: 'agent',
      name: '标准 native 执行',
      skill: 'superpowers:executing-plans',
      prompt: `执行已加载的 executing-plans，完成 plan.md 中 standard 档任务。
范围升至 deep 时更新源码地图和 routing-input.json，运行 cezar workflow-action route，返回 deep 并保留已完成工作。
${IMPLEMENTATION_EXECUTION}
${QUESTION('execute-standard')}`,
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
      prompt: `执行已加载的 executing-plans，完成 plan.md 中 deep 档任务；读取 execution.json 中 native 选择原因，保留高风险约束。
${IMPLEMENTATION_EXECUTION}
${QUESTION('execute-deep-native')}`,
      verdicts: ['complete', 'question', 'blocked'],
    },
    {
      id: 'execute-deep',
      type: 'agent',
      timeoutMs: 90 * 60_000,
      name: '复杂 SDD 逐任务实现与审查',
      skill: 'superpowers:subagent-driven-development',
      prompt: `执行已加载的 subagent-driven-development，完成 plan.md 中 deep 档任务，使用官方 implementer、task-reviewer 和 re-review 模板及原生工作目录。
记录实际派发能力、模型和审查报告路径。
${IMPLEMENTATION_EXECUTION}
${QUESTION('execute-deep')}`,
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
      prompt: `执行已加载的 code-reviewer，担任独立、只读的最终分支审查。核对需求、设计、计划、当前 branch.diff 及 verify.json/verified.json 的验证证据。
首次审查使用官方模板：DESCRIPTION 来自任务，PLAN_OR_REQUIREMENTS 使用相关产物路径，BASE_SHA 来自 run.json，HEAD_SHA 来自当前 HEAD；branch.diff 补足未提交及新增文件。
仅在已有完整审查时，使用官方 subagent-driven-development/re-review-prompt.md，结合既有发现、修复报告及 fix-before.diff，限定复查修复引入的问题。验证失败后的首次审查仍覆盖全分支。
最终回复说明未评判范围；无实质阻塞返回 approve，需要修复返回 changes，证据不足返回 blocked。
既有审查（首次为空）：
{{nodes.review.summary}}`,
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
      prompt: `执行已加载的 systematic-debugging，使用官方 subagent-driven-development/implementer-prompt.md，以当前计划、失败证据和工作树填写参数。
先对照 baseline.json 判断根因，仅修复本次变更引入的重要问题。既有失败或缺失基础设施记录证据并返回 blocked。
将修复前变更保存在 fix-before.diff；官方 progress.md 记录修复和针对性验证，最终回复提供官方修复报告。针对性检查通过后返回 fixed，宿主负责重新验证；保持冻结检查和约束。
验证输出：
{{nodes.verify.output}}
审查发现（未审查时为空）：
{{nodes.review.summary}}
${QUESTION('fix')}`,
      verdicts: ['fixed', 'blocked', 'question'],
    },
    {
      id: 'deliver',
      type: 'agent',
      name: '整理验证证据与裁决',
      skill: 'superpowers:verification-before-completion',
      prompt: `执行已加载的 verification-before-completion，核对 verify.json、verified.json、官方进度账本及宿主裁决 和已批准的独立审查。
最终回复给出需求与证据对应关系、变更文件、实际命令及结果、裁决、遗留限制和证据路径；复用既有报告。证据一致返回 ready，否则 blocked。本节点不修改源码或执行提交。
已批准的独立审查：
{{nodes.review.summary}}`,
      verdicts: ['ready', 'blocked'],
    },
    {
      id: 'seal',
      type: 'check',
      name: '核对验证后代码未变',
      command: 'cezar workflow-action seal',
    },
    {
      id: 'publish-mr',
      type: 'github.draft-pr',
      name: '推送分支并创建 Draft MR',
    },
    {
      id: 'request-review',
      type: 'github.pr-update',
      name: '请求 guohongwei 审核（GitLab 通知）',
      reviewers: ['guohongwei'],
    },
    {
      id: 'notify-wecom',
      type: 'notify.wecom',
      name: '企业微信群通知并 @ 审核人',
    },
    {
      id: 'notification-failed',
      type: 'end',
      name: 'MR 已创建，群通知失败',
      status: 'success',
    },
    {
      id: 'notify-publication-failed',
      type: 'notify.wecom',
      name: '通知推送或创建 MR 失败',
      body: '推送或创建 MR 失败\n任务：{{title}}\n原因：{{failure}}',
    },
    {
      id: 'notify-blocked',
      type: 'notify.wecom',
      name: '通知工作流阻塞',
      body: '工作流阻塞\n任务：{{title}}\n原因：{{failure}}',
    },
    {
      id: 'publication-failed',
      type: 'end',
      name: '提交审核失败（保留已完成工作）',
      status: 'failed',
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
      name: 'MR 已创建，自动交接完成',
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
      to: 'publish-mr',
    },
    { from: 'publish-mr.created', to: 'request-review' },
    { from: 'publish-mr.failed', to: 'notify-publication-failed' },
    { from: 'request-review.done', to: 'notify-wecom' },
    { from: 'request-review.failed', to: 'notify-wecom' },
    ...(['done', 'skipped', 'failed'] as const).flatMap(port => [
      { from: `notify-blocked.${port}`, to: 'stopped' },
      { from: `notify-publication-failed.${port}`, to: 'publication-failed' },
    ]),
    { from: 'notify-wecom.done', to: 'done' },
    { from: 'notify-wecom.skipped', to: 'done' },
    { from: 'notify-wecom.failed', to: 'notification-failed' },
    {
      from: 'seal.fail',
      to: 'blocked-report',
    },
    {
      from: 'blocked-report.pass',
      to: 'notify-blocked',
    },
    {
      from: 'blocked-report.fail',
      to: 'notify-blocked',
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
