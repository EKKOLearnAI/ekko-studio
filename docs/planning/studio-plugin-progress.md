# Studio 插件体系实施记录

更新：2026-10-24。分支：`feat/studio-plugin-context`。基线：`8f215f59d`。

本文件记录实际实现；[架构总案](studio-plugin-architecture.md)、[契约](studio-plugin-contracts.md)和[实施计划](studio-plugin-execution.md)仍定义完整交付范围。当前为迁移开发状态，尚未完成全量插件化；旧聊天 HTTP 入口已去掉本机 Socket 回环，运行引擎和存储仍使用原实现。

## 已实现的代码

| 范围 | 当前实现 |
| --- | --- |
| 公共 SDK | 独立 TypeScript 包、JSON DTO、manifest、Agent 工厂、作用域、输出事件、错误码、注册/通知回调/清理入口；SDK/RPC 版本检查 |
| 上下文 | 宿主签发不可变身份与 profile；当前有 `sessions.get/remove`、`agents.list`、`runs.start/get/output/cancel/interactions/respond/usage`、`chat.start/get/cancel` 和 `workflows.run/get/cancel`；每次调用重新授权并校验取消状态，RPC 使用宿主句柄。独立实例/工作流要求无资源绑定；聊天支持绑定自身会话 |
| 注册 | profile 隔离、内置/插件提供方联合类型、激活阶段暂存、完整声明及冲突校验、事务发布、generation 资源释放 |
| 插件宿主 | 本地目录校验、摘要工件、独立子进程、有限 RPC 并发、请求超时、输出背压、进程树清理、配置 revision、运行时租约；profile 服务依赖图、schema RPC、持久化激活诊断和限定节点的只读 hook |
| 安装策略 | 14 个系统插件 ID 已保留；用户安装不能覆盖，删除在接触工件/worker 前返回 `SYSTEM_PLUGIN_PROTECTED`；profile 选择不会被重复系统登记覆盖 |
| 事件 | `ctx.on` / `ctx.once`、profile/owner 授权、每分区有序通知；`ctx.events.consume` 持久化游标、租约、重试/死信和保留期；仅把明确允许的旧业务事件字段投影到公共事件表 |
| Agent API 执行 | 实例、接受请求、幂等、启动、流输出、完成屏障、取消、终态与事件事务落库；崩溃恢复标记 interrupted，不自动重放输入 |
| 原生管理检查 | 通用 `management.inspect`、目录能力发现、独立短期资源和所有者/profile 鉴权；Codex 脱敏账号状态及模型分页，Qwen ACP 信息/认证方式；登录、配置文件等完整管理仍未迁移 |
| 受管进程 | runtime 租约持有管道进程，宿主签发句柄、用户/profile/runtime 隔离、有界字节读取与写入背压、环境白名单、退出确认和进程树终止；worker 不持有宿主 ChildProcess |
| 原生模型网关 | Run 绑定 loopback 租约、宿主凭据闭包、Responses/Anthropic 同协议直通、模型图片能力透传、逐调用计量及取消清理；Qwen/Codex scoped 原生目录隔离；已复用旧 proxy 适配器支持三种协议的四个转换方向，其他协议及厂商完整验收待完成 |
| 图片附件 | 宿主上传/像素校验与配额、owner/profile 隔离、Run 输入绑定、SDK 分块读取、Qwen/Codex 原生图片转发；尚未接入旧聊天 UI，历史附件回收待完成 |
| MCP 工具 SDK | `runtime.mcp.connect` 支持显式 stdio/HTTP 配置、工具发现/调用、文本/图片/JSON 结果、跨成功轮次连接复用、撤权回收及可等待清理；原生配置注入、统一交互凭据和 resources/prompts 仍未完成 |
| 协议抽取 | 标准 ACP 连接及事件转换移入独立 `studio-agent-drivers`；旧调用通过兼容入口复用，原有协议测试继续通过 |
| 旧聊天启动 | 准入已迁为共用服务，HTTP 直接调用；直调入口已绑定宿主 ExecutionScope、复制输入与身份并区分准入前取消和准入后排队；SDK 已通过 `chat.start/get/cancel` 接入已有会话文本运行 |
| 工程接入 | bootstrap、鉴权 API、生成式 OpenAPI、runner 构建、插件私有导入边界检查、独立 Echo 样例 |

安装策略测试中的 14 条 fixture 只验证保护和幂等规则。**当前没有把这 14 个 Agent 注册成已安装系统插件**，也没有用空壳包代替厂商迁移。已有 Qwen 与 Codex 独立包的 global/scoped 文本与图片运行增量（scoped 目前要求原生协议一致），尚未默认安装或替换旧入口，不能计为完整迁移。旧 Coding Agent 仍使用原执行和管理路径。Hermes/Ekko 仍是原内置模块。

## 当前开发接口

所有接口使用已有认证；需要 profile 的接口使用现有 profile 中间件。不得把身份、权限或 owner 放进请求体自行选择。

| 方法及路径 | 作用 |
| --- | --- |
| `GET /api/studio/plugins` | 已安装插件与宿主决定的安装策略；超级管理员 |
| `POST /api/studio/plugins` | 从服务器本地目录安装；超级管理员；不自动启用 |
| `GET /api/studio/plugins/:id/profile` | 读取 profile 配置及 revision；超级管理员 |
| `GET /api/studio/plugins/:id/diagnostic` | 读取当前 profile 的激活状态、公共错误码和租约占用；超级管理员 |
| `GET /api/studio/plugins/:id/consumers` | 列出当前插件/profile 的可靠消费者；超级管理员 |
| `GET /api/studio/plugins/:id/consumers/:consumerId/deliveries` | 最多 1,000 条待投递/处理中/死信元数据；不返回 payload 或租约凭据 |
| `POST /api/studio/plugins/:id/consumers/:consumerId/control` | 带 revision 暂停、恢复或显式 reset-now；超级管理员 |
| `POST /api/studio/plugins/:id/consumers/:consumerId/retry` | 选择 position 与死信 revision 重试；超级管理员 |
| `PUT /api/studio/plugins/:id/profile` | 配置、授予声明的能力、启停；超级管理员；活动租约阻止切换 |
| `DELETE /api/studio/plugins/:id` | 卸载用户插件；超级管理员；保留配置及运行历史 |
| `GET /api/studio/agent-types` | 当前已激活插件提供的目录；尚未合并旧内置目录 |
| `POST /api/studio/agent-images` | 上传至当前用户/profile 的图片工件，原始字节体，返回 artifact 引用 |
| `DELETE /api/studio/agent-images/:id` | 删除自有且尚未被已接受 Run 引用的图片 |
| `GET /api/studio/agent-instances` | 当前用户、当前 profile 的实例 |
| `POST /api/studio/agent-instances` | 按已注册类型的 schema 创建实例 |
| `PUT /api/studio/agent-instances/:id` | 按 revision 更新自身实例配置；活动 Run 阻止修改，旧租约确认回收后提交 |
| `POST /api/studio/agent-instances/:id/inspect` | 检查空闲自有实例的原生元数据；与运行/配置修改互斥，不创建 Run 或聊天历史 |
| `POST /api/studio/agent-instances/:id/runs` | 接受文本/图片引用及幂等键 |
| `GET /api/studio/agent-runs/:id` | 读取自身 Run 状态 |
| `GET /api/studio/agent-runs/:id/output` | 按 `after` 序号读取自身 Run 输出 |
| `POST /api/studio/agent-runs/:id/cancel` | 请求取消自身 Run |

运行记录与旧聊天会话目前分别存储。该入口用于迁移开发验证，不能据此宣称五类运行入口已经统一。安装记录、profile 配置、实例、Run、输出及公共事件使用新增 SQLite 表，没有改写旧历史记录。

## 尚未完成的交付范围

| 任务 | 状态与缺口 |
| --- | --- |
| T00 | 已完成源码清单及部分原测试基线；真实 CLI/平台矩阵、协议录制、数据副本和性能基线尚未齐全 |
| T01 | SDK 和边界检查已有实现；仍需与完整契约对齐，包括交互、管理、可靠消费等 |
| T02 | 会话删除、Agent 实例启动、旧聊天准入及工作流启动已与 SDK 共用服务；已覆盖作用域、幂等与真实 worker RPC。群聊、全局任务及其余领域仍未完成；工作流原引擎尚未统一 |
| T03 | 进程、RPC、注册回滚、资源回收、profile 服务 DAG 与调用、激活诊断及生命周期通知已有实现；完整运行诊断和限额验收仍未完成 |
| T04 | 通知、可靠消费者、重试/死信、保留期、会话删除事务事件、实例启动/公共删除 hook 已有实现；旧运行 hook/事务统一、完整事件族、因果预算与负载验收未完成 |
| T05 | ACP/MCP 协议驱动、受管管道进程、SDK 模型/MCP 工具代理和公共 MCP 启动/凭据租约已有实现；原生 MCP 注入/交互绑定、PTY、其他协议驱动及旧厂商调用迁移仍未完成 |
| T06 | 实例 API 已有多轮租约、交互、取消、token 归并、模型调用计量关联及成功 checkpoint；父子 Run、原聊天及其他入口统一写入未完成 |
| T07 | 新注册表与实例开放 ID；旧枚举、历史别名及客户端目录尚未迁移 |
| T08–T10 | 厂商插件独立化和 Hermes/Ekko 统一运行接入未完成；禁止用定义搬迁替代功能验收 |
| T11 | 新 HTTP 入口已接入；聊天/Socket、群聊、工作流、全局任务及客户端管理未完成 |
| T12 | 本地用户包和系统删除保护已有实现；14 个随包工件、默认安装、排空升级/回滚、分发验收未完成 |
| T13–T14 | 真实迁移演练、跨平台验收、临时路径清理与最终发布验收未完成 |

后续仍有七大交付块：统一运行与剩余业务入口、插件基础能力收尾、通用 Web/Desktop/App 界面、14 个 Coding Agent 独立插件包、Hermes/Ekko 内置统一接入、安装升级与发布分发、最终迁移验收与旧代码清理。旧聊天 SDK 的已有自有会话文本启动、查询和取消已完成，不再列为待开发项。

推进顺序：补齐 Qwen/Codex 的完整迁移 → 接入聊天界面形成可体验闭环 → 扩展到其余 Agent 和业务入口 → 分发与最终验收。MCP 工具 SDK 已整合、提交并推送，原生配置注入等剩余能力随迁移继续推进。Hermes/Ekko 继续保持内置身份；14 个厂商插件须逐个迁移和验收，保留 ID 或 fixture 不计为交付。

## T02 进展：会话删除共用领域服务

本项验收范围为现有会话删除用例的迁出，以及插件 ctx 接入；不代表 T02 整体完成。

- [x] 单删和批删的原生检查/清理、运行停止、本地删除及通知集中到 `services/sessions/removal.ts`；controller 只适配请求、旧响应格式和批量统计。
- [x] SDK 与 worker 支持 `ctx.sessions.remove(id)`；manifest 必须声明并获授 `sessions.remove`，worker 每次调用校验能力；身份、profile、绑定会话和取消信号来自宿主，RPC 不接受调用方指定它们。
- [x] 本地会话、消息、任务和工作区差异在一个 SQLite 事务内删除；同 ID 删除串行化，成功提交后才发布原有删除通知。归档通知不会误投影为 `session.deleted`。
- [x] 核验 HTTP/SDK 返回语义、native-only 历史、同 ID 不同 profile、取消/权限撤销、删除期间 profile 变化、数据库回滚、并发及真实 worker 授权。

| 入口 | 身份与范围 | 实现与结果 |
| --- | --- | --- |
| 现有 HTTP 单删/批删 | 保留认证中间件的用户或服务令牌身份；领域调用前和原生检查后重新检查目标 profile 权限 | 都调用 `removeStudioSession`；响应中的 `hermes`、批量计数和失败列表保持兼容 |
| `ctx.sessions.remove(id)` | 当前 execution scope 的主体与 profile；有绑定会话时只能操作该 ID；重新检查用户状态和 profile 访问权 | 同一领域服务；返回 `{ deleted, native: { attempted, deleted, profileId, error? } }`，失败使用公共错误码 |

副作用顺序为：读取目标 → 授权 → 只读原生检查 → 再次授权和取消检查 → 既有 Coding Agent 停止/原生删除 → 本地事务 → 删除通知。显式指定 profile 时，不停止或删除其他 profile 下同 ID 的本地会话。原生检查期间目标本地会话发生迁移时返回 `REVISION_CONFLICT`。

取消发生在首个副作用前时拒绝操作；开始变更后完成本地清理并报告实际结果，避免已删除却返回“取消成功”。原生状态和 Studio 数据库无法构成共同事务，保留既有策略：原生失败作为结果中的诊断，本地删除继续；本地失败回滚并返回 `INTERNAL`，不会发出成功通知。native-only 删除没有本地 owner，沿用旧入口不发送本地会话删除通知的行为。

本项未实现统一运行租约下的活动 Run 拒绝/取消选项，仍使用既有 Coding Agent 停止端口；Hermes/Ekko 统一运行适配由 T06/T10 负责。本阶段通知是提交后的进程内发布；后续 T04 已补上会话删除事务事件和可靠消费，见下节。删除 hook 与原生删除的跨系统恢复仍需后续迁移验收。

本次专项：9 个文件、196 项通过（包含删除/事务、原 controller、分享会话权限、真实 worker、内核、事件、压缩记录与任务回归）；`npm run build`、`npm run harness:check` 和 `git diff --check` 均通过。该增量未重跑全量 coverage/浏览器矩阵，下文保留基础实现的历史验证结果。

## T02 进展：Agent 实例启动共用领域服务

本项实现新 Agent API 的启动端口和 `ctx.runs.start`。这不是旧聊天启动迁出完成，也不代表 T02 或 T06 整体完成。

- [x] `POST /api/studio/agent-instances/:id/runs` 和 `ctx.runs.start({ instanceId, input, idempotencyKey })` 共用执行上下文和 `services/agents/start.ts`；没有本地 HTTP/Socket 回连或假 Koa/Socket 对象。
- [x] SDK/runner/宿主完整支持 `runs.start`；manifest 声明且当前 profile 授予此能力后，真实 worker 才能调用。身份和 profile 来自宿主句柄，输入不能携带 owner、principal、provider 或 scope。
- [x] 授权等待前复制请求；协调器在接收前重新检查主体、profile 和实例 owner。暂不支持已有 session/workspace/Run 绑定的上下文启动新 Run，明确返回 `CAPABILITY_UNSUPPORTED`，不会丢弃绑定后扩大范围。
- [x] 相同 owner/profile 下的幂等键关联实例及完整输入；HTTP/SDK 并发重试只创建一次。不同输入返回 `REVISION_CONFLICT`；已接收请求在提供方移除后仍可查询，权限撤销后不能靠重试读取结果。
- [x] 接收前取消不落库、不执行；接收落库后返回实际 Run 回执，调用方上下文结束不撤销已接受的独立执行。后续通过现有 Run 读取/输出/取消 HTTP 入口管理；SDK 取消方法已在后续 T06 增量实现，见下文生命周期进展。

| 边界 | 当前行为 |
| --- | --- |
| 身份与资源 | HTTP 使用认证中间件创建的 scope；事件上下文使用订阅 owner；两者都只能启动相同 owner/profile 的已创建实例 |
| 校验与提交 | JSON/字段/长度校验与请求快照 → 当前授权和取消检查 → 实例归属、输入和能力校验 → 持久化 accepted → 协调器执行 |
| 持久化与通知 | 复用现有 Run 唯一键、输出存储及终态/事件事务；启动服务不增加第二个输出或完成事件生产者 |
| 失败与恢复 | 不自动重试 RPC 写入；响应丢失可使用相同幂等键取回已有记录。重启仍将未结束 Run 标记 interrupted，不重放输入 |

专项覆盖 HTTP/SDK 一致性、并发幂等、owner/profile 隔离、伪造字段、取消与撤权、输入快照，以及真实事件回调 worker 的启动、重复调用和能力撤销。Node 24.22.1 下的本增量验证结果：

- 插件、启动、协调器与会话删除专项：9 个文件、78 项通过。
- `npm run test:coverage -- --maxWorkers=2 --testTimeout=20000 --hookTimeout=20000`：885 个文件通过、12 个跳过；8,986 项通过、32 项跳过。仅本地命令使用 20 秒时限，未改仓库默认配置。
- `npm run test:e2e -- --workers=2 --reporter=line`：1,024 项首轮全部通过。
- `NODE_ENV=production npm run build`、`npm run harness:check` 和 `git diff --check`：通过。

上述检查验证本增量及既有功能回归，不替代真实厂商 CLI、系统插件迁移或发布工件验收。

## T02 进展：旧聊天启动准入服务

本增量迁出原 Socket `run` 处理器的准入与调度规则，保留原有执行器。该阶段尚未完成 HTTP 直调；后续进展见下节。旧聊天 SDK 接入仍未完成，T02 不整体完成。

- [x] `services/chat-run/start.ts` 接收认证后的 caller scope、请求和执行/事件端口；无需 Koa ctx、Socket 对象或本机网络连接即可直接测试准入行为。
- [x] profile/session 授权、Ekko 历史身份归一、附件归属登记、分类校验、三类命令选择、推送设备绑定、排队和启动失败清理集中到该服务。Socket 入口只组合原命令执行器、运行执行器与事件发送。
- [x] 运行族判断和队列消息投影迁为共用函数，排队/恢复/内部调度保持同一规则；不修改消息与 Run 存储格式，也不增加新的输出写入者。
- [x] 复制请求顶层后再做身份归一和取出推送快照，原请求不会被这些操作修改；这不是插件公共输入校验或完整不可变请求快照。

| 边界 | 当前行为 |
| --- | --- |
| 身份来源 | 原认证与分享会话 packet middleware 继续负责身份和分享输入限制；用户、当前 profile、来源 ID、排队重授权回调由入口注入，不取自客户端 payload |
| 读取与校验 | 先解析可访问 profile、规范化执行族；普通附件输入校验已有会话的 profile，并在运行启动前登记归属；新会话可预登记附件 |
| 命令与排队 | 命令先于设备绑定与排队执行；共享会话不登记上传、不绑定接收者设备，排队项保留原始来源与撤权检查；工作流/群聊的 Ekko 斜杠任务继续交给运行时 |
| 副作用与事件 | 设备绑定完成才启动或排队；绑定失败返回原 `run.failed`。队列通知及 webhook 格式不变，推送秘密不传入运行执行端口 |
| 失败与恢复 | 保留旧行为：执行异常只释放尚无运行句柄/中止控制器/活动标记的预留，已有运行状态不被误清；队列仍是进程内状态，不宣称持久化恢复 |

新增无传输对象的服务测试覆盖 profile 拒绝、附件、命令分流、共享队列撤权、设备绑定、启动失败及请求不变性；既有 Socket/HTTP 测试继续作为行为对照。Node 24.22.1 下：

- 专项共 7 个文件、152 项通过（原 6 文件 139 项，以及 reasoning/API mode 回归文件 13 项）；新增服务用例 23 项。
- 覆盖率首轮 885 个文件、9,008 项通过，1 项旧源码路径断言失败；已将队列入参断言移至新服务，并通过专项复测。最终 `npm run test:coverage -- --maxWorkers=2 --testTimeout=20000 --hookTimeout=20000` 全量复验 886 个文件通过、12 个跳过；9,009 项通过、32 项跳过（394.98 秒）。本地时限参数不改变仓库配置。
- 浏览器全量 `npm run test:e2e -- --workers=4 --reporter=line`：1,023 项通过、1 项侧栏测试失败。trace 显示从聊天切换到历史页时，侧栏尺寸读取返回空值；未修改侧栏实现/测试，`sidebar-resize.spec.ts --workers=1` 单独复测 6 项全部通过。这不是首轮浏览器全绿。
- 生产构建、harness 与差异检查通过。真实厂商 CLI、系统插件迁移及发布工件仍未验收。

## T02 进展：旧聊天 HTTP 直接调用

本增量完成旧聊天 HTTP 的进程内调用和等待结果接口。`runOnce` 不再创建 `socket.io-client`，也不构造假 Socket。执行仍由原 `ChatRunSocket` 宿主组合原引擎；这不是统一协调器迁移或 SDK 接入完成。

- [x] controller 只映射输入输出；`services/chat-run/http.ts` 保留输入/显式模型身份校验、认证和分享约束，再调用内部 `DirectChatRunPort`。HTTP 与 Socket 复用 `startChatRun`。
- [x] `ChatRunCaller` 分离身份、会话观察、单独回复和其他客户端广播；旧引擎通过过渡适配支持真实 Socket 与直接调用者。HTTP 入口不经过 Socket 握手、虚构连接或 `runAndWait`。
- [x] `wait.ts` 保留完成 200、失败 500、待确认 409、超时 504、服务/认证错误 503，以及输出、推理和最多 1000 条事件的响应形状；工具事件使用原发送投影。等待服务将共享撤权作为 403 失败处理并清空已收集的私有内容；生产共享 HTTP 中间件仍保留撤权时主动断开连接的保护。
- [x] 排队输入携带进程内可信调用者，普通排队与展开命令均保留原身份；只有真正开始执行才监听原生运行事件，避免把前一轮完成当成本请求结果。队列消息序列化不包含调用者、身份或凭据。
- [x] 超时/待确认只释放观察者，已接收的执行继续；共享撤权移除该调用者尚未执行的输入，延迟派发再次检查权限。手机确认事件按会话和原设备转发；服务关闭与会话删除结束相关等待。

| 边界 | 当前行为 |
| --- | --- |
| 身份与资源 | 保留原回环握手的用户、profile、App 设备撤销及分享 owner 检查；分享输入仍由服务端会话派生配置；不读取 payload 中的调用者身份 |
| 排队与生命周期 | 观察只覆盖自身执行阶段；HTTP 观察者结束不清除已接受任务的身份。队列仍在内存，不提供持久化恢复 |
| 副作用与兼容 | 沿用原消息、Run、usage、推送与 webhook 写入者；Web/App 的 Socket 事件和 HTTP 请求/响应字段无需迁移 |
| 暂存边界 | 旧宿主仍负责引擎组合和广播；`ChatRunCallerTarget` 是内部过渡类型，不能作为插件 SDK 参数 |

Node 24.22.1 下验证：

- 专项 10 个文件、217 项通过，覆盖三类运行的调用边界、并行 Web 观察者、原生队列归属、超时、撤权、设备隔离、服务关闭和原 HTTP 响应契约；随后补充原生 compact 和真实分享 HTTP 撤权清理验证。
- 最终全量 coverage：888 个文件通过、12 个跳过；9,036 项通过、32 项跳过（267.36 秒，`--maxWorkers=2 --testTimeout=20000 --hookTimeout=20000`，未修改仓库默认时限）。首轮仅一项共享会话集成测试因旧回环 fixture 未注册运行宿主失败；已按生产 bootstrap 注册直调宿主，相关专项 51 项通过后完成上述全量复验。
- 生产构建、harness 与差异检查通过。
- 浏览器全量 `npm run test:e2e -- --workers=4 --reporter=line`：1,024 项首轮全部通过（18.3 分钟）。本次按 coverage、生产构建、harness、浏览器矩阵顺序执行；未修改客户端实现或测试配置。

下一步把旧聊天启动接入**宿主签发的统一上下文**：约束绑定会话/profile/owner、输入快照、取消与结果句柄，并完成真实 worker RPC 的权限和生命周期测试。现有 `ctx.runs.start` 仍只接受独立 Agent 实例。旧 `runAndWait` 仍供工作流/群聊内部编排使用，不能把其假 Socket 暴露为公共 SDK 实现。随后推进工作流执行用例；多轮/父子 Run 租约、hook、usage、checkpoint 和可靠事件仍按 T04/T06 处理。

## T02 进展：直调入口的宿主作用域与输入快照

本增量是旧聊天统一上下文的前置接入，**没有新增 SDK/RPC 聊天方法**，没有把内部 DTO 或调用者端口暴露给插件。

- [x] 直调宿主通过 `createChatRunInvocation` 创建或收窄 `ExecutionScope`，固定主体、profile、会话与 trace。已提供上下文与认证用户、请求 profile 或绑定会话不一致时拒绝；已有 Run/workspace 绑定仍明确返回不支持，避免丢弃约束。
- [x] HTTP 在首次异步认证前复制嵌套输入和响应选项；直调宿主在微任务调度前再次复制请求、用户和设备。修改调用方原对象不会改变排队输入或执行身份。分享输入归一仍保留原来的超时和事件响应选项。
- [x] 宿主信号在首次准入授权前后检查；此时取消不会登记附件、绑定设备、入队或执行。准入授权通过后即进入旧服务可能产生副作用的阶段，调用作用域结束和观察者释放不撤销该工作；延迟派发仍执行原授权回调，分享撤权照常拒绝。
- [x] 排队调用者携带冻结的作用域，最终运行继续使用原主体和输入。该对象只留在进程内，不加入 Web/App 事件或队列序列化。

原 HTTP/分享授权与会话访问策略保持不变。此处主体绑定证明调用参数不能替换宿主身份，**不等于已经实现插件的 session owner 授权**。无登录模式保留内部 service 主体和原有运行归属；该主体不能作为插件权限来源。旧聊天仍使用原执行器、内存队列与结果等待端口，不具备统一协调器的持久化接收、幂等结果句柄或父子租约。

Node 24.22.1 下验证：

- 6 个专项文件、137 项通过，覆盖身份/输入快照、绑定冲突、准入取消、排队期间作用域结束、分享撤权及原 HTTP 契约。
- 最终 coverage：889 个文件通过、12 个跳过；9,051 项通过、32 项跳过，260.03 秒。命令为 `npm run test:coverage -- --maxWorkers=2`，保留默认 5 秒测试时限。此前按本机默认并发运行时，旧 STT 路由测试一项超时；最终按 CI runner 的并发规模全量复验通过，未改 STT 实现或测试。
- 生产构建、harness、规划文档链接与差异检查通过。
- 登录/认证界面、流式聊天、多标签会话和协议文本浏览器回归：5 个文件、32 项首轮全部通过（38.7 秒）；完整浏览器矩阵由本次推送后的 GitHub Playwright 检查继续验证。

该阶段后续的 SDK 旧聊天启动已在下节实现，包括公共输入/结果句柄、当前用户及 session owner 校验、已接收请求生命周期，以及真实 worker RPC 的权限和取消验收。工作流原引擎、完整运行协调器和厂商插件迁移继续保持未完成。

## T02 进展：旧聊天 SDK 接入

本增量开放 `ctx.chat.start/get/cancel`，由 `services/chat-run/plugin.ts` 调用 HTTP 已使用的 `DirectChatRunPort`。仍由旧引擎负责消息、usage 和业务通知；没有本机回连、假 Socket 或第二个聊天消息写入者。T02/T06 整体继续保持未完成。

- [x] 公共输入为 `{ sessionId, input: string, idempotencyKey }`。只接受已有、归属当前主体的直接聊天；Agent、模型、provider、workspace 和 reasoning 配置取自宿主存储。拒绝身份、凭据、配置覆盖、非文本输入和斜杠管理命令。
- [x] `chat.start`、`chat.read`、`chat.cancel` 各自须经过 manifest 声明、当前 profile grant 与宿主上下文授权。每次操作检查活动 user、profile 和 session owner；管理员不能跨 owner，导入历史的 gateway `user_id` 不冒充 Studio owner。会话绑定不得扩大，已有 Run/workspace 绑定返回不支持。
- [x] 请求在首次异步授权前复制。延迟准入与排队派发重新检查 user/profile/owner 和会话配置；配置变化拒绝派发。首次接收在宿主持久化回执，同 owner/profile 的同幂等键和输入只派发一次，不同输入返回 `REVISION_CONFLICT`。
- [x] `chat.get` 返回请求自身的状态、输出和推理快照，不暴露原始内部事件。每种文本最多保留 65,536 个字符并标记 `truncated`；完整历史仍由原聊天存储负责。启动重试和取消回执不含正文，不能绕过 `chat.read`。确认/澄清期间保持 `waiting_input`，不会将其误报为完成。
- [x] 接收前 scope 取消不派发；接收后插件回调结束或 worker 退出不撤销宿主请求。取消未派发/排队请求只针对该调用者；启动准备期间先记录取消，待实际运行开始后调用原停止端口。已完成请求不会误停下一轮；原生停止未同步标记 `interrupted`，不报告取消成功。
- [x] 回执保存在新增 `studio_plugin_chat_runs` 表；终态只写入一次。宿主重启将未结束回执标为 `interrupted`，不自动重放。关闭时释放观察者和排队引用。bootstrap 在直调端口就绪后恢复插件，允许 `plugin.ready` 回调调用聊天。

| 公共方法 | 能力 | 结果 |
| --- | --- | --- |
| `ctx.chat.start({ sessionId, input, idempotencyKey })` | `chat.start` | `ChatRunReceipt`，其 `id` 是宿主请求回执 ID，不是旧引擎 Run ID；不含输出正文 |
| `ctx.chat.get(id)` | `chat.read` | 当前状态、revision、输出、推理、截断标记和公共错误码 |
| `ctx.chat.cancel(id)` | `chat.cancel` | 不含正文的实际最新回执；尚未确认停止时为 `cancelling` |

范围限制：本项不创建会话、不认领无 owner 的导入历史、不支持附件或会话管理命令，也不接入工作流/群聊/全局任务。交互回复、多轮/父子租约、可靠事件、自动恢复与统一协调器继续由后续任务实现；持久化的是请求回执，旧执行队列仍在内存。真实 worker 测试使用独立临时插件包和真实子进程 RPC，执行端为确定性 fixture，不等于真实厂商 CLI 验收。

完整官方 Node 24.22.1 下验证：

- 真实 worker RPC 和 SDK 结果权限专项：2 个文件、49 项通过；涵盖声明/grant 撤销、幂等重取、回调结束后的结果生命周期和定向取消。直调准入、排队/取消竞态、HTTP/分享权限及原停止端口回归也纳入全量。
- 最终 `npm run test:coverage -- --maxWorkers=2`：890 个文件通过、12 个跳过；9,093 项通过、32 项跳过，262.57 秒。保留仓库默认测试时限。
- 认证、流式聊天、多标签会话与协议文本浏览器回归：5 个文件、32 项首轮全部通过（约 1.2 分钟）。完整浏览器/平台矩阵由本次推送后的 CI 验证，不将本地专项冒充全矩阵。
- 最终生产构建、harness、规划文档文件链接和 `git diff --check`：通过。

首轮全量因临时 npm 分发的 Node 可执行文件旁缺少 npm，导致既有 Node/npm 探测用例 4 项失败；换用完整官方发行包后，相关用例及启动/关闭专项 31 项全部通过。未改这些业务实现、原测试或时限；其后全量先通过 9,092 项，再补充正文权限回归并完成上述最终 9,093 项复验。

## T06 进展：实例运行生命周期

本增量扩展已有 Agent 实例协调器，尚未把旧聊天、工作流、群聊和全局任务切换到该写入链，T06/T11 仍未完成。

- 同实例输入串行排队，排队期间仍受 deadline 限制，派发前重新核对权限、实例 revision 与提供方快照。队列取消只移除对应 Run；同实例后续输入不会被误停。
- 声明 `persistentSession` 的 runtime 可跨成功轮次复用；单轮结束只关闭该轮上下文，runtime signal 保留。宿主持久化 lease 与 Run 绑定，空闲 60 秒释放；失败、取消和关闭释放 runtime。活动输入、排队和租约受配额约束。
- 增加 `waiting_input` 和 `finalizing`。输出排空、交互回复与未结束工具均进入完成屏障；结果返回后 5 秒内未收尾则中断。领取完成权后取消返回 `RUN_FINALIZING`。
- 规范交互先持久化，再由 HTTP 或 `ctx.runs.interactions/respond` 查询和响应。绑定 owner/profile/Run，校验选项与时效，响应幂等并只派发一次。响应回执不含 prompt/choices；`runs.respond` 不赋予正文读取权限。取消和恢复将未解决交互中断。
- `ctx.runs.cancel` 接入同一取消端口；HTTP/SDK 的 usage 查询返回按模型调用归并的记录。delta 累加、cumulative 替换、final 校正；相同 revision 不重复计数，冲突 revision 和变更模型 ID 拒绝并回滚对应输出。没有报告的用量保持未知，不宣称零消耗。
- checkpoint 与成功终态在同一事务保存；只有显式声明 resume 且提供方/配置快照完全匹配时，下一次创建 runtime 才传入恢复引用。启动恢复只把未终结 Run 标为 interrupted，关闭旧 lease，不重放输入。

新增接口：`GET /api/studio/agent-runs/:id/interactions`、`POST /api/studio/agent-runs/:id/respond`、`GET /api/studio/agent-runs/:id/usage`。SDK 新增 `runs.cancel/interactions/respond/usage`；取消、响应分别要求 `runs.cancel`、`runs.respond`，读取仍要求 `runs.read`，真实 worker 每次重新验证授权。

当前恢复不跨插件 generation 自动迁移 checkpoint，也不提供模型服务权威计费合并；这些与父子 Run、可靠事件和五入口统一仍须继续完成。独立 worker 的交互/多轮测试使用临时测试插件，不替代真实厂商 CLI 验收。

后续竞态检查补齐 runtime 退出屏障：同实例在旧 runtime 的创建/销毁未确认时继续占用租约，不因等待超时就创建第二个 runtime；迟到工厂结果只清理，不发送用户输入，确认退出后才允许重试。工厂创建完成后再次检查当前授权、实例 revision 和 provider。新增退出/迟到/撤权用例及原协调器、真实 worker 回归共 4 个文件、76 项通过；保留原创建取消的 5 秒返回边界，不增加仓库测试时限。

Node 24.22.1 下验证：

- 生命周期、真实 worker、上下文授权、HTTP/RPC 专项：7 个文件、87 项通过（最后补充的 2 项 HTTP 用例单独复测，所在文件 5 项全部通过）。
- 全量 coverage：890 个文件、9,108 项通过；12 个文件/32 项跳过；1 项既有 Electron 原生设备控件测试失败。失败发生于测试的崩溃 renderer 诊断，进程被既有 55 秒期限终止；同文件单独复测 1 项通过（15.9 秒）。没有修改该业务或测试，也不把这次全量称为首轮全绿。
- 生产构建、harness、规划文档文件链接和差异检查通过。全量浏览器回归正在运行。

## T02 进展：内部编排调用者端口

工作流、群聊和全局任务共用的 `runAndWait` 及内部中止入口已移除假 Socket，改用 `ChatRunCaller` 的身份、观察和消息投递端口。运行输入与用户身份在异步 readiness 前复制；宿主绑定 profile、session 和实际来源 surface。桥接/Ekko 的结果只通过直接调用者回调累计一次，原有推送、广播、审批和超时中止继续复用原服务。

专项 5 个文件、337 项通过，涵盖三类来源、输入/身份快照、唯一文本累计、审批、工作流调度、群聊及 MCP 凭据；服务端类型检查通过。已有测试中对假 Socket 字段的依赖已改成调用者端口断言，没有删除原行为检查。

后台通知续跑也已改用独立宿主调用者端口，绑定 job/profile/session，不再借用在线房间用户的 Socket/身份；排队后保留该端口。原引擎负责正常广播，端口只补送直接错误，避免重复输出。空房间/在线用户、忙碌队列/立即执行、Bridge/Ekko 回归共 4 个文件、208 项通过。普通 Socket 输入仍保留现有传输适配，内部编排尚未切到新实例协调器；五入口统一仍保持未完成。

## T02 进展：工作流共用启动服务与 SDK

HTTP `runNow` 与 `ctx.workflows.run` 共用图预检、模型/节点能力检查、权限复核及持久化接收服务。HTTP 保持原 202 响应；SDK 返回调度元数据回执，不含图、节点配置、输出正文、路径或原生错误。

- SDK 输入仅允许 `workflowId`、`idempotencyKey`、`input`、`startNodeIds`、`timeoutMs`；先复制输入，再等待授权。用户/profile 从宿主上下文获取；绑定会话、工作区或 Run 的上下文不能启动独立工作流。
- `workflows.run/read/cancel` 分别授权，worker 每次重新核验声明和当前 grant。读取/取消严格限定 Run 的原始 owner 和 profile，包括管理员；没有 owner 的旧记录不能被插件认领。
- owner/profile 下的幂等键与完整输入绑定；并发重复只创建一个原工作流 Run。请求绑定和 Run 在同一 SQLite 事务提交；绑定失败回滚 Run，不执行节点。相同键不同输入拒绝，历史 Run 删除后重试返回不可用，不重放输入。
- 每个异步预检之后及最后一次写入之前重新授权，并核对工作流定义快照；撤权、取消或定义改变不落库。接受后独立执行，插件回调结束不撤销已接受工作流。
- `get/cancel` 复用现有工作流记录与停止服务；`canceled` 表示原调度器已取消。原停止服务会记录原生中止失败，因此不能用该回执证明所有原生进程均已停止；完整取消屏障仍属 T06/T11。

验证：4 个文件、197 项通过，覆盖真实 worker 授权/撤权、SDK/HTTP 兼容、并发幂等、原调度器、末次授权、定义变更和数据库故障回滚；生产构建通过。该增量不增加第二个工作流输出写入者，也未把原引擎迁为新实例协调器；工作流的统一父子 Run、预算与实际用量仍需继续实现。

## T03 进展：服务依赖、RPC 与激活诊断

manifest 可声明 `contributes.services` 的版本和方法输入/输出 schema，以及 `requires.services` 的版本范围和可选标记。服务 ID 必须属于提供插件的命名空间并携带 major，例如 `acme.search/index@1`；不能覆盖核心服务。

- `ctx.services.provide(token, implementation)` 仅在激活时登记完整声明。Agent/服务先暂存并校验，再同步发布；缺方法、版本/schema 不符、冲突或初始化失败都会回收该代贡献。
- 宿主在导入代码前构建当前 profile 的依赖图，按提供者优先激活；缺失、禁用或不兼容的必需依赖阻止激活，循环依赖拒绝。可选依赖不会无限等待，`ctx.services.use(dependency).status()` 返回当前可用状态。
- `client.call(executionContext, method, input)` 必须使用宿主签发的存活上下文。RPC 不接受自报身份，保留原主体、profile、资源绑定和 trace。方法输入/输出均在宿主校验，单次调用有 5 秒边界，取消信号会传到提供方。
- 服务调用分别要求 `services.use:<id>`、`services.provide:<id>`。提供方通过转发上下文调用 Studio 领域 API 时，必须同时满足提供方和整条调用链的当前 grants；不能借服务 token 扩大权限。
- 必需消费者仍启用时拒绝卸载提供者；活动消费者存在时拒绝切换其提供者配置。提供者崩溃或主动撤销服务会撤下必需消费者，保留无关健康插件；可选消费者继续存在并观察 unavailable。
- 激活状态与配置分开持久化。诊断接口返回 `disabled/inactive/activating/ready/blocked/failed`、公共错误码、配置 revision 与租约状态，不返回原生错误、配置、路径或凭据。宿主退出后不将持久化的旧 ready 当作当前可用。

真实 worker、依赖图/schema、撤权/取消、崩溃级联、注册回滚、诊断 HTTP 与 RPC 专项：5 个文件、49 项通过；生产构建、harness、规划链接与差异检查通过。服务变更订阅见后续增量；完整诊断视图和共享进程/MCP/模型仍属于未完成范围。可靠消费者与初始 hooks 的后续进展见下节。本节不代表 T03–T05 整体完成。

## 本轮运行与工作流增量的完整回归

服务增量之前的完整 coverage 复验为 892 个文件、9,149 项通过，12 个文件/32 项跳过，573.48 秒；保留仓库默认时限。此前全量中失败的路由注册用例把整个应用导入耗时计入行为断言，现将导入移至 fixture 初始化，仍执行原路由及顺序断言；单文件 coverage 的 24 项通过。

浏览器首轮为 1,021 项通过、3 项失败，未记为全绿。空缓存复现定位到 XLSX worker 的 `read-excel-file/web-worker` 未被初始依赖扫描覆盖，运行中补打包导致页面重载并关闭同时打开的 DOCX；已加入 Vite 预构建，空缓存预览/侧栏专项 12 项通过。侧栏几何断言改为等待路由初始化后的稳定位置，保持原尺寸条件与默认时限。完整浏览器复验为 **1,024 项全部通过**，34.2 分钟。

服务增量 `816b28ac9` 的独立全量 coverage 为 890 个文件/9,159 项通过，3 项失败，12 个文件/32 项跳过。失败项是 Windows Pi 撤销测试超时、TTS 路由导入超时、Cursor 进程树心跳就绪超时；三个文件复验中 Windows/Cursor 通过，TTS 稳定复现。TTS 现将完整应用导入移到 fixture 初始化，保留实际注册断言和默认时限，23 项 coverage 通过。此处不将专项复验合并记作全量通过，后续增量继续执行完整回归。

包含服务、可靠消费者和 TTS 夹具修正的固定提交 `17959b5ac` 全量 coverage：**895 个文件、9,184 项全部通过**，12 个文件/32 项跳过，325.06 秒，保留默认测试时限。后续会话删除事务增量的专项结果另列，不混入该提交的全量证据。

会话删除事务及重放归属固定提交 `12b60ac7e` 的全量 coverage：**895 个文件、9,190 项全部通过**，12 个文件/32 项跳过，344.74 秒。Hook 增量在独立 worktree 开发，未混入该次全量。

## T04 进展：可靠消费者与管理

`ctx.events.consume(name, { types, start, resume }, handler)` 已通过真实 worker 接入。名称在 plugin/profile/owner 下唯一；激活阶段验证全部贡献后登记。`start` 明确选择 now/earliest，`resume` 明确选择 continue/from-now，类型变化必须显式重置。注销或卸载保留游标及死信；消费者代码应按 event.id 处理重复。

- 分发器轮询已提交的公共事件表，进程内通知丢失不影响补发；支持 SDK 已声明的核心类型（初始九类，后续增加服务上下线两类）。每次重放重新取得宿主上下文并检查当前 grants，拒绝的资源在调用插件前被过滤。
- 成功后才确认；处理租约和确认令牌持久化，旧租约的迟到确认/失败不会覆盖重投。每 partition 有序，其他 partition 可并发；系统时钟跳变不会回收本进程仍在处理的租约。
- 默认每次 30 秒、最多 5 次尝试、指数退避上限 30 秒；死信只阻塞所在 partition。正常注销取消不消耗尝试，worker 崩溃计入失败；回调超时撤销上下文并关闭 worker。
- 每消费者最多 10,000 条待处理记录、4 个并行 partition，分发器最多 64 个活动投递。批量扫描和诊断读取有上限；队列满时保持游标，不丢弃下一条匹配事件。
- 公共事件默认保留 7 天，分批清理；partition 序号独立持久化，不随事件删除归零。低于保留水位或待投递记录已过期时返回 `EVENT_CURSOR_EXPIRED`，不会悄悄跳过；管理端必须明确 reset-now。
- 管理 API 复用超级管理员/profile 鉴权，并再次限定 pluginId 与 consumerId；控制和死信重试携带 revision，诊断不含事件内容或租约令牌。

本增量只保证已进入公共事件表的可靠消费。Agent 实例终态已有同事务写入，会话删除随后在下节补齐；旧运行通知仍由提交后的内存通知投影，生产端崩溃窗口尚未消除，不能称为全入口可靠事件。完整事件族、hook、事件因果预算、宿主配置界面与压力验收仍未完成。

专项验证为 8 个文件、75 项通过，包含真实 worker 重投、撤权、激活失败保留游标、HTTP 范围和 revision、队列/分区/保留期故障；生产构建、服务端类型、harness 与差异检查通过。后续完整 coverage 单独记录，不将这些专项数量代替全量结果。

## T04 进展：会话删除事务事件与重放归属

本地会话删除现将 `session.deleted` 及其宿主归属元数据写入删除记录、消息和关联任务的同一 SQLite 事务。事件写入失败会回滚本地删除；事务提交后、通知发出前退出，可靠消费者仍可读取事件。原 App/Webhook 删除通知使用同一事件 ID，普通插件通知领取一次发布标记，不额外生成第二条公共事件。

归属存放在独立宿主表，不进入 EventEnvelope。新实例终态和旧运行投影也记录可验证的 owner；重放时检查当前用户/profile、捕获的归属及仍存在资源的当前归属。已删除资源必须有捕获的归属，未知归属的旧记录不因 payload 中的 actor 或相同 profile 获得权限。外部导入的 gateway user_id 不当作 Studio owner。App 删除通知在已有 studio_user_id 时优先使用它，避免把清理事件发给同数字的外部身份。

事件和关联归属/通知标记随保留期一起清理；分区序号迁移使用事务，并可从保留事件恢复缺失水位。原生删除仍是外部副作用，无法和 SQLite 原子提交；失败继续按原响应报告，本节不声称实现跨系统回滚。旧运行终态生产端、完整事件族和 hooks 尚未统一。

会话删除、原 controller/DB、App 订阅、事件/消费者、运行生命周期和工作流专项：9 个文件、359 项通过；最后的 App owner 优先级另验 3 个文件、36 项。生产构建、服务端类型与 harness 通过。

## T04 进展：只读 hook 与准入快照

`ctx.hooks.before(point, handler, { key, priority? })` 当前开放 `runs.start` 与 `sessions.remove`，要求对应 `hooks.before:<point>` grant。优先级降序，再按 pluginId/key 排序；输入深冻结并隔离复制，固定链在执行中不加入新贡献。每插件最多 32 个 hook、每 profile 128 个，活动回调和待准入请求各有 128 上限。

- 每次 2 秒、总链 5 秒。拒绝、非法补丁、取消、撤权、provider 退出或超时均在业务接受前失败；超时关闭 worker，已开始的 hook 随资源回收失效。
- HookContext 仅暴露查询。RPC 再次限制为只读能力；服务转发不能借机写入，普通插件贡献修改和事件发布也不能从 hook 的异步链发出。其他存活事件回调可在同一 worker 中正常发布已获准事件。
- runs.start 补丁只接受文本 content 和进一步收紧的 timeoutMs。原始请求决定幂等身份，实际输入与 hook 顺序/generation 随 Run 接受同事务保存；相同并发请求共用一次准入，已接受请求在 hook 或提供方移除后仍返回已有回执。
- hook 前检查原输入、实例归属和提供方；hook 后再次检查用户权限、取消、实例 revision 和提供方身份，再按同一核心规则校验实际输入。拒绝或快照写入失败不会创建 runtime 或留下 accepted 记录。
- 现有 HTTP/SDK 会话删除共用删除 hook，仅允许 continue/reject；hook 之后再查权限和目标是否变化，再开始原生/本地变更。未安装或已撤销 hook 时，原核心删除仍独立工作。

运行 hook 当前接入新 Agent 实例的 HTTP/SDK 准入；包括同一真实 worker 从事件回调发起 runs.start，再回调自身 hook 的闭环。旧聊天、群聊、工作流和全局任务仍使用原运行引擎，尚未接入这条 hook 链，完整统一入口由后续迁移负责。底层仓储清理不重复触发用户删除 hook；worker 仍是受信任本地代码，不能将 SDK 只读约束解释为 OS 沙箱。

初轮综合专项 10 个文件、250 项通过；后续并发上限与真实 worker 闭环补充后，hook 两文件 26 项通过。生产构建、SDK/runner/服务端类型与 harness 通过。提交 `9723d7c19` 的完整 coverage：897 个文件、9,218 项通过，12 个文件/32 项跳过；保留默认时限。

## T03–T04 进展：插件、Agent 与服务状态通知

激活成功后发布 `plugin.ready` 及实际注册的 `agent.available`、`service.available`；此时目录已可查询。禁用、卸载或贡献自行撤回时先撤销目录，再发布对应 unavailable。显式禁用和卸载发布 `plugin.disabled`；启用状态下重新配置、宿主退出不伪装成用户禁用，重复禁用/撤回不重复通知。

激活失败、worker 崩溃和必需依赖丢失发布脱敏 `plugin.failed`，失败插件的暂存业务事件不发布。服务撤回只阻断需要该项服务的消费者，并递归撤销其贡献；其他服务的消费者、可选依赖和无关插件继续运行。诊断状态先于通知更新，资源回收中的旧回调无法再取得能力。

服务事件 payload 为 `{ serviceId, version }`；profile 与提供方在 subject 中，订阅/可靠消费分别要求 `events.subscribe:<type>` / `events.consume:<type>`。可选依赖先查询 `status()`，再用状态事件刷新；重放是历史变化通知，当前可用性仍以 `status()` 为准。

这些通知进入现有持久事件表，采用原有权限、游标和重试规则。进程内目录变化与事件表不构成跨进程原子事务；宿主硬退出后的目录通过激活重建，不宣称完整生命周期事务恢复，也不代表 T03–T05 整体完成。

插件/Agent 综合专项：17 个文件、222 项通过；最后的卸载与宿主退出补充后，服务及 hook worker 两文件 22 项通过。生产构建、服务端类型、harness 与差异检查通过。

提交 `fe0625444` 的完整 coverage：897 个文件、9,221 项通过，12 个文件/32 项跳过；默认时限。

## T05 进展：runtime 受管管道进程

`AgentRuntimeContext` 增加宿主绑定的 owner 与 `processes.spawn({ command, args, cwd, env? })`。内置工厂和插件代理使用同一进程服务；插件另需声明并获授 `processes.spawn`。工厂的进程归 runtime 租约所有，可跨成功轮次复用，单次事件/HTTP 结束不改变其身份。

- `ProcessHandle` 提供 `read/write/end/stop/dispose`；进程对象和 PID 不是 RPC 操作凭据。宿主绑定的 runtime 句柄不能由 owner/profile 参数替换，其他用户或 runtime 的调用不能操作该进程。Hook 不可借已有句柄变更进程。
- 每次读取最多四段 16 KiB 字节，空批次不是 EOF；`exit` 确认进程退出，仍须读空剩余缓冲。管道在约 256 KiB 高水位暂停、低水位恢复；单次写入最多 64 KiB，同一进程只接受一个待完成写入和一个读者。主动终止后丢弃的迟到输出用 `truncated` 标识。
- 每个 runtime 最多保留 64 个句柄、宿主最多 128 个存活受管进程；结束后调用 dispose 释放句柄。停止、scope 结束、工厂失败、worker 故障和权限撤销后的操作都会回收相应资源；退出未确认时不释放租约，避免启动重叠进程。
- 父进程仅传入基础路径、Home、系统/临时目录和 locale；不自动继承应用认证、提供商密钥或 Node 注入选项。显式 env 是插件提交的普通字符串，不能取出平台秘密。Windows 环境按不区分大小写合并；`ELECTRON_RUN_AS_NODE=1` 固定。
- POSIX 使用独立进程组，先 TERM、再 KILL；Windows 显式等待 `taskkill /T /F` 与子进程关闭。无法确认进程树退出时返回错误。CLI shim 复用现有转义规则，多行 shim 参数拒绝并要求 stdin/提示文件。

当前只提供管道进程，不含 PTY/resize、秘密模板或受管 MCP/模型代理；标准 ACP 驱动接入见下节，旧厂商执行路径尚未迁移。插件是受信任本地代码，进程能力不提供 OS 沙箱或保证已自行脱离进程组的程序可被回收；Windows 原生父进程先退出后的孤儿追踪仍需后续平台验收。

新增真实管道/worker、跨用户、撤权、崩溃、工厂失败及退出屏障测试，并加入 Windows/macOS/Linux 的独立默认时限检查；不将本机结果代替尚未返回的 CI 平台结果。

综合回归 20 个文件、245 项通过；平台专项在本机 4 个文件、43 项通过，1 项仅 Windows 的 shim 检查跳过。生产构建、SDK/runner/服务端类型、harness 与差异检查通过。

提交 `57321726b` 完整 coverage：900 个文件、9,243 项通过，12 个文件/33 项跳过，默认时限。其 Windows/macOS/Linux native-processes CI 均通过，包括新增默认时限的进程、worker、退出屏障及 Windows shim 检查；该时点浏览器和 ARM64 仍在运行。

## T05 进展：ACP 驱动使用 SDK 进程句柄

独立 driver 包提供 `ManagedProcessTransport`，接受与 SDK `ProcessHandle` 结构兼容的最小字节端口。ACP 连接改为依赖通用 I/O；原有 ChildProcess 调用继续兼容，插件可通过受管句柄驱动同一协议实现，不导入 server 私有代码。

适配层串行发送最多 64 KiB 的写入分片，最多缓存 16 MiB / 128 个待写消息；end 等待已排队字节写完。stdout/stderr 分开投递，UTF-8 重组仍由 ACP 解析器负责；截断、写失败或提前关闭会拒绝待处理请求，不能解释成成功。退出后释放进程句柄；主动清理保留宿主确认退出的屏障。

验证覆盖大文本/图片、原生历史恢复过滤、模型与 reasoning 选择、分片字节、stdin 结束顺序、缓存上限和失败传播；真实插件 worker 打包加载独立驱动后，通过 SDK RPC 启动协议 fixture CLI，完成大文本输入、输出与退出闭环。这是公共进程/驱动契约验证，**不等于真实厂商 CLI 或任何一个 Coding Agent 已完成迁移**。

相关专项 4 个文件、35 项通过，包括等待进程启动期间撤销 grant 后回收新句柄的竞态。生产构建、harness、独立 driver 构建与 npm 工件解包加载通过；包只含独立驱动及类型，没有发布到 npm。

提交 `0826c31dd` 完整 coverage：901 个文件、9,251 项通过，12 个文件/33 项跳过，默认时限。三平台 native-processes、Build、全部浏览器分片与 ARM64 CI 均已通过。

## T05–T06 进展：SDK 受管模型调用

`ctx.models.list/stream/get` 使用与公开 Model API 相同的模型目录及提供商解析。`models.read` 授予目录和回执查询，`models.stream` 授予流式调用及其返回流。提供商凭据只在宿主内解析；插件不能指定 owner、profile、父 Run 或原始密钥。目录返回限定模型 ID、provider 与 callable 状态。

- `stream` 接收幂等键、限定模型 ID、完整 Responses 风格历史、可选工具/reasoning/温度/输出预算，返回 `id/events/cancel`。文本、reasoning、完成输出项和终态回执均是 JSON DTO；远端图片 URL、隐式历史 ID 和不支持的提供商模式继续按 Model API 规则拒绝。
- 回执按 owner/profile/幂等键持久化，输入哈希包含 session/父 Run 绑定。同键不同输入或绑定拒绝；活跃调用重试返回可重试冲突并可 `get` 查询；终态重试仅重放完整回执，不再请求提供商。宿主重启将未结束记录标成 interrupted，不自动重发可能已计费的请求。
- 全局用量以宿主模型调用 ID 去重，并关联会话和父 Run。父 Run 投影由宿主独占同一调用 ID，插件重复上报不会再次写入输出或聚合用量；缺失提供商 counters 时 SDK 回执和投影明确为 null。费用延迟补全沿用共享用量服务并更新回执 revision。
- 流终态在提供商迭代器的用量记录完成后才发出；用量写入失败不能报告成功。核心协调器和 worker 都等待活动模型请求收尾，才完成成功 Run；取消无法确认时保留运行租约隔离。回执与父 Run 投影同事务更新，全局用量保留原共享记录路径，不宣称跨系统事务。
- callback/run 句柄均由宿主签发；RPC 检查当前回调归属，不能从另一个回调或只读 hook 借用上下文。查询/读取前后及活动流期间重查权限。回调结束、提前退出迭代、worker 崩溃、撤权和 deadline 会取消所属请求。
- 每个宿主最多 64 个活动模型调用，每个 worker 最多 64 个流/待打开句柄；每流缓冲 32 个事件，流累计上限 2 MiB / 16,384 个事件，单输出项 256 KiB，持久输出 384 KiB。默认 120 秒，可显式选 100 ms–600 秒；RPC 每次读取最多等待 1 秒并保留同一个上游读取，不因轮询重发请求。取消等待最多 5 秒，超时不证明提供商已结束。

当前父 Run 绑定面向统一 Agent 实例记录；旧聊天原生 Run 的计量迁移、完整 usage 修正事件、共享 MCP/PTY、厂商插件、真实提供商/CLI 与容量基线仍未完成。取消回执保留已完成输出项；未完成项的逐字片段不作为可恢复历史。持久幂等回执暂不清理，以防旧键再次发出已计费请求。

模型、权限、真实 worker、回调归属、服务/消费者、现有 Model API 与进程回归 12 个文件、150 项通过；随后结算屏障、事务回滚、错误映射和未读终态清理专项 4 个文件、46 项通过。生产构建、服务端类型和 harness 已通过；最终完整 coverage 随提交继续执行。

提交 `17bd1d83d` 完整 coverage：904 个文件、9,279 项通过，12 个文件/33 项跳过，默认时限。

## T05 进展：公共 MCP 启动配置与凭据租约

Coding Agent 和 Ekko 的平台 MCP 启动配置改用 Studio 公共模块：统一本地 launcher、Node/Electron 模式、profile、Web UI 地址和静态 token 清空规则。厂商代码继续负责原生配置格式转换；Ekko 保留 native task-plan 模式，其他入口保留原交互配置。Hermes 长期配置自动注入的稳定路径/临时目录保护仍由原模块负责。

原 Ekko 每轮凭据逻辑迁至通用 `leaseStudioMcpServers`，由宿主明确传入 Agent 身份。凭据仍按执行 context 独立签发、取消撤销，不覆盖同 profile/session 的其他活动 context。携带 Run 凭据时重建完整本地传输，不沿用配置中自定义 command、URL、headers 或 env；保留受支持的并发及请求时限字段。外部 MCP 不取得该凭据；两种禁用标记均不签发凭据，Ekko 工具提供者也不连接禁用服务器。

真实 MCP 进程/HTTP 认证、并发凭据、过期撤销、定向启动、覆盖配置隔离、原 CLI 配置/恢复、Cursor、多模态及 HTTP MCP 专项：8 个文件、107 项通过；生产构建、服务端类型和 harness 通过。Hermes 自动注入的 24 项在主工作区通过；该测试的“稳定 launcher”fixture 在 `/tmp` 工作树触发临时目录保护，初次扩大回归有 19 项失败，因此后续完整回归在主工作区运行，没有放宽生产保护。

本增量移除重复平台启动配置和原聊天专用租约文件，尚未开放插件 MCP 代理/租约 SDK、绑定统一交互上下文或迁移全部厂商。MCP 连接的关闭屏障与 native 配置注入仍需继续完成。

提交 `d23604f54` 完整 coverage：904 个文件、9,284 项通过，12 个文件/33 项跳过，默认时限。

## T05 进展：MCP 客户端使用 SDK 进程句柄

独立 driver 包新增 `ManagedJsonRpcTransport`，通过公共受管字节端口实现按行 JSON 消息，不依赖 MCP 包或 server 私有代码。调用方传入协议验证器；官方 MCP Client 可直接使用该 transport，保留协商、工具发现、Unicode 文本和图片结果。

入站帧严格验证 UTF-8，分段拼接，默认上限 10 MiB（可配置 1 字节至 16 MiB）；截断、半帧退出和非法协议帧均失败。出站消息按 64 KiB 串行写入，队列最多 32 MiB / 128 帧，等待宿主确认写入。stdout 与 stderr 分离。close 等待实际进程 dispose，重复调用保留同一屏障及失败结果；客户端回调抛错不能阻断清理，ACP transport 同步修复了该边界。

官方客户端通过真实子进程及真实插件 worker 完成初始化、发现、较大 Unicode 调用和关闭后退出检查；专项 5 个文件、50 项通过。生产构建、独立 driver 构建及 harness 通过；npm 工件解包后与官方 MCP Client 类型检查和实际加载通过，未发布。MCP 检查加入三平台 native-processes 默认时限任务。该增量仅交付公共协议驱动，SDK MCP 代理、连接池及旧入口迁移仍待完成。

提交 `92ebcdbe5` 完整 coverage：905 个文件、9,299 项通过，12 个文件/33 项跳过，默认时限。

## T05 进展：公共 MCP 工具提供者的连接生命周期

Ekko 库公开 MCP 工具提供者及传输工厂接口，可注入公共受管进程 transport；自定义工厂只接收显式配置的 env，不继承宿主环境。默认 stdio/HTTP 调用继续兼容。工具对象绑定其连接作用域，其他作用域不能复用该对象调用；同一作用域的目录刷新串行执行，并固定请求配置快照。

`closeScope` 和 `dispose` 返回可等待的关闭屏障。取消期间迟到的工厂结果直接回收，不再启动握手；已有握手先关闭传输。配置变化须等待旧连接退出；失败保留原关闭错误，不再建立重叠连接。关闭全部作用域采用完整结算，某个连接失败不会提前放弃其他连接。可选 HTTP DELETE 最多等待一秒，随后关闭传输并中断剩余请求。客户端在握手失败时未等待的 close 通过宿主屏障记录，不产生遗漏的清理失败。

MCP/HTTP/图片、隔离、撤销、失败重试、配置替换与真实进程/原 Ekko runtime 专项：6 个文件、111 项通过。生产构建、服务端类型、Ekko 公开 API 文档与 harness 通过。该接口为 SDK 与内置运行接入提供完成屏障；原聊天终态顺序及整个连接池迁移仍未宣称完成。

提交 `28da79f3b` 完整 coverage：906 个文件、9,308 项通过，12 个文件/33 项跳过，默认时限。

## T05 进展：SDK runtime 的受管 MCP 工具

内置工厂和插件工厂均取得宿主提供的 `runtime.mcp.connect`。插件需 `mcp.connect` grant；stdio 通过已有受管进程/JSON 驱动，HTTP 使用同一公共 MCP 工具提供者。配置是调用方显式提供的 command/cwd/env 或 URL/headers，不自动读取或暴露 profile 秘密，也不借用旧聊天的交互 context。返回句柄提供工具发现、调用和可等待 dispose；连接可跟随 runtime 复用至后续成功轮次。

- RPC 句柄绑定 worker、generation、runtime、owner 和 profile；当前回调仍须通过来源检查。其他用户的工厂、只读 hook 和已结束的 scope 不能借用或读取迟到结果。宿主与 worker 每 250 ms 重查活动权限，空闲撤权也回收连接。
- 每 runtime 16 个连接、宿主 64 个；默认单请求，显式并行最多四个；工具最多 256 个、参数 128 KiB、结果 DTO 512 KiB、stdio 帧及 HTTP 响应流 1 MiB。HTTP 拒绝重定向，配置拒绝 URL 内嵌凭据及非法 header。
- 保留文本、图片、工具 schema 和 JSON 内容；返回模型工具名，不支持的原生命名沿用公共代理工具。工具调用失败不自动重放，通信失败明确提示远端副作用可能未知。
- SDK dispose、工厂失败、worker 崩溃、撤权及核心租约释放都等待连接和进行中请求结束；迟到连接清理失败会保留错误，不能在绑定被移除后被遗忘。全部资源并行结算，一个资源失败不提前跳过其他清理。

真实插件 worker 覆盖 SDK 工具调用、多轮连接复用、Unicode/图片、跨用户/只读 hook、无 grant、撤权和崩溃回收；宿主覆盖 HTTP 凭据、重定向/大小/并发/容量限制、取消和工厂失败后的排空。最初 worker 新用例把大正文误作幂等键，被既有 admission 上限拒绝；修正 fixture 以独立键提交正文后通过，没有放宽生产约束。

最终专项 6 个文件、71 项通过；此前宿主、服务和进程回归 6 个文件、63 项通过。生产构建、SDK/runner/服务端类型及 harness 通过。新增 `ekko-agent/mcp` 公共子入口供宿主只加载 MCP 模块；上述 MCP 服务和生命周期检查已加入三平台默认时限任务。

整合到 `feat/studio-plugin-context` 后，在完整 Node 24.22.1、隔离测试环境下复验：

- 6 个专项文件、71 项通过。
- `npm run test:coverage -- --maxWorkers=2`：908 个文件、9,315 项通过；12 个文件、33 项跳过，323.67 秒。保留仓库默认时限。
- 生产构建、Ekko 包构建、SDK/driver/runner 构建通过。
- 本地 npm 打包并解包后，`ekko-agent/mcp` 完成工具发现、Unicode 调用和可等待清理；外部调用方使用 SDK/MCP 公共类型的编译检查通过，未发布 npm 包。
- 独立目录的 `npm ci --ignore-scripts --no-audit --no-fund` 通过；本增量未修改依赖版本。

公共 MCP 工具能力已接入 SDK，但旧聊天终态、厂商 native 配置注入、统一交互凭据、MCP resources/prompts 及其他剩余迁移仍未完成，不据此关闭整体迁移目标。

MCP SDK 已以 `93cc9e9ff` 提交并推送至现有草稿 PR。随后在该提交的独立检出运行完整浏览器回归：935 项全部通过，9.8 分钟；该提交包含此前已独立提交的浏览器 harness 优化。另复测宿主、MCP、进程、服务和生命周期 6 个文件、84 项通过。

## T08 进展：Qwen 独立 ACP 运行增量

`plugins/qwen-code` 提供 `studio.agent-qwen` / `qwen` 独立实现，经公共 SDK 和 driver 打包到 `dist/plugins/qwen-code`，不导入 server 私有代码。构建只包含已有实现的包，不自动登记其余 13 个系统 ID。

- global 文本运行通过宿主进程句柄执行 `qwen --acp`，规范输出包含文本、推理、工具和审批；有界输出队列防止慢消费者无限积压。
- ACP 新增异步审批回调，校验原始选项和会话，取消/退出中止待确认请求并忽略迟到回复。旧调用未提供回调时维持原行为。
- 成功保存原生会话 checkpoint，后续轮次使用协商后的 load/resume，丢弃加载期历史重放。进程退出前不确认成功；非零退出、畸形协议和结果后不退出均失败并回收进程。
- 独立打包会产生不同的 SDK 类身份；RPC 现按有界公共错误字段识别 SDK 错误，不调用外部序列化器或 getter，避免合法错误被误记为 INTERNAL。执行失败与清理失败分离，单轮故障不误停整个插件。

该增量尚未交接 scoped provider 配置、原生登录/管理、宿主 MCP/Skills 注入、图片工件、用量对账或聊天选择器；也没有默认安装或删除旧 Qwen 实现。Codex 及其余厂商迁移、真实 CLI 完整验收仍未完成，T08/T09 继续保持未完成。

验证：Qwen 独立工件/真实 worker、错误边界与输出背压及原宿主回归共 4 文件、31 项通过；ACP 审批与原协议/受管进程回归 2 文件、30 项通过；插件类型检查、生产构建通过。worker 使用确定性 CLI fixture，不等于厂商真实模型调用验收。

最终全量 coverage：911 文件、9,334 项通过，12 文件/33 项跳过，273.46 秒；Node 24.22.1、两 worker、默认测试时限。harness 和差异检查通过。本机 Qwen Code 0.25.0 与 Codex 0.163.0 在隔离配置目录完成真实 initialize 握手；未使用这些握手结果声称登录、模型调用或完整真实 CLI 验收完成。

## T08 进展：Codex 独立 app-server 运行增量

`plugins/codex` 提供 `studio.agent-codex` / `codex` 工件，经公共 SDK、受管进程和有界双向 JSONL RPC 运行。生产构建现在也生成两个已有实现的插件包；原安装策略不变，未把预留 ID 自动登记为已迁移插件。

- 每个 runtime 初始化一次原生 app-server，成功轮次复用进程和 thread；租约释放后从持久化 checkpoint 恢复原 thread，不静默新建替代会话。
- 文本 delta 和最终 snapshot 使用相同消息 ID，工具完成去重。事件在 turn/start 响应前到达时有界暂存；严格按 thread/turn 过滤，其他会话及旧轮次输出不能混入当前 Run。
- 命令与文件审批走统一 interaction，用户只能选择公开且被原生允许的选项。取消发出 turn/interrupt，随后等待实际进程关闭；准入期间取消同样回收进程。畸形帧、异常退出和未结束工具不能提交成功 checkpoint。
- 原生 RPC 分开维护双向请求 ID、限制并发及帧大小，退出时中止所有等待；不自动重试可能已发生副作用的请求。

此增量当时仍缺 scoped provider 设置、原生配置/登录管理、图片、clarification/MCP elicitation、compact 和原生用量账本归并；后续 clarification 进展见下节。线程累计计数没有冒充逐模型调用用量。新聊天选择器、默认系统安装和旧 Codex 路径交接均未完成；本项不关闭 T08/T09。

验证：Codex/Qwen 真实 worker、原生 thread 恢复、审批、取消及 RPC 协议专项 3 文件、19 项通过；类型检查、生产构建及 harness 通过。两包已纳入三平台默认时限进程任务。本机 Codex 0.163.0 还经实际生产插件 bundle 与宿主管理进程完成 initialize/清理验证，未发起推理。

最终全量 coverage：913 文件、9,347 项通过，12 文件/33 项跳过，277.18 秒；Node 24.22.1、两 worker、默认测试时限。两个 npm 插件工件在仓库外解包验证，解包后的 Codex 工件通过同一实际 CLI 握手与清理检查；未发布 npm 包。生产构建、harness 和差异检查通过，当前完整浏览器证据仍为前述 `93cc9e9ff` 的 935 项通过。

随后补齐取消的实际退出屏障：原生 turn 已 interrupted 但进程仍在退出时，Run 保持 cancelling，直到受管进程确认退出。新增真实延迟退出测试与原 Codex/RPC 专项 2 文件、14 项通过，插件类型/构建与 harness 通过。第一次调整在已取消的单轮上下文内抢先触发清理，被原有作用域检查正确拒绝；最终复用取消处理器创建的退出屏障，未放宽宿主授权。前述全量数字对应此修复前的完整增量，此修复另有上述专项证据。

## T06/T08 进展：原生澄清与实例配置更新

- Codex `item/tool/requestUserInput` 按问题分别接入统一交互；保留选项描述，按原生约束允许选择或自由文本，整组回答按原始问题 ID 返回。秘密输入及畸形问题组在持久化前拒绝，尚未实现凭据专用交互。
- SDK 增加 `allowText`、选项 description、`interaction.withdrawn` 和撤回响应回执；旧澄清请求继续允许文本。宿主在发送前校验回答，原生撤回形成确定终态，重复/迟到响应不能覆盖它。完成、取消和请求尚未发布时的原生清理均有覆盖，不伪造默认回答。
- 原生 RPC 可撤回单个入站请求，抑制迟到回复，同时保留其他请求及连接。双向 ID 相同及原生复用请求 ID 不会误删新请求的中止句柄。
- 实例配置更新验证 owner/profile、schema、mode 和 revision。活动/排队 Run 阻止修改；空闲运行时须确认清理后再提交，期间拒绝新 Run，旧幂等请求仍可查询。异步清理后重新授权并检查提供方；撤权或清理失败保留配置。新 revision 不加载旧 checkpoint，旧 Run 历史仍可读。
- Qwen/Codex 的实际独立工件及真实 worker 验证配置切换，确认旧进程回收、新配置生效及历史保留。接口及交互约束已同步生成式 OpenAPI。

专项 6 文件、87 项通过；生产构建、插件类型检查和 harness 通过。前一阶段澄清增量全量回归 913 文件、9,359 项通过。包含实例配置更新及真实 worker 撤回回执的最终 coverage：914 文件、9,382 项通过，12 文件/33 项跳过，279.47 秒；Node 24.22.1、两 worker、默认时限。上一提交 `1cb4ba455` 的 CI 构建、runtime、三平台受管进程及完整浏览器分片均通过；本增量 CI 状态以 PR 为准。

增加 `npm run verify:plugins:native`：在临时 Home 与本地 Responses/Anthropic 模拟服务下，运行生产插件工件和宿主管理进程。可用 `STUDIO_CODEX_COMMAND` / `STUDIO_QWEN_COMMAND` 指定已安装 CLI 的路径，不自动安装 CLI、不读取既有 Home 或账号凭据。本机 Codex 0.163.0、Qwen Code 0.25.0 均完成两轮实际文本运行及同一原生会话续聊。该结果验证原生协议与输出，不覆盖真实提供商服务、登录、工具/图片/审批全矩阵。

两插件完整迁移仍缺 scoped provider、原生登录/管理、宿主 MCP/Skills 注入、图片、用量对账及聊天交接；Codex 另缺 MCP elicitation 与 compact。实例配置 API 不等同于厂商原生配置管理完成，七大交付块及 T08/T09 继续保持未完成。

## T06/T08 进展：统一原生管理检查

已增加公共 `AgentManagementAdapter.inspect` 和 `AgentInspection` DTO，Agent 目录公开检查能力；内置提供方直接实现，插件通过 worker RPC 使用同一契约。`POST /api/studio/agent-instances/:id/inspect` 仅根据宿主持有的自有实例配置启动检查，没有可覆盖的身份、profile、路径或 provider 参数。

- 检查与新 Run、实例配置修改互斥，活动/排队 Run 阻止检查；不创建 Studio Run、checkpoint 或原生聊天会话。
- 检查使用独立短期进程/MCP 作用域，重新检查当前 owner/profile、提供方 generation、配置 revision 和插件授权。16 个并发检查、25 秒期限、256 KiB 元数据及有界模型/认证方式列表。
- 请求断连、取消、撤权与应用关闭会中止检查并确认清理。忽略取消的 worker 被终止，直到清理完成才释放实例；不能确认退出时保留占用。修复了延迟关闭旧管理 worker 可能误伤下一轮运行的竞态。
- Codex 通过原生 `account/read`（不刷新令牌）和有界 `model/list` 分页返回账号状态及模型选择；原生 email、Home、配置、token 和未知扩展字段不进入结果。模型分页循环被拒绝并回收进程。
- Qwen 只执行 ACP v1 initialize，读取客户端名称/版本与认证方式。该握手不提供账号登录状态，明确返回 unknown；不为查询模型创建原生会话，模型发现明确返回 unsupported。

真实工件验收已扩展到检查接口：本机 Codex 0.163.0 返回无需 OpenAI 认证的本地 provider 状态及 8 个原生模型；Qwen Code 0.25.0 返回原生认证方式。两者随后均通过两轮本地模型 fixture 文本执行及同一原生会话续聊。使用临时 Home、伪凭据和本地模型服务，没有进行真实账号登录、真实供应商推理或全能力验收。

该增量不包含登录/退出、配置文件修改、CLI 安装升级、终端、Skills/MCP 原生管理或通用界面。scoped provider 模式仍需宿主模型网关与原生隔离配置接入；不能使用现有模型流接口宣称完整兼容原生工具协议。七大块与 T08/T09 继续保持未完成。

验证：最终管理/配置/原生插件/HTTP/worker/生命周期/ACP 专项 8 文件、138 项通过；全量 coverage 915 文件、9,414 项通过，12 文件/33 项跳过，563.45 秒（Node 24.22.1、两 worker、默认时限，同机同时执行浏览器回归）。生产构建、插件及服务端类型检查、生成式 OpenAPI、harness 和差异检查通过。

完整浏览器回归首轮 934 项通过、1 项失败（11.2 分钟，无自动重试）：既有 `unified-page-loading` 的 TTS 页在虚拟时钟推进后没有找到加载遮罩。保留首次失败诊断，原断言、默认时限和生产前端代码均未修改；仅该用例带 trace 单独复测 1 项通过（8.1 秒）。不将本次浏览器全量称为首轮全绿；前一提交 `c7ddd48e9` 的构建、runtime、全部浏览器分片与三平台进程 CI 均已通过，新提交仍由 PR CI 继续验证。

## T05/T06/T08 进展：Run 绑定原生模型网关与 scoped 配置

新增公共 `ctx.models.gateway({ model, protocol })`，由宿主监听 loopback 并签发逐 Run 临时凭据。Qwen/Codex 独立包已接入 scoped 模式，原生 Home/配置/历史放在宿主按 owner、profile、实例、提供方版本和配置 revision 划分的目录，不复用用户全局账号目录。

- 授权必须声明并获授 `models.gateway`。租约只接受已有 Run，不能从请求覆盖 owner/profile/session/Run；每次请求重新解析所选宿主模型，原生请求的 model 不能改变上游目标。提供方凭据与授权 fetch 留在宿主闭包，插件只获得短期 loopback token。
- 当前只开放 Responses→Responses 和 Anthropic Messages→Anthropic Messages 的同协议原生路径；完整保留 custom tool、推理签名/密文、工具历史和图片字段，不以通用文本接口裁剪原生请求。模型协议不匹配明确拒绝，尚无 Chat Completions 转换、原生 compact 或 WebSocket 路径。
- 每个 HTTP 调用分配宿主 modelCallId，固定父 Run 和计量所有权；成功帧须等待用量及 Run 投影提交，累计原生线程计数不伪装成逐调用账单。缺失 counters 保持 unknown，EOF/错误/记账失败不输出成功帧。记账或清理失败保留未确认状态并阻止成功完成。
- 受限额约束：64 个租约/在途请求、每租约 4 请求，16 MiB 输入、32 MiB 输出、1 MiB SSE 帧、120 秒请求期限、10 分钟租约期限。取消、请求断连、权限撤销、Run 收尾、worker/宿主退出撤销准入并回收在途工作；旧 token 不能重绑下一轮。
- Qwen 使用隔离的 Anthropic 配置；Codex scoped 每轮启动独立 app-server，再以原生 thread checkpoint 续聊，global 保留原进程复用。临时 token 仅进入受管子进程环境，原生配置文件不持久化 token。scoped 检查接口暂明确不支持，避免误读全局账号。
- stateDirectory 不是操作系统沙箱。CLI 原生登录/完整管理、跨协议网关、host MCP/Skills 注入、图片 artifact 接入、全局原生用量对账、旧目录回收/升级迁移与聊天 UI 仍未完成。T08/T09 及七大交付块继续保持未完成。

验证中：最终专项 6 文件、111 项通过，覆盖真实 worker 的 scoped 续聊、取消、启动阶段中止、目录隔离、网关授权/撤销和记账失败屏障。本机 Codex 0.163.0、Qwen Code 0.25.0 真实工件各完成 global/scoped 两轮，均保持同一原生会话；14 次本地 fixture 模型请求通过，scoped 逐调用宿主计量通过。未进行真实账号登录或真实供应商推理。纯 token 解析从记账服务抽出，保留原导出与语义，避免独立验收误加载服务器日志轮转定时器；该调整后用量/模型专项 6 文件、158 项通过，真实 CLI 验收进程正常退出。

完整 coverage 首轮 916 文件、9,444 项通过，既有 Windows Pi 撤销用例 1 项超时，12 文件/33 项跳过（780.94 秒，与浏览器回归并行）；原失败用例保持默认 5 秒时限，单独复测 1 项通过。完整 coverage 独立重跑全部通过：917 文件、9,445 项通过，12 文件/33 项跳过，305.08 秒（Node 24.22.1、两 worker、默认时限）。最后补充的“解析尚未完成时取消 RPC、仍等待宿主收尾”由网关/桥接 2 文件、25 项专项通过验证。最终完整生产构建、SDK/driver/runner/插件类型检查、生成式 OpenAPI、harness/API 文档和差异检查通过；最终插件工件的真实 CLI 验收再次通过并正常退出。

浏览器首轮 933 项通过、2 项失败（12.6 分钟，无自动重试）：既有动态 GIF 壁纸与 TTS 页面加载遮罩用例。保留首次失败诊断，前端代码、原断言和默认时限均未修改；这两个原用例带 trace 单独复测全部通过（11.6 秒）。不称为浏览器首轮全绿。上一提交 `40fc22e08` 的全部 CI 已通过；当前增量继续由 PR CI 验证。

## T05/T08 进展：Qwen/Codex 图片工件接入

本增量开放新 Agent 实例 API 的图片输入，旧聊天入口与 UI 尚未接管，不计为 Qwen/Codex 完整迁移。两包新增 `artifacts.read` 声明，已有启用配置须明确授予新能力。

- `POST /api/studio/agent-images` 接收原始字节，宿主识别并解码校验单帧 PNG/JPEG/WebP/GIF，限制单图 4 MiB、四千万像素；调用者不能提供路径、URL 或归属。图片及元数据存入 Studio SQLite，使用同一备份边界。
- owner/profile 隔离；每用户最多 256 张/64 MiB、宿主 4096 张/256 MiB，同时最多四个上传。每 Run 最多八图/6 MiB；接收和派发均校验引用及媒体类型。未使用的图片可由 owner 删除，已接受 Run 的附件保留用于历史；自动回收尚未实现。
- SDK `ctx.artifacts.read(id, offset)` 要求 `artifacts.read` grant、当前存活 Run 和有效输入中存在该图片。每次读取最多 192 KiB，RPC 返回前重查授权和取消；跨 owner/profile、非附件、已结束 Run、撤权和非法偏移均拒绝。公共 `readAgentImages` 校验分块身份、编码、连续性、数量和总大小。
- 两个独立包通过公共 SDK 读取图片，Qwen 发送 ACP 图片块，Codex 发送 data URL；Run/输出 DTO 不持久化 base64 正文。scoped 模式透传宿主解析的图片能力，未声明支持时在原生准入前拒绝；Qwen 原生配置同步该能力，避免限定模型 ID 的名称推断把图片替换成文字。global 模式依赖用户原生模型的视觉配置。
- 真实 worker 回归覆盖 global/scoped 图片、续聊、无视觉能力拒绝和读取期间撤权；首次边界检查发现跨插件目录导入，最终图片读取 helper 放在公共 SDK。首次真实 Qwen 验收发现模型未声明图片能力，修正宿主能力透传与原生配置后复验。

验证（独立工作树，Node 24.22.1，保持默认测试时限）：

- 最终图片/模型/worker 专项 8 个文件、143 项通过，包含按所选模型元数据而非协议判断视觉能力，以及分块编码、进度、取消和撤权检查；HTTP/协调器/准入/hook 等此前专项 9 文件、125 项通过。
- `npm run test:coverage -- --maxWorkers=2` 首轮：915 文件、9,455 项通过，14 文件/36 项跳过；2 项旧模型返回字段断言未包含新增 `images` 而失败，432.89 秒。更新契约断言后模型专项 2 文件/69 项通过，随后新增模型元数据与 SDK 分块用例也已包含在上述最终 143 项中；未把专项复测记为全量 coverage 首轮通过。
- 最终生产构建、SDK/driver/runner/插件类型检查、生成式 OpenAPI、harness/API 文档与差异检查通过。
- Codex 0.163.0、Qwen Code 0.24.7 的实际 CLI 在隔离目录分别完成 global/scoped 两轮，四种组合均保持原生会话，图片确实到达本地模型端，14 次本地请求及 scoped 计量检查通过。无真实账号登录或远程供应商推理。
- 完整浏览器回归 `npm run test:e2e -- --workers=2 --reporter=line` 首轮 935 项全部通过，19.7 分钟，无自动重试。原提交 `22556d531` 的全部 CI 已通过，本增量由推送后的 PR CI 继续验证。

本分支对最终同一生产源码的补充验证：

- 图片/SDK、worker、HTTP、模型网关/bridge 与模型 API 专项 7 文件、138 项通过；独立 SDK npm 工件导入与图片重组验证通过。生产构建、插件构建和 harness 均通过。
- 冻结源码后的全量 coverage：917 文件/9,461 项通过，1 文件/1 项失败，12 文件/33 项跳过（545.39 秒）；既有 Electron 原生设备切换测试的子进程触及 55 秒退出时限。原实现、断言和时限未改，该文件单独复测通过（18.85 秒）。本轮全量不记为全绿；此前开发中的一次全量因模型能力实现更新时仍加载旧模块而失败，亦不作为最终通过证据。
- 认证、聊天流、协议文本及多标签浏览器专项共 32 项通过；复核独立检出的前端、浏览器测试及相关配置共 640 个受版本控制文件，内容一致，复用上述 935 项完整回归证据。
- 本机 Codex 0.163.0、Qwen Code 0.25.0 各在 global/scoped 模式完成文本→图片两轮、同一原生会话续聊及 scoped 宿主计量，14 次本地模型请求通过。Qwen 原生配置投影到 `modelProviders.anthropic[].generationConfig.modalities.image`，避免未知自定义模型走文本回退；global 模式仍需原生配置声明图片支持。此验证使用临时 Home 和本地模型服务。

真实厂商账号与远程推理、聊天 UI、登录/安装、MCP/Skills 注入、跨协议和完整用量对账仍未验收。

## CI 修复：JEV harness 重复解析

`272794bb9` 的 GitHub Build 在 coverage 阶段失败：`jev-harness.test.ts` 的 runtime 注册用例超过默认 5 秒，生产构建尚未开始。检查器在一次扫描中重复解析相同源码、runtime 配置和语言文件；现按**单次检查**复用 AST 和 usage 分析，不跨检查缓存，因此源码/manifest 变更和缺失文件仍立即可见。

36 项 JEV 专项在默认时限下全部通过；本地同一 Node 下专项测试耗时从约 14.9 秒降到 6.4 秒，原失败用例约 0.6 秒。未跳过检查，未增加测试时限。`f38f2fcec` 的 [GitHub Build](https://github.com/EKKOLearnAI/ekko-studio/actions/runs/39999727673) 已通过：888 个文件、9,040 项测试通过，14 个文件/36 项跳过，随后生产构建通过；原超时用例在 CI 为约 1.2 秒。

## T05/T08 进展：复用旧网关的协议转换

旧 Coding Agent proxy 的 Responses、Anthropic、Chat Completions、图片及 SSE 转换代码已整体移到 `studio/services/models/protocol`，旧调用方经 `studio/public/model-protocol` 访问。适配器内容保持一致，原代理路由继续服务旧聊天；插件网关不调用旧 Run manager，也不增加一次到旧 HTTP proxy 的转发。

```text
旧聊天 CLI → 旧 proxy → 共享协议适配器 → 模型服务
插件 CLI   → Run 网关 → 同一份共享适配器 → 模型服务
```

- 新入口支持 Responses→Chat Completions、Responses→Anthropic Messages、Anthropic Messages→Chat Completions、Anthropic Messages→Responses；同协议继续原生直通。上游配置、认证 fetch、可信 model、重定向限制及请求取消由宿主管理。
- `ctx.models.gateway` 返回 `transport: native | translated`，桥接与 worker 保留该字段；同一 Run 内改变传输类型会拒绝请求。Codex 转换模式关闭厂商 web search，普通函数工具与命名空间使用稳定、不冲突的名字映射并在返回时恢复。
- 新入口在转换前观察上游原始 SSE/JSON，保留输入、输出、缓存读写和 reasoning 用量；不把旧适配器合成的零或 EOF 当作已测量用量或成功终态。帧/总输出限额、取消、撤权、错误脱敏和计量后交付成功帧的屏障继续生效。
- 转换路径仅承诺文本、图片与普通函数工具。厂商托管工具、custom grammar、严格 schema、强制工具选择、无法表达的内容块明确拒绝；厂商私有推理签名不承诺跨协议重放。Gemini 等其他协议、真实账号和厂商推理仍待逐项验收。
- 删除此前未提交的另一套 Responses/Anthropic 消息转换试验，保留共享适配器外必要的权限、用量、结束状态及工具身份检查。未将协议转换增量算作 Qwen/Codex 完整迁移，七大交付块继续保持未完成。

验证（Node 24.22.1，默认测试时限）：

- 最终新旧网关、插件 worker、模型 API、图片和协议专项：12 文件、338 项通过。新增覆盖四方向的 JSON/SSE、工具命名空间续轮、图片、缓存/推理计量、缺失用量、截断、错误、取消与撤权。
- 生产构建、SDK/driver/runner/插件类型检查、生成式 OpenAPI、harness 与 Ekko 公共 API 文档检查通过。
- 实际 Codex 0.163.0 / Qwen Code 0.25.0 CLI 在 global 原生、scoped 原生、scoped Chat Completions 与 scoped 另一原生协议下各完成两轮，文本→图片及原生会话保持通过，共 28 次本地模型请求；scoped 逐调用计量通过。修正测试图片检测遗漏 Chat Completions 的 `image_url`，并根据真实 Codex 解码失败补齐 Responses `total_tokens` 后复验；没有真实账号登录或远程推理。
- 认证、聊天流、协议文本及多标签浏览器专项 31 项通过（单 worker，无自动重试）；本轮没有修改前端。完整 coverage 首轮 919 文件、9,494 项通过，12 文件/33 项按既有条件跳过，315.42 秒；两 worker，未改变超时或断言。

## 已有验证证据

- 新内核、真实 worker、注册失败回滚、profile/owner 隔离、删除保护、运行协调、HTTP 和依赖边界有专项自动测试。
- ACP 原测试覆盖图片、Unicode/分片、MCP、恢复时去重、模型配置、权限、取消和协议失败。
- 完整应用构建已通过；新增 runner 输出在 `dist/server/plugin-runner.cjs`。
- 真实 CLI 和三种发布形式尚未验证；mock/fixture 结果不等于厂商实际兼容性签收。

基础实现提交 `8a5eda0be` 的验证记录（本次 T02 增量结果见上节）：

| 检查 | 结果与限制 |
| --- | --- |
| 插件、协调器及 ACP 专项 | 8 个测试文件、50 项通过；最后的 profile 通配符保护另重跑内核 9 项通过 |
| `npm run build` | 当前源码完整构建通过，包括 SDK/driver/runner 类型检查、前端及服务端产物 |
| `npm run build:plugins` | SDK 声明、独立驱动及 runner 构建通过 |
| 独立 SDK 工件 | 本地 npm 打包后在临时目录加载成功；未发布到 npm |
| `npm run harness:check` / `git diff --check` | 通过，包含新增私有导入边界检查；规划本地链接检查通过 |
| 全量 coverage 首轮 | 874 个文件通过、7 个失败、12 个跳过；8,892 项通过、20 项超时，另有一次测试 worker RPC 超时；该次 coverage 命令未通过 |
| 超时用例重跑 | 7 个失败文件重新运行；其中 3 个按默认时限通过，剩余 4 个在单进程、20 秒时限下全部 80 项通过。未修改仓库默认时限，也未将此结果冒充全量 coverage 一次通过 |
| 浏览器全量回归 | 首轮 984 项通过、9 项失败、28 项因串行组失败未执行；9 项失败单进程重跑全部通过；剩余位置补跑 29 项全部通过（包含一个已重跑用例） |

上述测试验证当前实现，不覆盖尚未迁移的完整新体系。A01–A34 不能整体标记完成。

## 本地开发与核验

```sh
npm run build:plugins
npx vitest run tests/server/studio-plugin-*.test.ts tests/server/studio-agent-coordinator.test.ts tests/server/native-acp-turn.test.ts
npx vitest run tests/server/studio-session-removal.test.ts tests/server/sessions-controller.test.ts tests/server/session-share-access.test.ts
npx vitest run tests/server/studio-agent-run-start.test.ts tests/server/studio-plugin-host.test.ts tests/server/studio-agent-coordinator.test.ts
npx vitest run tests/server/studio-plugin-chat-run.test.ts tests/server/studio-plugin-host.test.ts tests/server/chat-run-bridge-readiness.test.ts
npm run harness:check
```

从桌面运行环境启动测试时，按仓库 runbook 在子进程清除 `HERMES_*`、`EKKO_*`、`ELECTRON_*`、`AUTH_TOKEN` 和 `PORT`，避免测试继承真实用户状态。

独立开发示例见 [Echo 插件](../../plugins/example-echo/README.md)。worker 提供故障隔离和宿主能力检查，仍属于受信任的本地代码执行环境，不是操作系统沙箱。
