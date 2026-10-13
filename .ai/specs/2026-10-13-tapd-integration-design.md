# TAPD 接入调研与适配设计（待确认）

日期：2026-10-13。当前分支：`codex/tapd-integration`，基线为已推送的 `2bb2453`。

本文只调研和设计，不表示 TAPD 已实现，也不表示已通过真实账号联调。对标对象是 **Cezar 当前的 Jira Cloud / Linear 集成**，不是三个厂商产品的全部功能。目标是让 TAPD 进入相同的连接、浏览、任务发起和自动化生命周期；厂商差异必须明确暴露，不能用空数据或假事件掩盖。

## 1. 已实现的 Jira / Linear 功能基线

| 功能 | Jira Cloud | Linear | 代码依据 |
| --- | --- | --- | --- |
| 认证 | HTTPS Cloud site + 邮箱 + API token；探测 cloudId，优先 gateway，授权失败时有限 site fallback | Personal API key + GraphQL；读取 organization 身份 | `packages/cezar/src/server/tracker/jira.ts`、`linear.ts` |
| 连接范围 | 一个本地仓库绑定一个 Jira project | 一个本地仓库绑定一个 Linear team | `packages/contract/src/tracker.ts`、`packages/cezar/src/tracker-association.ts` |
| 项目发现 | 分页、项目搜索、按 ID 校验规范项目名称 | 分页、团队搜索、按 ID 校验规范团队名称 | 两个 adapter 的 `listCandidates`、`resolveAssociation` |
| 工单浏览 | 更新时间倒序；服务端 JQL 分页 | 更新时间倒序；GraphQL cursor 分页 | 两个 adapter 的 driver |
| Active / All | `statusCategory != Done` / 不限制 | 排除 `completed`、`canceled` / 不限制 | `jira.ts:jqlFor`、`linear.ts:driver` |
| 搜索 | 文本搜索；合法 issue key 同时查询 key | `searchIssues`；不搜索评论 | 同上 |
| 多标签筛选 | 每个标签单独组成 AND 条件 | 每个标签单独组成 AND 条件 | 同上；大小写敏感，不是任一标签匹配 |
| 详情 | 重新向厂商读取；验证 issue project；ADF 转 Markdown | 重新向厂商读取；验证 issue team；Markdown 描述 | `getItem`、`adf.ts` |
| 详情界面 | 编号、标题、作者、时间、状态、标签、来源链接、描述 | 同样的共享界面 | `packages/web/src/routes/tracker/tracker.tsx` |
| 发起 AI 任务 | 描述快照 + 补充上下文 + 最后追加用户指令；可选模型、账号、技能链、工作流；支持拖入输入框 | 相同 | `tracker-handoff.tsx`、`packages/web/src/lib/tracker-task.ts` |
| 内容缺失 | 列表 8,000 字符，详情 60,000；转换丢失或截断须用户确认；最终提示词最多 100,000 | 相同 | `adf.ts`、`tracker-task.ts` |
| 页面刷新 | 可见列表按需共享检查第一页，默认 60 秒；加载后续页时不自动替换整份分页结果；详情不按定时器持续刷新 | 相同 | `server/tracker/watch.ts`、`docs/issue-trackers.md` |
| 自动化创建事件 | 支持 | 支持 | `jira-events.ts`、`linear-events.ts` |
| 自动化状态变化事件 | 支持历史事件，目标状态 ID 筛选 | 当前不开放 | `jira.ts:automationOptions`、`linearEventCapabilities` |
| 自动化标签增删事件 | 当前不开放 | 当前不开放 | 两者能力声明，不应因 schema 中有枚举就认为已支持 |
| 自动化必需标签 | 候选快照必须包含所有选中标签；建议来自分页工单，不是完整标签目录 | 相同 | `automations/tracker-poller.ts`、`editor-tracker-fields.tsx` |
| 自动化生命周期 | 默认 30 分钟检查；保存暂停、预览、启用、禁用、执行日志；启用不补跑旧历史；断点扫描、回执去重、失败退避 | 相同 | `docs/issue-trackers.md`、`server/tracker/event-scan.ts`、`automations/` |

共同边界：浏览不写厂商数据；不抓取评论、附件、自定义字段；不提供 OAuth、多账号选择、多范围绑定和全量后台同步。GitHub 是独立 forge 集成，包含 PR/检查/合并，不能把 TAPD 放进 GitHub 的接口模型。依据：[现有连接文档](../../docs/issue-trackers.md)、[新增提供商约束](../../docs/adding-issue-tracker.md)。

### 安全、缓存和凭据基线

- 凭据只通过写接口提交，保存在仓库外的项目级 managed dotenv 文件；GET 不返回秘密，也不使用全局环境凭据兜底。路径、连接 UUID、credential digest 与 revision 防止更换凭据后复用旧实例。文件并非静态加密。依据：`server/tracker/connections.ts`、`connection-env.ts`、连接文档。
- Scope、cache、cursor 和读取请求绑定项目、source、connection revision、查询条件；更换连接、解绑或换范围时拒绝迟到结果。cursor 是进程内签名令牌，重启后失效。依据：`server/tracker/index.ts`、`cursor.ts`、`trackerReadScope`。
- 共享 transport 限制整次操作 deadline（默认 10 秒）、2 MiB 响应体、redirect，区分 unauthorized / rate_limited / not_found / invalid_response / unavailable；不记录原始上游错误体和凭据。依据：`server/tracker/transport.ts`。
- **手动任务**默认不注入 tracker 凭据。**已启用的 tracker 自动化**会重新校验当前连接与捕获版本，再向其任务注入该项目凭据，并要求代理读取完整当前工单；不是 server 强制保证代理完成读取。依据：`server/tracker/agent-credentials.ts`、`automations/task-template.ts`。TAPD 必须显式沿用这项例外，不能宣称所有场景都不向代理提供凭据。

Linear 的事件限制不是实现遗漏：官方说明创建后三分钟内的修改不进入 activity change 记录，因此目前不能以它证明完整状态变化历史。[Linear 官方 API](https://linear.app/developers/graphql)。Jira 的分页历史读取入口见[官方 Issues API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)。

## 2. TAPD 官方接口与匹配关系

适用对象：用户提供的 `https://www.tapd.cn/` 公有云标准项目。这个首页只能确认域名，不能证明公司已开通 API，也不能确认项目不是轻协作；后两项是联调前条件。轻协作、私有部署和 OAuth 不属于本方案。

| 现有能力 | TAPD 对应接口 | 设计要点 |
| --- | --- | --- |
| 认证 | Bearer 个人访问令牌（`Authorization: Bearer <token>`） | 令牌是 write-only 秘密，整份响应不得日志/返回/持久化；固定 API origin 为 `https://api.tapd.cn`；每请求附带 `?s=mcp` 与 `Via: mcp` |
| 参与项目发现 | `GET users/info` 取 `nick` → `GET workspaces/user_participant_projects?nick=...` | 用户参与的项目集合；无分页；可在完整且有响应上限的集合上本地搜索、切片，然后签名分页；不能截断后伪称全集 |
| 项目身份校验 | `GET /workspaces/get_workspace_info` | 读取项目规范名称、company_id；拒绝其他公司的 workspace、错误 source 和已不匹配的凭据 |
| 需求列表/详情 | `GET /stories?workspace_id=...`，可传 `id` | 标题字段 `name`；字符串 ID 必须完整保留，不能转 JS Number |
| 缺陷列表/详情 | `GET /bugs?workspace_id=...`，可传 `id` | 标题字段 `title`；独立资源接口，必须区分需求 ID 和缺陷 ID |
| 分页与排序 | `limit`、`page`、`order` | 需求默认 30、最大 200；具体缺陷参数以文档/联调验证为准；页数及游标位置严格校验 |
| 搜索 | 需求 `name` / `description`；缺陷对应标题、描述参数 | 编号查询与文本查询都要设计；跨字段 OR 不可假定上游支持，要明确真实语义与可恢复分页方案 |
| 状态显示 | `workflows/status_map` | 映射状态 code 与中文名称；需求的状态目录可能需要 workitem_type_id，不能当作项目只有一套流程 |
| Active 筛选 | `workflows/last_steps`，需求可参考 `all_last_steps` | 按厂商终态定义处理，不能硬编码 `done` 或按中文“已完成”判断；需求多类别必须保留各自终态语义 |
| 标签 | 需求官方 `label` 查询；多值枚举存在 OR 语义 | 尚不能推断 label 的多值 AND 语义或缺陷标签同等能力；必须实测，并对照返回字段格式 |
| 历史事件 | 需求/缺陷 histories 系列 | 历史字段结构、分页上限、按日期查询、稳定历史 ID、完整性与时区须验证；不能只查询当前状态或 modified 后伪造转换 |

上述事实分别来自 TAPD 官方：[认证](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/API%E9%85%8D%E7%BD%AE%E6%8C%87%E5%BC%95.html)、[API 使用必读](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/%E4%BD%BF%E7%94%A8%E5%BF%85%E8%AF%BB.html)、[项目列表](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/api_reference/workspace/projects.html)、[项目信息](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/api_reference/workspace/get_workspace_info.html)、[需求读取](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/api_reference/story/get_stories.html)、[缺陷读取](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/api_reference/bug/get_bugs.html)、[状态名映射](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/api_reference/workflow/get_workflow_status_map.html)、[终态](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/api_reference/workflow/get_workflow_last_steps.html)、[需求各类别终态](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/api_reference/workflow/get_workflow_all_last_steps.html)。历史 API 证据和待核实字段另见 TAPD 调研记录。

## 3. 接入方案选择

| 方案 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- |
| 一个 TAPD provider + 同一 workspace + 需求/缺陷页签 | 一个凭据与范围；复用通用流程；上游分页各自清晰 | query/watch/自动化需显式类型维度 | **推荐** |
| 拆成 TAPD需求 / TAPD缺陷 两个 provider | 单列表 adapter 简单 | 当前一个仓库只能绑定一个 tracker，用户无法同时访问同一项目两种工单；重复账号配置 | 不采用 |
| 一个混合“全部”列表，跨 API 合并排序 | 可混合浏览 | 双流排序、类型化状态、跨流剩余位置和分页变动更复杂；不是 Jira/Linear 基线所要求的功能 | 本次不增加 |

推荐 UI：Settings → 工单提供商 → TAPD → 填入个人访问令牌与显式时区 → 保存 → 浏览项目 → 绑定。在工单页切换“需求 / 缺陷”，两者各有搜索、Active/All、标签、详情和发起任务。令牌清空、连接替换、断开、离线恢复行为沿用现有流程。切换类型清理当前列表页，但按带类型 ID 保持详情身份和草稿隔离，不能把需求草稿投到缺陷。

## 4. 数据和接口适配

### 身份与合同

- 增加有限枚举 `tapd`，不将 `TrackerKind` 改为任意字符串。
- 增加 write-only credentials variant `{kind:'tapd', accessToken, timeZone}`；严格校验令牌长度与控制字符。令牌是唯一秘密。
- API 网页 origin 固定；source 标识拟为 `tapd`，凭据轮换由 connection revision 保证，不相信浏览器提交的名称或 URL。
- `externalId` 仍为 workspace ID，`externalName` 仍为厂商规范项目名称；不把类别拼入 scope 名称。
- 工单内部 ID 用 `story:<原始字符串ID>` / `bug:<原始字符串ID>`；原始长整型字符串不丢精度、不误识别为 GitHub #number。通用 `kind:'issue'` 保持兼容，可增加可选 `itemType` 和展示编号字段以避免 UI 解析私有 ID。
- 列表、搜索、watch、automation options 与 trackerTrigger 引入可选类型字段，TAPD 要求明确 story/bug；Jira/Linear 老请求无需此字段且行为不变。watch query key、签名 cursor、预览扫描 checkpoint 和自动化基线都包括类型。类型改变视为事件来源改变，清理不兼容 progress 并重新基线。
- 深链接从带类型的工单 ID 决定对应接口；绑定验证、lookup 和返回 `workspace_id` 校验缺一不可。网页 URL 只由已验证 workspace/type/ID 构造，具体路径必须完成官方例证和联调验证，禁止接收任意上游跳转 URL。

### 分页、搜索与过滤

- 两个页签独立按上游稳定可验证的排序分页，使用现有 signed cursor。明确页式 API 在数据更新时不是事务快照；刷新回第一页，页面边界去重不能代替完整性声明。
- 编号搜索保留原始 ID；文本搜索的跨标题/描述组合规则先验证。若上游只有单字段过滤，应明确搜索字段选择，或做可恢复的多流查询；禁止只取第一页后浏览器过滤并显示“无结果”。
- 标签 AND 的首选是已证实的上游组合条件。如果上游仅提供 OR/单标签过滤，则单标签预筛选 + **adapter 服务端**逐页验证全部标签，记录已扫描页和页内位置，直到凑满展示页或扫描完；达到操作预算必须返回可继续扫描的明确状态，不能伪称查询完成。必要的扫描状态扩展写进合同并复用通用分页恢复机制。该策略需要用户批准后实现，不能擅自把 AND 改为 OR。
- Active：按需求类别和厂商终态过滤。同一状态 code 可能出现在不同工作流中，不能仅把所有类别终态并集作为全局排除条件。若上游无法表达按类别条件，就逐类别查询并做有界可恢复扫描。获取不到状态目录应报告 unavailable，不能退回猜测。

### 内容、时间和错误

- TAPD HTML 描述在 server 转为安全 Markdown/文本；保留段落、列表、代码、表格和安全链接。禁止执行/渲染原始 HTML，不主动下载远程媒体；图片、嵌入对象、转换丢失或截断明确设置 unsupportedContent / bodyTruncated。
- 沿用 8k/60k/100k 上限和缺失确认流程；不增加评论、附件、自定义字段抓取，以维持现有快照边界。
- `created` / `modified` 没有显式 offset 的字符串不能使用 host `Date.parse` 随机解释。只有官方或账号实测确认时区后才进行明确转换；必要时新增可见时区配置。不能因 tapd.cn 域名就默认为 Asia/Shanghai。
- TAPD JSON envelope 的 `status` 与 HTTP status 分开验证；HTTP 200 不等于业务成功；只输出受控错误，不泄露 `info` 中的敏感数据。429、超时、异常内容、空列表和 not_found 沿用共享类型。

## 5. 自动化：目标能力与开放门槛

目标是复用现有 `automationOptions`、`pollEvents`、TrackerPoller、EventScanner、checkpoint、回执去重和日志，不添加新的调度器或 webhook 服务。自动化选定 workspace 与类型，requiredLabels 仍是候选当前快照的 AND 条件，与“标签变化触发”严格区分。

| 事件 | TAPD 设计 | 开放条件 |
| --- | --- | --- |
| 工单创建 | 两种类型各自用不可变 ID + created 构造创建事件，分页发现 | 确认查询窗口、时区、分页、延迟可见性和完整时间戳 |
| 状态变化 | 查询对应类型的真实 histories，解析 old/new 或 field_changes | 连续同状态转换、同一轮多次变化、历史分页、稳定 ID、精确时间、覆盖完整性验证通过 |
| 标签增删 | 目标接口列出能力待验证 | 必须有可验证的历史变化编码与完整性，否则不宣传支持 |

创建事件不能依赖 modified；状态事件不能依赖当前状态差异。需求多类别的目标状态目录要使用复合身份（例如类别 ID + 状态 code），并验证历史可关联到正确类别；不能以相同名称替代 vendor ID。

默认沿用保存暂停、预览、30 分钟检查和启用时当前基线。跨日 history 扫描按厂商可查询日期切片，分页/日期/当前 issue 均可 checkpoint；用重叠窗口和 durable receipt 去重。用时间预算而不仅是请求次数；预算耗尽不重置页一。凭据旋转、切换类型、source 改变、禁用、掉线和迟到响应均沿用现有 isolation。

凭据注入与现有自动化保持一致，但必须独立扩展 `resolveTrackerAgentEnv`、`renderTrackerTask` 的 TAPD 分支；不能让“非 Jira 就是 Linear”的三元表达式把 TAPD 令牌当 Linear key。现有秘密脱敏清单也须覆盖 TAPD 令牌。只读凭据无法完成任务指令里的回写，UI/文档应解释权限边界；本次不新增自动写回 API。

**能力对标不等于虚假齐全**：若真实 API/权限不能证明历史完整，就在 options 中返回 limitations 并拒绝启用对应事件，报告尚未达到该项 Jira 等价能力。浏览和创建事件可以单独验收，但不能把未开放的状态事件写成“已全部对标”。

## 6. 预计改动位置

| 层 | 改动 |
| --- | --- |
| Contract | `packages/contract/src/tracker.ts`；相关 automation/run schemas 的 provider 枚举、可选类型和能力限制 |
| Adapter | 新 `server/tracker/tapd.ts`，HTML 转换模块；必要时 `tapd-events.ts`；Zod vendor payload schemas |
| Registration/storage | `tracker/index.ts`、`connection-env.ts`，保持旧 dotenv 格式严格兼容；`dry-run.ts` 完整 fixture |
| Refresh | `watch.ts`、客户端 tracker query/cache/watch key 包含类型；复用 SSE/WS 与 HTTP 路由，不创建 TAPD 私有路由家族 |
| Automation | `event-source.ts`、`event-scan.ts`、`automations/types.ts`、`task-template.ts`、`agent-credentials.ts` 等硬编码 Jira/Linear 的穷举位置 |
| Web | `lib/tracker-providers.ts`、settings credentials form、`routes/tracker/` 页签及字段、automation 类型选择和厂商显示；所有新增 UI 同时加入中英词条 |
| Docs/tests | 更新连接文档和新增提供商文档；contract parity、scoped routes、project isolation、API/client/UI 和适配器测试；无关代码不重构 |

## 7. 实施顺序和验收

1. 锁定关键 API 语义：账号 API 权限、标准项目类别、workspace/company 归属、终态/类型、标签 AND、时间时区、历史完整性。获得脱敏响应样本；不要在聊天或仓库保存真实密码。
2. 测试驱动完成 contract、credential round-trip/revision、注册和项目发现；验证无 boot 网络、旧 Jira/Linear 凭据文件正常读取、替换旧连接拒绝迟到结果。
3. 测试驱动完成需求/缺陷列表、跨页筛选、详情/HTML、长 ID 与任务发起；增加 dry-run 双类型、多页、长正文和内容损失样本。
4. 扩展 UI 页签、查询/watch 类型隔离、中文界面；复用 shared composer，证明切换过滤/刷新不破坏草稿、类型切换不串数据、数字不会变 GitHub ref。
5. 按能力门槛加入自动化与目标状态选择，验证跨日/跨页恢复、两次转换、延迟索引、预览不启动任务、禁用/换凭据停止旧来源派发、回执去重及脱敏。
6. 本地测试和真实只读联调分开报告。类型检查、tracker/automation/contract/UI 回归、生产构建/打包；真实联调只 GET/只读，不创建/修改 TAPD 工单，不启用真实自动化。此前 Windows POSIX 测试缺失不应被算作功能测试通过。

验收需要真实账号参与的项目，不依赖公开首页匿名访问。无真实凭据时可以完成代码和 synthetic tests，但必须标明“未真实联调”，不宣称已兼容所有 TAPD 账号/项目类型。

## 8. 待确认的设计决定

- 是否采用一个 TAPD provider、单 workspace 绑定、“需求 / 缺陷”双页签方案（推荐）。
- 是否接受必要的合同扩展以正确表达类型、筛选扫描进度和自动化目标状态身份，保持旧 Jira/Linear 默认行为不变。
- 实现前需提供项目类别/API开通状态；验收时在设置中输入 API 凭据和公司 ID。尚未确认时区、标签编码/AND、历史完整性之前不承诺状态/标签事件同等可用。

本设计为评审草案，未更改业务代码，未提交或推送新功能。
