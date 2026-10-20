# 需求、代码库与环境探测：一手资料研究

研究日期：2026-10-19。范围：内置 `cezar-unattended-v7` 的 probe 提示词；不修改 Superpowers 或 auto-rd-harness 原文。以下“建议”是面向本项目的工程推导，并非来源提供的现成角色提示词。

## 一手资料与可迁移原则

1. Anthropic 建议保留最小的高信号上下文，用路径等轻量引用按需检索，并以结构化笔记维持长期任务状态；避免脆弱的复杂提示词和穷举边界条件。适用于当前 context-map，而非一次扫描、复制整个仓库。[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
2. Anthropic 的工具设计文章要求工具职责明确、输入输出无歧义、返回相关且精简的信息，并通过真实任务评估改进。适用于明确 probe 只调查和输出证据，宿主执行基线，后续节点按地图补查。[Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
3. GitHub 指出让 agent 反复试错安装依赖可能慢且不可靠，因此支持在工作前执行可验证的环境准备。适用于优先读取仓库现有 CI、开发环境配置和准备步骤，不自行猜测通用语言命令。GitHub 在准备失败后仍启动 agent 的产品策略不必照搬；cezar 可以继续保持阻塞。[Configure the development environment](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)
4. Bazel 说明可复现构建依赖确定的源码身份、工具和依赖版本，并列出宿主系统二进制、绝对路径等非隔离因素。适用于记录实际 worktree、HEAD、工具版本和隐含依赖；并不要求所有目标仓库迁移到 Bazel，也不能宣称普通 worktree 已构成 hermetic sandbox。[Hermeticity](https://bazel.build/basics/hermeticity)
5. NASA 要求需求能追溯到利益相关者期望；验证计划包含每项需求的验收条件、验证方法和必要环境。适用于轻量 AC → 代码 → 检查关联，而非引入航天项目流程。编译通过只证明部分技术检查，不能替代用户行为验收。[Technical Requirements Definition](https://www.nasa.gov/reference/4-2-technical-requirements-definition/)、[Product Verification](https://www.nasa.gov/reference/5-3-product-verification/)

## 对现有实现的判断

现有 workflow.yaml 已覆盖动态工具链、worktree 隔离、准备/基线/验证分离、unknown 不视为零影响、禁用测试检查、需求缺口交给澄清等关键要求，应该保留。

仍有四个直接可改的缺口：

- auto-rd-harness 原文依靠关键词列候选文件；这只能作为起点。需要继续追踪实际入口、调用/依赖关系、测试、API/数据边界及必须维持的默认行为，否则候选数不能代表影响范围。
- 原始请求被要求转为 AC，但未明确区分用户明确要求、证据推导与未知项；容易把分析者的假设变成“用户验收条件”。
- 已要求记录环境事实，但未明确比对“仓库声明版本”和“实际可用版本”，也未要求记录源码/探测时点身份。重新进入节点时旧地图可能已过期。
- 现有 probe 直接混合流程、JSON 样例和细节长段落。优先以职责、调查顺序、证据规则、输出合同四部分表达；精简重复规则，不再增加入口或 adapter 层。

## 可直接用于节点的规则草案

```text
Establish a small, evidence-backed handoff for the target worktree. Investigate; do not design or implement the solution.

Preserve the user request verbatim. Derive numbered acceptance criteria only when supported by that request; label inferred constraints separately. Record unanswered questions and contradictions without resolving product preferences yourself.

Read applicable repository instructions, then build manifests, lockfiles, CI and existing development/setup documentation. Compare declared tool versions with the installed executables and their observed versions. Record the actual worktree, source revision, OS/shell, module boundaries and external prerequisites. Missing or unverified facts stay unknown.

Start source discovery with CodeGraph when indexed, otherwise targeted searches. Follow relevant entrypoints, dependencies, existing tests and public/data boundaries. Keyword matches are candidates, not confirmed impact. Identify existing behavior and default guarantees the change must preserve. Do not scan or copy the whole repository merely to fill context.

Map acceptance criteria to relevant code and existing checks. Identify gaps where implementation will need new tests. Keep paths and symbols as retrieval references; later stages must reread current source before relying on them. A map is a guide, not a prohibition on discovering missing context.

Derive setup, baseline and final verification from actual repository evidence. Prefer existing project wrappers and lockfile-aware commands; do not choose a toolchain from a fixed language list. Check whether tests are disabled, skipped or dependent on unavailable services. Separate environment preparation from checks. Mark all test results pending host execution.

Write concise findings, their source paths, confidence and unresolved gaps into the existing artifacts. Ready means the artifacts are usable and checks are identified; it does not mean requirements are fully clarified or tests have passed. Send requirement gaps to brainstorming/adjudication. Report missing execution prerequisites as concrete blockers.
```

该草案应与当前 environment.json / routing-input.json / context-map.jsonl 的现有合同拼接在同一节点内，不改变原始 vendor，不额外发明输出协议。

## 建议的提示词评估样例

- 声明 Java 8、机器只有 Java 21：准确记录差异，不能宣称环境匹配。
- 多模块仓库关键词只命中 UI，但调用路径涉及契约：地图覆盖真实跨模块关系。
- 无测试或默认跳过测试：不把零测试成功当作行为验收。
- 新 worktree 无依赖、主 checkout 有依赖：正确生成准备步骤并等待宿主基线。
- 需求只说“优化体验”：保留未明确指标，进入澄清，不自创验收范围。
- 后续实现新增文件或改变结构：补查和更新地图，不被初始候选列表锁死。

以上是建议的行为评估用例；静态字符串测试只能检查提示词接线，不能证明 agent 已具备这些行为。


## Skill standardization check

The execution entry is now skills/project-probe/SKILL.md, with the name
project-probe and a trigger-only description. Directory/name/frontmatter were
checked against https://agentskills.io/specification and the writing-skills
instructions. Source provenance stays in research records, not role instructions.
The service keeps cezar:project-probe as its registry alias.

Baseline inspection identified a colon in the skill name, a flat Markdown file
instead of the standard directory entry, a process-oriented description, and
source narrative without operational value. A regression test failed on the old
path before these changes and passed afterwards. Independent paper applications
before/after used the same two scenarios: declared Java 8 vs installed Java 21
with skipped tests and vague performance intent; and a UI keyword match whose
real impact crosses the API contract and service. The revised role preserved
unknowns and pending test results without relying on an external project name.
These are document/application checks, not real repository execution or proof
of optimal model behavior.
