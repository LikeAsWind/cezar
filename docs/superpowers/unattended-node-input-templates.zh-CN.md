# 当前无人值守工作流：节点输入与交接

依据当前模板生成，适用于使用此模板的新任务；历史任务仍绑定自己的快照。共 38 个节点、103 条连线。官方 skill 原文保持不变，下面只列宿主任务输入。

## 交接原则

- 官方 sdd-workspace 通过 plan-path 定位唯一计划目录，progress.md 是执行事实来源；native 与 SDD 可以从同一账本继续。
- 输入按“用途：路径”传递。设计和计划的待生成文件不会被当作缺失输入。
- planning 后由 validation-scope 核对覆盖，追加的新检查必须先有基线；原有检查和版本不可更改。
- 验证失败也保存当前差异与诊断，并使旧成功凭据失效。审查和交付绑定当前代码树及验证凭据。
- 限定复查使用官方 re-review 模板，获得旧发现、返修报告、修复前后代码树及 fix.diff；首次审查保持全分支。
- 用户补充从已有会话事件传递；裁决仅接收当前问题和对应阶段证据。发布、审核人设置及通知失败各自恢复。

## 需求与项目环境探测（probe）

角色：[cezar:project-probe](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/skills/project-probe/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
宿主限制探测工具与时限。按节点输入维护四份探测产物；仅发现环境和验证入口，编译测试由后续宿主执行。
```

用户输入模板：

```text
执行已加载的 cezar:project-probe，完成需求影响面、源码地图和必要环境探测。不要进入设计或实现。

原始需求：使用 Read 读取交接文件 {{handoffPath}} 的 ## Goal，无需查询环境变量。
任务身份：读取 {{runJsonPath}}，确认当前任务与工作树一致。

仅维护本阶段四份产物：
- 影响面背景：{{probePath}}
- 源码地图：{{contextMapPath}}
- 构建与测试环境：{{environmentPath}}
- 复杂度依据：{{routingInputPath}}

宿主发现的工具位置：
{{discoveredToolLocations}}

根据项目证据选择对应工具链；只核对选定版本，不逐一尝试所有已安装版本。版本查询仅使用宿主允许的命令：
{{versionQueryPrefix}} '<installed executable name or absolute path>' '<--version or -version or -v>' '<absolute Java home or empty string>'
自定义验证脚本在命令的 coverage 中列明覆盖的仓库相对文件或模块；根目录 cwd 不代表覆盖整个项目。

遵守宿主工具边界，不执行编译、测试、安装或源码修改。相互独立的读取与搜索可并行，控制单次返回量，避免上下文过载；存在依赖的操作顺序执行，报告串行写入。恢复时复用已有产物，仅补充缺失或过期证据。

本阶段总时限为 30 分钟。必要证据齐备后立即保存并交接；关键环境或证据缺失则明确记录阻塞。

最终回复简述结论与缺口，最后一行只输出以下标记之一：
CEZ:VERDICT ready
CEZ:VERDICT blocked
```


## start（start）

类型：`start`。工作流入口。

出口：next → 需求与项目环境探测。

## 项目编译与测试基线（baseline）

宿主执行：`cezar workflow-action baseline`。退出码 0 走 pass，否则走 fail；错误与结果保存在节点会话。

出口：pass → 按探测证据选择复杂度；fail → 记录阻塞并结束。

## 按探测证据选择复杂度（route）

宿主执行：`cezar workflow-action route`。退出码 0 走 pass，否则走 fail；错误与结果保存在节点会话。

出口：pass → 简单任务直接规划，其余进入设计；fail → 记录阻塞并结束。

## 简单任务直接规划，其余进入设计（route-fast）

类型：`if`。条件：{"kind":"output","ref":"route.output","op":"equals","value":"fast"}。

出口：true → 轻量计划；false → 设计与需求消歧。

## 轻量计划（fast-plan）

角色：`superpowers:writing-plans`

```text
执行已加载的 writing-plans，按原始需求编写最小完整计划，保存 plan.md。原始需求作为本分支的规格；复用 probe.md 和源码地图中的证据。
按官方格式自查，并将项目约束与实际验证入口纳入计划。核对 routing-input.json 与计划影响面，运行 cezar workflow-action route，返回实际 fast/standard/deep；不以升档代替重试。
范围扩大时，以冻结 validation-plan.json 为底稿，在 environment.json 仅追加新模块检查及对应基线；宿主核对覆盖并执行新增基线。不得删除或改写旧检查、版本与预期输出。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定问题编号（如 Q-001）、独立一行 origin: fast-plan 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
需求背景与影响面：docs/superpowers/probe/{{日期-英文主题}}-probe.md
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
编译测试命令与版本约束：.ai/cezar/runs/example-run/validation-plan.json
复杂度判断依据：docs/superpowers/probe/{{日期-英文主题}}-routing-input.json
当前复杂度档位：.ai/cezar/runs/example-run/route.json
本节点输出：
实现计划（本节点输出；尚未生成，直接创建，不预先读取）：docs/superpowers/plans/{{日期-英文主题}}-plan.md
工具链与验证入口草稿（本节点输出，仅范围扩大时按冻结计划追加检查与基线，不改旧约束；尚未生成，直接创建，不预先读取）：docs/superpowers/probe/{{日期-英文主题}}-environment.json
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <fast | standard | deep | blocked | question>
```

出口：fast → 核对验证覆盖与新增模块基线；standard → 最多两次升档；deep → 最多两次升档；blocked → 记录阻塞并结束；failed → 记录阻塞并结束；question → 最多八轮按需裁决。

## 设计与需求消歧（design）

角色：`superpowers:brainstorming`

```text
执行已加载的 brainstorming，结合原始需求和 probe.md 完成澄清与设计，保存 design.md。
恢复时复用已有设计、已完成的 builder check 及反馈。

设计阶段按以下原则收口：
- 项目事实、依赖库行为由本节点定向核实。影响方案成立的关键假设，不留给实现者确认。
- 已授权范围内的技术细节可自行决定，在设计中说明依据和取舍。
- 涉及需求歧义、外部可观察的行为变化且授权不明确，或证据冲突导致无法决定时，返回 question，交给裁决者。
- 实现阶段可承担编码细节、测试落地与运行验证；不能承担决定方案是否成立的前提核实。

必要问题已解决、关键前提有证据支持，且完成 builder check 并处理反馈后，才返回 ready。
存在尚未解决的关键问题时，提出具体问题；无法继续且没有可裁决的问题时返回 blocked。
最终回复简述设计结论、关键依据及留给实现阶段的验证事项。

遵守 validation-plan.json 的目标版本约束。
范围变化时更新 routing-input.json，并运行 cezar workflow-action route，不降档。

需要裁决时，在最终回复中给出一个完整问题、稳定编号（如 Q-001）、独立一行 origin: design，以及证据路径，返回 question。
恢复时核对宿主注入的裁决，更新设计后继续。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
需求背景与影响面：docs/superpowers/probe/{{日期-英文主题}}-probe.md
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
编译测试命令与版本约束：.ai/cezar/runs/example-run/validation-plan.json
复杂度判断依据：docs/superpowers/probe/{{日期-英文主题}}-routing-input.json
本节点输出：
设计方案（本节点输出；尚未生成，直接创建，不预先读取）：docs/superpowers/specs/{{日期-英文主题}}-design.md
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <ready | question | blocked>
```

出口：ready → 完整实现计划；blocked → 记录阻塞并结束；failed → 记录阻塞并结束；question → 最多八轮按需裁决。

## 最多八轮按需裁决（clarification-round）

类型：`loop`。最多 8 次，恢复不重置次数。

出口：repeat → 按需需求与技术裁决；exhausted → 记录阻塞并结束。

## 按需需求与技术裁决（adjudicator）

角色：`cezar:adjudicator`

下列初始化输入仅用于首次调用或无法恢复原会话时。后续正常恢复同一个裁决会话，只发送本轮问题。后台系统配置保持一致，避免上下文压缩后丢失角色规则；它不作为每轮用户输入重复插入。

```text
执行已加载的 adjudicator，仅回答宿主注入的当前问题，最终回复完整给出 Q 编号、独立一行 origin、回答、依据及不确定性，由宿主持久化并显示在会话和图节点输出中。
按 origin 返回调用者：design 返回 answered；fast-plan、plan、execute-fast、execute-standard、execute-deep、execute-deep-native、fix 返回对应 origin。origin 无效或证据、授权不足则 blocked。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
需求背景与影响面：docs/superpowers/probe/{{日期-英文主题}}-probe.md
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
编译测试命令与版本约束（环境问题时读取）：.ai/cezar/runs/example-run/validation-plan.json
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <answered | fast-plan | plan | execute-fast | execute-standard | execute-deep | execute-deep-native | fix | blocked>
```

出口：answered → 设计与需求消歧；blocked → 记录阻塞并结束；failed → 记录阻塞并结束；fast-plan → 轻量计划；plan → 完整实现计划；execute-fast → 轻量 native 执行；execute-standard → 标准 native 执行；execute-deep → 复杂 SDD 逐任务实现与审查；execute-deep-native → 复杂任务 native 执行（保留高风险约束）；fix → 修复本次变更引入的问题。

后续问题的用户输入示例：

```text
当前问题：Q-002
origin: design
返回节点：design

Q-002：验收标准是否要求合入前复现触发路径？
{{本次完整问题与证据}}

答复保留 Q-002 和独立一行 origin: design；最后一行输出 CEZ:VERDICT answered，无法裁决时输出 CEZ:VERDICT blocked。
```

原调用节点提出问题后保持会话打开、等待裁决。宿主将匹配的问题答复和该节点的结束标记直接送回原会话，不重发初始化输入；服务重启后才使用持久化会话恢复：

```text
裁决结果（Q-002，返回 design）：
{{裁决者对 Q-002 的完整答复}}

{{design 节点的结束标记要求}}
```

本轮新增的用户补充、附件和派发回报仍随对应输入传递。完整历史保留在会话与澄清记录中，不反复包成 JSON 注入。

等待裁决仍计入原节点时限和资源占用。裁决阻塞、失败或取消时关闭等待的原会话，并结束其等待状态；原会话意外退出时停止裁决并明确报错。服务退出会停止定时派发，不在旧管理器中启动新代理。前端会话及来源节点、裁决节点均展示提问助手、裁决助手、问题编号与状态，刷新后从事件历史重放。

## 完整实现计划（plan）

角色：`superpowers:writing-plans`

```text
执行已加载的 writing-plans，以 design.md 为依据保存完整 plan.md，按官方格式自查，纳入项目约束和实际验证入口。
根据计划影响面更新 routing-input.json，运行 cezar workflow-action route，保留至少 standard，返回 standard 或 deep，不降档。
范围扩大时，以冻结 validation-plan.json 为底稿，在 environment.json 仅追加新模块检查及对应基线；宿主核对覆盖并执行新增基线。不得删除或改写旧检查、版本与预期输出。
返回 deep 前，在最终回复中单独一行输出 CEZ:EXECUTION 后跟 JSON：{"schemaVersion":1,"tasksIndependent":true/false/null,"subagents":{"available":true/false/null,"tool":"实际工具名或 null","evidence":"实际观察或缺失说明"}}。宿主保存证据并选择执行器。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定问题编号（如 Q-001）、独立一行 origin: plan 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
设计方案：docs/superpowers/specs/{{日期-英文主题}}-design.md
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
编译测试命令与版本约束：.ai/cezar/runs/example-run/validation-plan.json
复杂度判断依据：docs/superpowers/probe/{{日期-英文主题}}-routing-input.json
当前复杂度档位：.ai/cezar/runs/example-run/route.json
本节点输出：
实现计划（本节点输出；尚未生成，直接创建，不预先读取）：docs/superpowers/plans/{{日期-英文主题}}-plan.md
工具链与验证入口草稿（本节点输出，仅范围扩大时按冻结计划追加检查与基线，不改旧约束；尚未生成，直接创建，不预先读取）：docs/superpowers/probe/{{日期-英文主题}}-environment.json
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <standard | deep | blocked | question>
```

出口：standard → 核对验证覆盖与新增模块基线；deep → 核对验证覆盖与新增模块基线；blocked → 记录阻塞并结束；failed → 记录阻塞并结束；question → 最多八轮按需裁决。

## 核对验证覆盖与新增模块基线（validation-scope）

宿主执行：`cezar workflow-action scope`。退出码 0 走 pass，否则走 fail；错误与结果保存在节点会话。

出口：pass → 验证后选择轻量执行；fail → 记录阻塞并结束。

## 验证后选择轻量执行（scope-fast）

类型：`if`。条件：{"kind":"output","ref":"validation-scope.output","op":"equals","value":"fast"}。

出口：true → 轻量 native 执行；false → 验证后选择标准或复杂执行。

## 验证后选择标准或复杂执行（scope-standard）

类型：`if`。条件：{"kind":"output","ref":"validation-scope.output","op":"equals","value":"standard"}。

出口：true → 标准 native 执行；false → 按任务依赖与能力选择执行器。

## 轻量 native 执行（execute-fast）

角色：`superpowers:executing-plans`

```text
执行已加载的 executing-plans，完成 plan.md 中 fast 档任务。
范围超出当前档时更新源码地图和 routing-input.json，运行 cezar workflow-action route，返回 standard/deep 并保留已完成工作。
使用官方 sdd-workspace 为当前 plan.md 定位唯一工作目录；progress.md、brief 和报告都保存在该目录，不新建宿主进度副本。native 按官方 task-done 的测试完成契约将步骤标为 [x]；SDD 在逐任务审查通过并写入完成账本后勾选，未完成不得勾选。合并派发时，在账本用 Task N: report: 文件名 标明各任务共用的报告，不复制报告。构建输出不另存全量日志，最终回复报告命令、版本、退出码、测试数量和必要失败诊断。保留工作目录供后续验证、独立审查与裁决读取。
完成所有 Task 后返回 complete。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定问题编号（如 Q-001）、独立一行 origin: execute-fast 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
实现计划（执行前读取）：docs/superpowers/plans/{{日期-英文主题}}-plan.md
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
编译测试命令与版本约束：.ai/cezar/runs/example-run/validation-plan.json
复杂度判断依据：docs/superpowers/probe/{{日期-英文主题}}-routing-input.json
当前复杂度档位：.ai/cezar/runs/example-run/route.json
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <complete | standard | deep | blocked | question>
```

出口：complete → 目标项目完整交付验证；standard → 最多两次升档；deep → 最多两次升档；blocked → 记录阻塞并结束；failed → 记录阻塞并结束；question → 最多八轮按需裁决。

## 标准 native 执行（execute-standard）

角色：`superpowers:executing-plans`

```text
执行已加载的 executing-plans，完成 plan.md 中 standard 档任务。
范围升至 deep 时更新源码地图和 routing-input.json，运行 cezar workflow-action route，返回 deep 并保留已完成工作。
使用官方 sdd-workspace 为当前 plan.md 定位唯一工作目录；progress.md、brief 和报告都保存在该目录，不新建宿主进度副本。native 按官方 task-done 的测试完成契约将步骤标为 [x]；SDD 在逐任务审查通过并写入完成账本后勾选，未完成不得勾选。合并派发时，在账本用 Task N: report: 文件名 标明各任务共用的报告，不复制报告。构建输出不另存全量日志，最终回复报告命令、版本、退出码、测试数量和必要失败诊断。保留工作目录供后续验证、独立审查与裁决读取。
完成所有 Task 后返回 complete。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定问题编号（如 Q-001）、独立一行 origin: execute-standard 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
实现计划（执行前读取）：docs/superpowers/plans/{{日期-英文主题}}-plan.md
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
编译测试命令与版本约束：.ai/cezar/runs/example-run/validation-plan.json
复杂度判断依据：docs/superpowers/probe/{{日期-英文主题}}-routing-input.json
当前复杂度档位：.ai/cezar/runs/example-run/route.json
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <complete | deep | blocked | question>
```

出口：complete → 目标项目完整交付验证；deep → 最多两次升档；blocked → 记录阻塞并结束；failed → 记录阻塞并结束；question → 最多八轮按需裁决。

## 按任务依赖与能力选择执行器（execution-route）

宿主执行：`cezar workflow-action execution`。退出码 0 走 pass，否则走 fail；错误与结果保存在节点会话。

出口：pass → 独立任务且具备派发能力；fail → 记录阻塞并结束。

## 独立任务且具备派发能力（execution-sdd）

类型：`if`。条件：{"kind":"output","ref":"execution-route.output","op":"equals","value":"sdd"}。

出口：true → 复杂 SDD 逐任务实现与审查；false → 复杂任务 native 执行（保留高风险约束）。

## 复杂任务 native 执行（保留高风险约束）（execute-deep-native）

角色：`superpowers:executing-plans`

```text
执行已加载的 executing-plans，完成 plan.md 中 deep 档任务；读取 execution.json 中 native 选择原因，保留高风险约束。
使用官方 sdd-workspace 为当前 plan.md 定位唯一工作目录；progress.md、brief 和报告都保存在该目录，不新建宿主进度副本。native 按官方 task-done 的测试完成契约将步骤标为 [x]；SDD 在逐任务审查通过并写入完成账本后勾选，未完成不得勾选。合并派发时，在账本用 Task N: report: 文件名 标明各任务共用的报告，不复制报告。构建输出不另存全量日志，最终回复报告命令、版本、退出码、测试数量和必要失败诊断。保留工作目录供后续验证、独立审查与裁决读取。
完成所有 Task 后返回 complete。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定问题编号（如 Q-001）、独立一行 origin: execute-deep-native 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
实现计划（执行前读取）：docs/superpowers/plans/{{日期-英文主题}}-plan.md
执行器选择及原因：.ai/cezar/runs/example-run/execution.json
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
编译测试命令与版本约束：.ai/cezar/runs/example-run/validation-plan.json
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <complete | question | blocked>
```

出口：complete → 目标项目完整交付验证；question → 最多八轮按需裁决；blocked → 记录阻塞并结束；failed → 记录阻塞并结束。

## 复杂 SDD 逐任务实现与审查（execute-deep）

角色：`superpowers:subagent-driven-development`

```text
执行已加载的 subagent-driven-development，完成 plan.md 中 deep 档任务，使用官方 implementer、task-reviewer 和 re-review 模板及原生工作目录。
记录实际派发能力、模型和审查报告路径。
使用官方 sdd-workspace 为当前 plan.md 定位唯一工作目录；progress.md、brief 和报告都保存在该目录，不新建宿主进度副本。native 按官方 task-done 的测试完成契约将步骤标为 [x]；SDD 在逐任务审查通过并写入完成账本后勾选，未完成不得勾选。合并派发时，在账本用 Task N: report: 文件名 标明各任务共用的报告，不复制报告。构建输出不另存全量日志，最终回复报告命令、版本、退出码、测试数量和必要失败诊断。保留工作目录供后续验证、独立审查与裁决读取。
完成所有 Task 后返回 complete。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定问题编号（如 Q-001）、独立一行 origin: execute-deep 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
实现计划（执行前读取）：docs/superpowers/plans/{{日期-英文主题}}-plan.md
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
编译测试命令与版本约束：.ai/cezar/runs/example-run/validation-plan.json
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <complete | blocked | question>
```

出口：complete → 目标项目完整交付验证；blocked → 记录阻塞并结束；failed → 记录阻塞并结束；question → 最多八轮按需裁决。

## 最多两次升档（upgrade）

类型：`loop`。最多 2 次，恢复不重置次数。

出口：repeat → 设计与需求消歧；exhausted → 记录阻塞并结束。

## 目标项目完整交付验证（verify）

宿主执行：`cezar workflow-action verify`。退出码 0 走 pass，否则走 fail；错误与结果保存在节点会话。

出口：pass → 独立全分支审查或限定复查；fail → 一次最终返修。

## 独立全分支审查或限定复查（review）

角色：`superpowers:code-reviewer`

```text
执行已加载的 code-reviewer，担任独立、只读的最终分支审查。核对需求、设计、计划、当前 branch.diff 及 verify.json/verified.json 的验证证据。
首次审查使用官方模板：DESCRIPTION 来自任务，PLAN_OR_REQUIREMENTS 使用相关产物路径，BASE_SHA 来自 run.json，HEAD_SHA 来自当前 HEAD；branch.diff 补足未提交及新增文件。
仅在宿主提供限定复查参数时，使用官方 subagent-driven-development/re-review-prompt.md，读取 FINDINGS、REPORT_FILE 与 DIFF_FILE，按 FIX_BASE_SHA/HEAD_SHA 范围复查。两者是包含未提交文件的 Git 代码树快照。验证失败后的首次审查仍覆盖全分支。先核对官方账本和既有测试证据，临时程序文件不存在不能推断从未执行。
最终回复说明未评判范围；无实质阻塞返回 approve，需要修复返回 changes，证据不足返回 blocked。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
设计方案（可选输入，未生成，无需读取）：docs/superpowers/specs/{{日期-英文主题}}-design.md
实现计划：docs/superpowers/plans/{{日期-英文主题}}-plan.md
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
当前验证结果与失败原因：.ai/cezar/runs/example-run/verify.json
验证对应的变更凭据：.ai/cezar/runs/example-run/verified.json
本次任务完整代码差异：.ai/cezar/runs/example-run/branch.diff
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <approve | changes | blocked>
```

出口：approve → 整理验证证据与裁决；changes → 一次最终返修；blocked → 记录阻塞并结束；failed → 记录阻塞并结束。

## 一次最终返修（final-retry）

类型：`loop`。最多 1 次，恢复不重置次数。

出口：repeat → 修复本次变更引入的问题；exhausted → 记录阻塞并结束。

## 修复本次变更引入的问题（fix）

角色：`superpowers:systematic-debugging`

```text
执行已加载的 systematic-debugging，使用官方 subagent-driven-development/implementer-prompt.md，以当前计划、失败证据和工作树填写参数。
先对照 baseline.json 判断根因，仅修复本次变更引入的重要问题。既有失败或缺失基础设施记录证据并返回 blocked。
在当前计划的官方 progress.md 记录修复和针对性验证，最终回复提供官方 implementer 修复报告，宿主将报告保存到同一工作目录。针对性检查通过后返回 fixed，宿主负责重新验证及生成修复增量；保持冻结检查和约束。验证未启动时按宿主错误诊断处理，不要求不存在的成功凭据。
验证输出：
{{nodes.verify.output}}
审查发现（未审查时为空）：
读取宿主提供的当前官方审查报告；尚未审查时仅使用验证失败诊断。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定问题编号（如 Q-001）、独立一行 origin: fix 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
实现计划：docs/superpowers/plans/{{日期-英文主题}}-plan.md
源码定位地图：docs/superpowers/probe/{{日期-英文主题}}-context-map.jsonl
修改前的检查结果：.ai/cezar/runs/example-run/baseline.json
当前验证结果与失败原因（可选输入，未生成，无需读取）：.ai/cezar/runs/example-run/verify.json
编译测试命令与版本约束：.ai/cezar/runs/example-run/validation-plan.json
本次任务完整代码差异（可选输入，未生成，无需读取）：.ai/cezar/runs/example-run/branch.diff
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

最终回复末行：CEZ:VERDICT <fixed | blocked | question>
```

出口：fixed → 目标项目完整交付验证；blocked → 记录阻塞并结束；failed → 记录阻塞并结束；question → 最多八轮按需裁决。

## 整理验证证据与裁决（deliver）

角色：`superpowers:verification-before-completion`

```text
执行已加载的 verification-before-completion，核对 verify.json、verified.json、官方进度账本及宿主裁决 和已批准的独立审查。
最终回复给出需求与证据对应关系、变更文件、实际命令及结果、裁决、遗留限制和证据路径；读取宿主提供的已批准审查报告并复用。证据一致返回 ready，否则 blocked。本节点不修改源码或执行提交。

原始需求：使用 Read 读取交接文件 {{工作树}}\.ai\cezar\runs\example-run\handoff.md 的 ## Goal，无需查询环境变量。
任务身份：读取 run.json，确认任务与工作树一致。
输入文件：
任务与工作树信息：.ai/cezar/runs/example-run/run.json
实现计划：docs/superpowers/plans/{{日期-英文主题}}-plan.md
当前验证结果与失败原因：.ai/cezar/runs/example-run/verify.json
验证对应的变更凭据：.ai/cezar/runs/example-run/verified.json
必需输入缺失时报告具体缺口，不搜索其他任务产物；待生成输出和未生成的可选输入不属于输入缺失。

最终回复末行：CEZ:VERDICT <ready | blocked>
```

出口：ready → 核对验证后代码未变；blocked → 记录阻塞并结束；failed → 记录阻塞并结束。

## 核对验证后代码未变（seal）

宿主执行：`cezar workflow-action seal`。退出码 0 走 pass，否则走 fail；错误与结果保存在节点会话。

出口：pass → 推送分支并创建 Draft MR；fail → 记录阻塞并结束。

## 推送分支并创建 Draft MR（publish-mr）

类型：`github.draft-pr`。工作流入口。

出口：created → 请求 guohongwei 审核（GitLab 通知）；failed → 通知推送或创建 MR 失败。

## 请求 guohongwei 审核（GitLab 通知）（request-review）

类型：`github.pr-update`。工作流入口。

出口：done → 企业微信群通知并 @ 审核人；failed → 通知审核人设置失败（保留 MR）。

## 企业微信群通知并 @ 审核人（notify-wecom）

类型：`notify.wecom`。工作流入口。

出口：done → 更新 TAPD 需求为验收；skipped → MR 已创建，自动交接完成；failed → MR 已创建，群通知失败。

## 更新 TAPD 需求为验收（tapd-acceptance）

类型：`tracker.update-status`，目标状态名：`验收`。由宿主执行，不启动代理。

读取任务保存的 TAPD 空间与需求编号，核对当前连接一致；查询需求所属工作流，解析“验收”的实际状态编号，调用 TAPD 更新接口并重新读取确认结果。已经处于验收状态时直接确认成功；不回退已完成的需求。

出口：done → 自动交接完成；无关联 TAPD 需求时 skipped → 自动交接完成；failed → MR 已通知，TAPD 状态回写失败。恢复时只重试本节点，不重发 MR 通知、不重跑开发。

## MR 已创建，群通知失败（notification-failed）

类型：`end`。终态：failed。

出口：结束。

## 通知审核人设置失败（保留 MR）（notify-review-failed）

类型：`notify.wecom`。工作流入口。

出口：done → MR 已创建，审核人设置失败；skipped → MR 已创建，审核人设置失败；failed → MR 已创建，审核人设置失败。

## MR 已创建，审核人设置失败（review-request-failed）

类型：`end`。终态：failed。

出口：结束。

## 通知推送或创建 MR 失败（notify-publication-failed）

类型：`notify.wecom`。工作流入口。

出口：done → 提交审核失败（保留已完成工作）；skipped → 提交审核失败（保留已完成工作）；failed → 提交审核失败（保留已完成工作）。

## 通知工作流阻塞（notify-blocked）

类型：`notify.wecom`。工作流入口。

出口：done → 阻塞或返修耗尽；skipped → 阻塞或返修耗尽；failed → 阻塞或返修耗尽。

## 提交审核失败（保留已完成工作）（publication-failed）

类型：`end`。终态：failed。

出口：结束。

## 记录阻塞并结束（blocked-report）

宿主执行：`cezar workflow-action blocked`。退出码 0 走 pass，否则走 fail；错误与结果保存在节点会话。

出口：pass → 通知工作流阻塞；fail → 通知工作流阻塞。

## MR 已创建，自动交接完成（done）

类型：`end`。终态：success。

出口：结束。

## 阻塞或返修耗尽（stopped）

类型：`end`。终态：failed。

出口：结束。
