# 当前无人值守工作流：产物统计

按当前源码统计，不代表单次运行会创建全部文件，也不代表全部内容都会加入模型上下文。

## 位置与数量

- docs/superpowers：6 类文档产物，其中探测 4 份、官方设计和计划各 1 类；简单路径不生成设计。
- 宿主 runs/<任务ID>/：最多涉及下表 14 类文件，按阶段及需要生成，另外有可选 images/。
- 官方原生进度账本、brief、任务报告及审查包数量由实际 Task 和执行方式决定，不修改其原生规则。
- 全局 runs.json 保存任务状态、完整节点输出、流程位置及循环预算。
- 命名预留索引位于工作树 .ai/cezar/artifact-topics/，由宿主使用并自忽略，不是代理报告。

## 代理需要的文档

文档使用 YYYY-MM-DD-<topic>-<name> 前缀；短名为宿主映射别名。

| 名称 | 产生方 | 使用方 | 内容 | 条件 |
| --- | --- | --- | --- | --- |
| probe.md | 探测 | 设计、计划、裁决 | 影响面背景 | 探测 ready 必需 |
| context-map.jsonl | 探测；相关阶段补充 | 需要定位源码的节点 | 文件、符号、关系和证据索引 | 探测 ready 必需 |
| environment.json | 探测 | 宿主基线 | 工具链及验证入口草稿 | 冻结后不作为执行依据 |
| routing-input.json | 探测；设计/计划/执行修订 | 宿主路由 | 复杂度依据 | 首次路由及升档使用 |
| design.md | 设计 | 完整计划、审查 | 官方格式设计 | 标准/复杂路径 |
| plan.md | 轻量计划或完整计划 | 执行、审查、修复 | 官方格式实现计划 | 成功实现路径必需 |

探测四份在 docs/superpowers/probe/；design.md 在 specs/；plan.md 在 plans/。官方 progress.md、brief 和任务报告继续留在 .superpowers/sdd/<本计划工作目录>/ 等官方原生位置。

## 宿主任务文件

路径为宿主项目 .ai/cezar/runs/<任务ID>/，与目标工作树中的 docs 目录分开。

| 文件 | 产生方 | 使用方 | 用途 |
| --- | --- | --- | --- |
| handoff.md | 宿主；代理维护必要交接 | 各节点、恢复、PR 摘要 | 原始需求与交接记录 |
| events.ndjson | 宿主 | 会话回放、启动记录、工具调用展示 | 完整事件历史 |
| superpowers.json | 宿主 | 启动、恢复 | 锁定 skill 快照 |
| run.json | 宿主初始化 | 各阶段身份与路径定位 | 任务、工作树、基线和产物前缀 |
| unattended.json | 宿主检查器 | 执行绑定、验证、封存 | 受保护的冻结计划与验证凭据 |
| route.json | 宿主路由 | 分支判断、后续升档 | 复杂度和理由 |
| validation-plan.json | 宿主基线 | 执行、验证、相关裁决 | 冻结工具链和验证命令 |
| baseline.json | 宿主基线 | 执行、修复 | 基线结果、环境核验、必要诊断 |
| execution.json | 宿主读取计划回复并选择策略 | 复杂分支判断、native 回退 | 能力证据及 SDD/native 决策 |
| unattended-question.json | 宿主接收提问和裁决回复 | 裁决、返回调用节点、恢复 | 完整问题、回答状态和历史裁决 |
| verify.json | 宿主验证 | 审查、修复、交付 | 实际验证结果和必要失败诊断 |
| verified.json | 宿主验证 | 审查、交付、封存 | 通过验证的变更哈希与命令 |
| branch.diff | 宿主验证/封存 | 独立审查 | 包含未提交和新增文件的完整变更 |
| fix-before.diff | 修复节点 | 限定复查 | 修复前变更范围 |

images/ 仅在存在附件或截图时产生。节点完整回复和检查点保存在现有 runs.json/事件历史中，不另建每节点 Markdown。

## 每个阶段新增或更新什么

| 阶段 | 输出 |
| --- | --- |
| 探测 | 四份探测报告；宿主 run.json |
| 基线 | 冻结 validation-plan.json、baseline.json；成功后保护到 unattended.json |
| 复杂度路由 | route.json |
| 轻量计划 | 官方 plan.md、节点回复 |
| 设计 | 官方 design.md、完整设计检查点；需要时输出问题 |
| 裁决 | 完整回答进入节点输出和宿主问题历史 |
| 完整计划 | 官方 plan.md；deep 时在回复中给出 CEZ:EXECUTION，宿主写 execution.json |
| 执行策略 | execution.json 中记录 SDD/native 选择 |
| 执行 | 业务变更、官方 progress.md/原生产物、节点回复 |
| 最终验证 | verify.json；通过后 branch.diff、verified.json |
| 独立审查 | 完整审查回复；不另建 host review.md |
| 修复 | fix-before.diff、修复变更、官方进度及完整修复回复 |
| 交付 | 完整交付回复；不另建 delivery.md |
| 封存 | 核对变更哈希，更新 branch.diff；不新增成功 Markdown |
| 阻塞 | 既有事件、状态及必要 handoff 记录；不另建 blocked.md |

## 不再独立生成

question.md、clarification.md、自定义 ledger.md、execution-input.json、重复的 implementation.md/delivery.md/blocked.md/request.md/resume-message.md/last-failure.txt，以及 baseline-N.log/verify-N.log 等宿主全量打印日志。官方自身产物不在删除范围内。

## 编译与测试证据

原始输出使用操作系统临时目录解析，命令结束后删除。宿主结果保存实际命令、工具链/版本核验、退出码、耗时、分类、输出哈希、可识别的测试执行情况和测试数量。失败增加最多 12000 字符诊断；成功不保存全量打印。工具输出无法可靠识别测试数量时，不猜测数值。

## 澄清可见性与依赖

完整问答可在任务会话查看，图节点输出展示该节点最近一次结果。宿主保存历史并绑定 Q/origin；返回节点获取与自己相关的结论，审查和交付获取已回答裁决。独立的新任务不会自动依赖这些产物。
