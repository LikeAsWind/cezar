# 当前无人值守工作流：完整输入提示词清单

依据当前源码导出，适用于重启后的新任务。不是历史运行的逐字启动记录。{{...}} 是宿主运行时填入的值，无需用户填写。

## 统计

12 个代理节点、6 个命令检查节点、2 个宿主 Git 操作节点、9 个条件/循环/起止节点，共 29 个节点。

下表按 JavaScript 字符串 length 统计静态节点任务字符数；探测采用宿主专用输入的占位符版本。字符数不包含角色正文、动态路径、宿主上下文或额外系统规则，不等于 token 数。

| 节点 | 中文名称 | 角色 | 静态任务字符数 |
| --- | --- | --- | ---: |
| probe | 需求与项目环境探测 | cezar:project-probe | 689 |
| fast-plan | 轻量计划 | superpowers:writing-plans | 313 |
| design | 设计与需求消歧 | superpowers:brainstorming | 344 |
| adjudicator | 按需需求与技术裁决 | cezar:adjudicator | 245 |
| plan | 完整实现计划 | superpowers:writing-plans | 476 |
| execute-fast | 轻量 native 执行 | superpowers:executing-plans | 402 |
| execute-standard | 标准 native 执行 | superpowers:executing-plans | 404 |
| execute-deep-native | 复杂任务 native 执行（保留高风险约束） | superpowers:executing-plans | 356 |
| execute-deep | 复杂 SDD 逐任务实现与审查 | superpowers:subagent-driven-development | 394 |
| review | 独立全分支审查或限定复查 | superpowers:code-reviewer | 436 |
| fix | 修复本次变更引入的问题 | superpowers:systematic-debugging | 445 |
| deliver | 整理验证证据与裁决 | superpowers:verification-before-completion | 212 |

## 系统输入与启动参数

系统输入组合所选角色原文、相关无人值守规则、启用时的派发/自动化规则、用户或项目额外 system prompt，以及交接/待办规则。角色原文在各节点处链接，不重复粘贴官方 skill。

模型、工作目录、工具权限、MCP、会话编号和超时属于启动参数。探测总时限 30 分钟，两个 deep 执行节点 90 分钟，其余采用宿主默认规则。

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

原始需求：读取 CEZ_HANDOFF_FILE 的 ## Goal。
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

遵守宿主工具边界，不执行编译、测试、安装或源码修改。独立读取每批最多三项，报告串行写入。恢复时复用已有产物，仅补充缺失或过期证据。

本阶段总时限为 30 分钟。必要证据齐备后立即保存并交接；关键环境或证据缺失则明确记录阻塞。

最终回复简述结论与缺口，最后一行只输出以下标记之一：
CEZ:VERDICT ready
CEZ:VERDICT blocked
```

## 轻量计划（fast-plan）

角色：[superpowers:writing-plans](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/writing-plans/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
设计或清晰的小任务原始需求是计划依据。计划使用注入的 plan.md 路径；执行方式已由工作流选择，无需询问人工。冻结验证约束纳入计划。
```

用户输入模板：

```text
执行已加载的 writing-plans，按原始需求编写最小完整计划，保存 plan.md。原始需求作为本分支的规格；复用 probe.md 和源码地图中的证据。
按官方格式自查，并将项目约束与实际验证入口纳入计划。核对 routing-input.json 与计划影响面，运行 cezar workflow-action route，返回实际 fast/standard/deep；不以升档代替重试。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定 Q 编号、独立一行 origin: fast-plan 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT fast
CEZ:VERDICT standard
CEZ:VERDICT deep
CEZ:VERDICT blocked
CEZ:VERDICT question

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
需求背景与影响面：{{artifactPaths.probe.md}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
编译测试命令与版本约束：{{artifactPaths.validation-plan.json}}
复杂度判断依据：{{artifactPaths.routing-input.json}}
当前复杂度档位：{{artifactPaths.route.json}}
实现计划（本节点生成，恢复时复用）：{{artifactPaths.plan.md}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：来源为本节点的历史裁决，包括待恢复的阻塞结论

## 设计与需求消歧（design）

角色：[superpowers:brainstorming](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/brainstorming/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
Independent builder review replaces interactive design approval：这是机器审核。需要需求授权的问题逐个交给独立裁决者，返回后核对答复；证据不足保持 blocked。
```

用户输入模板：

```text
执行已加载的 brainstorming，结合原始需求和 probe.md 完成澄清与设计，保存 design.md。
恢复时复用已完成的 builder check 及反馈。
必要问题解决并完成 builder check 后返回 ready。遵守 validation-plan.json 的目标版本约束。范围变化时更新 routing-input.json 并运行 cezar workflow-action route，不降档。最终回复说明设计进度和未完成检查。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定 Q 编号、独立一行 origin: design 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT ready
CEZ:VERDICT question
CEZ:VERDICT blocked

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
需求背景与影响面：{{artifactPaths.probe.md}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
编译测试命令与版本约束：{{artifactPaths.validation-plan.json}}
复杂度判断依据：{{artifactPaths.routing-input.json}}
设计方案（本节点生成，恢复时复用）：{{artifactPaths.design.md}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：来源为本节点的历史裁决，包括待恢复的阻塞结论

## 按需需求与技术裁决（adjudicator）

角色：[cezar:adjudicator](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/skills/adjudicator/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
读取宿主注入的当前问题及引用证据，在最终回复中完整返回同 Q 编号和 origin 的答复。证据或需求授权不足则 blocked。
```

用户输入模板：

```text
执行已加载的 adjudicator，仅回答宿主注入的当前问题，最终回复完整给出 Q 编号、独立一行 origin、回答、依据及不确定性，由宿主持久化并显示在会话和图节点输出中。
按 origin 返回调用者：design 返回 answered；fast-plan、plan、execute-fast、execute-standard、execute-deep、execute-deep-native、fix 返回对应 origin。origin 无效或证据、授权不足则 blocked。

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT answered
CEZ:VERDICT fast-plan
CEZ:VERDICT plan
CEZ:VERDICT execute-fast
CEZ:VERDICT execute-standard
CEZ:VERDICT execute-deep
CEZ:VERDICT execute-deep-native
CEZ:VERDICT fix
CEZ:VERDICT blocked

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
需求背景与影响面：{{artifactPaths.probe.md}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
编译测试命令与版本约束（环境问题时读取）：{{artifactPaths.validation-plan.json}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：当前问题、来源、状态及历史裁决

## 完整实现计划（plan）

角色：[superpowers:writing-plans](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/writing-plans/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
设计或清晰的小任务原始需求是计划依据。计划使用注入的 plan.md 路径；执行方式已由工作流选择，无需询问人工。冻结验证约束纳入计划。
```

用户输入模板：

```text
执行已加载的 writing-plans，以 design.md 为依据保存完整 plan.md，按官方格式自查，纳入项目约束和实际验证入口。
根据计划影响面更新 routing-input.json，运行 cezar workflow-action route，保留至少 standard，返回 standard 或 deep，不降档。
返回 deep 前，在最终回复中单独一行输出 CEZ:EXECUTION 后跟 JSON：{"schemaVersion":1,"tasksIndependent":true/false/null,"subagents":{"available":true/false/null,"tool":"实际工具名或 null","evidence":"实际观察或缺失说明"}}。宿主保存证据并选择执行器。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定 Q 编号、独立一行 origin: plan 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT standard
CEZ:VERDICT deep
CEZ:VERDICT blocked
CEZ:VERDICT question

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
设计方案：{{artifactPaths.design.md}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
编译测试命令与版本约束：{{artifactPaths.validation-plan.json}}
复杂度判断依据：{{artifactPaths.routing-input.json}}
当前复杂度档位：{{artifactPaths.route.json}}
实现计划（本节点生成，恢复时复用）：{{artifactPaths.plan.md}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：来源为本节点的历史裁决，包括待恢复的阻塞结论

## 轻量 native 执行（execute-fast）

角色：[superpowers:executing-plans](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/executing-plans/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
使用当前工作树和冻结工具链；恢复时复用官方 progress.md 及宿主检查点。完成任务后停在最终全分支审查之前，由 cezar 验证并独立审查。需求阻塞可交裁决者。
```

用户输入模板：

```text
执行已加载的 executing-plans，完成 plan.md 中 fast 档任务。
范围超出当前档时更新源码地图和 routing-input.json，运行 cezar workflow-action route，返回 standard/deep 并保留已完成工作。
每个 Task 审核通过后，将 plan.md 中对应任务标记为 [x]；未审核或审核未通过不得勾选。测试证据及审查报告仍记录在 progress.md 和原生报告中。构建输出不另存全量日志，最终回复报告命令、版本、退出码、测试数量和必要失败诊断。
完成所有 Task 后返回 complete。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定 Q 编号、独立一行 origin: execute-fast 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT complete
CEZ:VERDICT standard
CEZ:VERDICT deep
CEZ:VERDICT blocked
CEZ:VERDICT question

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
实现计划（执行前读取）：{{artifactPaths.plan.md}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
编译测试命令与版本约束：{{artifactPaths.validation-plan.json}}
复杂度判断依据：{{artifactPaths.routing-input.json}}
当前复杂度档位：{{artifactPaths.route.json}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：来源为本节点的历史裁决，包括待恢复的阻塞结论

## 标准 native 执行（execute-standard）

角色：[superpowers:executing-plans](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/executing-plans/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
使用当前工作树和冻结工具链；恢复时复用官方 progress.md 及宿主检查点。完成任务后停在最终全分支审查之前，由 cezar 验证并独立审查。需求阻塞可交裁决者。
```

用户输入模板：

```text
执行已加载的 executing-plans，完成 plan.md 中 standard 档任务。
范围升至 deep 时更新源码地图和 routing-input.json，运行 cezar workflow-action route，返回 deep 并保留已完成工作。
每个 Task 审核通过后，将 plan.md 中对应任务标记为 [x]；未审核或审核未通过不得勾选。测试证据及审查报告仍记录在 progress.md 和原生报告中。构建输出不另存全量日志，最终回复报告命令、版本、退出码、测试数量和必要失败诊断。
完成所有 Task 后返回 complete。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定 Q 编号、独立一行 origin: execute-standard 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT complete
CEZ:VERDICT deep
CEZ:VERDICT blocked
CEZ:VERDICT question

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
实现计划（执行前读取）：{{artifactPaths.plan.md}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
编译测试命令与版本约束：{{artifactPaths.validation-plan.json}}
复杂度判断依据：{{artifactPaths.routing-input.json}}
当前复杂度档位：{{artifactPaths.route.json}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：来源为本节点的历史裁决，包括待恢复的阻塞结论

## 复杂任务 native 执行（保留高风险约束）（execute-deep-native）

角色：[superpowers:executing-plans](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/executing-plans/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
使用当前工作树和冻结工具链；恢复时复用官方 progress.md 及宿主检查点。完成任务后停在最终全分支审查之前，由 cezar 验证并独立审查。需求阻塞可交裁决者。
```

用户输入模板：

```text
执行已加载的 executing-plans，完成 plan.md 中 deep 档任务；读取 execution.json 中 native 选择原因，保留高风险约束。
每个 Task 审核通过后，将 plan.md 中对应任务标记为 [x]；未审核或审核未通过不得勾选。测试证据及审查报告仍记录在 progress.md 和原生报告中。构建输出不另存全量日志，最终回复报告命令、版本、退出码、测试数量和必要失败诊断。
完成所有 Task 后返回 complete。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定 Q 编号、独立一行 origin: execute-deep-native 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT complete
CEZ:VERDICT question
CEZ:VERDICT blocked

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
实现计划（执行前读取）：{{artifactPaths.plan.md}}
执行器选择及原因：{{artifactPaths.execution.json}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
编译测试命令与版本约束：{{artifactPaths.validation-plan.json}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：来源为本节点的历史裁决，包括待恢复的阻塞结论

## 复杂 SDD 逐任务实现与审查（execute-deep）

角色：[superpowers:subagent-driven-development](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/subagent-driven-development/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
使用官方逐任务派发与审查流程、原生报告和 ledger。Task 审查包括未提交变更。完成任务后停在最终全分支审查之前，由 cezar 验证并独立审查。需求阻塞可交裁决者。
```

用户输入模板：

```text
执行已加载的 subagent-driven-development，完成 plan.md 中 deep 档任务，使用官方 implementer、task-reviewer 和 re-review 模板及原生工作目录。
记录实际派发能力、模型和审查报告路径。
每个 Task 审核通过后，将 plan.md 中对应任务标记为 [x]；未审核或审核未通过不得勾选。测试证据及审查报告仍记录在 progress.md 和原生报告中。构建输出不另存全量日志，最终回复报告命令、版本、退出码、测试数量和必要失败诊断。
完成所有 Task 后返回 complete。
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定 Q 编号、独立一行 origin: execute-deep 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT complete
CEZ:VERDICT blocked
CEZ:VERDICT question

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
实现计划（执行前读取）：{{artifactPaths.plan.md}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
编译测试命令与版本约束：{{artifactPaths.validation-plan.json}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：来源为本节点的历史裁决，包括待恢复的阻塞结论

## 独立全分支审查或限定复查（review）

角色：[superpowers:code-reviewer](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/requesting-code-review/code-reviewer.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
当前节点就是最终独立审查席位，只读并在回复中交付报告。完整 diff 包括未提交和新增文件；已有完整审查后的复查遵守官方 re-review 范围。
```

用户输入模板：

```text
执行已加载的 code-reviewer，担任独立、只读的最终分支审查。核对需求、设计、计划、当前 branch.diff 及 verify.json/verified.json 的验证证据。
首次审查使用官方模板：DESCRIPTION 来自任务，PLAN_OR_REQUIREMENTS 使用相关产物路径，BASE_SHA 来自 run.json，HEAD_SHA 来自当前 HEAD；branch.diff 补足未提交及新增文件。
仅在已有完整审查时，使用官方 subagent-driven-development/re-review-prompt.md，结合既有发现、修复报告及 fix-before.diff，限定复查修复引入的问题。验证失败后的首次审查仍覆盖全分支。
最终回复说明未评判范围；无实质阻塞返回 approve，需要修复返回 changes，证据不足返回 blocked。
既有审查（首次为空）：
{{nodes.review.summary}}

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT approve
CEZ:VERDICT changes
CEZ:VERDICT blocked

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
设计方案：{{artifactPaths.design.md}}
实现计划：{{artifactPaths.plan.md}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
当前验证结果与失败原因：{{artifactPaths.verify.json}}
验证对应的变更凭据：{{artifactPaths.verified.json}}
本次任务完整代码差异：{{artifactPaths.branch.diff}}
修复前代码差异（复查时读取）：{{artifactPaths.fix-before.diff}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：已回答的历史裁决

## 修复本次变更引入的问题（fix）

角色：[superpowers:systematic-debugging](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/systematic-debugging/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
只修复本任务引入的问题，依据实际失败和基线诊断；环境缺失或既有失败记录 blocked。保持冻结验证和目标版本约束。
```

用户输入模板：

```text
执行已加载的 systematic-debugging，使用官方 subagent-driven-development/implementer-prompt.md，以当前计划、失败证据和工作树填写参数。
先对照 baseline.json 判断根因，仅修复本次变更引入的重要问题。既有失败或缺失基础设施记录证据并返回 blocked。
将修复前变更保存在 fix-before.diff；官方 progress.md 记录修复和针对性验证，最终回复提供官方修复报告。针对性检查通过后返回 fixed，宿主负责重新验证；保持冻结检查和约束。
验证输出：
{{nodes.verify.output}}
审查发现（未审查时为空）：
{{nodes.review.summary}}
需要裁决时，在最终回复中给出一个完整阻塞问题、稳定 Q 编号、独立一行 origin: fix 和证据路径，返回 question。宿主保存并传给裁决者；恢复时核对注入的裁决再继续，证据不足则 blocked。

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT fixed
CEZ:VERDICT blocked
CEZ:VERDICT question

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
实现计划：{{artifactPaths.plan.md}}
源码定位地图：{{artifactPaths.context-map.jsonl}}
修改前的检查结果：{{artifactPaths.baseline.json}}
当前验证结果与失败原因：{{artifactPaths.verify.json}}
编译测试命令与版本约束：{{artifactPaths.validation-plan.json}}
本次任务完整代码差异：{{artifactPaths.branch.diff}}
修复前代码差异（修改前保存）：{{artifactPaths.fix-before.diff}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。先读源码地图，再定向读取相关源码；仅补查缺失或过期证据。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：来源为本节点的历史裁决，包括待恢复的阻塞结论

## 整理验证证据与裁决（deliver）

角色：[superpowers:verification-before-completion](<C:/Program Files/Development/AI_Projects/cezar/packages/cezar/src/workflows/assets/superpowers/vendor/superpowers/skills/verification-before-completion/SKILL.md>)

角色相关宿主规则：

```text
使用当前任务的工作树，读取项目 AGENTS.md；产物短名对应宿主注入路径。原始需求来自 CEZ_HANDOFF_FILE 的 Goal。仅执行当前节点，以其 CEZ:VERDICT 交接；节点回复由宿主保存。推送和创建 MR 由宿主收尾节点执行；合并和工作树删除留给人工。
本节点核对宿主最新验证和独立审查，不代替失败检查宣布成功；交付后保留工作树进入人工 review。
```

用户输入模板：

```text
执行已加载的 verification-before-completion，核对 verify.json、verified.json、官方进度账本及宿主裁决 和已批准的独立审查。
最终回复给出需求与证据对应关系、变更文件、实际命令及结果、裁决、遗留限制和证据路径；复用既有报告。证据一致返回 ready，否则 blocked。本节点不修改源码或执行提交。
已批准的独立审查：
{{nodes.review.summary}}

完成后，最终回复最后一行仅输出以下标记之一（此处为英文协议指令的中文展示）：
CEZ:VERDICT ready
CEZ:VERDICT blocked

任务身份：读取 run.json，确认任务与工作树一致。
相关文件：
任务与工作树信息：{{artifactPaths.run.json}}
当前验证结果与失败原因：{{artifactPaths.verify.json}}
验证对应的变更凭据：{{artifactPaths.verified.json}}
必需输入缺失时报告具体缺口，不搜索其他任务产物。

{{stageContext}}
```

stageContext 仅在有实际内容时注入；不重复任务身份和路径，不传空裁决列表：

- checkpoint：重新进入本节点且已有记录时，注入其已保存输出
- clarification：已回答的历史裁决

## 全部节点顺序与命令输入

| 节点 | 中文名称 | 类型 | 执行输入 | 输出 |
| --- | --- | --- | --- | --- |
| start | start | start | 启动任务 | next |
| probe | 需求与项目环境探测 | agent | cezar:project-probe | ready / blocked |
| baseline | 项目编译与测试基线 | check | cezar workflow-action baseline | pass / fail、退出码与宿主结果 |
| route | 按探测证据选择复杂度 | check | cezar workflow-action route | pass / fail、退出码与宿主结果 |
| route-fast | 简单任务直接规划，其余进入设计 | if | route.output equals fast | true / false |
| fast-plan | 轻量计划 | agent | superpowers:writing-plans | fast / standard / deep / blocked / question |
| design | 设计与需求消歧 | agent | superpowers:brainstorming | ready / question / blocked |
| clarification-round | 最多八轮按需裁决 | loop | 已有循环次数；最多 8 次 | repeat / exhausted |
| adjudicator | 按需需求与技术裁决 | agent | cezar:adjudicator | answered / fast-plan / plan / execute-fast / execute-standard / execute-deep / execute-deep-native / fix / blocked |
| plan | 完整实现计划 | agent | superpowers:writing-plans | standard / deep / blocked / question |
| execute-fast | 轻量 native 执行 | agent | superpowers:executing-plans | complete / standard / deep / blocked / question |
| execute-standard | 标准 native 执行 | agent | superpowers:executing-plans | complete / deep / blocked / question |
| execution-route | 按任务依赖与能力选择执行器 | check | cezar workflow-action execution | pass / fail、退出码与宿主结果 |
| execution-sdd | 独立任务且具备派发能力 | if | execution-route.output equals sdd | true / false |
| execute-deep-native | 复杂任务 native 执行（保留高风险约束） | agent | superpowers:executing-plans | complete / question / blocked |
| execute-deep | 复杂 SDD 逐任务实现与审查 | agent | superpowers:subagent-driven-development | complete / blocked / question |
| upgrade | 最多两次升档 | loop | 已有循环次数；最多 2 次 | repeat / exhausted |
| verify | 目标项目完整交付验证 | check | cezar workflow-action verify | pass / fail、退出码与宿主结果 |
| review | 独立全分支审查或限定复查 | agent | superpowers:code-reviewer | approve / changes / blocked |
| final-retry | 一次最终返修 | loop | 已有循环次数；最多 1 次 | repeat / exhausted |
| fix | 修复本次变更引入的问题 | agent | superpowers:systematic-debugging | fixed / blocked / question |
| deliver | 整理验证证据与裁决 | agent | superpowers:verification-before-completion | ready / blocked |
| seal | 核对验证后代码未变 | check | cezar workflow-action seal | pass / fail、退出码与宿主结果 |
| blocked-report | 记录阻塞并结束 | check | cezar workflow-action blocked | pass / fail、退出码与宿主结果 |
| publish-mr | 推送分支并创建 Draft MR | github.draft-pr | 当前任务工作树、分支、基准分支与交付摘要 | created：MR 链接 / failed |
| request-review | 请求 guohongwei 审核（GitLab 通知） | github.pr-update | 当前任务 MR、reviewers: guohongwei | done / failed |
| publication-failed | 提交审核失败（保留已完成工作） | end | 推送、创建 MR 或请求审核失败 | failed |
| done | MR 已创建并请求审核 | end | MR 链接及审核请求已提交 | success |
| stopped | 阻塞或返修耗尽 | end | 流程到达终点 | failed |

## 条件附加输入

实际存在时才附加：用户追加指令、任务附件路径、子任务报告/收件信息、本节点失败证据，以及账号或会话变化后的恢复说明。nodes 引用替换为相应节点的实际输出。

## 澄清查看位置

会话：每轮提问和裁决者的完整回复。图：对应节点最近一轮的完整输出。宿主持久保存历史；不生成独立问答 Markdown 或自定义 ledger。

## 源码核对入口

- 节点任务与流程：packages/cezar/src/workflows/templates/unattended.ts。
- 探测专用输入、相关路径和上下文：packages/cezar/src/workflows/unattended-probe.ts。
- 角色原文与宿主交接规则拼装：packages/cezar/src/workflows/superpowers-bundle.ts。
- 返回标记协议：packages/cezar/src/workflows/graph.ts 的 verdictInstruction。
- 实际启动参数与通用系统输入拼装：packages/cezar/src/workflows/run.ts 的 runAgentStep。

该文档是中文展开清单，便于审阅，不是任意一次启动的逐字日志。具体运行时的完整 system prompt、user prompt、工具及参数以任务会话中的代理启动记录为准；不会把启动记录反过来作为额外输入再发给模型。

## GitLab 审核通知

seal 通过后由宿主自动提交剩余变更、推送任务分支并创建 Draft MR，再指定 guohongwei 为审核人。已有 MR 复用；不自动合并、不删除工作树。推送/创建/请求审核失败时保留已完成工作和已有 MR 链接，在提交审核失败终点记录错误。邮件由 GitLab 发送，受实例邮件配置和审核人通知设置控制；接口成功仅表示审核请求成功，不代表邮件已送达。不增加 SMTP、邮件产物或代理节点。
