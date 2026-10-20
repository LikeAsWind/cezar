# Superpowers 通用工作流迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将 unattended 保留为普通 version: 2 工作流模板，使其使用宿主提供的可复用执行能力，不再由新任务执行 Superpowers 快照内的 runtime.mjs。

**Architecture:** 保留现有 agent/check/if/loop 节点及三档流程。把产物、验证计划、命令执行及验证凭证抽离为 cezar 自身模块，通过统一的工作流命令入口调用；Superpowers bundle 仅负责流程、角色和原始上游资源。保留旧快照的专属脚本执行方式，避免重写历史任务。

**Tech Stack:** TypeScript ESM、现有 Zod、version: 2 YAML、Vitest、Node 脚本测试。

**Spec:** 当前对话中用户明确要求“superpowers-v7 迁移到通用的工作流里”，以及现有 workflow.yaml 的节点与交付保证。

## Global Constraints

- 不新增语言白名单、固定本机工具路径或必填用户配置。
- 不改写 Superpowers 上游原始 Skill 和模板。
- 保留三档分支、裁决者回到提问节点、有限返修和人工 review 终点。
- 保留真实退出码、超时/取消、工作树隔离、明确 JDK 绑定、冻结验证计划和验证后 diff 校验。
- 历史任务不切换快照，不移动产物，不重置循环次数；Continue 与进程重启必须遵守旧协议。
- 不夹带修改八分钟政策、主题命名或环境与澄清的先后关系；这些是独立的行为变更。
- 保留用户刚更新的 project-probe 正文，不用代码迁移覆盖它。

## Review Focus

- 普通项目在无 Node 项目依赖时也能使用宿主执行能力。
- 复制/编辑模板后仍能获得正确上下文和验证保证，不通过工作流名称或固定节点 id 猜测所属流程。
- 旧快照、定制图、新任务、Continue 和重启分别验证。
- 验证计划或凭证被工作树文件改写时不能冒充宿主验证通过。
- Windows Maven/JDK 环境、目录包含空格、错误退出和取消不回退到不匹配的默认工具链。

## 当前证据

- `src/workflows/unattended.ts` 已通过通用 graph schema 加载 YAML，无需另建图引擎。
- 该文件把命令占位符替换成当前 Node + 快照 runtime.mjs 的绝对路径。
- `unattended-guards.ts` 通过快照脚本路径和命令后缀识别受管检查，宿主保证与 bundle 路径耦合。
- `unattended-probe.ts` 用快照 runtime init 初始化产物。
- `run.ts` 在验证、恢复、提示词和环境注入处有受管流程分支。
- `runtime.mjs` 包含 init/route/execution/baseline/verify/seal 六类确定性操作；迁移不能把这些检查变成模型自行声明。

### Task 1: 抽离宿主执行能力，保留旧入口

**Files:** `packages/cezar/src/workflows/` 新增共享执行模块；`packages/cezar/workflow-bundles/superpowers-v7/runtime.mjs` 及现有 runtime 测试用于兼容基准。

**Interfaces:** 共享操作接受明确的 root、runId、action 和受控环境；返回真实输出/失败。业务验证函数不读取 Superpowers 更新状态。

- [x] 先增加宿主直接初始化、路由、执行验证和 seal 的失败/成功测试。
- [x] 抽离产物及验证逻辑，改用宿主依赖，不让新宿主模块依赖 bundle 内 vendor/runtime/zod。
- [x] 保留旧快照可独立执行的现状，不修改已保存快照。
- [x] 复用已有 runtime 场景验证冻结计划、已知失败指纹、JDK 绑定、依赖隔离和 diff 校验没有丢失。

### Task 2: 提供通用命令入口并迁移模板

**Files:** `packages/cezar/src/index.ts`、共享工作流执行模块、`workflows/unattended.ts`、bundle `workflow.yaml`。

**Interfaces:** cezar 提供工作流操作命令；模板的 check 节点仍使用现有 command 字段。宿主生成当前安装的可执行入口，不要求目标项目安装 cezar 或 Node 依赖。

- [x] 编写测试：新模板命令不引用 bundle/runtime.mjs；普通自定义图也可调用同一入口。
- [x] 增加统一命令入口，参数校验及失败返回遵循现有 CLI 约定。
- [x] 将模板确定性操作切换到该入口，保留 agent/if/loop 连线和原始角色加载。
- [x] 将阶段提示词内的重路由命令切换到同一入口，去除新流程的 runtime.mjs 指示。
- [x] 验证 YAML 图有效、分支输出和版本快照中的角色仍正确。

### Task 3: 解除宿主保障与专属脚本路径的耦合

**Files:** `workflows/run.ts`、`unattended-guards.ts`、`unattended-probe.ts`、`unattended-recovery.ts`、`superpowers-pin.ts` 及相关测试。

**Interfaces:** 新命令使用共同的身份识别和上下文初始化；旧 runtime 命令识别继续保留。共享状态校验不因重命名或复制模板失效。

- [x] 先覆盖新任务、复制图、旧快照 Continue、重启恢复和取消场景。
- [x] 用共同入口识别替代只匹配快照 runtime 的逻辑，同时兼容旧路径。
- [x] 将 probe 初始化、产物映射和工具链注入接到宿主公共实现。
- [x] 保持校验前后两个阶段和所有会话构造路径一致。
- [x] 确认没有为了迁移增加 Agent 节点或模型调用。

### Task 4: 验证、文档和激活

**Files:** bundle README、`docs/reference.md`、打包校验及相关测试。

- [x] 更新文档，明确 YAML/Skill 与宿主公共执行能力的责任。
- [x] 运行 runtime/产物脚本测试、工作流加载/guard/probe/Continue/pin/recovery 测试。
- [x] 运行 `npm run typecheck` 和 `npm run check:pack`。
- [x] 在无目标项目依赖的临时 Git worktree 验证通用入口，覆盖成功和真实失败。
- [x] 仅在验证通过后生成新 bundle 快照；旧任务锁不变。
- [x] 重启前检查活动任务；只在不会中断活动任务的条件下应用，并报告新旧任务适用范围。

## 验收

新任务使用普通 YAML 图和直接角色 Skill，命令不再引用 Superpowers 专属 runtime；同一宿主能力可被其他图模板调用。旧任务继续执行固定快照。所有原有确定性验证与恢复保证有测试覆盖，且没有新增模型路由开销。
