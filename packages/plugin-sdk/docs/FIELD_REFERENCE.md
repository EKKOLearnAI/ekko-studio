# SDK v1 字段与边界手册

本文与 STUDIO_CTX.md（能力）、STUDIO_RETURNS.md（回传流程）、HOST_API.md（业务参数）一起阅读。
类型由 sdk/src/index.ts 导出。`?` 表示可以不提供；可空必须明确写 `null`，不等于缺失。
公开 JSON 不允许 undefined；可选字段不用时省略，不写 `{ field: undefined }`。
本版本收紧错误回传的运行时校验：原先被丢弃/转换的非法 JSON、非法枚举、缺少必填字段和多余的
宿主协议字段会报错。正确遵循 SDK v1 类型的插件不需要修改协议版本；旧代码应修正后重新构建。

## 通用数据规则

| 项 | 类型与约束 | 含义/默认/失败 |
| --- | --- | --- |
| Json | null、boolean、有限 number、string、稠密数组、普通对象 | 对象键是字符串；禁止函数、symbol、BigInt、循环引用、Date、二进制、getter、稀疏数组；先检查再序列化，不做静默类型转换 |
| 大小 | 每次序列化最多 2,000,000 UTF-8 字节 | 包含 JSON 结构字符；超出抛出错误。存储还检查整个命名空间记录的总大小 |
| 嵌套 | 最多 32 层 | RPC、存储、Agent 回传和 SDK Schema 均有限制；拆分业务记录而非依赖无限嵌套 |
| 标识符 | 1–80 字符，`^[a-z][a-z0-9._-]{0,79}$` | 插件、Agent 局部 ID、工具、RPC、命令、动作、定时任务与视图使用；禁止 `..` 和 constructor/prototype/__proto__ |
| 时间戳 | Unix epoch 毫秒，number | `timestamp`、`deadlineAt`；不是秒，不是相对时长。宿主业务原始接口另有单位时见 HOST_API.md |
| Dispose | `() => void / Promise<void>` | 清理函数应可安全释放资源；通过 lifecycle 登记后宿主保证只调用登记句柄一次 |
| 错误 | 抛出 Error，异步接口 reject | 不用返回假成功；失败工具使用明确的 ToolResult。管理/普通调用最长 120 秒，Agent 单轮最长一小时并受父任务取消 |

## 六种上下文的字段

所有字段以当前上下文生命周期为界；不能保存句柄，在调用结束后继续使用。
字段在下表未标 `?` 时会存在，但所关联的服务仍可能因权限或环境不可用而 reject。

| 字段 | 类型/存在条件 | 来源、语义与约束 |
| --- | --- | --- |
| plugin | 只读 PluginManifest；PluginContext、ClientContext | 当前插件已校验清单，不是宿主全局插件目录 |
| identity | 只读 PluginIdentity；所有上下文 | 宿主绑定的真实调用者；启动/定时任务使用激活管理员，回调中动态绑定当前调用者 |
| identity.userId | number，必有 | Studio 账号 ID；不能用前端传入的任意账号 ID 替换 |
| identity.profile | string，必有 | 当前资源 Profile，宿主 API 固定绑定它，不允许切换 |
| identity.sessionId? | string | 与当前调用绑定的会话；独立页面/管理操作通常没有，不能假设总存在 |
| identity.runId? | string | 当前宿主运行 ID；AgentRunContext 必有，AgentSessionContext 不保证本轮 ID |
| identity.runtime? | string | 发起调用的运行时标识，例如 ekko-agent、hermes 或 Coding Agent ID；开放字符串，不是权限或稳定枚举 |
| identity.surface? | string | 入口来源，例如 ui、chat、group-chat、workflow、api、schedule、页面 slot 或业务事件 source；开放字符串，不能据此提权 |
| identity.workspace? | string | 当前会话已绑定的工作区；无会话/工作区时缺省。Agent 优先使用 paths.workspaceDir |
| identity.agentId | string；三个 Agent 上下文必有 | 完整 `plugin:<pluginId>/<agentId>`，不是局部注册 ID |
| config | 只读 JSON 对象；普通/前端/运行上下文 | 插件全局配置，按 configSchema 应用默认值；后端可见 secret，前端会删去 secret 字段；不能当成用户私有设置 |
| signal | AbortSignal，必有 | 所属生命周期的取消信号；取消后停止后续工作，已发送到外部系统的动作不保证回滚 |
| paths.dataDir | string；PluginContext | 绝对路径，插件私有稳定目录，重载/升级/卸载保留，不把数据写到安装版本目录 |
| paths.runtimeDir | string；AgentSession/Run | 此原生 Agent 会话的绝对运行目录，可保存原生会话文件 |
| paths.workspaceDir | string；AgentSession/Run | 实际会话工作区绝对路径；与 runtimeDir 含义不同 |
| host | HostApi；Plugin/Run/Client | 八个业务模块及受限 request，字段见 HOST_API.md；每次按真实身份授权 |
| extensions | PluginExtensions；PluginContext | 注册 agents/tools/commands/hooks/actions/rpc；具体注册字段见下文 |
| state | PluginState；Plugin/Run/Client | 显式存储作用域，下文说明隔离边界；AgentRun 一定有 agentSession |
| events | on(pattern, listener)；Plugin/Client | 业务观察；需要 events；精确名称、`*` 或 `.*` 前缀。不是修改原业务的钩子 |
| scheduler | every(id, intervalMs, action, input?)；Plugin | 需要 automation，apply 期间登记；intervalMs 是 1000–2147483647 毫秒的安全整数；input 默认 {}，action 必须已注册；同一任务不重叠，重启不补跑 |
| log | info/warn/error(message, data?)；Plugin/Agent | message 为字符串，截断到 4000 字符；data 是可选 JSON；最近 200 条日志，不能记录凭证 |
| lifecycle | add(dispose)、acquire(factory)；所有上下文 | acquire 返回 Promise<Dispose>，异步获取期间若取消会立即清理；与所属上下文一同结束 |
| permissions | readonly PluginPermission[]；Run | 实际 manifest 权限，不是运行环境支持项 |
| features | readonly string[]；Run | 环境支持项 api/events/tools/commands/automation，Ekko 可能再含四种 hook；不能代替权限判断 |
| session.get | `() => Promise<Json>`；Run | 当前 sessionId 的宿主快照；无绑定会话时 reject，需 api.read |
| workspace.read/write | read(path)、write(path,content)；Run | 只作用于当前会话工作区；path/content 是字符串，需要绑定会话和工作区及 api.read/write，仍执行宿主路径检查 |
| tools.call | (name,input) => Promise<ToolResult>；Run | name 是 `插件id/工具名`，input 是 JSON 对象，需要 tools 和目标工具的输入契约 |
| messages.notify/emit | Run | notify(message,level='info')；emit(type,data,{audience}?)，需要 ui，audience 默认 caller，可选 plugin 广播所有本插件账号/Profile 页面 |
| locale? | string；Client | 当前界面语言代码；切换语言重新挂载，不假定固定语言集合 |
| view / slot | string；Client | view 是清单视图 ID；slot 为 page/settings/workspace/agent-settings，动态侧栏为 workspace-sidebar |
| location.path/query | string / 字符串或字符串数组对象；Client | 当前宿主路由与查询；不构成授权身份，不包含登录 token |
| data | Json；Client | 视图调用方提供的页面数据，未提供为 null；没有隐含固定业务字段，插件需声明/校验自己依赖的结构 |
| rpc.call | (name,input?) => Promise<Json>；Client | name 是本插件 RPC 名，input 缺省变为 null；失败 reject，不自动重试 |
| messages.on | (type,listener) => Dispose；Client | 接收插件自定义消息；与 events 的 business 通道分开 |
| ui | Client | notify(message,level)、confirm(message)、prompt(message)、navigate(path)、selectModel(options?)；confirm 返回 boolean，prompt 返回 string 或取消时 null；navigate 是宿主路径 |
| mode? | scoped/global；AgentManagement | 只有宿主绑定管理模式时提供；不得假设存在 |
| progress | ({message,percent?}) => void；AgentManagement | message 为状态文本；percent 是可选进度提示，当前宿主仅记 message 日志，不保证显示百分比，不是完成回执 |
| mode | scoped/global；AgentSession/Run | 会话绑定模式，改变后按新实例隔离；不增加权限 |
| resumeState? | AgentCheckpoint；AgentSession | 声明 resume 时可能注入已有检查点；首次运行缺省，插件负责版本兼容与恢复 |
| deadlineAt | number；AgentRun | 本轮 Unix 毫秒截止时间，取消可能提前发生；不是剩余毫秒数 |
| output.emit | (AgentEvent) => Promise<void>；AgentRun | 标准事件流，Promise 提供背压；字段在 STUDIO_RETURNS.md，不自行伪造宿主终态 |
| mcpServers | 只读 `Record<name,Record<string,Json>>`；AgentRun | 本轮受管 MCP 的引擎适配配置；无服务为空对象。按条目实际提供的 command/args/env 或 URL/headers 映射到引擎；值是传输相关的开放 JSON，不保证每个条目有全部键。凭证本轮结束失效，不能写日志/前端/永久配置 |
| interactions | AgentRun | approve({operationId,title,details,input?})；clarify({question,choices?})；字段见下文 |
| attachments | AgentRun | resolve(assetId) 返回 assetId/name/mediaType/localPath/size（字节，number）；read 返回 Uint8Array；assetId 必须属于当前授权附件。文件/图片是必需输入能力，不能静默丢弃 |
| model | AgentRun | 根据 mode 区分的联合类型，见下文，不是原始上游凭证 |

### 存储与页面选择器

state.plugin 是整个插件共享；state.user 按账号；state.profile 按账号/Profile；state.session 再按会话，
无绑定会话时不提供。state.agentSession 仅 AgentRun 保证存在，按 Agent、账号、Profile、会话、模式分区。
每个存储有 namespace(...segments)、get(key)、set(key,value)、delete(key)、keys()。
namespace 是累计命名空间，最多 16 段，每段 1–256 字符；key 是 1–256 字符且不能是保留键。
get 不存在时返回 undefined（此本地返回不属于传输 JSON）；set 成功返回 void。读改写需自己串行化。
前端存储需 storage.client，它允许访问插件全部数据，不是账号级数据授权机制；私有数据应走 RPC。

ui.selectModel 的 options 仅有可选 current:{provider,model}，两项都是字符串。
选择后返回必填 profile/provider/model 三个字符串，及可选 apiMode；后者可为 chat_completions、
codex_responses、anthropic_messages、bedrock_converse、codex_app_server。取消为 null，错误 reject。
选择器不保存配置、不发模型请求，不回传 key 或供应商地址。

## Studio 读取的清单与注册数据

### plugin.json

| 字段 | 必填与类型 | 约束与默认 |
| --- | --- | --- |
| id/name/version/apiVersion | 必填 string/string/string/1 | id 遵循标识符规则；name 非空且最多 160 字符；version 是精确 x.y.z，可带预发布后缀，须与 package.json 一致 |
| server/client | 至少一项，string | 包内相对 .js/.mjs 成品路径，禁止绝对路径及 ..；server 导出 apply，client 导出 mount；安装不构建源码 |
| permissions | 必填字符串数组，可空 | api.read、api.write、tools、commands、events、hooks、automation、ui、storage.client、agents、browser.cdp；旧 capabilities 不接受 |
| description? | string | 非空，最多 4000 字符 |
| author? | {name:string,url?:string} | name 非空最多 200 字符，url 规则同下 |
| repository/homepage/documentation/issues/changelog? | string | HTTP(S) URL，无账号密码，最多 2048 字符 |
| license? | string | 非空最多 200 字符 |
| keywords? | string[] | 最多 20 项，每项非空最多 40 字符 |
| icon? | string | 包内相对 PNG/JPEG/WebP/GIF 或 base64 data URL；文件最大 256 KB，图标字段最多 350000 字符；不接受任意 SVG/越界路径 |
| configSchema? | Schema | 根必须 object；字段语义见 Schema 表；未声明时 config 是普通全局 JSON 对象 |
| dependencies? | Record<pluginId,version> | 其他 Studio 插件的精确版本，不是 npm 库；依赖必须先启用 |
| mcp? | {name:string} | 需 tools；名称 1–64 字符，字母开头，仅小写字母数字下划线连字符；默认共享 ekko-studio-plugins；独立名称不可占用宿主前缀或已安装名称 |
| views? | PluginView[] | 最多 50 项，无重复 id；每项 id/title/slot 必填，title 非空最多 160；slot 为 page/settings/workspace/agent-settings |
| views[].icon/order? | string / 安全整数 | workspace/agent-settings 必须有宿主命名 icon；其他允许合法图片；order 为 -10000…10000 |
| navigation? | {main?:Entry[],settings?:Entry[]} | 每组最多 50 项，省略不显示对应全局入口 |
| Entry.viewId/icon | 必填 string | 指向已声明且在本组不重复的视图；icon 不可省略，settings 只接受命名图标，main 还允许合法图片 |
| Entry.title/order? | string / 安全整数 | title 默认视图标题，非空最多 160；order 为 -10000…10000 |
| workspace? | {sidebar:string} | sidebar 是独立动态侧栏视图 ID，不得与 views 中的 ID 相同，且必须已有 workspace 页面 |

### Schema

type 必填，为 object/array/string/number/integer/boolean/null。title、description 是可选说明文本；
插件自己的 contracts/plugin.json 则强制每个结构和字段都有 description（两种检查不能混同）。
properties 是字段名到 Schema 的映射；required 是 properties 中字段名数组，省略等于不要求；
additionalProperties=false 拒绝额外字段，未设时允许。items 描述数组元素；enum 限定 JSON 候选值。
minimum/maximum 为含边界数值；minLength/maxLength 为 JavaScript 字符串长度；maxItems 限数组项数。
default 是缺省配置值，只有配置归一化会填入，不会自动替工具参数或业务契约填值。
secret=true 从前端配置移除；前端未提交该字段时保存旧密钥，显式空字符串是新值，不代表自动保留。
不支持 $ref/oneOf/anyOf/pattern 等未列关键字。宿主 Schema 根必须 object，最大深度 32。

### 注册定义

| 注册 | 必填数据与回调 | 可选字段/行为 |
| --- | --- | --- |
| tools | name、description、inputSchema、execute(input,run) | readOnly:boolean 默认 false；只有显式 true 才标为只读，返回 ToolResult |
| commands | name、description、execute(args,run) | args 为原始参数字符串，返回 JSON 或 void（宿主归一为 null） |
| actions | name、description、inputSchema、execute(input,run) | 需 automation；返回插件自定 JSON，供工作流消费 |
| rpc | register(name,handler(input,run)) | input 为 JSON，返回 JSON；输入/输出/存储业务结构写 contracts/plugin.json 并调用校验辅助函数 |
| hooks | name、handler(value,run) | priority 默认 0，有限 number，升序；四种 hook 见能力指南，返回 value?/deny?；deny 时拒绝，不能更换工具名称 |
| agents | AgentDefinition，见下表 | 需 agents，只能 apply 时注册；重复局部 ID 拒绝，返回完整 ID 与异步 dispose |

## Agent 字段字典

| 结构 | 字段与约束 |
| --- | --- |
| AgentDefinition | id（局部标识符）、name/vendor（非空，最多 160）、agentApiVersion:1、getStatus、management、modes、features、runtime 必填；description/icon 可选字符串 |
| management | settings/checkUpdate/upgrade/remove/supportsAutoUpdate 均可选；upgrade 要求 checkUpdate，supportsAutoUpdate 要求两者；无支持函数默认 false |
| modes | global/scoped 至少一个；global.listModels 必需；scoped.protocols 是非空数组，只能含 chat_completions/codex_responses/anthropic_messages |
| features | surfaces 非空数组，只能含 chat/group-chat/workflow/api；streaming/resume 为必填 boolean；图片文件不是开关 |
| runtime.createSession | 返回含 run、dispose 的实例；resume=true 时 checkpoint 必需；同实例串行运行 |
| AgentRunInput | input:AgentContent[] 本轮输入；history:AgentMessage[] 不含本轮；instructions:{kind,text}[]，kind=system/role/task/workspace；options 为引擎自定义 JSON 对象，当前宿主通常传 {} |
| AgentMessage | role=system/user/assistant/tool，content 为内容块数组；toolCallId? 是工具关联 ID，不是新运行 ID |
| AgentContent | text 分支必填 type:'text'/text:string；image/file 分支必填 type/assetId/name/mediaType 字符串且后三项非空。附件凭 assetId 经宿主授权，不传任意本地路径作为附件 |
| scoped model | provider/model/apiMode/baseUrl/token 必填字符串；apiMode 取 scoped.protocols 支持值；reasoningEffort? 字符串；contextWindow/outputLimit 为必填 number 或 null（未知），表示 token 容量；token 是短期宿主代理凭证 |
| global model | model?/reasoningEffort? 字符串，缺省使用插件原生默认；不注入 scoped 凭证 |
| approve 输入 | operationId/title/details 为必填字符串，input? 为 JSON；返回 outcome=approved/denied/cancelled/timeout，只有 approved 允许继续操作 |
| clarify 输入 | question 必填字符串，choices? 字符串数组；返回 answered+text，或 dismissed/cancelled/timeout，不以超时当默认答案 |
| AgentStatus | installed:boolean、version:string 必填；未安装可用空 version；source/path/error? 必须为字符串，表示安装来源、本地路径和诊断。缺省不是 null |
| AgentSettingsTarget | viewId:string 必填，本插件 agent-settings 视图；query? 为字符串键值对象，不得用作权限身份 |
| AgentUpdateInfo | currentVersion/latestVersion:string、updateAvailable:boolean 必填；message?:string；维护前宿主会重新检查版本，不自动接受过期结果 |
| 升级输入/输出 | 输入 version/expectedVersion:string 必填；输出 installedVersion:非空 string，message?:string；安装后的 getStatus.version 必须等于目标版本 |
| AgentModelCatalog | status/source/scope/models 必填；status=ready/empty/not_installed/auth_required/unsupported/timeout/error；source 是来源说明字符串；scope=available（可用目录）/configured（已配置）/builtin（引擎内置）；message?:string |
| AgentModel | id:非空 string、name:string 必填；provider/resolvedModel? 字符串，分别为提供商与解析后的模型 ID；isDefault/hidden? boolean；contextWindow/maxOutputTokens? 非负安全整数（token 数）；reasoningEfforts? 字符串数组 |
| AgentRunResult | content:AgentContent[]、finishReason:stop/length/tool_limit 必填；usage?/checkpoint? 可选；content 是完整最终回复，不仅是最后一段增量 |
| usage | inputTokens/outputTokens 必填，可为 null 或非负安全整数；cacheReadTokens? 同规则；costUsd? null 或非负有限数，单位美元；isEstimated:boolean 必填。未知数量用 null，不编造 0 |
| AgentCheckpoint | schemaVersion 必填正安全整数；data 必填 JSON（允许 null），不允许缺失；插件负责格式迁移。resume=false 时也可回传，但宿主不注入恢复状态 |

宿主拥有的上述返回对象拒绝未声明字段；开放业务 JSON（options、data、工具 result 等）则按其业务契约校验。
模型目录 ready 表示已取得可选目录，empty 表示目录为空，not_installed 表示原生引擎未安装，
auth_required 表示需要原生登录，unsupported 表示不支持目录查询，timeout/error 表示查询失败，message 用于可读原因。
流事件六种分支的必填字段见 STUDIO_RETURNS.md；每个事件在交付前校验，未知 type、非法 phase、缺失字段会 reject。

## 业务事件与实时会话

PluginEvent 必填 id/type/timestamp/identity/data；channel? 为 business/message，缺省按 business；
audience? 为 caller/plugin。data 是随事件类型变化的开放 JSON，不是所有事件都包含 content/delta/state。
业务观察的 data.subject 标识对象，data.delta 为文本增量，data.summary 为摘要，data.state 为运行快照；
订阅者必须按 type 判断和校验依赖字段，再通过 HOST_API.md 的历史接口补齐完整数据。
自定义 message 的 data 由插件自己的 events 契约定义；不能在 events.on 上等待 messages.emit 的消息。

SessionEvent 必填 event:string、session_id:string，其他字段沿用核心聊天协议。
message.delta 的 delta 为增量字符串；run.completed 的 output 为完整回复；run.failed 的 error 为错误信息；
resumed 是恢复快照，可能含运行/队列/历史状态，不能当作一个增量拼接。
transport.connected/disconnected/error/closed 是连接状态，reason/error（若有）是字符串；
控制方法 run/stop/resume/queue/interactions 的 Promise<void> 只确认分发，终态由事件确认。
queue.insert/cancel 接收已存在 queueId，不接收新消息；approve 接收 approvalId/choice，clarify 接收 clarifyId/response。
connect 的 sessionId 是 1–256 字符的已授权会话 ID，普通单聊用 sessions.connect，BOT 用 bots.connect。
close 仅释放订阅，stop 才停止运行；断线不缓存重放指令，恢复后按快照和历史重建页面。
