# Superpowers 更新机制调研与建议

日期：2026-10-19。本文件是调研结论和实施方案，不代表更新器已经实现，也没有创建计划任务、发起更新 PR 或启用后台联网。

## 当前事实

- 内置副本固定为 7.0.0；provenance.json 保存来源提交和逐文件哈希。
- unattended.ts 从包内固定目录读取角色与辅助文件。仅记录角色正文不足以保证任务中途更新后仍能读取相同的脚本和模板。
- skills-update.ts 已有六小时检查缓存、跨进程锁、状态和更新协调，但来源被 isOpenMercatoSkillsSource 限定为 open-mercato/skills；不能直接让现有 npx 更新命令覆盖 Superpowers vendor。
- 本项目尚未配置 Renovate。内置技能还要随 npm 包发布，不能假定用户安装目录可写，或机器上已安装某个 agent 的插件管理器。

## 一手资料

1. [Superpowers 官方仓库](https://github.com/obra/superpowers#updating)：更新随 agent 安装方式而异。这不能替 cezar 自己管理的副本提供同步保证。
2. [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)：可查询最新正式发布；获取到候选 tag 后仍应解析并固定实际 commit，而非继续跟随浮动分支。
3. [GitHub REST 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)：支持条件请求、缓存和适当退避。适合低频检测；失败必须区分于“已是最新”。
4. [Renovate JSONata manager](https://docs.renovatebot.com/modules/manager/jsonata/)：可跟踪 JSON 中的自定义依赖信息，适合将来维护仓库的版本更新 PR。
5. [Renovate postUpgradeTasks](https://docs.renovatebot.com/configuration-options/#postupgradetasks)：同步 vendored 文件需要实际任务脚本和宿主命令授权；单改 manifest 版本不会自动更新技能文件，托管环境也不能假定允许执行命令。

下面的目录、状态、六小时窗口和兼容策略是面向 cezar 的工程选择，不是一手资料规定的通用标准。

## 方案比较

| 方式 | 适用场景 | 本项目取舍 |
| --- | --- | --- |
| 跟随本机某个 agent 插件自动更新 | 同一个 agent 内直接使用插件 | 不作为运行依赖；多后端、插件路径和更新时间不可控 |
| 每次运行拉 main 或覆盖 vendor | 快速实验 | 不采用；不可复现，包目录可能只读，运行中辅助文件会变化 |
| 仓库定期同步并提出更新 PR | 维护内置默认版本 | 可作为维护层；用户获得新版仍需更新 cezar |
| 内置兜底 + 版本化快照 + 受控激活 | 已安装 cezar 中管理工作流技能 | 推荐；不增加常驻进程，支持离线、任务固定和回退 |

## 推荐的运行机制

1. **发现**：在现有 Skills 设置/刷新入口增加 Superpowers 来源，展示当前生效版本、官方候选版本、检查时间与兼容状态。人工检查始终可用；启用对应的自动检测后最多六小时查询一次，使用 ETag/Last-Modified、超时和退避。沿用现有调度/锁机制，不新增服务。新的后台网络来源必须符合仓库 opt-in 约束，不能悄悄扩大现有 Open Mercato 默认自动更新例外。
2. **暂存**：下载指定官方 tag 对应 commit 的完整 skills 与辅助文件、许可证，存入 cezarHomeDir 下的版本目录。登记版本、commit、内容摘要和完整文件清单。只导入数据，不运行下载内容的安装脚本；拒绝越界归档路径。原有内置 vendor 不动。
3. **验证**：核对完整性、角色和辅助文件路径、工作流引用、首审/复查模板、图退出和无人值守交接规则，运行适配回归与必要的角色行为评估。哈希不能证明语义兼容，也不是独立的发布者签名；不能因为 semver 是补丁版本就跳过审查。
4. **激活**：只有通过适配验证的候选才可启用；用小的活动版本指针原子切换，新任务使用新快照。检查失败时保留旧指针，界面显示具体原因和变更记录。优先人工激活，后续再考虑已明确授权的自动策略。
5. **任务锁定**：任务创建时固定完整 bundle 的 commit/摘要和绝对快照路径；首次执行、Continue、重启恢复及原生子角色都读取同一快照。不能只冻结 system prompt 而让 helper 路径跟随“当前版本”。旧任务不会被指针切换影响。快照缺失时恢复指定版本或报告阻塞，不静默改用最新版。
6. **回退/清理**：回退只改变新任务的活动指针；失败候选不影响现有版本。只清理没有任务引用的缓存；保留内置兜底与可回退快照。状态可以重建，用户不需要手写锁文件或迁移配置。

版本/commit 路径必须经过校验，使用项目现有 cezarHomeDir 和原子写机制，遵守 CEZ_HOME 测试隔离。更新操作互斥，网络失败不阻塞服务启动，不把离线伪装成“最新”。

## 兼容边界

`cezar-unattended-v7` 的交接规则适配的是 v7。发现 v8 可以提示，但不能自动把 v8 当作兼容 v7；需完成适配并提供明确的工作流版本。自有 project-probe 与 adjudicator 不随上游同步而被覆盖。整套提示词、模板和脚本必须作为同一个版本激活，不能逐文件混用。

维护层之后可以用 GitHub Actions 或 Renovate 调用同一份同步/验证脚本，生成完整 vendor diff 与清单变化；没有现成 Renovate 部署时不为这一项依赖专门引入它。不要把“版本字段更新 PR”误认为技能内容已更新。

## 实施顺序与验证目标

1. 先增加显式检查、暂存、差异报告和同步脚本；默认依旧使用内置版本。
2. 完成任务版本锁定与恢复路径，再开放活动指针切换。未做到任务固定前，不能在服务运行时热替换目录。
3. 接入现有 Skills UI、更新状态和选定的低频检测策略。

必须覆盖：离线/限流、损坏或越界包、上游删除模板、并发升级、只读安装目录、验证失败保留旧版本、切换期间旧任务/Continue/恢复仍用旧辅助文件、回退、新大版本提示、两份自有技能不被覆盖。
