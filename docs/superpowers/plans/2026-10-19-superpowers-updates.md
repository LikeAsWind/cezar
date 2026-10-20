# Superpowers 更新机制实施计划

**目标：** 在现有 Skills 页面检查、暂存、审阅、启用和回退 Superpowers，运行中与恢复任务固定完整技能快照。

**依据：** `docs/superpowers/research/2026-10-19-superpowers-update-mechanism.md`，用户已要求继续实施。

## 约束

- 内置版本继续零配置、离线可用；不修改只读安装目录。
- 默认关闭新增后台检测；显式启用后低频检查，绝不自动启用候选。
- 所有用户状态位于 cezarHomeDir，通过 CEZ_HOME 隔离测试。
- 上游下载固定官方仓库 commit，拒绝归档越界、链接及不兼容主版本，不执行下载的安装/测试脚本。
- 候选只进行结构与完整性验证，界面明确不能据此声称行为兼容；审阅确认后才切换。
- 快照包含上游角色与辅助文件、自有角色、上下文、工作流和宿主执行器。旧任务/Continue/恢复不跟随活动指针变化。
- project-probe 与 adjudicator 不由上游覆盖；用户本地覆盖保留。
- 本轮不清理历史快照，避免误删仍被任务引用的版本。

## 执行与验证

1. [x] 在 contract 定义更新状态和各操作请求；API 链式注册、middleware 校验与类型对齐。
2. [x] 实现六小时检测缓存、版本化暂存、清单校验、互斥锁、原子启用/回退；验证离线、损坏、恶意归档和并发失败。
3. [x] 实现任务私有版本锁及所有执行/继续路径接线；验证活动版本切换后旧任务仍使用旧 helper，损坏快照不静默换版。
4. [x] 在 Skills 页面增加 Superpowers 更新卡；验证默认无网络、未审阅不能启用、失败显示原生效版本、可回退。
5. [x] 合并验证：服务与组件测试、API parity/路由清单、类型检查、构建和包资产校验；更新文档后核对本地 API 与 Vite 页面模块。

## 实施验证（2026-10-19）

- 更新服务 16 项、任务固定 6 项、unattended 7 项：29/29 通过。
- API、组件、workspace contract parity 与路由清单联合检查：17/17 通过。
- bundle Node 校验：25/25 通过；Skills/i18n/路由既有回归由界面实现阶段验证通过。
- Continue 上下文与工具策略串行复核：10/10 通过。
- `npm run typecheck`、`npm run build:web`、`npm run check:pack` 通过；服务构建由 typecheck 前置执行。
- 本地服务已重启；GET 无联网读取、显式 POST check、Vite Skills 页面模块及代理 API 返回 200；真实官方检查显示当前与最新均为 7.0.0，autoCheck=false。未暂存或激活真实上游候选。
- 扩展图执行 5 项及恢复失败 1 项未通过：Windows 直接 spawn `.mjs` 测试夹具产生 EFTYPE，图测试另有 Unix `mkdir` 命令 ENOENT 和临时目录清理 EPERM。这些未作为更新机制验证通过项，未扩大修改执行后端或测试夹具。
- 审查修复了 manifest 缺失/损坏时启用与实际加载不一致、helper-only graph 漏固定、归档超限后继续扫描的问题；manifest 和 helper-only 回归已观察先红后绿。

## 验证边界

自动检查证明结构、文件完整性与工作流接线，不证明新角色行为符合用户意图。这里不向外部创建 PR、安装/启用上游新版，也不更改已有工作流默认选择。

普通 quick-task 文本或后续消息中首次使用 `/superpowers:*` 不触发整个 unattended bundle 固定；本轮固定覆盖内置 unattended 及明确引用受管角色/资产的自定义工作流。
