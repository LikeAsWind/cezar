# unattended 全分支产物交接审计

日期：2026-10-22（北京时间）。范围：当前宿主代码、内置 unattended 模板、实际运行 3554a2f7-365f-44a8-a155-fff31bc6968e，以及其已有产物。

> 下列九项发现记录修复前状态。当前实现与验收结果见文末“修复与验收记录”。

## 结论与边界

结构检查覆盖 33 个节点、94 条边，`graphIssues` 返回空数组。图结构合法，不代表交接语义正确。

确认 8 项需要优先处理的 P1 缺陷或有明确触发条件的风险，另有 1 项 P2 交接状态问题。未证明存在可绕过全部验证直接发布的 P0：真实构建验证、私有验证凭据和发布前源码差异校验仍在工作。

本报告为审计结果，不是修复完成声明。复现仅在自动清理的隔离临时目录执行；没有运行目标项目的新测试、修改其源码、恢复其工作流或发送通知。

证据等级：

- **实际发生**：实际任务事件与磁盘产物相互印证。
- **隔离复现**：直接调用真实生产函数，使用临时目录与构造输入，观察返回结果。
- **代码确认的条件风险**：生产者、消费者和分支均已读到；未在真实业务项目触发该分支。

## 1. P1：执行账本没有作为后继节点的明确输入，已造成事实误判

影响：所有 execute → review → fix → adjudicator → deliver 路径，以及执行节点重启恢复。

`stageArtifacts` 没有执行账本、原生报告或任务工作目录的路径。模板只写 `progress.md`，没有区分官方 `.superpowers/sdd/<plan>/progress.md` 与宿主任务目录下的 `progress.md`。裁决者也没有随 origin 获得设计、计划和执行报告的完整引用。

实际任务中：

- 原始账本 `.superpowers/sdd/2026-10-22-probing-scratchbufferpool-return-bug-plan/progress.md:9` 记录基线出现 `Pool not open` 32 次；`:16` 记录修复后 32000 次借出无异常，并明确原始归还异常尚未复现。
- 宿主任务目录 `runs/3554a2f7-365f-44a8-a155-fff31bc6968e/progress.md` 却写“复现仍未执行，harness 不存在于工作树”。
- review 把临时文件缺失判断成从未执行；裁决者复用这个前提，补跑程序后出现 JMX 阻塞，fix 返回 blocked。

原始证据地址：

- [原始执行账本](<C:/Program Files/Development/JAVA_Projects/yw-search-sort/.ai/cezar/worktrees/3554a2f7-365f-44a8-a155-fff31bc6968e/.superpowers/sdd/2026-10-22-probing-scratchbufferpool-return-bug-plan/progress.md:9>)。
- [后建的修复进度](<C:/Program Files/Development/JAVA_Projects/yw-search-sort/.ai/cezar/runs/3554a2f7-365f-44a8-a155-fff31bc6968e/progress.md:9>)。
- 运行事件 `events.ndjson` seq 3923 保留读取原始账本的工具输出；graphState.review、graphState.adjudicator 保留错误判断。

代码：[stageArtifacts](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/unattended-probe.ts:20>)、[执行交接约定](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/templates/unattended.ts:5>)。

修复方向：宿主持有当前计划的原生工作目录、账本和报告引用，不复制账本内容、不新建第二份同名事实来源。消费节点先核对账本和已保存结果；“程序文件已删除”“未精确复现原始异常”“从未执行”必须区分。临时程序可以删除，其必要结果和身份仍需可定位。

## 2. P1：首次验证失败时，返修节点的必需输入尚未生成

影响：任一执行分支 → verify.fail → final-retry.repeat → fix。

`workflow-action verify` 只有在所有命令成功后才调用 `captureDiff` 生成 `branch.diff`。命令失败会提前抛错。fix 却始终把 `branch.diff` 列为必需输入，并要求必需输入缺失时报告缺口。

隔离复现：一个正常启动并退出 1 的 Node 测试命令得到：

```text
error = verify failed; read verify.json diagnostics
verify.json = 存在
branch.diff = 不存在
verified.json = 不存在
```

若验证配置或环境校验更早失败，`verify.json` 也可能尚未生成。若此前成功验证过，则未被覆盖的旧 `branch.diff` 可能成为返修输入，产生另一种证据过期问题。

代码：[fix 输入](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/unattended-probe.ts:30>)、[命令失败提前抛错](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/scripts/workflow-action.mjs:428>)、[成功后生成 diff](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/scripts/workflow-action.mjs:431>)。

修复方向：验证开始时生成当前变更快照、使旧验证成功凭据失效；失败报告覆盖启动、配置、环境和测试失败。fix 根据真实失败阶段读取产物，不能强求仅成功时才有的凭据。

## 3. P1：路由产物与代理返回的档位没有硬一致性校验

影响：fast-plan → execute-fast；plan → execute-standard；执行升档。

`routeDecision` 对 route.json 保证档位不降低；图实际分支却使用代理 verdict。`guardUnattendedVerdict` 只检查规划文件非空，没有把规划 verdict 与 route.json 的档位对照。

隔离复现：route.json 为 `deep`、reason 为 `high_risk` 时，真实 guard 仍接受：

```text
fast-plan.fast → ACCEPTED
plan.standard → ACCEPTED
```

因此正确路由文件不能阻止代理走错较低档链路。

代码：[规划交接 guard](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/unattended-guards.ts:120>)、[路由计算](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/scripts/workflow-action.mjs:185>)、[规划节点](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/templates/unattended.ts:51>)。

修复方向：宿主校验 verdict 与机器路由一致，再决定分支；执行节点报告范围扩大后，也由宿主校验路由与升档出口，而不是只信回复中的档位。

## 4. P1：范围扩大后，冻结验证范围不会同步扩大

证据等级：代码确认的条件风险；没有在真实跨模块任务中执行复现。

影响：fast-plan、execute-fast、execute-standard 升档 → upgrade → design → plan → 新执行器。

升档回到 design，不经过 probe/baseline。validation-plan.json 在最初 baseline 后冻结，之后改变内容会被 guard 拒绝。路由输入和计划可以扩大到模块 B，但验证仍可能只运行最初模块 A 的命令。当前没有“新增影响面已被验证命令覆盖”的宿主交接检查。

这不等于实际 sort 任务漏跑测试：其最新 verify 已执行全模块测试。风险出现在初始验证范围较窄、后续扩大到新模块的任务。

代码：[upgrade 出口](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/templates/unattended.ts:465>)、[冻结验证检查](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/unattended-guards.ts:47>)、[verify 读取冻结命令](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/scripts/workflow-action.mjs:400>)。

修复方向：范围扩大时先核对验证覆盖。需要补充模块或测试入口时，走显式的验证计划修订及基线流程，保留已有检查和版本约束，不能通过放松冻结规则绕过失败。

## 5. P1：执行完成、审查批准和交付就绪缺少相应产物交接门槛

影响：四种执行器的 complete、review.approve、deliver.ready。

guard 的 required 表仅覆盖 probe、design、规划；没有检查执行任务是否完成、原生报告和账本是否可定位、审查是否对应当前验证、交付证据是否一致。

隔离复现：计划仍为 `- [ ] Task 1: not implemented`，没有执行、审查、验证产物时，guard 均接受：

```text
execute-deep-native.complete → ACCEPTED
review.approve → ACCEPTED
deliver.ready → ACCEPTED
```

实际任务第一次执行 complete 的摘要也明确写了“plan.md 未勾选任何任务，逐任务审核记录尚未建立”，宿主随后进入 verify。

这里证明的是这些节点的交接门槛缺失，不是证明可绕过全图的 verify/seal。后续构建测试仍会执行，但不能代替计划任务与需求证据核对。

代码：[required 表](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/unattended-guards.ts:120>)、[执行完成约定](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/templates/unattended.ts:5>)。

修复方向：补充按阶段校验的最小完成凭据，引用现有官方产物；校验任务完成及报告身份，不机械要求 native 分支具有 SDD 才有的逐任务审查文件。未满足要求时明确指出缺哪项，不能只靠代理输出标记放行。

## 6. P1：返修后的复查缺少修复报告与明确修复范围

影响：review.changes 或 verify.fail → fix.fixed → verify.pass → review。

review 模板要求读取修复报告，官方 re-review 模板要求 REPORT_FILE、FIX_BASE_SHA 与修复 diff。但宿主实际只注入既有 review.summary；review 的阶段路径没有修复报告引用，`unattendedContext` 只带 review 自己的 checkpoint，不带 fix 输出。

隔离复现：graphState 同时含 review 和 fix 摘要时，给 review 的上下文包含旧审查，缺少 `FIX_REPORT_SENTINEL`。

此外，实际 `fix-before.diff` 保存的是任务基线到修复前 HEAD 的全分支差异，不是修复后的增量 diff；`branch.diff` 也是全分支差异。当前没有明确交付旧审查 HEAD 对应的 FIX_BASE_SHA 和本次修复范围。

代码：[review 模板](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/templates/unattended.ts:189>)、[阶段路径](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/unattended-probe.ts:29>)、[checkpoint 仅取本节点](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/unattended-probe.ts:120>)。

修复方向：将既有发现、修复报告引用、修复基点及当前修复差异一起交给复查节点。保证每条旧发现都有明确处置结果，同时检查修复引入的问题。保留原来的修复前快照，不能把它当成修复后的增量差异。

## 7. P1：发布失败的恢复位置缺失，还可能误回旧执行节点

影响：seal.pass → publish-mr.failed → notify-publication-failed → publication-failed。

`unattendedRecoveryPoint` 只逆查 `->blocked-report`，没有处理发布失败链。

隔离复现：

```text
首次发布失败历史 → recovery = undefined
此前有 execute-standard.blocked，之后发布失败 → recovery = execute-standard
```

前者没有可续跑的正确发布位置；后者会把一次发布故障误判为旧执行阶段故障。可能重复执行已完成工作，且不一定重试真正失败的发布动作。

代码：[恢复点计算](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/unattended-recovery.ts:5>)、[发布分支](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/templates/unattended.ts:531>)。

修复方向：根据最后一次实际失败的动作保存恢复位置，发布失败恢复 publish-mr，审核请求失败恢复 request-review，通知失败恢复相应通知。MR 已存在时保持幂等，不能重新创建或回到实现。

## 8. P1：实时送达的用户补充要求没有可靠传给后继节点

证据等级：代码确认的条件风险；不声称实际 sort 任务因此丢失了某条要求。

`deliverMessage` 把实时消息写入事件流并发送给当前会话；没有把这些消息登记为跨节点约束输入。`unattendedContext` 读取的是 queuedMessages，阶段路径要求读取的是 handoff 的原始 Goal。下一节点是新会话时，无法保证收到已经实时送达、因而不在队列中的补充约束，只能依赖前一代理主动记账。

例如执行中补充“保持某项配置不变”，下一阶段仍可能只收到原始 Goal。这个风险影响设计、执行、审查及交付，而不只是恢复运行。

代码：[实时消息送达](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/run.ts:3512>)、[共享上下文的用户消息来源](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/unattended-probe.ts:132>)。

修复方向：已接受的用户补充消息应有一个持久的任务级来源，各阶段接收与自身相关的更新引用或摘要；不能用待发送队列充当完整的用户决策历史。

## 9. P2：审核人请求失败没有形成完整的下游状态交接

`github.pr-update` 失败只写 note，没有像创建 MR 失败那样写 node 输出 error。模板又将 request-review.failed 与 done 都接到默认 notify-wecom，默认内容只含任务和 MR 链接，不体现审核人未成功添加。

因此可能 MR 创建成功、指定审核人失败，但群消息与最终状态缺少这一事实。群通知失败也采用 success 终点，虽然终点名称指出通知失败，仍缺少单独重试通知的恢复语义。

代码：[审核更新错误处理](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/run.ts:5508>)、[通知默认正文](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/run.ts:5543>)、[失败出口](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/templates/unattended.ts:535>)。

修复方向：区分发布结果、审核请求结果、通知结果；错误作为结构化节点输出传给通知与 UI。保留 MR 链接，只重试失败的外部动作。

## 全节点交接矩阵

以下矩阵覆盖当前模板的 33 个节点；条件节点、循环节点和终点也计入。F1—F9 对应上面的发现编号。

| 节点 | 主要读取 | 主要产出或交接 | 审计结果 |
| --- | --- | --- | --- |
| start | 启动任务 | probe | 无独立产物 |
| probe | handoff Goal、run.json、项目与工具位置 | probe、地图、environment、routing-input | 非空及地图定位有 guard；内容准确性仍需后继核对 |
| baseline | environment、工具链、命令 | validation-plan、baseline、私有冻结状态 | 有版本绑定、环境检查和冻结保障 |
| route | routing-input、已有 route | route.json、tier 输出 | 机器路由单调不降档；下游 verdict 存在 F3 |
| route-fast | route.output | fast-plan / design | 连线与机器输出一致 |
| fast-plan | Goal、probe、地图、验证约束 | plan、route | F3；升档有 F4 |
| design | Goal、probe、地图、验证约束、裁决 | design、更新后的范围信息 | 必需设计非空有检查；升档仍有 F4 |
| clarification-round | 问题返回及循环次数 | adjudicator / blocked-report | 八轮上限明确 |
| adjudicator | 当前问题、历史、probe、地图、验证约束 | 同 Q/origin 答复、追加历史 | 返回 origin 有 guard；原始账本与调用阶段相关路径不全，F1 |
| plan | design、地图、验证约束、路由依据 | plan、route、深档执行能力证据 | F3、F4；深档能力 JSON 有 schema |
| execute-fast | plan、地图、验证约束 | 原生账本、代码、complete/升档 | F1、F5；升档有 F4 |
| execute-standard | plan、地图、验证约束 | 原生账本、代码、complete/升档 | F1、F5；升档有 F4 |
| execution-route | execution.json.input | sdd/native 与理由 | 结构校验及未知能力回退存在 |
| execution-sdd | execution-route.output | execute-deep / execute-deep-native | 分支明确 |
| execute-deep | plan、地图、验证约束 | 官方 ledger、任务报告、代码 | F1、F5；宿主明确停在最终全分支审查之前 |
| execute-deep-native | plan、execution、地图、验证约束 | 官方 ledger、测试证据、代码 | F1、F5；当前事故已发生于此证据的下游 |
| upgrade | 已用次数 | design / blocked-report | 两次上限明确；验证覆盖脱节 F4 |
| verify | 冻结 validation-plan、当前代码 | verify、branch.diff、verified | 真实验证有保障；失败产物交接 F2 |
| review | Goal、design 可选、plan、地图、验证与 diff、旧审查 | approve/changes/blocked 报告 | F1、F5、F6 |
| final-retry | verify/review 失败及已用次数 | fix / blocked-report | 一轮上限明确；不重置预算是设计行为 |
| fix | plan、baseline、verify、验证约束、diff、审查发现、裁决 | fix-before、修复报告、代码 | F1、F2、F6；既有故障与本次未完成需求需要区分 |
| deliver | Goal、verify、verified、批准审查、裁决 | 交付摘要与 ready | F1、F5；没有账本明确路径 |
| seal | 私有冻结状态、verified、当前源码 diff | pass/fail | 能拦截验证后源码变化，不证明所有需求已实现 |
| publish-mr | 运行记录、工作树、handoff | MR URL/number 或 error | 有已存在 MR 的幂等检查；失败恢复 F7 |
| request-review | MR number、reviewers | done/failed | 失败详情交接 F9 |
| notify-wecom | 项目通知配置、标题、MR URL | sent/skipped/failed | 项目维度正确；审核请求失败信息 F9 |
| notification-failed | MR 已创建且通知失败 | success 终点 | 名称保留失败事实，但重试和状态语义 F9 |
| notify-publication-failed | 发布失败原因、标题 | 通知结果 | 后续恢复 F7 |
| notify-blocked | 起因节点输出、错误、标题 | 通知结果 | 不覆盖原阻塞；长摘要可能截断细节 |
| publication-failed | 发布失败链 | failed 终点 | F7 |
| blocked-report | 当前分支失败、graphState、handoff | 在已有 handoff 记录阻塞 | 2000 字符摘要不是原始账本替代品 |
| done | 发布与通知链完成 | success 终点 | 不代表人工审查或合并完成 |
| stopped | 阻塞/次数耗尽 | failed 终点 | UI 总错误泛化，详细原因仍在节点输出 |

## 已有保障与不应误判的问题

1. **私有冻结验证状态有效。** baseline 后保存验证计划，verify/seal 对照宿主私有记录，不能随意篡改验证配置后放行。
2. **Java 版本绑定有效。** Java/Maven 命令需要选定 javaHome；存在环境版本检查；Maven 测试需要明确解除 skip，并检查测试执行证据。
3. **verify/seal 校验的是源码差异。** 修改 plan.md 不改变 captureDiff 的哈希，在隔离实验中得到确认，因为计划属于排除的工作流产物。这是边界，不应据此声称 seal 覆盖了计划语义；也不应简单冻结整个计划文本而禁止正常勾选任务。
4. **官方执行 skill 的终局流程已被宿主例外截停。** `roleHandoff` 明确“完成任务后停在最终全分支审查之前”。因此本审计没有把原版 skill 中终局清理 workspace 的文字，直接判成当前宿主必然删除账本的已证实 bug。
5. **裁决按 Q/origin 返回有保护。** 有问题编号、调用者和返回端口校验，历史追加保存；跨账号/后端不能随意沿用会话。
6. **模板与官方 skill 有版本锁。** 老 run 可能继续用锁定版本；宿主交接代码与模板修改的生效范围不同，不能承诺一次重启会替换所有旧任务的模板。修复必须明确旧运行如何恢复，不能静默替换已冻结证据。
7. **真正的后台任务仍需收取结果。** `task_started` 前台进度误登记已在此前修复；本次最新 fix 阻塞发生在复现程序，不是同一个后台追踪问题。

## 最小必要交接设计

不增加第二套官方进度账本，不保存全量 Maven 输出，不改写官方 skill 的推理过程。复用当前任务的已有状态，只保存必要的产物引用与身份：

- 当前 plan 对应的官方 workspace / ledger / 任务报告引用。
- 产物生产节点、对应源码基点或版本，以及是否仍适用于当前阶段。
- 失败也能生成的当前 diff 与简要验证报告。
- 返修前 HEAD、修复后 HEAD、修复报告和增量 diff 引用。
- 当前实际失败节点及可恢复位置。
- 用户补充约束的持久来源。

节点输入继续使用“用途：路径”的简短形式；完整历史保留在已有运行记录中，模型只接收当前必需的引用和变化摘要。账本、问答和节点 checkpoint 不应整段重复注入多次。

## 建议实施顺序与验收

1. **先修 F1、F2、F6。** 让各阶段得到同一份原始执行证据，且首次验证失败也能返修。验收：一次性 harness 已删除但结果存在时不得判“未执行”；首次 verify 失败可以进入 fix；复查确实收到本轮修复报告和范围。
2. **再修 F3、F4、F5。** 把路由、验证覆盖和完成声明连接起来。验收：deep 路由不能落入 fast/standard；新增模块必须覆盖验证；未完成任务或缺少必要报告不能只凭 complete 放行。
3. **修 F7、F9。** 发布、审核请求、通知分别保存结果与恢复位置。验收：重试发布不回到实现，不重复创建 MR；审核人添加失败在通知和 UI 可见。
4. **修 F8。** 已实时送达的用户补充要求可以被后继新会话读取。验收：执行中补充约束，review/deliver 接收到同一条更新，而不依赖当前代理主动复制。

所有验收至少覆盖 fast、standard、deep-native、deep-SDD、升档、裁决回流、首次验证失败、返修复查、进程重启恢复和发布失败。对外发送、推送和创建 MR 的测试使用 mock，不实际通知群聊。


## 修复与验收记录

本轮按整套交接机制修复，未修改 vendor 中的官方 Superpowers v7 原文。宿主模板现为 38 个节点、103 条连线。

| 审计项 | 修复结果 |
| --- | --- |
| F1 执行事实丢失 | 按官方 sdd-workspace 的 plan-path 定位唯一计划目录，执行、审查、返修、裁决与交付共享 progress.md 和原生报告路径；不生成宿主账本副本。 |
| F2 验证失败交接 | 验证开始使旧成功凭据和旧诊断失效；真实命令失败保存当前差异与诊断。宿主在启动前拒绝时也清除旧凭据并记录当前错误，返修不强求尚未生成的差异或成功凭据。 |
| F3 路由不一致 | 接受档位前重新核对当前 routing-input 与保存档位，禁止代理绕过机器路由或使用过期风险结果。 |
| F4 升档验证范围 | 新增可见的 validation-scope 节点，核对计划范围、只执行新增基线；验证计划仅允许追加，不改旧版本、命令或预期输出。验证时再核对实际变更。窄目标及未知脚本不能凭 root cwd 声称覆盖全仓库；自定义命令使用 coverage 声明范围。 |
| F5 虚假完成 | 检查计划步骤、官方账本身份及逐任务完成证据。native 使用 task-done 测试契约，SDD 使用逐任务审查及报告；批量派发可显式引用共享报告。审查和交付绑定宿主验证凭据及当前代码树。 |
| F6 返修复查 | 官方 re-review 模板接收旧发现、final-fix-report.md、修复前后 Git 代码树及 fix.diff；包含未提交与新增文件，不修改用户 index。没有完整旧审查或修复报告时不冒充限定复查。 |
| F7 发布恢复 | 推送、审核人设置、通知失败分别保存错误并恢复对应节点，不重复实施或发布；覆盖不足恢复到对应计划节点。 |
| F8 用户补充丢失 | 从已有运行事件和排队记录按消息身份合并，传给后继会话；保留相同措辞的后续决定，避免 Java 8 → Java 11 → Java 8 被错误去重。 |
| F9 通知状态 | 审核人设置和通知失败有独立可见路径，保留原因及已创建 MR；不能当作完全成功吞掉错误。 |

官方衔接：brainstorming 负责设计及 builder check；writing-plans 产出计划；executing-plans / subagent-driven-development 通过官方工作目录及账本交接；最终独立审查使用 code-reviewer，返修复查使用 re-review 模板，交付使用 verification-before-completion。宿主只接管分支、凭据、状态和发布通知，不替换角色推理流程。

### 验证结果与边界

- 相关 15 个 Vitest 文件共 102 项用例通过（分轮执行；最后改动相关 4 文件 37 项再次通过）。continuation-tools 的 8 项在并行的默认 5 秒预算下发生超时，串行使用 30 秒测试预算后全部通过，未修改生产超时。
- workflow 动作与产物脚本测试 10 项通过；包括失效旧证据、命令前失败、模块覆盖、增量基线、独立 index 快照与返修差异。
- 根目录 npm run typecheck 的 contract、api-client、server、web 全部通过；最后宿主门槛改动后服务端类型检查再次通过，服务端重新构建成功。
- 官方 vendor diff 为空。独立代码审查发现的三项 Important 均修复，限定复查无剩余 Critical / Important。
- HTML 的 38 个节点位置、说明、产物链接及 6 种演示路线经过静态执行检查。
- 全量 npm test 未通过：运行约二十分钟后因多项失败及超时中止，不能称为全量绿色。已单独确认未改动的 claude-bin POSIX 路径用例在 Windows 上因正反斜杠差异失败；未借本次修复修改无关平台代码。
- 重启前核对三个注册项目没有活动任务；已重启开发服务，后端健康及前端工作流页均 HTTP 200，在线工作流 API 确认新增节点已加载。
- 没有自动恢复历史失败任务、发送真实通知、创建真实 MR 或替换历史运行绑定的工作流快照。
