# 内置通用无人值守工作流

本设计取代先前项目级 bundle 的部署范围：用户要求在 cezar 管理的每个项目中都能选择内置工作流，而不是只为开发 cezar 仓库安装副本。

## 实现约束

- 保留 74 个 Superpowers 7.0.0 文件原文和许可证，单独的适配层处理无人值守交接。沿用已实现的探测、三档路由、独立审查、有限返修和 review 交付边界。
- 在内置模板注册表加入此工作流，在技能发现中以最低优先级提供配套 builtin skill。用户同名 workflow/skill 仍优先；quick-task 仍是默认。
- package 的 files 和 pack gate 覆盖全部 YAML、runtime、context、vendor、清单和许可证。源码运行与 dist 运行从同一个包内位置定位资产，不依赖开发者机器路径或写入用户项目。
- 目标仓库 probe 写 environment.json：实际工具链、结构化 baseline/verify 参数数组、工作目录、来源文件及检查种类。host 在真实 worktree 内验证路径与程序，冻结 validation-plan.json；后续验证不能用新的空计划替换它。
- setup/baseline/verify、程序名或已安装工具路径都由探测生成，不维护支持语言/程序白名单，不硬编码语言安装配方。准备只在基线前执行，必须幂等且仅作用于 worktree 本地缺失依赖。缺全局工具链、原有基线失败或无法给出真实验证入口时记录阻塞。
- 保留原本依赖隔离的保证：探测声明通用 dependencyRoots 和 workspaceLinks，host 在准备之后、基线和验证之前核对真实路径与映射，避免把主 checkout 的依赖当作当前 worktree 的证据。
- 原生 agent 使用 CEZ_TASK_ID，host checks 使用 CEZ_RUN_ID，runtime 处理身份差异。上游角色中的运行身份引用只在适配层调整。
- 机械限制是参数/路径验证及 host 实际退出码，不宣称是代码执行沙箱。探测阶段识别测试被跳过、未运行测试等情况，不把它们当作成功证据。

## 检验与上线

先用无本地安装的临时 Maven 项目证明内置 workflow/skill 缺失，再实现并证明可发现且 source=built-in。保留同名覆盖测试。验证 Maven 命令不会替换成 npm，拒绝空计划、无来源、越界或 shell 表达式。沿用图分支/终止、上下文隔离、diff 和进程树测试。

构建并检查 npm tarball，核对 source/dist 均能读取内置资产。归档本次会话生成的旧 cezar 项目副本，避免它遮蔽内置；不删除用户自定义副本。服务重启前确认没有运行中的任务，重启后对两个已注册项目的 API 验证 source=built-in，并确认配套 skill 可用。真实模型任务不在本次验证中自动启动。

## Direct role loading

Role nodes select original Superpowers 7 skills or templates directly. Their original body enters skill input. Discovery selects the researched custom project-probe role; routing and blocked-result packaging use node instructions only. Stage handoffs live directly in node prompts, with shared constraints injected once per node. No entry skill or adapter-reading chain remains. Upstream hashes and supporting files are preserved.


## Clarification adjudicator

Keep the original brainstorming skill unchanged. Its design node emits question
for one pending question, then a loop node permits up to eight adjudicator answers.
The adjudicator uses request/probe/context and actual source evidence, records
Q-number, answer, evidence and reversible machine rulings in clarification.md,
and returns answered or blocked. Brainstorming consumes the answer and asks the
next question or writes the design. Builder revision can enter the same loop.
No subagent capability or shared chat session is required; durable artifacts
preserve the conversation across fresh node sessions.

Unclear requirements must reach clarification: the router chooses at least
standard instead of immediately returning blocked, preserving all deep-risk and
monotonic-upgrade rules. Missing environment prerequisites still block. The
adjudicator cannot invent material product preferences or authorize external
effects. Exhaustion, unavailable evidence and failed adjudication end failed.
Planning, execution and repair may ask one question with their origin and use the same adjudicator node; its verdict returns to that caller. Independent code review stays separate and no role may silently expand scope.


## Research-backed custom prompts

skills/project-probe/SKILL.md and skills/adjudicator/SKILL.md are direct skill inputs, not adapter layers.
They are custom cezar roles based on primary-source research recorded under
docs/superpowers/research/; original Superpowers vendor files remain unchanged. The unused historical
auto-rd-harness reference copy has been removed from the distributed bundle. Probe distinguishes explicit ACs, inferred constraints and
unknowns; compares declared/observed environment versions; traces impact beyond
keyword matches; and leaves baseline execution to the host. Adjudication records
facts, reversible authorized choices or insufficient information, citing evidence
and preserving decision history. Both use available web tools for uncertain
external facts without sending private context to public search.

The shared eight-answer budget applies across design, planning, execution and
repair. Callers preserve task ledgers across re-entry. Only design uses answered;
other successful adjudicator verdicts name the question origin. These routes are
instructions to a trusted role, not a new runtime authorization boundary or proof
of model compliance. The role never implements or serves as the final reviewer.


## Version-aware compile/test handoff

Probe emits toolchains (name, module, targetVersion, buildVersion, runtimeVersion,
sources, constraints) and executable environmentChecks with expectedOutput.
Unknown versions remain null; target and build versions need not be equal.
Baseline freezes these fields in validation-plan.json; the host checks tool
output after setup and before baseline/final compile-test commands. Missing tools,
nonzero exits or missing expected markers fail with fresh reports and logs.
Later nodes use the frozen constraints rather than silently upgrading the target.
Legacy plans default to empty arrays to preserve prior behavior.

This is version observation and drift detection, not a universal compiler
compatibility solver. Target language/API and deployment-runtime compatibility
remain actual repository verification gates. For Java, the source/target flags
alone do not constrain all APIs; use a supported release/target JDK or existing
compatibility tooling appropriate to the repository, without silently changing
its compiler plugins or source policy.

Primary references:
- https://docs.oracle.com/en/java/javase/11/tools/javac.html
- https://maven.apache.org/components/plugins/maven-compiler-plugin/examples/set-compiler-source-and-target.html

Tests use local fixture tools to prove frozen metadata, stdout/stderr checks,
successful validation, changed-version rejection even after editing the probe
report, and failed-path evidence. They do not claim a real Java 8/11 matrix has
run against the user's project.
