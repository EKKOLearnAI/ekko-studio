# 宿主业务输入与返回

本表对应 sdk/src/host.ts、bots.ts、sessions.ts、browser.ts。调用对象是 ctx.host 或 run.host。
`?` 为可省略，不表示允许 null；返回保留原始 HTTP JSON 包装，不自动取 data，不把成功分发当完成。
业务实体会增加字段，SDK 用 Json 保留它们；插件应校验自己消费的字段，忽略不依赖的扩展字段，
不要将通用 Json 类型误认为“无字段约束”。宿主权限、归属、资源版本和业务状态检查始终生效。
协议层固定字段见 FIELD_REFERENCE.md；此处按方法列出业务输入、主要结果及并发规则。

## 通用请求与授权

request(path,{method?,query?,body?}?)：path 必须是相对 `/api/` 路径；method 默认 GET，可为
GET/POST/PUT/PATCH/DELETE；query 为字符串键值对象，值仅 string/number/boolean/undefined，
undefined 不发送，其他值转字符串；body 为严格 JSON。禁止完整 URL、路径穿越、编码斜线或反斜线。
Profile 自动固定为 identity.profile；query/body 中提供不同 profile 会拒绝。
GET 需要 api.read，其余方法需要 api.write，包括以 POST 实现的查询。
browser 使用独立 browser.cdp；账号、密钥、插件管理、Agent 维护及原始浏览器代理不能借 request 绕过。
HTTP 非成功状态 reject，错误保留状态及 PLUGIN_API；不是返回成功形状的 `{error}`。
JSON 返回受 2,000,000 字节限制，不支持 SSE、任意二进制上传下载；分页后继续读取。

通用 id 必须使用宿主返回的 ID，不从标题拼接；idempotency_key 是每次新操作独立的非空字符串，
重试同一操作沿用原 key 与原输入，不同操作不能复用；BOT key 最多 200 字符。
expected_revision/expected_history_revision 必须来自刚读取的目标快照，为非负安全整数。
409 表示快照、状态或版本已变化，应重新读取并重新决定，不能自行递增 revision 后盲目重发。

## 模型与 Agent 目录

| 方法 | 输入 | 返回/约束 |
| --- | --- | --- |
| models.list() | 无 | `/api/ekko-studio/models/v1/models` 的模型目录；模型 ID 和展示名不是同一字段，不包含上游 key |
| models.respond(input) | Responses JSON 对象；至少 model 与 input，input 为文本或该模型支持的内容块；其他生成参数由宿主模型服务校验 | 非流式 Responses JSON：id/object/model/output/usage 等；SDK 强制 stream=false，不提供流式 iterator；完整会话流使用 sessions.connect |
| agents.list() | 无 | 宿主 Agent 目录，按账号/Profile 和权限过滤；记录含 id/name/vendor/origin/modes/surfaces/actions 等，插件 ID 为 plugin:... |
| agents.status(id) | Agent 完整 ID | 已安装状态及版本，插件 Agent 遵循 FIELD_REFERENCE.md 的 AgentStatus |
| agents.models(id,refresh=false) | Agent 完整 ID；refresh 可选 boolean | 原生模型目录 status/source/scope/models/message?，模型字段见 FIELD_REFERENCE.md；scoped 选择使用宿主目录 |
| agents.settings(id) | Agent 完整 ID | 宿主导航目标 name/params/query；只打开本插件声明的设置页，不返回配置密钥 |

SDK 不统一所有供应商的模型输出扩展字段；output 是内容数组，不能假定恒有顶层 text。
apiMode、reasoningEffort、上下文容量应使用目录返回值，不在插件中硬编码任意模型支持能力。

## 单聊 sessions

| 方法 | 输入 | 返回/约束 |
| --- | --- | --- |
| list(query?) | 可选 limit/offset 非负整数，search 字符串，category/source/pinned 等按业务过滤 | 会话列表 JSON，包含会话记录及分页信息；Profile 已固定。不要将所有历史一次性塞入 SDK 消息 |
| get(id) | 会话 ID | 会话详情，基本字段 id/title/profile/source/agent/agent_mode/model/provider/workspace；历史使用 messages |
| create(input={}) | title? 字符串最多 500；agent? 完整运行时 ID，默认 ekko-agent；mode? scoped/global | 空会话结果，尚未启动模型运行；使用结果中的会话 ID，随后连接或 run |
| run(id,input,options={}) | input 为字符串或 JSON 内容块数组；options 见下文 | 默认 wait=false，返回 accepted/queued 的 session_id、可用 run_id/queue_id；wait=true 返回终态结果 |
| stop(id) | 会话 ID | 现有停止结果；最终停止由运行事件/历史确认 |
| remove(id) | 会话 ID | 删除结果，仍执行会话归属与运行状态校验 |
| rename(id,title) | title 字符串 | 更新标题结果 |
| archive(id,archived=true) | archived boolean | 归档/取消归档结果 |
| setModel(id,model) | provider/model 字符串及可选 reasoning_effort、模型分组等宿主模型选择字段；不提供密钥 | 模型选择更新结果，仍校验 Profile 和模型可用性 |
| setWorkspace(id,workspace) | workspace 为宿主允许访问的目录字符串 | 绑定工作区结果，宿主执行路径及运行状态检查 |
| messages(id,query?) | limit/offset 分页；其他查询保留原会话历史语义 | session、messages、total、offset、limit、hasMore，并可能有 taskPlans/workspaceRunChanges 等扩展 |
| connect(id,listener) | listener 接收 SessionEvent | HostSession 实时句柄，方法及事件见 FIELD_REFERENCE.md；不是 HTTP 轮询 |

run 的 options 支持 wait:boolean（SDK 默认 false）、timeout_ms:1–1800000 毫秒（HTTP 等待默认 300000）、
include_events:boolean 默认 false，以及 agent_id/mode/provider/model/reasoning_effort/workspace/instructions 等
宿主运行选项。session_id/input 由位置参数固定，不能用 options 覆盖；profile 不可改变。
普通 RPC 120 秒生命周期可能先于 HTTP 等待超时，长期观察应使用页面或插件生命周期中的 connect。
完成结果常有 ok/status/session_id/run_id/output/reasoning/events；output 为完整回复，events 仅请求时返回。
会话记录 started_at/ended_at/last_active 及普通历史消息 timestamp 使用 Unix 秒；
工作流、BOT 任务/计划记录的 *_at 使用 Unix 毫秒；实时 SDK PluginEvent.timestamp 也使用毫秒。
BOT 协作对话 messages.timestamp 沿用普通会话的 Unix 秒，不能与计划 next_at 混用。

内容块是宿主运行输入格式，不等于 AgentContent：例如文本块 type/text，附件块需当前会话已授权的
上传资源引用；AgentContent 的 assetId 只在宿主提供的 Agent 输入与输出中使用。
SDK 不通过此 JSON 方法上传文件，也不接受拿任意本地文件路径冒充已授权附件。

## BOT bots

BOT 是账号拥有的角色及会话，不等于 Agent 引擎目录。以下所有 sessionId 必须是有权访问的 BOT 会话。

| 方法 | 输入 | 返回/约束 |
| --- | --- | --- |
| list(query?) | search? 最多 200 字符，offset? 非负整数 | sessions 列表及分页字段；每条含会话 ID、title、bot_type 等 |
| create(input) | title 必填，去空白后 1–100 字符，账号内按 Unicode NFKC 与大小写归一后唯一；bot_type? 默认 zhezhe；model? 见下文；reasoning_effort? 字符串；workspace? string/null；expected_revision? | 新 BOT 会话/配置结果。workspace 未给/null/空白时创建独立默认目录，非空须已有可访问绝对目录；失败不创建 BOT |
| get(sessionId) | BOT 会话 ID | 权威快照，字段见下文；revision 与 history_revision 用途不同 |
| configure(sessionId,input) | expected_revision 必填；其余为要修改的设置，见下文 | 更新后快照；SDK 填入 session_id；模型变更只影响该 BOT，账号共享设置另行生效 |
| clear(sessionId,expectedHistoryRevision) | 刚读取的 history_revision | 清空历史结果，执行忙碌/归属检查；不删除工作区文件 |
| remove(sessionId,expectedHistoryRevision) | 刚读取的 history_revision | 删除结果；不删除绑定工作区文件 |
| connect(sessionId,listener) | 同单聊连接 | 同 HostSession 通道，完整流式、排队、审批、澄清与恢复 |
| models.list/agents/execution() | 无 | 分别为交互模型、Agent 执行能力及执行模型目录；不返回模型密钥 |
| tasks.list(input={}) | session_id?/search?/offset?/limit?/status?/order?；status 为 open/completed/closed；offset 非负，search 最多 200 | `{tasks:[...]}`，不是整个 BOT 快照 |
| tasks.apply(input) | 带 action 的任务操作，字段表见下文 | 操作相关 task/execution 或任务结果；仍由 BOT 调度，不能伪造后台 worker 身份 |
| tasks.messages(taskId,query?) | execution_id? 选择执行历史 | 任务对话快照，含 task/pending/消息与当前队列可操作状态 |
| tasks.send(taskId,input) | input 为任务内容块；expected_revision、idempotency_key 必填；expected_execution_id? 为观察到的执行 ID/null | 追加任务输入的回执；完成看执行事件，不把回执当完成 |
| tasks.insert/remove(taskId,input) | queue_id、expected_execution_id、expected_revision、idempotency_key 必填 | 插队/移除已排队执行；返回 task/pending/protectedQueueId/canInsert/canRemove/insertion/insertionError 等；不对正在执行项做普通队列删除 |
| tasks.executions(taskId) | 任务 ID | `{executions:[...]}`，包含执行 ID、会话、state、时间等 |
| tasks.events(executionId,after=0) | 执行 ID，after 非负游标 | `{events:[...]}`，继续按返回事件 ID 获取，不是时间戳游标 |
| flows.list(input={}) | flow_id? 或 session_id?/offset? | `{flows:[...]}`；指定 flow_id 获取单个归属校验后的协作 |
| flows.apply(input) | action=create/stop/resume/complete，见下文 | 协作状态；complete 要求宿主绑定的阶段运行上下文，普通插件请求不能伪造它 |
| flows.messages(flowId,query?) | before_id? 历史消息游标 | flow/messages/has_more/next_before_id/history_key；可能含 taskPlans 等扩展 |
| schedules.apply(input) | action=create/update/pause/resume/cancel/delete，见下文 | 计划记录，删除返回 deleted/schedule_id；查询计划通过 BOT 快照中的 schedules |
| memory.forget(id,expectedRevision) | 记忆 ID、该记忆 revision | 遗忘指定记忆结果；新增/修订记忆通过 BOT 对话，不能用此方法任意写记忆 |
| interactions.answer(id,expectedRevision,answer) | 交互 ID、revision、1–4000 字符答案 | 交互处理结果；已经回答或过期时拒绝，不能用旧 revision 覆盖 |

### BOT 快照、配置和实体字段

get 返回 session（会话记录或 null）、settings、revision（账号设置版本）、busy、history_revision、can_clear、
inherits_global_model、reasoning_efforts、compression、contextTokens、tasks/schedules/memories/interactions，
以及可能的 flows/active_flows/active_flow_count/active_tasks 等扩展。数组为空不表示缺少权限。
memories 的主要字段为 id/content/revision；interactions 为 id/task_id/question/kind/choices_json/revision。

model 是 {profile,provider,model} 三个必填字符串，可含 apiMode。账号/Profile 仍需宿主授权；
configure 使用 use_global_default=true 恢复该 BOT 的全局模型继承，不能把 null 当作任意有效模型。

| 配置字段 | 规则 |
| --- | --- |
| expected_revision | 必填非负安全整数，读取 get.revision；不是 history_revision |
| model/reasoning_effort/use_global_default | 仅改变位置参数 sessionId 对应的 BOT；reasoning_effort 从目录选择，允许空字符串恢复缺省 |
| workspace | 字符串，为账号共享后台任务目录设置；空字符串恢复账号私有目录；要求相关任务/交付空闲，不等于重绑已存在 BOT 的独立会话工作区 |
| agents | 最多 20 个账号共享执行预设；每项 id/name/description/selection 必填；selection 为 runtime/mode/profile/provider/model 与可选 reasoningEffort 等，必须选实际可用目录 |
| timezone | 有效 IANA 时区字符串 |
| maxSteps | 2–30 整数，默认 12 |
| compressionThreshold | null 继承全局，或 0.05–0.95 的数值比例 |
| maxConcurrentTasks | 1–12 整数，默认 6，账号共享 |
| taskTimeoutMinutes | -1 关闭时限，或 1–35791 整数，默认 60；只影响后续执行，单位分钟 |

Task 主要字段：id/session_id/title/summary/status/revision/requirements_revision/workspace/completion_evidence，
以及 execution_id/execution_state/running/pending_count/acceptance_state 等执行快照。
status 为 open/completed/closed；执行 state 为 pending/queued/starting/stopping/running/waiting_person/
waiting_user/waiting_approval/finished/failed/interrupted；selection_json/requirements_json 是编码后的 JSON 字符串，
读取时先 JSON.parse 并校验，不把它们当作已经展开的对象。不要修改只读 owner/时间/执行状态来模拟完成。

### BOT 任务、协作、计划的条件字段

tasks.apply 的 idempotency_key 对每次操作必填；action=create 时 session_id/title（1–200）/goal（1–8000）
必填，agent_id? 指定账号已登记的执行预设 ID，由宿主解析 selection，start=false 可仅创建；已有任务操作须 task_id 与
expected_revision，stop 还须当前 execution_id。action 的 start/stop/update/adopt/advance/record_acceptance 等
各自受任务状态、阶段及验收流程约束；不适用的内部流程动作会被拒绝，不能借 SDK 绕过。
业务完成必须有真实 completion_evidence；关闭与完成不同，不用更改执行 state 冒充已交付。

| tasks.apply.action | 条件字段与行为 |
| --- | --- |
| create | session_id/title/goal 必填，agent_id?/start?；返回 task 与可能的 execution |
| adopt | task_id/expected_revision/session_id/goal 必填，agent_id?/start?；将已有目标接为后台任务 |
| update | task_id/expected_revision/goal 必填；重写需求前要求任务空闲，不能静默换执行配置 |
| start | task_id/expected_revision；按保存的配置启动执行，结果含 task/execution |
| stop | task_id/expected_revision/execution_id；发出持久停止意图，读取后续状态确认停止 |
| close/reopen | task_id/expected_revision；关闭保留历史，重新打开仍受阶段和运行约束 |
| configure_acceptance | task_id/expected_revision/acceptance；改动验收要求，原有版本快照失效；不允许与 legacy next_steps/return_expectation 混用 |
| verify | task_id/expected_revision；由 BOT 验收编排派发独立验证，必须已配置可用验证执行预设 |
| record_acceptance | task_id/expected_revision 与宿主验收决策字段；只允许实际 user-facing BOT 交互上下文，普通插件 HTTP 请求不能代替它 |
| advance | task_id/expected_revision、message?；只推进保存的后续步骤，禁止 session_id/goal/agent_id/start 覆盖原计划 |

所有已有任务操作均可用 expected_execution_id（字符串或 null）固定观察到的执行目标；与当前值不符拒绝。
workspace 由 BOT/任务设置决定，不能在任务操作中用任意目录覆盖。内部受管验收/阶段动作需要可信 origin，
插件不应猜测内部字段执行；使用 BOT 实时对话请求相应流程，由宿主绑定身份和来源。

flows.apply:create 使用 session_id（创建者）/title（最多 200）/goal（最多 8000）/stages/idempotency_key；
stages 为 1–13 项数组，JSON 文本最多 32000 字符；每项 session_id/goal（最多 8000）/
return_expectation（最多 4000）必填，group? 为 0–12 整数。使用 group 时每项都须提供，分组从 0 连续递增，
同组并行且不能重复同一角色；不允许单角色自交接。rounds? 默认为 1，为 0–1000 整数，0 持续到停止。
阶段中每个 session_id 都必须属于当前账号。stop/resume 使用 flow_id/expected_revision/idempotency_key，不能重写已有路由或创建者；
complete 只供正在执行的受管阶段回应，缺少宿主 origin 的普通调用会拒绝。
flow 返回 id/title/goal/state/revision/current_position/stages/error；state 为 active/failed/stopped/completed；
stages 中有 id/position/group_position/session_id/goal/state/result_message_id/tasks 等，不能只根据某个 worker 完成就推定整个协作完成。

schedules.apply 的 idempotency_key 必填。create 需 mode=assistant/worker、kind=once/cron、expression、
timezone；assistant 还需 session_id/title（最多 200）/goal（最多 8000），worker 需 task_id（目标必须 open）。
once 表达式为带 Z 或 ±HH:MM 的未来 ISO 时间；cron 使用合法宿主 cron；timezone 为 IANA，
misfire=skip/run_latest，默认 skip。update 需 schedule_id/expected_revision，重新提供 kind/expression/timezone，
不能改变既有目标；pause/resume/cancel/delete 需 schedule_id/expected_revision。
计划记录含 id/mode/task_id/session_id/title/goal/kind/expression/timezone/next_at/state/revision/misfire，
next_at 是 Unix 毫秒；state=active/paused/cancelled/exhausted，取消的计划不能直接恢复。

## 群聊 groupChats

| 方法 | 输入 | 返回/约束 |
| --- | --- | --- |
| list()/get(id) | 已授权房间 ID（get） | 房间列表/详情 JSON，包含房间与成员/Agent 信息；访问仍要求成员或管理权限 |
| create(input) | name/inviteCode 必填字符串；还需有效 summaryProfile/summaryProvider/summaryModel，summaryApiMode?、summaryEveryTurns?（1–1000）；workspace?；memberName/memberDescription? 字符串 | 创建房间结果，记录含 id/name/inviteCode/workspace/summary* 等；摘要模型目录必须有效，不能只凭 TS 最小交集认为其他业务字段无需检查 |
| update(id,input) | name?、summaryProfile/summaryProvider/summaryModel?、summaryApiMode?、summaryEveryTurns?，以及 agentHandoffEnabled/agentHandoffMaxDepth/agentHandoffUnlimited? | 更新房间设置结果，管理员权限仍生效；字段组合由宿主检查 |
| remove(id) | 房间 ID | 删除结果，仍执行运行和归属检查 |
| send(id,content,mentions?) | content 是文本或宿主群聊内容块数组；mentions 为成员/Agent 标识数据数组 | 发消息结果；@all、成员身份、Agent 调用沿用原群聊规则 |
| stop(id,agentName) | 目标 Agent 名称字符串 | 中断该目标结果，不是停止所有成员 |
| messages(id,query?) | before?/limit? 等宿主历史游标 | 消息列表及分页状态；消息含 id/roomId/senderName/role/content/timestamp 等，不是 AgentContent 数组 |
| agents.list(id) | 房间 ID | 房间 Agent 目录 |
| agents.add/update(id,agentId?,input) | agent/profile/name、agentMode? scoped/global、provider/model? 须成对、apiMode?/reasoningEffort?/description?/avatar?/agentPreset? | Agent 记录结果；id 是房间参与者 ID，agent 是运行时 ID，name 是展示/提及名，三者不能互换；保留名字 all 不可使用 |
| agents.remove(id,agentId) | 房间参与者 Agent ID | 移除结果，房间授权和活动运行检查保留 |

## 工作流 workflows

| 方法 | 输入 | 返回/约束 |
| --- | --- | --- |
| list()/get(id) | 工作流 ID（get） | workflows 列表/单个 workflow 结果；记录含 id/name/profile/workspace/nodes/edges/viewport/created_at/updated_at |
| create(input) | name 非空字符串；workspace? string/null；nodes?/edges? 数组；viewport? 对象 | `{workflow}`；空图允许创建，但带边无节点/非法图拒绝；Profile 固定当前身份 |
| update(id,input) | name?/workspace?/nodes?/edges?/viewport? | `{workflow}`；修改定义不修改已创建运行快照 |
| remove(id) | 工作流 ID | 删除结果，权限和运行约束保留 |
| run(id,input?) | input 为可选字符串 | 运行启动结果；不是最终输出，随后查询 runs/getRun 或业务事件 |
| stop(id,runId) | 工作流与运行 ID | 停止结果，运行必须属于该工作流 |
| runs(id)/getRun(id,runId) | 工作流/运行 ID | `{runs}` / `{run}`；run 含 id/workflow_id/status/snapshot_nodes/snapshot_edges/start_node_ids/started_at/finished_at/error，可能含 node_sessions/edge_evaluations 等执行证据 |
| schedules.list(id) | 工作流 ID | `{schedules}` |
| schedules.create(id,input) | schedule 必填宿主 cron；timezone? 默认 UTC；enabled? 默认 true；input? string/null；start_node_ids? string[] 默认 []；timeout_ms? 1000–86400000 毫秒整数 | `{schedule}`，绑定工作流固定 Profile 与创建者 |
| schedules.update(id,scheduleId,input) | 同上字段的部分更新 | `{schedule}`，未提供字段保留，目标工作流不可改变 |
| schedules.remove(id,scheduleId) | 两个宿主 ID | 删除结果 |

viewport 是画布坐标 {x:number,y:number,zoom:number}。nodes/edges 是宿主图定义，不是任意字符串：
节点使用宿主支持的 type、唯一 id、position 与 data；data 中的 Agent/模型/工作区和插件 action 配置
受对应节点业务规则约束；边使用 id/source/target（及条件/路由等数据）引用现有节点。
运行状态为 queued/running/completed/failed/canceled；节点还有 blocked/approval_rejected 等状态。
图编译/依赖/权限失败会拒绝执行，不把已保存图当作可运行证明；节点详细扩展属于工作流协议而非 SDK 固定字段。

## 文件与桌面浏览器

files.list(path='') 返回 {entries,path,absolutePath}；entries 是目录条目，绝对路径是否可见仍由宿主授权。
files.read(path) 返回 {content,path,size}，content 为 UTF-8 文本，size 为字节数；缺少路径、敏感文件、
越界或过大内容会失败。不用 read 获取图片二进制，也不将 files 当作任意磁盘访问授权。

browser.tabs.list() 返回 {activeTabId:string|null,maxTabs:number,tabs:[{id,title,url,loading}]}；
create(url='about:blank') 返回新 Tab，close(tabId) 返回更新后的 tabs 快照。
cdp.attach(tabId) 返回 {cursor:number,sessions:[{sessionId,targetId}]}，这些是已知 iframe 会话。
cdp.send(tabId,method,params={},sessionId?) 返回该 CDP 方法的原始 JSON，不额外包 result；method 为
允许的 CDP 域方法，params 按该方法 Chromium CDP 定义，不是宿主 RPC 自定义字段。
cdp.events(tabId,cursor=0,limit=32) 返回 {cursor,oldestCursor,dropped,events}，limit 最大 64；
events 每条为 sequence/method/params，可能含 sessionId/truncated。游标过期 dropped=true；
单事件超 16000 字节时 params 为空且 truncated=true，按需重新读取页面状态。
cdp.release(tabId) 返回 {ok:boolean}，只释放自己的控制租约。
浏览器无授权共享 Desktop 或共享撤销时明确失败；不会另起浏览器 Profile，也不开放调试端口或 token。
