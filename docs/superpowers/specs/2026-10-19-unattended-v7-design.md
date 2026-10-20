# cezar 仓库的 Superpowers 7.0.0 无人值守工作流

## 目标与边界

为本仓库提供可安装的项目工作流 `cezar-unattended-v7`：探测项目与需求，复用上下文，按复杂度自动选择 fast、standard 或 deep 链路，交付到 review。正常执行不等待人工确认；安全边界、环境阻塞和无法可靠裁决的问题留下报告并失败退出。工作流由用户主动选择，不更改 quick-task 或 cezar 默认行为。

用户要求角色提示词来自 Superpowers v7，禁止自行重写替代角色。上游 skills 全目录、辅助脚本和 LICENSE 原样保存，SHA-256 清单固定版本；cezar 的输入输出、无人值守及运行边界单列为 adapter，不能伪称原版行为。项目探测参考 auto-rd-harness 的 probe persona，注明来源并保留许可证。

## 交付布局

- `packages/cezar/workflow-bundles/superpowers-v7/`：工作流、适配说明、安装器、原文与来源清单。不是新增服务功能。
- 安装器写入当前仓库 `.ai/cezar/workflows/cezar-unattended-v7.yaml` 和 `.ai/cezar/skills/cezar-unattended-v7/`。这是本仓库忽略的本机安装层；源 bundle 可提交。
- 各节点通过 cezar 注入的 skill 绝对路径读取原文，不能假定 task worktree 有主 checkout 的未提交文件。
- 执行产物放在 task worktree 的 `.superpowers/probe/`，自带 `.gitignore`，不进入业务 diff。保存 run ID、起始 HEAD、任务原文和状态；不同 worktree 隔离。后续节点只在匹配的 run ID 下继续。

## 原文映射

| 阶段 | Superpowers 7.0.0 原文 |
| --- | --- |
| 设计 | `brainstorming/SKILL.md` |
| 设计检查 | `brainstorming/builder-check-prompt.md` |
| 计划 | `writing-plans/SKILL.md` |
| fast / standard 实现 | `executing-plans/SKILL.md` |
| deep 实现与任务审查 | `subagent-driven-development/SKILL.md` 及 implementer/task-reviewer/re-review 模板 |
| 全分支审查 | `requesting-code-review/code-reviewer.md` |
| 最终一次返修 | `subagent-driven-development/implementer-prompt.md`、`systematic-debugging/SKILL.md` |
| 修复复查 | `subagent-driven-development/re-review-prompt.md` |
| 验证 | `verification-before-completion/SKILL.md` |

v7 的任务审查一次读取 diff，同时给出 spec compliance 和 code quality 两个结论，不拆成自行创作的两个角色。deep 内部实现按任务顺序派发，不并行修改同一个 worktree。

## 公共探测与共享上下文

1. 初始化 run 产物目录，保存 HEAD、Git 状态和任务。
2. 探测需求、验收项、仓库规范、工作区划分、入口与相关代码；有 `.codegraph` 时先用 CodeGraph，否则用搜索与源码。
3. 写 `probe.md`、`context-map.jsonl`、`environment.json`、`routing-input.json`。地图每项含路径、职责、关联验收项、依赖和置信度。统计完整候选集合，展示清单可以截断，计数不可截断。路径是仓库相对路径，不能含越界路径。
4. 环境事实包括 OS、Shell、Node/npm、锁文件、依赖是否可用、workspace 链接是否指向本 task worktree、构建/测试入口。不得把主 checkout 的测试当作 worktree 证据，不保存凭据或整个环境变量表。
5. 基线节点在隔离 worktree 缺少本地依赖或 workspace 链接错误时运行一次 `npm ci`，再核对实际 realpath；这是主动选择本工作流后的任务内环境准备，不安装全局工具。随后运行 `npm run typecheck` 及探测选中的现有针对性测试，保存命令、退出码、耗时与日志。依赖准备失败或任一基线命令失败一律阻断，并报告原有问题，不交给需求 fixer。编译和针对性测试基线不等同于所有测试基线，报告明确此边界。
6. 后续节点先读摘要和地图，再核对自己涉及的源码；地图是定位线索而非事实豁免。新发现补充记录，任务状态与裁决写到 ledger，恢复时不重做已完成任务。

## 三档路由

路由工具使用结构化输入计算结果，agent 负责提供有依据的输入，不以自由文本评分代替规则。零匹配或未知影响面不得进入 fast。

- **fast**：明确需求、低风险、单模块，1–3 个候选文件；生成最小计划，native 执行。
- **standard**：其余影响明确的普通功能/修复；完整设计、独立 builder check、完整计划，native 执行。
- **deep**：跨 workspace/模块、超过 10 个候选文件，或 API contract、运行状态/调度、持久化迁移、Git/worktree、身份权限、默认行为变更；完整设计与 builder check、完整计划、SDD 每任务新实现者和任务审查。
- 未知影响面进入 standard 并先补充探测；验收含关键歧义且源码与约束无法裁决时 blocked。
- 实现前再次检查档位，发现范围扩大只升级不降级；记录理由。fast 可升级到 standard/deep，standard 可升级到 deep。上升链无环；已完成工作由 ledger 交接。

## 执行、审查与有限返修

fast：probe → baseline → route → 最小计划 → native 实现 → 最终验证 → 独立全分支审查。

standard：probe → baseline → route → 设计 → builder check → 计划 → native 实现 → 最终验证 → 独立全分支审查。

deep：probe → baseline → route → 设计 → builder check → 计划 → SDD（逐任务实现与审查）→ 最终验证 → 独立全分支审查。

外层最终审查就是上游 native/SDD 的 final review seat，executor 在派发该 seat 之前交还 cezar，避免重复审查。builder check 只有一次修订机会，仍有 load-bearing 疑问则失败报告，不把问题当默认批准。

SDD 内部遵守 v7 五轮返修与裁决规则；第 4–5 轮所需更高能力模型不可用时记录阻塞，不能伪装已升级。模型优先使用用户在 cezar 选择的后端/模型，子代理能力与可用模型由运行时探测，不能写死未验证的型号。

最终验证顺序遵守 AGENTS.md：`npm run typecheck` → `npm test` → `npm run test:unit` → `npm run build` → `npm run test:package`。命令由 host check 节点执行，非 agent 自述；生成的编译产物不能混入业务提交。

验证或最终审查失败只派发一次最终 fixer，fixer 只能修复本次任务引入的问题，之后再验证；若此前没有完整全分支审查，验证通过后必须进行首次全分支审查，已有完整审查才作 scoped re-review。仍失败则退出，不无限回环。Minor 可以列为 deferred，但需求缺失、错误行为、安全问题或缺失验证不能靠降级严重性放行。验收报告列出裁决、延后事项和真实验证结果。

## 显式适配规则

- 用户已授权无人值守：brainstorming/writing-plans 的人工交接由独立检查与有证据的 Ruling 接替，不冒充人工批准；高风险外部动作和完全无法判断的需求仍停止。
- worktree 已由 cezar 创建：核对并复用，原文中的额外创建/删除/merge/push/publish 流程不执行。
- 上游在 task 中要求 commit；本仓库要求每次 commit 前完成完整五项 gate。executor 可保留任务内 commit，但必须先执行这些 gate；不能以“cezar 会 autosave”豁免自己的 commit。审查必须覆盖起始 HEAD 到当前 worktree 的所有变更，包括未提交内容及新文件，不能只看 HEAD~1。
- 审查原文要求只读 checkout：由 cezar 保存审查摘要到外部 handoff/节点输出；只有实现/协调节点整理工作区内报告。审查员不写源码、index 或 HEAD。
- 上游收尾删除临时工作区、finishing-a-development-branch 改为保留报告并返回 review，不自动清理 cezar worktree，不自动 push/PR/merge。
- 原文要求特定 tool 或更强模型而运行时不支持时，记录能力缺失并失败；不悄悄省略独立审查。

## 验证与范围

验证 vendor 文件哈希、安装幂等、cezar 原生 loader/schema/graphIssues、所有 verdict/失败/循环边、三档判定（高风险小改、未知、跨模块、超过阈值）、产物路径/run 隔离和 final gate 的固定命令。模拟三条成功链路、验证失败、审查返修、阻塞与返修耗尽。不会在验证本 bundle 时启动真实模型或执行用户需求；真实无人值守跑通仍需一次用户选择的小任务，静态/模拟通过不能声称实跑通过。
