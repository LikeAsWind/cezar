# 无人值守工作流可靠性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Track completed tasks here and in the plan ledger.

**Goal:** 依次修复可信验证、阶段交接、基线分类、阻塞续跑、执行策略和澄清会话复用六项问题。

**Architecture:** 复用已有图执行、Continue、私有 run 状态与完整 bundle 固定机制。宿主保障集中在小模块，runtime 执行目标项目命令；图继续只用现有节点类型。

**Tech Stack:** TypeScript / Zod / Node.js / YAML / Vitest / Node test。

**Spec:** `docs/superpowers/specs/2026-10-19-unattended-reliability.md`

## Global Constraints

- 在现有 `codex/gitlab-repository-support` checkout 顺序实施；保留之前工作和无关 GitLab 修改。
- 不修改 vendor 原始角色，不加新模型中转节点，不自动提交或发布。
- 私有可信状态在已有 dataDir 的 runs/ 下；工作树副本保持供角色读取。
- 非受管工作流、旧任务与后端降级路径必须有回归覆盖；不得静默跳过最终验证。
- 六项按序，前一项验证后再进入下一项；当前对话不用另建面板或侧栏任务。

## Review Focus

- 删除、篡改可信计划或验证凭证必须失败；不能从可写副本静默重建信任。
- 裁决者返回错误调用方、使用旧 Q 或漏写产物不能推进工作流。
- 已知失败只限明确命令/输出匹配；超时、无法启动和最终验证失败不接受。
- Continue、重启与回路耗尽不能重置预算、重做已完成任务或丢失固定版本。
- native 回退要明示能力原因；恢复原会话不能污染独立 reviewer。

## Task 1：可信验证计划与验证凭证（complete）

**Files:** 新增 `packages/cezar/src/workflows/unattended-guards.ts` 与对应测试；修改 `workflows/run.ts`。
**Interfaces:** `guardUnattendedCheck(dataDir, runId, cwd, command, phase)`，phase 为 before/after。通过 run 的 bundle pin 识别受管 runtime 命令；其他命令无影响。

- [x] 回归先红后绿：baseline 后修改计划，verify 前拒绝；verify 后改凭证，seal 前拒绝；普通命令不影响。
- [x] 宿主在成功 baseline 后保存计划原文，verify 前核对；成功 verify 后保存凭证并在 seal 前核对，写入与读取校验任务身份。
- [x] guards/pin/unattended 18 测试与服务类型检查通过。

## Task 2：阶段产物和裁决返回校验（complete）

**Files:** `unattended-guards.ts` / 测试；`run.ts`；bundle 本地角色与说明按需同步。
**Interfaces:** 宿主校验入口 `guardUnattendedVerdict(dataDir, runId, cwd, nodeId, verdict)`；Task 1 的私有状态扩展待处理问题。

- [x] 回归先红后绿：成功缺地图/设计失败；question 的 origin 不符失败；裁决返回别的调用方或漏记答复失败。
- [x] 成功出口前核验必要产物和最小内容/结构；保存当前 Q 与 origin，回答必须追加并对应本次问题；错误传给阻塞报告。
- [x] guards/Continuation context 11 测试与服务类型检查通过；只对明确引用受管 verify runtime 的图接入 verdict guard。

## Task 3：已知基线失败分类（complete）

**Files:** bundle `runtime.mjs`、`bundle.test.mjs`、probe 技能与共享说明。
**Interfaces:** baseline 命令可有显式 `expectedFailure`（非零 exitCode、非空 outputIncludes、完整规范化输出 outputHash、来源理由）；verify 命令禁止该字段。runtime 输出记录真实退出码、日志指纹和分类。

- [x] 真实 CLI 回归先红后绿：匹配的已知产品失败允许继续，输出不匹配仍阻塞；verify 禁止 expectedFailure，仍要求零退出。
- [x] 共享交接说明要求充分复现证据；宿主保存原日志与非零退出码，分类 known-product-failure，不改写为通过；超时/取消/启动失败不匹配。
- [x] bundle 26/26 测试通过。未修改上游 vendor 或自有技能正文，仅更新宿主与本地共享合同。

## Task 4：阻塞后的工作流续跑（complete）

**Files:** `unattended-guards.ts`、`run.ts`、对应恢复/Continue 测试。
**Interfaces:** 私有状态保存原执行节点、graphState、待处理 Q；Continue 对受管 failed 任务采用固定 workflowDef 回到原图，原始补充消息写入共享续跑证据。

- [x] 回归：真实 RunManager + 受管快照 + runner seam，Continue 返回原设计阶段并走 verify/review/deliver/seal；保留循环计数，不新建 continue-N 聊天步骤。普通 Continue 的 7 项工具策略回归通过。
- [x] 复用现有队列/execute 所有权机制和 graphState；非法恢复点返回明确错误。问答阻塞回到调用方，审查/封存阻塞先重跑 verify。
- [x] guards/recovery/Continue 12 项通过，服务类型检查通过；自动恢复只接入 failed，已取消任务仍保留原行为，使用现有取消与队列清理机制。

## Task 5：复杂度与执行策略解耦（complete）

**Files:** runtime、workflow.yaml、probe / plan 本地交接说明、bundle 测试。
**Interfaces:** `execution-input.json` 记录计划任务独立性及已核实 subagent 能力；程序输出 `execution.json`（native/sdd、理由）。deep 经宿主策略条件选择 SDD 或 native，不改变 deep 审查要求。

- [x] 策略回归先红后绿：独立任务/观察到派发能力才 SDD；紧耦合、独立性未知、能力缺失均 native，deep 风险档位保留。
- [x] 复用 check / if；deep-native 是替代执行分支，不额外叠加执行者。原始角色保持不变，旧快照不强制要求新策略文件。
- [x] bundle 28 测试、20 项 guards/恢复/Continue/加载测试与服务类型检查通过；HTML 待 Task 6 完成后统一同步。

## Task 6：澄清后的调用方会话复用（complete）

**Files:** workflow.yaml、必要的图会话 helper、会话回归与 HTML。
**Interfaces:** 同一调用方澄清重入复用已有会话选择 helper；不放宽 session.continue 的 self-target 校验。后端不支持或实际启动账号不匹配时沿用文件恢复。reviewer/builder 不复用实现会话。

- [x] 回归先红后绿：返回调用方可使用自己的会话；后端、显式账号及实际隐式启动账号切换均回退，启动前同步保存 sessionId/profileId 配对；审查上下文不复用。
- [x] 仅在受管 adjudicator→调用方边触发复用，不改 schema、不修改原始角色；旧快照没有新策略节点时不强制新策略输入。
- [x] 核心合并 69/69、bundle 28/28、全项目 typecheck、服务/Web 构建、check:pack 通过；HTML 9 场景/33 产物及 8 个裁决返回路径浏览器验证，无脚本错误或外部请求。已重启本地空闲服务，新 API 返回 28 节点/87 连线。

## 最终验证与边界

- 六项已依次完成，未提交或推送；保留之前 GitLab 与 Superpowers 更新机制的未提交工作。
- 独立审查发现并修复：已知失败中夹带额外失败、隐式账号切换误续会话、账号回退时持久化旧 sessionId；均有针对性回归。
- 已知失败必须是隔离复现、完整规范化输出指纹匹配；不稳定输出保持阻塞，不声称有通用测试报告分类器。
- 无宿主可信基线的旧运行不能从可写文件重建信任；受管快照缺失仍失败，不换成最新版本。
- 能力记录来自当前规划会话对实际工具的观察，未知走 native；这不是对任意后端实现了新的派发能力。
- 宿主测试包含真实命令进程、RunManager 与模拟 runner 接线；未使用付费模型执行完整三档真实仓库任务，不将静态/模拟通过声称为模型行为保证。
