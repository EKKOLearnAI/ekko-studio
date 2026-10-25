# Studio 上下文与插件接口契约

日期：2026-10-24

状态：设计草案 v0.3，配套[架构总案](studio-plugin-architecture.md)与[实施计划](studio-plugin-execution.md)。类型片段用于约束完整接口形状；开发中的 SDK 实际能力见[实施记录](studio-plugin-progress.md)，尚未发布，未实现部分仍需在 T01、T02 等任务中补全。

## 1 身份与版本

| 标识 | 规则 |
| --- | --- |
| `PluginId` | publisher 命名空间，例如 `acme.research`；限制字符与长度，禁止路径分隔符 |
| `AgentTypeId` | 新类型为 `acme.research/assistant`；已有内置 ID 保留，别名仅由核心兼容表声明 |
| `AgentInstanceId` | 宿主生成，关联类型、owner、profile、配置 revision |
| `RuntimeSessionId` | 宿主生成的原生会话租约 ID；厂商 session/thread ID 存在恢复引用中 |
| `RunId` | 宿主生成，贯穿消息、交互、用量、产物和终态 |
| `Generation` | 插件激活的不可变版本标识，固定工件摘要和配置版本；内置 Agent 不使用此标识 |
| `ScopeId` | 宿主分配的调用/资源范围，不接受插件伪造 |

`AgentFamily` 保留产品归属含义，原有 Hermes/Ekko/Coding 值用于兼容和展示。执行路由使用 type ID 和已解析的工厂。新增 Agent 可以带 category 标签。提供方区分 `builtin | plugin`；只有插件另有 `origin: bundled | installed`，随包 Coding Agent 插件仍属于 plugin。运行协调器不按 family、origin 或厂商 ID 编写业务执行分支。

提供方引用由核心生成，不由调用者自报；Agent 目录、原生会话租约、Run 和交互使用同一判别联合：

```ts
type AgentProviderRef =
  | {
      kind: 'builtin'
      module: 'hermes' | 'ekko'
      implementationVersion: string
    }
  | {
      kind: 'plugin'
      pluginId: string
      version: string
      generation: string
    }
```

Run 冻结提供方引用与实例配置 revision。内置实现版本需能定位 Studio 构建及对应引擎版本；运行时探测另记录实际原生版本。内置实现不创建虚拟 plugin ID、manifest、安装记录或 generation。基础设施按提供方选择已注册工厂或 RPC 代理；执行、事件、用量和权限语义相同。

插件目录额外返回只读安装策略，独立于 Agent 执行契约：

```ts
type PluginInstallationPolicy =
  | { kind: 'system'; removable: false }
  | { kind: 'user'; removable: true }
```

现有 14 个 Coding Agent 作为系统插件随 Studio 默认安装，使用 `provider.kind = 'plugin'`、`origin = 'bundled'` 和 system 安装策略。第三方安装使用 user 策略，具体是否允许卸载还受当前权限、依赖与租约约束。系统身份由宿主受信任的分发清单决定，不能由插件 manifest 或请求字段自报；升级不改变该身份。Hermes/Ekko 为 builtin，不使用插件安装策略。

SDK、worker RPC、manifest、公共事件分别有 schema 版本。宿主启动前验证 SDK semver 范围与 RPC major；不兼容工件保持 installed/blocked 状态，不调用入口。DTO 使用 JSON 可序列化值，时间统一毫秒或明确的 ISO 字符串；大内容使用带权限的 artifact 引用。

## 2 上下文层次

### 2.1 应用服务与插件上下文

宿主内部持有 `StudioKernel`，由 bootstrap 注入数据库、认证、传输和领域服务实现。它不作为插件 API 导出。Hermes/Ekko 通过 bootstrap 获得所需的窄服务接口，运行时接收下述统一执行上下文；不需要创建 PluginContext 或经过插件 loader。共享 Agent 契约保持纯类型/schema，可由内置模块直接使用，也可由 SDK 导出给插件。

```ts
type Disposer = () => void | Promise<void>

interface PluginContext {
  readonly plugin: PluginIdentity
  readonly config: Readonly<JsonObject>
  readonly logger: PluginLogger
  readonly agents: AgentContributions
  readonly commands: CommandContributions
  readonly services: ServiceContributions
  readonly http: HttpContributions
  readonly scheduler: ScheduleContributions
  readonly storage: PluginStorage
  readonly secrets: PluginSecretReferences
  readonly events: EventContributions
  readonly hooks: HookContributions
  readonly lifecycle: PluginLifecycle

  on<K extends keyof StudioEventMap>(
    type: K,
    handler: EventHandler<K>,
    options?: SubscriptionOptions,
  ): Disposer
  once<K extends keyof StudioEventMap>(
    type: K,
    handler: EventHandler<K>,
    options?: SubscriptionOptions,
  ): Disposer
  emit(event: DeclaredPluginEvent): Promise<EventReceipt>
}
```

PluginContext 绑定全局插件及 generation，管理贡献和资源，不绑定 profile 或账号。它不具有“当前登录用户”。激活期不能通过 `ctx.sessions` 读取任意用户会话；业务服务通过宿主派发的 ExecutionContext 使用。

`register`、`on`、`provide`、路由和任务注册均返回幂等 Disposer，并自动进入当前插件资源栈。插件可以提前解除单项资源；宿主停用时逆序清理剩余资源。`lifecycle.onDispose(fn)` 用于补充清理，不能代替宿主对受管资源的登记。

### 2.2 执行上下文

```ts
interface ExecutionScope {
  readonly scopeId: string
  readonly principal: PrincipalSummary
  readonly profileId: string
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly runId?: string
  readonly surface: 'chat' | 'group-chat' | 'workflow' | 'global-agent' | 'api' | 'job' | 'event'
  readonly traceId: string
}

interface ExecutionContext extends StudioDomainServices {
  readonly scope: ExecutionScope
  readonly signal: AbortSignal
  readonly logger: ScopedLogger
}

interface AgentRunContext extends ExecutionContext {
  readonly scope: ExecutionScope & {
    readonly runId: string
    readonly runtimeSessionId: string
  }
}
```

`StudioDomainServices` 按总案能力表拆成独立接口。请求入口负责认证并调用内部 factory；插件不持有任意 `asUser`、修改 profile 或创建 root 上下文的接口。元数据只读，权限在每次领域服务调用时再校验，不能仅相信 TypeScript readonly 或插件发来的 scope 字段。

事件上下文权限由订阅授权、插件能力授予、资源可见性共同限定，不继承事件发起者的管理员身份。计划任务保存经过授权的 owner/服务身份和 profile，执行时重新检查权限。新身份无法访问历史资源时明确拒绝，不静默升级权限。

插件激活期的 storage 仅保存明确属于全局插件的公共配置或内部索引。用户私有业务数据通过执行上下文的 storage 访问，默认追加 owner 隔离。共享数据必须由服务契约明确声明可见范围，不能把“同一 profile”自动等同于“全部用户互相可读”。

跨 Run 的原生进程使用 AgentRuntimeContext：包含 runtime lease、提供方引用、已解析实例配置、受管进程与恢复存储，不持有某个已结束 HTTP 请求的 user、signal 或可变 profile。单轮 signal 取消本轮工作；runtime signal 结束原生会话。插件运行时另外受 plugin signal 约束；内置运行时由应用与所属模块的生命周期管理。

内置调用与插件调用使用相同领域服务、作用域和授权检查。插件额外受 manifest/授予范围约束，内置模块不需要插件授予记录，但不能因此绕过用户、profile、工作区和资源权限。核心目录、运行协调器和事件服务不依赖插件 worker 才能启动。

### 2.3 领域服务方法规范

方法接收业务 DTO 并返回 Promise/可管理的流，不接收 Koa Context、Socket、SQLite statement 或厂商 SDK 实例。流句柄由宿主管理关闭与取消。读方法与写方法分开，业务校验和访问检查属于领域服务，HTTP/Socket 只映射协议。

示例语义：

| 方法 | 必须包含的行为 |
| --- | --- |
| `sessions.remove(id, options)` | 授权、检查活动 Run、按删除策略取消/拒绝、原生清理、关联记录处理、提交事件 |
| `sessions.archive(id)` | 当前规则、revision、归档持久化和通知 |
| `runs.start(input)` | 能力/权限校验、hook、冻结配置、创建 Run、执行调度；返回句柄 |
| `workflows.run(id, input)` | 图校验、节点能力、预算、快照与统一 Run 调度 |
| `files.read(ref)` | 文件归属、真实路径校验、尺寸限制、远端文件提供者与取消 |
| `models.stream(input)` | 授权模型选择、凭据代理、流、用量归属和取消 |

当前 SDK 模型调用提供 `models.list()`、`models.stream(ModelStreamInput)` 和 `models.get(id)`。流返回 `ModelStreamHandle`，通过 `for await (const event of handle.events)` 读取，提前结束迭代或 `await handle.cancel()` 会等待宿主取消；完整回执含输出与可为 null 的用量。`idempotencyKey` 是必填项，终态重试只返回持久回执，活动重试返回冲突而不重复执行。宿主固定 owner/profile/session/Run 归属，插件请求不能覆盖。支持范围、权限、限额与尚未完成的旧入口迁移见[模型调用实施记录](studio-plugin-progress.md#t05t06-进展sdk-受管模型调用)。

当前 SDK 另提供 `ctx.models.gateway({ model, protocol })`，要求 `models.gateway` 授权与已有 Run 绑定。`protocol` 为 `responses`、`anthropic` 或 `chat-completions`。同协议保持原生直通；跨协议复用旧 Coding Agent proxy 提取的共享适配器，支持三种协议之间的六个转换方向。Chat Completions 使用 `/v1/chat/completions`，仅接受单一 choice；流的 finish_reason、迟到 usage 及 `[DONE]` 一起等待权威计量完成，缺少终止标记按失败处理。返回 `{ baseUrl, token, model, protocol, transport, images, dispose }`，其中 token 是本机网关临时凭据，上游密钥不离开宿主。每次 HTTP 请求重新解析模型配置；用户、profile、session、Run 归属均由宿主固定。请求中的 model 不能覆盖实际目标。

`transport` 为准入时的 `native` 或 `translated` 提示。CLI 侧协议保持不变，每次请求重新解析并授权所选宿主模型；同一 Run 内允许原生直通与转换互切，具体请求仍须满足目标协议的能力检查。转换路径支持文本、图片及普通函数工具；保留命名空间身份并按上游原始用量与结束状态计量，不以旧适配器补出的零或 EOF 作为权威结果。Responses 可按函数名和命名空间选择当前已声明函数，转换到 Chat/Anthropic 的对应字段；未声明或畸形选择在上游请求前拒绝。厂商托管工具、custom grammar、严格工具/schema 输出与其他强制工具选择不属于通用转换契约，明确拒绝；厂商私有推理签名不承诺跨协议重放。Codex 转换模式通过 thread/start 或 thread/resume 的临时 config 覆盖禁用原生 web search，不把该设置写入用户配置文件。其他模型协议仍明确拒绝，Gemini 等后续单独验收。

网关只监听 loopback，租约最长 10 分钟；每请求 120 秒，16 MiB 输入、32 MiB 输出、1 MiB SSE 帧；最多 64 个租约/请求、每租约 4 个请求。只支持前台完整历史请求，不支持服务端历史引用、后台任务、压缩端点和 WebSocket。HTTP 重试视为新模型调用，不承诺推理副作用幂等。原生成功帧在权威用量写入后交付；缺失计量保留 unknown。`dispose()` 撤销准入并等待请求和记账；Run 取消、worker 退出、授权撤销、超时和宿主关闭也自动回收。清理/记账不确定时不得当作成功屏障。

`AgentRuntimeContext.stateDirectory` 为可选宿主能力：配置宿主存储后，两种模式的运行、资源和管理操作均可获得按提供方版本、owner、profile、实例和状态 revision 隔离的持久辅助目录；只读检查不分配目录。global 模式仍使用插件选择的原生账号 Home，该目录不覆盖用户原生配置。默认状态 revision 等于配置 revision；符合插件 `resumeConfigKeys` 声明的更新保留原状态 revision，目录与原生资源无需复制。关联记录与配置更新在同一事务提交，沿用既有目录命名，不搬移旧文件。路径不可由执行参数覆盖，同一工件 worker 重启保持稳定。插件在其中管理自己的原生配置/历史；目录隔离不是操作系统沙箱。历史清理、跨模式和升级迁移仍未完成。

当前 T02 已落地 `ctx.sessions.remove(id)`，要求 `sessions.remove` 授权，并与现有 HTTP 单删/批删共用领域服务。返回本地 `deleted` 与独立的 `native` 清理结果；profile 与主体由宿主绑定，不接收调用参数。首个副作用前响应取消，开始变更后返回实际结果。上表的活动 Run 策略 options、hook 和可靠投递仍为目标契约，不能据此假定已实现；详见[实施记录](studio-plugin-progress.md#t02-进展会话删除共用领域服务)。

当前 `ctx.runs.start({ instanceId, input, idempotencyKey })` 与新 Agent 实例 HTTP 启动共用领域服务，返回持久化的 `AgentRunRecord` 回执；随后通过 `runs.get/output` 查询。`input` 沿用当前文本 `AgentRunInput`，不接受主体、profile、provider 或 scope 字段。插件必须声明并获授 `runs.start`，实例须属于当前主体及 profile。带 session/workspace/Run 绑定的 scope 暂返回 `CAPABILITY_UNSUPPORTED`，不通过清除绑定启动独立执行。

启动在授权等待前复制输入；接收前取消不产生 Run。接收后的独立 Run 由协调器管理，回调结束或请求断开不隐式取消它。相同 owner/profile、幂等键、实例和输入返回原记录，输入冲突返回 `REVISION_CONFLICT`；重试也重新授权。现有 HTTP 取消入口继续可用，实例 SDK 取消与声明能力后的多轮 runtime 复用已在后续 T06 增量实现；父子 Run、hook 和旧入口统一仍未实现；不能将当前回执等同于上表完整的可管理流句柄。详见[启动实施记录](studio-plugin-progress.md#t02-进展agent-实例启动共用领域服务)。

旧聊天现通过 `ctx.chat.start({ sessionId, input, idempotencyKey })` 接入；它不改变 `ctx.runs.start` 的实例请求形状。SDK 只接受已有自有直接聊天的文本输入，配置由宿主会话派生，不接受身份、profile、凭据、Agent/provider/workspace 覆盖或斜杠管理命令。要求分别声明并获授 `chat.start`、`chat.read`、`chat.cancel`；当前 user/profile/session owner 在启动、读取、取消和延迟派发时重新检查。管理员权限不绕过 owner；无明确 Studio owner 的导入会话拒绝执行。有 session 绑定时只能操作该会话，Run/workspace 绑定仍不支持。

启动返回 `ChatRunReceipt`，其 `id` 为持久化请求回执 ID；使用 `ctx.chat.get(id)` 获取包含状态及输出/推理快照的 `ChatRunRecord`，`ctx.chat.cancel(id)` 请求定向取消。状态包含 `accepted`、`queued`、`running`、`waiting_input`、`cancelling` 及四种终态；取消未确认时不报告 `cancelled`，原生停止未同步为 `interrupted`。启动重试和取消回执不含输出/推理，读取正文始终需要 `chat.read`。输出和推理各最多 65,536 字符，截断时 `truncated=true`。同 owner/profile 的幂等键与完整公共输入绑定；重复调用可取回原回执，不同输入拒绝。接收后回调或 worker 结束不撤销执行；宿主重启只标记中断，不重放输入。

HTTP 与 SDK 共用内部直调端口和旧执行器，SDK 不暴露 `ChatRunCallerTarget`，不产生第二套消息/usage/业务事件。新回执表不代表旧队列已持久化或 T06 统一协调已完成。新建会话、附件、管理命令、交互回复和其他运行入口仍在后续范围，详见[SDK 接入实施记录](studio-plugin-progress.md#t02-进展旧聊天-sdk-接入)。

当前 `ctx.workflows.run({ workflowId, idempotencyKey, input?, startNodeIds?, timeoutMs? })` 与 HTTP 共用启动服务，返回 `WorkflowRunReceipt`；`workflows.get/cancel(id)` 查询/取消原始 owner 的工作流 Run。三个方法分别要求 `workflows.run/read/cancel`。独立调用要求无 session/workspace/Run 绑定；用户和 profile 由宿主确定。输入快照、最后一刻授权、定义快照和 owner/profile 幂等绑定均在接收边界核验，请求绑定与原 Run 原子提交。回执只含身份、时间和原调度状态；取消回执不证明每个原生进程均已退出。当前仍使用原工作流引擎，不代表上表预算与统一 Run 调度已完成；见[工作流实施记录](studio-plugin-progress.md#t02-进展工作流共用启动服务与-sdk)。

写操作接受 `idempotencyKey` 或领域 revision；是否可重试由方法契约明确。RPC 断线不能触发无条件重试付款、消息发送、文件写入或启动 Run。会话删除等跨运行时操作采用可恢复操作记录，不声称远程清理和 SQLite 可以组成一个原子事务。

通用错误包含 `code`、安全 `message`、`retryable` 和可选 `details/operationId`。建议稳定错误码：`INVALID_ARGUMENT`、`FORBIDDEN`、`NOT_FOUND`、`REVISION_CONFLICT`、`CAPABILITY_UNSUPPORTED`、`PLUGIN_UNAVAILABLE`、`PLUGIN_VERSION_INCOMPATIBLE`、`SYSTEM_PLUGIN_PROTECTED`、`RUNTIME_UNAVAILABLE`、`CANCELLED`、`DEADLINE_EXCEEDED`。HTTP 状态码由传输适配，不向插件暴露内部堆栈和凭据。

### 2.4 当前实例生命周期接口

开发 SDK 已提供 `runs.cancel(id)`、`runs.interactions(id)`、`runs.respond(id, { interactionId, idempotencyKey, choiceId?, text? })` 和 `runs.usage(id)`。读取使用 `runs.read`，取消和响应分别使用 `runs.cancel`、`runs.respond`。响应仅返回 `{ id, runId, status }`，不携带交互正文；重试仍验证当前权限与 Run 范围。响应不确定失败时不会自动重放。

同实例输入当前串行运行；`persistentSession` 是显式能力，成功轮次才保留 runtime，空闲 60 秒后释放。运行输入 deadline 包含排队等待。checkpoint 只在成功终态事务中提交，并在完整提供方引用和配置 revision 匹配且支持 resume 时用于下一次创建；兼容配置更新可在事务中将成功 checkpoint 的配置关联推进到新 revision，原 Run 记录不变。不同插件工件 generation 不自动兼容；未完成输入不会自动重放。结果返回后的输出收尾期限为 5 秒，领取 `finalizing` 后拒绝取消并返回 `RUN_FINALIZING`。

现有 usage DTO 按 modelCallId、revision 去重，cumulative/final 替换，delta 累加，final 可由更高 final revision 校正。SDK 模型调用 ID 由宿主独占计量，runtime 回显不会重复计入；未知 counters 为 null。跨父子 Run 聚合及旧原生 Run 的权威计量迁移仍待完成。实例生命周期的实际证据见[实施记录](studio-plugin-progress.md#t06-进展实例运行生命周期)，不能据此宣称旧聊天及其他入口已统一。

## 3 Agent 注册与管理

### 3.1 类型与工厂注册

```ts
interface AgentContributions {
  register(definition: AgentTypeDefinition): Disposer
}

interface AgentTypeDefinition {
  id: string
  name: string
  description?: string
  configSchema: JsonSchema
  capabilities: DeclaredAgentCapabilities
  create(input: RuntimeCreateInput, ctx: AgentRuntimeContext): Promise<AgentRuntime>
  management?: AgentManagementAdapter
}

interface AgentRuntime {
  capabilities(): Promise<EffectiveAgentCapabilities>
  run(input: AgentRunInput, ctx: AgentRunContext): Promise<AgentRunHandle>
  checkpoint?(): Promise<OpaqueResumeReference>
  compact?(input: CompactInput, ctx: ExecutionContext): Promise<CompactResult>
  dispose(reason: RuntimeDisposeReason): Promise<void>
}

interface AgentRunHandle {
  events: AsyncIterable<AgentOutputEvent>
  result: Promise<AgentRunResult>
  cancel(reason: string): Promise<CancelReceipt>
  respond?(input: InteractionResponse): Promise<void>
  steer?(input: SteeringInput): Promise<SteeringReceipt>
}
```

`register` 验证 ID、manifest 声明、schema 和工厂接口。注册被暂存，激活成功时统一发布；重复 ID 和别名冲突失败。插件不能注册其他发布者或替换现有内置类型。清理只撤销本 generation 的贡献，不删除同名新版本的注册。

现有 Coding Agent 的历史 ID 由核心兼容表绑定到系统插件 ID，允许该插件保留既有类型；第三方不能占用这些保留 ID 或覆盖系统安装。停用/故障清理撤销可执行贡献时保留系统类型的静态目录项及不可用原因；Disposer 不能删除系统安装定义。

Hermes/Ekko 使用同一 `AgentTypeDefinition` 与 `AgentRuntime`，由 bootstrap 调用内部目录注册入口注入工厂，执行 schema、能力及 ID 冲突校验。该入口不要求 manifest，不暴露给插件，也不使用插件激活事务或 worker。插件启动失败不能阻止已初始化的内置类型发布；内置工厂随应用/模块关闭清理，不能通过插件卸载撤销。

`RuntimeCreateInput` 包含宿主确定的 Agent 实例快照、配置 revision、模式、工作区引用及可选恢复引用。实例配置可定义 system prompt、模型选择或原生 preset；原生配置是否支持以能力为准。一个插件可贡献多个类型，一个类型可有多个持久化实例。

当前实例配置更新使用 `PUT /api/studio/agent-instances/:id`，提交 `{ revision, config, mode }`。只允许当前 profile 的所有者修改；活动/排队运行返回冲突，不隐式取消。宿主在空闲租约回收期间阻止新执行，确认退出、重新授权并确认提供方不变后以 revision/CAS 写入。更新创建新的配置 revision，保留既有运行历史。插件可通过 `capabilities.resumeConfigKeys` 声明至多 32 个顶层 schema 字段，要求 `resume: true`、字段唯一且存在于根 schema properties。仅当模式不变且所有实际变化均在声明范围内，事务保留原生目录关联和成功 checkpoint；未声明、不兼容或模式变化仍从新原生会话开始。Qwen 声明 model/reasoningEffort/systemPrompt/mcpServers，Codex 另支持自身 effort/developerInstructions/approvalPolicy/sandbox；cwd、command、args、env 均不在声明中。活动运行、旧 revision、撤权、提供方变化或清理失败不提交配置和状态关联。该接口不替代厂商原生登录或配置文件管理。

`AgentRunInput` 包含内容块、已授权历史/上下文引用、模型选择、预算、超时和必要的来源信息。host 私有 token、数据库行和任意 sessionMap 均不进入参数。原生多轮会话使用 checkpoint 恢复；恢复失败应返回可判断错误，不能悄悄重放有副作用的工具调用。

### 3.2 能力协商

| 能力组 | 字段示例 | 缺失时 |
| --- | --- | --- |
| 输入与输出 | text、images、files、streaming、reasoning | 预检拒绝不支持的输入；单次文本结果仍可用 |
| 原生状态 | persistentSession、resume、contextUsage、compact | 禁用对应操作，明确恢复语义 |
| 交互 | approvals、clarifications、steering、queueInsertion | UI 不提供不存在的控制；不伪造批准或插入成功 |
| 模型与模式 | scoped/global、模型目录、reasoning 参数 | 保持现有模式和原生配置优先级 |
| 工具接入 | MCP、Skills、工具事件、后台任务 | 仅在有实现和配置的情况下启用 |
| 输入框命令 | 静态命令贡献、原生动态目录、参数提示、命令调用 | 未提供时不展示插件命令；加载失败与空目录分别呈现 |
| 管理 | detect、install、update、uninstall、login、config、terminal | 不支持时给出原因或明确手工操作方式 |

静态声明是最大支持集合，运行时探测形成当前实例的有效集合；插件不能通过探测扩大 manifest 授权。内置 Agent 同样受静态声明、平台授权及实例范围约束。与 OS、CLI 版本或模型有关的结果包含 provenance 和 revision。用户不能在请求中自报 capabilities。

`AgentManagementAdapter` 提供状态探测、安装/更新操作、配置文档、登录流程、模型列表、Skills/MCP 管理等可选能力。操作返回统一 operation/interaction 句柄和 DTO；原生 CLI 密钥、Home、配置覆盖规则由对应内置模块或插件处理。Studio 的共享 Skills 只读约定、global/scoped 边界以及人工安装策略必须保留。这里的原生管理操作不等于 Studio 插件包管理；Hermes/Ekko 继续提供原有引擎管理能力，不显示插件安装或卸载操作。

当前已实现 `management.inspect(input, context): Promise<AgentInspection>`、资源位置、`management.setup(input, context): Promise<AgentSetup>` 、`management.prepareLogin(input, context)` 和 `management.prepareInstall(input, context)`。目录只公开各能力的 true 标志，不序列化函数。input 由宿主根据自有实例生成，包含 `instanceId/config/configRevision/mode`；context 使用独立短期资源作用域，没有当前聊天身份或领域服务。HTTP 检查入口为 `POST /api/studio/agent-instances/:id/inspect`，不接收配置、路径、owner 或 provider 覆盖。要求实例空闲；检查期间拒绝新运行及配置修改，不创建 Run、checkpoint 或原生聊天会话。

`POST /api/studio/agent-instances/:id/setup` 接受 `{ revision }`，返回宿主绑定的实例/revision/provider、`cli: { state: available|unavailable, version? }`、`installation: { command, args }` 与 `authentication: { kind: native|studio, command?, args?, input? }`。native 必须提供 command/args；studio 不允许附带原生登录字段。输出限 64 KiB，不接受 env、账号标识、凭据或任意附加字段；命令不能含控制字符。Qwen/Codex 仅执行有界版本检查并返回手工操作指引，不自动安装或登录，也不把可用 CLI 当作已认证。scoped 模式不读取全局账号；global 的认证状态另由 inspect 提供。此能力复用管理互斥、授权、25 秒期限与清理屏障。

手动安装的原生 CLI 可将 `installation` 声明为 `{ kind: 'manual', url }`，宿主只接受无用户名/密码的 HTTPS 文档 URL，管理页显示链接。此类型不提供命令、环境或自动安装；适配器不声明 `prepareInstall`，不会出现受管 npm 安装入口。`nativeAgentSetup` 的第二参数同时支持 npm 固定版本字符串和此文档对象。

检查结果仅允许原生名称/版本、认证状态及方法 ID/名称、模型 ID/名称/默认项/推理级别，并附宿主 provider/configRevision 快照。认证状态区分 `authenticated/required/not_required/unknown`；模型发现区分 `available/unsupported/authentication_required`，后两者必须返回空 items，不会把未知当成未登录或空目录。适配器不得借检查执行登录、刷新凭据、推理或改写配置。结果上限 256 KiB、512 个模型、32 个认证方法；宿主检查字段、重复 ID 和大小。并发上限 16，执行期限 25 秒；撤权、取消、断连和关闭均回收资源。取消后最多等待 5 秒确认回调与受管资源清理，不合作的 worker 会被终止；清理未确认时保留实例占用，不能启动下一轮。

Codex 使用 `account/read`（`refreshToken: false`）和有界分页 `model/list`，不返回账号标识、原生 Home 或秘密。Qwen 仅执行 ACP v1 initialize，投影客户端信息和认证方法；该握手不提供当前认证状态，无会话模型发现不支持。退出账号、自动升级和完整 MCP 管理仍未实现；显式受管安装见下文；配置文件和 Skills 的 Studio 编辑接入见下节，不将此检查接口计为完整原生管理迁移。

Copilot 1.0.91 先进行 ACP initialize，再用独立 headless SDK 的 JSON-RPC 2.0 / Content-Length 连接调用 `auth.getStatus`；只有明确已认证才调用 `models.list`。未登录返回 `authentication_required`，不创建原生会话、Run 或消息，账号标识和 SDK 私有字段被丢弃。共享 driver 支持有界 JSONL/Content-Length 帧，但不包含厂商方法分支。

原生登录由用户显式调用 `POST /api/studio/agent-instances/:id/login { revision, idempotencyKey }`。插件的 prepareLogin 只返回私有 `command/args/cwd/env`，不进入 HTTP 回执；宿主分配 PTY 并返回独立 `AgentManagementOperation`，不创建 Run、消息或计量。Qwen 使用交互 CLI，用户输入 `/auth`；Codex 使用 `login --device-auth`。两个插件拒绝 scoped 登录，继续使用 Studio 模型凭据。CLI 退出码为零只代表命令结束，账号认证另由 inspect 核实。

管理操作绑定原实例、revision、提供方 generation、owner/profile；当前交互登录的超级管理员才可启动或控制终端，运行内 MCP 凭据不能调用这些 HTTP 入口。登录持有实例互斥和插件外部租约，确认短期 prepareLogin RPC 完成后才获取外部租约，避免 worker 超时清理与管理操作循环等待。实例运行/配置及插件替换、卸载须等实际进程清理。worker 崩溃、撤权、宿主关闭或十分钟期限会终止 PTY；清理未确认不能报告取消成功或解除实例占用。

`GET /api/studio/agent-instances/:id/operations` 返回最近 32 条元数据；`GET /api/studio/agent-management-operations/:id` 查询原回执。同一幂等键返回原操作，重启后记为 interrupted，不重放登录或输入。`/output?after=N` 返回至多四个 16 KiB base64 字节块、游标、truncated/finished 和 nextInputSequence；输出仅在内存保留至多 256 KiB，结束后保留五分钟，最多 128 个缓冲。`POST /input { sequence, text }` 每帧至多 64 KiB，按序号及内容摘要抑制最近一帧的重复写入，未知写入只能原样重试；PTY 累计输入至多 1 MiB。输入及终端输出不进入 SQLite 或应用日志。`POST /resize { cols, rows }` 限制每维 2–1000；`POST /cancel` 等待清理后返回状态。前端按输出写入回调逐页消费、限制待发输入，关闭视图不隐式停止登录，可重新连接并恢复下一输入序号。

`POST /api/studio/agent-instances/:id/install { revision, idempotencyKey }` 显式安装插件声明的原生 CLI，权限与登录相同。`prepareInstall` 返回严格的 `AgentCliInstallPlan { kind: 'npm', packageName, version, bin, runner: 'node'|'binary', preferDedupe?: boolean, nativeHomeEnv?: string[] }`；只接受固定 semver、普通 npm 包名与 bin 名，不接受命令、标签、URL、环境值或目录覆盖。可选布尔值 `preferDedupe` 只控制 npm 的 `--prefer-dedupe`，满足原生扩展依赖单一 SDK 模块身份的要求；不开放任意 npm 参数。可选 `nativeHomeEnv` 最多声明八个不同的、大写且以 `_HOME`/`_DIR` 结尾的变量名，宿主将它们统一绑定到本次安装私有前缀内的目录；插件不能提供值，也不能覆盖 HOME、PATH、NODE_OPTIONS。npm 前缀、缓存、原生 postinstall 与版本探针均留在私有安装目录。插件还需 `processes.spawn` 授权。Qwen 固定 0.25.0，Codex 固定 0.163.0；两种实例模式均可安装。

宿主使用当前 Node/Electron Node helper 执行 npm JS 入口。每个 owner/profile/实例具有独立 prefix、npm 配置、缓存及临时 Home，从官方 registry 安装，不修改全局包或原生账号目录。安装期间实例与提供方被租约占用；失败或取消等待真实进程清理，再删除未选中的暂存目录。先校验包名、固定版本及包内入口，再执行有界 `--version` 探针；进程全部清理且授权仍有效后，原子切换私有指针。旧安装在切换前保持有效，未确认清理的暂存不删除。现阶段保留旧安装用于后续回滚，版本清理与跨提供方升级迁移另行验收。

`AgentRuntimeContext.nativeCli` 可为 `{ state: 'ready', command, args }` 或 `{ state: 'unavailable' }`，仅由宿主提供，经内部 RPC 进入插件。SDK 的 `nativeAgentLaunch` 让显式 `config.command` 优先；没有自定义命令时使用验证后的私有 CLI，并保留配置 args。首次未安装可沿用 PATH；已选安装损坏、平台/架构或提供方版本变化则要求修复，不静默回退到别的全局版本。重启、兼容配置和模式变化保留同一实例的程序安装；账号目录与运行 checkpoint 仍遵循各自原契约。

安装回执的 `action` 为 `install`，原登录回执迁移默认 `login`；同一幂等键不能跨两种操作复用。安装复用有界日志、查询、重连、停止与重启中断记录，输入和 resize 明确不支持。界面按已注册能力显示安装按钮，保留自定义命令优先的提示；日志完全消费后才可再次安装。CLI 安装与正常退出不代表账号已认证。

### 3.3 多个资源位置与固定页面

Coding Agent 插件通过 `management.locations(input, context)` 告诉 Studio Skills 在哪里、Agent 原生配置在哪里。返回 `AgentResourceLocations`：`skills` 是多个技能根目录的数组；`configs` 是多个配置文件或配置目录的数组。一个技能根目录下还可包含多个技能及各自的附属文件。插件不实现文件扫描、读取或保存 RPC；这些操作归 Studio，复用现有文件能力与固定编辑页面。

| 描述 | 每项字段 | Studio 的职责 |
| --- | --- | --- |
| `skills[]` | 稳定 `id`、`name`、绝对 `path`、`scope`、`readOnly` | 扫描各根目录，呈现技能及文件树，读取和编辑 |
| `configs[]` | 同上，加 `kind: file / directory` 和可选 `format` | 展示多个配置文件，扫描配置目录，按格式编辑和保存 |

位置 ID 在各自数组内唯一；相同名称可以来自不同目录，Studio 用来源 ID 和相对路径区分，不能按名称合并覆盖。字段省略表示该类能力未提供，空数组表示已提供但当前没有位置。位置目录暂未创建不等于插件不可用；配置文件缺失沿用现有创建/保存体验。共享与内置资源必须声明只读；目录嵌套、同一路径别名和符号链接仍由 Studio 文件访问规则处理，不能绕过只读来源。

宿主根据自有实例的配置 revision、global/scoped 模式和工作区调用位置声明，提供 scoped 状态目录；不需要先执行聊天或 `create`。用户、profile、实例与提供方由宿主绑定，HTTP 不接受调用者指定路径。目录能力为 `{ management: { locations: true } }`，HTTP 入口为 `POST /api/studio/agent-instances/:id/locations`，请求 `{ revision }`，响应包含实例、提供方、配置 revision 及两个位置数组。现阶段要求实例空闲，使用既有管理调用的超时、取消和资源回收边界。

`configSchema` 描述 Studio 保存的实例参数，不等于 Agent 原生配置文件清单。`create({ config }, runtimeCtx)` 的提示词、MCP 等输入也不替代此位置声明。Studio 管理的 MCP 及其运行凭据仍由宿主提供，插件负责原生适配；插件描述的 Skills 与配置位置应对应 Agent 实际使用的范围。模式或工作区改变后重新解析整个位置清单，不能继续使用旧位置缓存。

Qwen/Codex 已实现多个位置声明；现有 Coding Agent 配置页与 Skills 页已消费声明，按自有实例选择来源，保存后下一次运行重新创建原生 runtime。未选择实例时继续使用原管理路径。配置页已提供实例 schema 表单、手工安装指引和受管交互登录终端；显式受管 CLI 安装已接入，自动升级、真实账号及完整管理验收仍待完成。

Studio 文件入口为 `POST /api/studio/agent-instances/:id/resources`：`{ action: 'list', revision }` 返回位置、`snapshot` 和文件目录；`read` 使用 `{ revision, snapshot, kind, locationId, path }`，`write` 再带 `content/etag`。相对路径采用 `/` 分隔，文件位置的 path 为空；不接受绝对路径或自报 owner/provider。所有操作在管理锁与取消作用域内重新授权，位置快照包含提供方、配置 revision 与规范化位置。文件版本绑定规范路径和内容；原生文件被外部修改时返回冲突。JSON/TOML 保存前校验语法，原子替换并保留既有文件权限。

只读声明跨 Skills/configs、重叠目录和路径别名生效；全局共享 Skills 仍只读，多硬链接文件也只读。拒绝相对路径越界、悬空链接和非文本文件。扫描最多访问 4,096 项、返回 2,048 个文件，深度 12；跳过目录内符号链接与隐藏后代，显式声明的隐藏根目录可扫描。文本读取上限 1 MiB。缺失目录返回空目录，缺失的声明配置文件可创建；达到限额或无权限时明确失败，不伪装为空。旧 Skills 详情页可编辑技能正文及可写附属文本文件；整个 Skill 包的导入/删除已接入，任意目录树增删仍未开放。

`POST /api/studio/agent-instances/:id/skills/import` 使用 multipart 的 `revision/snapshot/locationId/file`，不接受调用者给定目标路径或身份。文件夹上传保留单一顶层 Skill 目录；单 ZIP 可在根或单一顶层目录提供非空 UTF-8 `SKILL.md`。宿主复制上传字节，在物化 ZIP 条目前检查有效目录数量（包含 ZIP64），有界解压、校验 CRC，拒绝越界路径、重复大小写别名、链接、特殊文件和加密内容。最多 256 个文件，每文件 4 MiB，总计 16 MiB，`SKILL.md` 最多 1 MiB；传输另允许 2 MiB multipart 元数据。ZIP 的 owner-execute 位可保留，其余权限按私有文件收敛。完整暂存目录只发布到不存在的目标，不覆盖已有 Skill；失败清理暂存内容。

资源入口另支持 `review-skill/remove-skill`，固定 `kind: skills`。review 返回选定目录（包含隐藏与二进制资产）的完整内容版本及文件/字节数；remove 必须携带该 etag，删除前重新读取校验。声明根目录、受保护后代、符号链接、多硬链接或特殊文件均拒绝删除。错误导入/删除请求在关闭空闲原生租约前拒绝，有效变更仍等待原生清理并再次校验。目录删除属于文件系统操作；主机故障、恢复与跨进程竞态仍在最终验收范围。

Web 复用既有 Skills 导入弹窗和删除确认，明确选择可写来源，并在确认中展示来源路径。切换实例/profile 或退出页面会作废旧确认与迟到读取；列表不混用旧来源。变更后下一轮自动重新加载，不要求执行旧引擎的重载命令。

资源编辑接入保留现有固定页面，不引入独立资源编辑页面或插件文件读写接口。DSH 保留现有原生配置 iframe、插件清单及其打开/关闭生命周期；本阶段不做通用前端插件化。

### 3.4 插件向 Studio 提供输入框命令

本节定义完整目标契约；激活期及聊天租约内动态注册、worker 调用和 Web 输入框已实现，跨入口迁移仍待完成。**插件自己注册命令、解析参数、处理调用，并按现有命令返回格式输出；Studio 不实现插件命令的业务逻辑。** Studio 提供注册容器、输入框补全、通用鉴权、按注册关系转发、生命周期管理及既有结果呈现。普通功能插件也可贡献命令，不要求先注册 Agent；前端沿用现有输入框，不加载插件 JavaScript。

#### 注册与调用归属

插件通过 `PluginContext.commands.register(definition, handler)` 注册命令描述及其处理器，返回 Disposer。定义包含稳定的命名空间 `id`、`name`、可选 `aliases`、`description`、`argsHint` / `examples`，以及适用的 Agent 类型/实例范围和输入入口。描述和参数提示用于前端展示；子命令、参数语法、默认值、校验和执行全部由插件 handler 负责。宿主只校验注册/调用 DTO、来源、目标范围和资源限额，不解析业务参数。

用户选择补全项时只更新草稿；提交时 Studio 根据命令 ID 或已注册名称找到处理器，将完整原始输入、实际输入的命令名称和原始参数尾部交给插件。宿主只识别路由所需的命令名，不重写参数、不展开提示词、不决定调用哪个原生 API，也不按厂商或命令名称维护执行分支。插件自行决定如何处理，包括调用自身服务、原生 CLI/ACP/RPC 或经授权的 ctx 能力。需要启动或控制 Run 时，由插件显式调用相应受管服务，Studio 不从命令文本或返回字段推断并启动 Run。

不设置由 Studio 调度的 `prompt/action/native` 命令分类，不为插件新建另一套命令业务执行器。所有插件命令使用同一个注册与调用机制；原生命令的发现、参数和协议适配也属于插件。

注册时在 manifest 声明命令贡献及允许的目标范围，并获授 `commands.register`；这不授予命令实际使用的业务权限。调用时宿主注入可信 ExecutionContext，按用户资源权限与插件当前 grants 的交集鉴权；profile、会话、实例及原生租约不能由插件伪造。共享会话等现有限制保持，排队后派发时重新检查权限与绑定。

命令 ID 与短名称分开处理。同一插件重复 ID 属于注册冲突；不同 Agent 的 `/compact` 等命令按当前目标定位到各自插件。有效目标内短名称有歧义时显示来源，并提供宿主生成的限定名称，例如 `/acme.research:review`；不按安装顺序猜测 handler，也不覆盖该范围内的平台保留命令。命令不可用、插件失效或选择过期时明确返回错误，不改投其他处理器。未匹配任何注册的 `/...` 文本沿用现有输入规则。

#### 沿用现有命令返回格式

插件返回现有 `session.command` 的业务 payload，宿主补充并校验传输信封中的 `event: 'session.command'`、`session_id` 与调用关联。插件不拿 Socket 对象，不直接写消息或用量表。SDK 应从当前返回格式提取公共 DTO/schema，不另包一层不兼容的结果格式。

| 现有字段 | 保留的语义 |
| --- | --- |
| `command`、`action` | 实际命令名及结果动作；插件提供，宿主核验命令绑定，现有客户端据此展示 |
| `ok`、`message` | 成功/失败及可读消息；未知扩展动作仍可按通用命令消息呈现 |
| `messageKey` | 现有本地化消息标识；不认识的标识回退到 `message` |
| `started`、`terminal` | 保留当前命令开始/会话忙碌与结束语义；支持先开始、后续结果的异步命令 |
| 既有结构化字段 | 按当前动作保留，例如 `available`、`contextTokens/contextWindow/contextPercent`、token 统计、`isWorking`、`compacted` 等；不重命名、不任意套入新的 `data` 层 |

当前 `terminal` 会影响客户端会话运行状态，不能把“这次查询已返回”一律写成 `terminal: true`。例如运行中查询 `/status` 可以已返回结果但保持 `terminal: false`；`/compact` 可以先返回 `started: true, terminal: false`，后续再返回结束结果。插件负责正确生成这些字段，宿主只检查其归属及生命周期一致性，防止旧调用的迟到事件终止另一轮 Run。调用回执的结束和会话状态分开记录，不用 `terminal` 一项替代两者。

单次返回和异步返回均沿用上述 payload；异步处理使用 SDK 受管结果通道，绑定同一次调用并传播取消/超时。现有客户端的 `role: command`、`commandAction`、`commandData` 及状态呈现继续使用；既有持久化和广播由宿主共用链路唯一执行，不能插件与宿主各写一次。`action` 只是处理结果，不是让 Studio 再执行删除、改标题、压缩等业务的指令；此类业务由插件调用获准的领域服务完成后报告结果。身份、跨会话引用及结果字段仍受通用 schema/授权校验。

迁移时以 [Coding Agent 命令返回](../../packages/server/src/modules/coding-agents/services/session-command.ts)、[Ekko 命令返回](../../packages/server/src/modules/studio/services/chat-run/ekko-session-command.ts) 和 [客户端 handleSessionCommandEvent](../../packages/client/src/stores/hermes/chat.ts) 为兼容基线。输入、成功、失败、运行中查询及异步完成均保留 fixture；通用插件的新命令只需按该格式返回即可展示，不要求 Studio 新增命令业务分支。

#### 动态注册与生命周期

静态贡献随插件激活暂存并原子发布。插件发现原生会话的新命令后，自行更新该目标范围内的注册/可用性；宿主只验证声明范围、发布目录 revision，并绑定 generation 和 runtime lease。原生协议解析和调用由插件保留，不引入 Studio 厂商专用命令适配器。没有会话时可先提供静态命令及未就绪状态，打开补全菜单不得隐式触发聊天、登录或推理。

Disposer、停用、卸载和 generation/原生租约回收撤销对应注册。切换 profile、Agent/实例、模式、工作区或配置时重新获取当前目标的命令；客户端保留草稿但清除旧选择绑定，旧租约的迟到目录/结果不能污染新目标。Hermes/Ekko 及平台命令由各自内置模块注册和处理，不依赖插件 worker；一个插件的失败不影响其他提供方的命令。

通用转发服务维护调用 ID、幂等回执、deadline、取消及资源清理。重复提交不自动重复执行插件 handler，未确认的外部副作用不自动重试；“已派发”不等于处理成功。目录大小、文本长度、RPC 帧及并发有界。Web/Desktop/App 共用命令目录、通用转发和当前返回格式；HTTP/Socket 只适配传输，旧客户端保留现有协议投影。

当前 SDK 已开放 `commands.register`、`CommandInput/Result/Context`，manifest 声明静态命令 ID；Web 输入框消费目录，通过带 revision 和幂等键的 HTTP 调用插件 handler，实时事件和轮询回执共用现有结果渲染。注册支持 `id/name/aliases/description/argsHint/agentTypeIds`，名称支持 Unicode 字母、数字、下划线、点、冒号和连字符。受管聊天优先展示无歧义短名称，歧义时使用限定名称；旧平台命令的保留名称继续受保护。暂不支持 examples、草稿和其他输入入口。插件回执不直接清空聊天、删除消息、终止其他 Run 或跳转到返回数据中的会话；业务变更仍须经获权领域服务。`ctx.chat.start` 当前拒绝斜杠管理命令的限制保持。完整验收见实施计划 A35–A39。

manifest 的可选 `contributes.runtimeCommands` 只允许声明本插件 Agent 类型，并须声明/获授 `commands.register`。宿主仅为已绑定自有直接聊天的 runtime 注入可选 `runtime.commands.replace([{ definition, handler }])`；独立 Run 或管理探测不提供此能力。注册沿用相同目录、调用服务和 worker handler，宿主只接收描述，私有目标由协调器绑定 owner/profile、会话、实例/revision、提供方 generation 和 runtime 租约。每个目录最多 64 项、65,536 字节；验证全部通过才替换，相同描述保留 revision。取消、清理、worker 故障及配置/所有权改变撤销或隐藏目录，旧句柄不得更新新租约。

Qwen 插件消费 ACP `available_commands_update`，在同一 worker 内保留处理器；ACP 恢复期间只缓冲匹配原生会话的命令元数据，不回放历史消息。基础 `/compress` 与 Codex `/compact` 由各插件静态注册，因此查看新聊天目录或空闲租约回收后不必启动 CLI。Qwen 保留原始斜杠参数，不把系统提示词和交互指引拼入参数；Codex 自己调用 `thread/compact/start`，等待真实 turn/item 终态后提交成功 checkpoint。原生拒绝的操作维持失败语义，不能把受理回执算作业务完成。尚未声明支持所有原生交互式管理操作、Hermes/Ekko 或 App 命令迁移。

受管实例聊天的命令上下文包含宿主派生的 `session.instanceId/instanceRevision`，处理器可显式通过 `ctx.runs.start` 启动当前实例 Run。宿主以私有 scope 映射和持久来源表绑定命令回执、输入消息和唯一 Run，来源字段不接受插件请求覆盖。接受事务复核当前所有权、实例 revision 与运行中的命令回执，canonical 投影复用命令输入消息。正常命令完成不取消已接受工作；处理器失败、超时或取消须等待关联 Run 的清理，清理未确认则回执失败并隔离原租约。父 Run/workspace 绑定仍不支持；本接口不自动解释斜杠文本或插件返回动作。

### 3.5 一个最小插件

以下示例展示入口关系，`createEchoRuntime` 等实现由样例包提供：

```ts
export function apply(ctx: PluginContext) {
  ctx.agents.register({
    id: 'acme.research/assistant',
    name: '研究助手',
    configSchema: researchConfigSchema,
    capabilities: researchCapabilities,
    create: createEchoRuntime,
  })

  ctx.on('run.completed', async (event, eventCtx) => {
    eventCtx.logger.info('执行完成', { runId: event.subject.runId })
  })

  ctx.hooks.before('runs.start', async (input, hookCtx) => {
    return { action: 'continue' }
  }, { key: 'run-policy', priority: 0 })
}
```

实施样例必须独立于 server 源码编译，并补齐运行、取消、输入校验、事件、测试和 manifest；不以这段示意代码替代可安装样例。

## 4 Run 状态与输出

### 4.1 状态机

```text
accepted → queued → starting → running → finalizing → completed
                              ↕ waiting_input
accepted / queued / starting / running / waiting_input
                              → cancelling → cancelled
任意未终结状态 → finalizing → failed 或 interrupted
```

完成、失败、取消和中断只有一个最终结果。协调器以持久化 revision/CAS 仲裁同时到达的完成和取消。未完成取消时不能报告 cancelled；强杀后记录中断原因和外部副作用可能已发生的事实。

进入 finalizing 时原子领取结束权。已领取完成权的 Run 收到取消请求时返回 `RUN_FINALIZING` 及当前状态；若取消先取得结束权，随后正常返回的运行结果不能覆盖它。完成权领取后持久化失败必须可恢复或转为失败，不能永久停留在无法查询原因的中间状态。

同一原生会话默认只有一个活动 Run，后续输入进入队列。只有运行时声明且实现 steering/queueInsertion 时才采用对应路径。最终状态提交后，失效 runtime lease、旧 Run 或不匹配提供方快照的迟到事件被拒绝或作为诊断处理，不写入下一轮；插件快照还须匹配 generation。

### 4.2 事件与完成屏障

运行时可输出的事件类别：`message.delta`、`message.snapshot`、`reasoning.delta`、`tool.started`、`tool.progress`、`tool.completed`、`tool.failed`、`interaction.requested`、`usage.reported`、`artifact.created`、`context.updated`、`checkpoint.updated`、`diagnostic`。

每个事件带运行时本轮递增 `producerSequence`，消息、工具调用、模型请求分别有稳定关联 ID。宿主补充真实的 provider 引用、runtime lease、scope 和 run 身份；只有插件提供方携带 plugin ID 和 generation。拒绝越界 ID、超长数据和未知 schema。delta 与 snapshot 必须声明替换/追加语义，禁止把同一最终文本再追加一次。

完成须同时满足：

1. `result` 成功返回，输出流正常排空；任一失败则进入失败流程。
2. 所有已接收事件通过校验并持久化，未完成交互和工具有确定结局。
3. 已接收用量按模型请求 ID 归并，工作区差异/产物按约定提交。
4. 原生恢复引用保存，Run 终态和事务事件在同一事务中提交。
5. 提交后向 Socket、Webhook、App 和插件消费者发送同一业务事实。

`result` 已返回但流不关闭时设置 finalization deadline，超时中断；不能因为 worker 进程退出就推断执行成功。usage 以后才校正时发布独立修正事件，不重发 run.completed。

### 4.3 用量与计费

`usage.reported` 必须包含 `modelCallId`、provider/model、计数单位、`delta | cumulative | final` 模式和 revision。宿主按 `(runId, modelCallId, metric, revision)` 去重并规范化，累计快照不能反复相加。

当前运行时事件要求 `modelCallId/model/mode/revision/inputTokens/outputTokens`，可选 `cacheReadTokens/cacheWriteTokens/reasoningTokens` 为非负安全整数。运行时 `inputTokens` 已包含缓存总输入，缓存字段只作明细；输出和 reasoning 同理，不重复加总。delta 按字段累加，缺少字段不改变已有明细；cumulative/final 替换快照，缺少明细保持未知。相同 revision 的任何指标冲突整体回滚，最终更正仍须显式 final。宿主模型服务的用量继续由原生规范化器转换并独占写入，不接受运行时对同一宿主模型调用重复计量。

Agent 运行时报告数据，核心负责计价和账户归属。若通过 `ctx.models` 调用，模型服务已经记录该请求的权威用量；运行时对同一请求的回报只能关联或校验，不能二次记账。父 Run、子 Run 和后台工作使用关联 ID，聚合统计避免再次累计同一模型调用。未知用量以 unknown 表示，不写成零来宣称已完整计量。

### 4.4 交互与取消

交互请求持久化为 interaction ID，绑定 run、provider 引用、runtime lease、资源和可选项。用户响应经原有身份与授权检查，再传给 handle.respond。重复响应幂等，过期响应返回明确错误，不能恢复到另一个原生会话。该契约同时适用于内置和插件 Agent。

当前交互实现中，clarification 可用 `allowText: false` 限制为已声明选项；未提供此字段的旧澄清请求保持允许文本。选项可附带 description，响应只能选择一个 choiceId 或提供 text。审批始终只接受选项。原生请求已被服务端清理时，运行时发出 `interaction.withdrawn`，宿主把尚未完成的请求记为 withdrawn，不伪造用户回答；已成功响应的请求不会被迟到撤回覆盖。若撤回与响应 RPC 并发，`handle.respond` 可返回 `{ status: 'withdrawn' }`，宿主保留实际回执及幂等记录。resolved/withdrawn 均为确定结局；expired/interrupted 仍不能满足正常完成屏障。秘密输入尚无凭据专用契约，厂商插件须在发布普通持久化交互之前拒绝这类请求。

取消先阻止新输入和下游调用，再请求原生停止，等待输出收尾；超过期限关闭 runtime 并清理受管进程树。取消 RPC、调用方断线、HTTP 超时和永久终止原生会话是不同操作，必须分别实现。客户端断线默认不结束已经接受的持久化任务，用户显式取消和任务 deadline 才触发对应策略。

## 5 事件订阅与可靠消费

### 5.1 公共事件

```ts
interface EventEnvelope<T> {
  schemaVersion: 1
  id: string
  type: string
  occurredAt: number
  partitionKey: string
  sequence: number
  subject: EventSubject
  data: T
  causationId?: string
  correlationId: string
}
```

事件 map 使用判别联合，使 `ctx.on('run.completed', ...)` 得到对应 payload 类型；边界同时执行运行时 schema 校验。公共投影移除 token、原生 auth 文件、内部路径策略、`push_target_id` 和不属于授权范围的内容。事件回调拿到的是受限 EventContext，不能借事件中的 actor 字段模拟该用户。

| 事件族 | 首批事件 |
| --- | --- |
| 插件与目录 | `plugin.ready`、`plugin.failed`、`plugin.disabled`、`agent.available`、`agent.unavailable`、`service.available`、`service.unavailable` |
| 会话 | `session.created`、`session.updated`、`session.archived`、`session.deleted` |
| 执行 | `run.accepted`、`run.started`、`run.waiting_input`、`run.completed`、`run.failed`、`run.cancelled`、`run.interrupted` |
| 交互与任务 | `interaction.requested`、`interaction.resolved`、`task.updated`、`plan.updated` |
| 群聊与工作流 | `group.message.created`、`workflow.run.started`、`workflow.run.completed`、`workflow.run.failed` |
| 数据修正 | `usage.corrected`、`artifact.created` |

Run 文本 delta 是高频流，不默认写成可靠业务通知；需要它的消费者显式订阅 `runs.watch`。现有 `chat.run.completed` 等外部命名通过兼容投影生成，不能因更改内部名而破坏 Webhook/App 协议。

内置 Agent 和插件 Agent 的执行都产生上述公共 Run 事件。核心订阅与投递服务独立于插件宿主；`ctx.on/once/events` 是插件接入该服务的入口。插件停用只移除它的订阅和贡献，不停用内置 Agent 的事件生成、Webhook 或 App 投影。

### 5.2 三种投递方式

| API | 投递和顺序 | 失败行为 |
| --- | --- | --- |
| `ctx.on(type, handler)` | 激活期订阅；每订阅按 partition 串行，不承诺跨 partition 总顺序；无重启补发 | 异步回调超时/异常记录诊断，不回滚原事务，不自动重试 |
| `ctx.once(type, handler)` | 第一个获准且匹配的事件在入队前原子占用一次名额 | 解除后回调失败也不重试；重启不保留一次性消费状态 |
| `ctx.events.consume(name, spec, handler)` | 持久化游标、至少一次投递、同 partition 顺序；消费者名稳定 | 成功后确认；失败有界退避重试，进入 dead letter 后暂停该 partition 并允许管理操作 |

普通订阅使用有界队列。超过上限时暂停/解除该订阅并报告可观测故障，不阻塞主 Run，也不静默无限积压。可靠消费者使用数据库队列和配额，不能转成内存无限缓存。

可靠投递的生产端采用事务事件表：业务事务内写事件，提交后分发器读取。消费者必须用 `event.id` 或自己的领域幂等键处理重复；外部 HTTP 副作用无法保证严格 exactly once。注销消费者、卸载插件时保留游标和死信，重新启用是否续消费由显式策略决定。权限在每次重放时重新检查，过滤掉的敏感内容不在错误日志中泄露。

第一版默认通知回调超时为 5 秒，可靠消费单次超时 30 秒、最多 5 次尝试；具体值进入宿主配置，并以压力验收调整。可靠事件默认保留 7 天，游标早于保留水位时返回 `EVENT_CURSOR_EXPIRED`，要求明确选择跳到当前或从业务快照重建。暂停不意味着无限保留。

当前实现的 consumer spec 为 `{ types, start: 'now' | 'earliest', resume: 'continue' | 'from-now' }`；三个字段均必填，消费类型要求对应的 `events.consume:<type>` grant。管理操作 `pause/resume/reset-now` 使用消费者 revision，死信 retry 使用投递 position/revision。持久化全局保留水位采用保守失效策略；低于水位的消费者必须显式重置，即使删除的部分记录属于其他 profile。Agent 实例终态和会话删除已在业务事务中写入公共事件及私有归属元数据；旧运行通知的生产端事务迁移尚未完成，不能把消费者可靠性等同于所有旧业务事件的可靠生产。

### 5.3 扩展事件

manifest 中声明 `acme.research:report.created` 一类命名空间及 schema。`ctx.emit` 只允许发布声明且获准的插件事件，返回持久化接收凭据；不能伪造核心 `run.completed`。

激活期事件仅有插件自身作用域。含用户资源的事件只能由 ExecutionContext 下的事件服务发布，并由宿主绑定 subject、profile 和可见性。事件触发新 Run 或新事件时继承 causation/trace，设置深度和速率预算，避免完成回调无限启动自己。

## 6 可改变流程的钩子

```ts
ctx.hooks.before('runs.start', handler, { key: 'run-policy', priority: 0 })
ctx.hooks.before('sessions.remove', handler, { key: 'delete-policy', priority: 0 })
```

首批仅开放两个明确节点。hook 按 priority 降序、plugin ID、声明 key 排序，串行执行，顺序进入运行快照。输入是只读快照；返回值为 `continue`、`reject` 或该节点允许的 `patch`。

`runs.start` 只允许修改经 schema 限定的输入内容和在原授权范围内收紧预算；不能替换 Agent、actor、profile、凭据、provider 引用或提升模型权限。`sessions.remove` 第一版仅允许继续或拒绝，不允许把目标换成另一个会话。

hook context 只提供只读领域查询和日志。处理器不能经 SDK 启动 Run、删除数据或发送外部消息。worker 本身是受信任代码，不能据此承诺约束其所有 OS 副作用。

每个 hook 默认 2 秒，总链 5 秒；超时或异常使当前操作明确失败。自动重试仅在尚未发生业务副作用且调用方使用幂等键时允许。系统授权、校验和预算规则始终执行，插件 hook 不能代替或绕过它们。

当前 SDK 返回 `{ action: 'continue' }`、`{ action: 'reject' }`，或仅对 runs.start 返回 `{ action: 'patch', patch: { content?, timeoutMs? } }`。content 暂为文本块；预算只能在前序已收紧预算内继续缩小。实例执行准入以原始请求计算幂等身份，实际输入和已执行 hook 顺序随接受记录同事务保存；重试已接受请求不重新执行 hooks。旧聊天及其他运行引擎尚未切到此准入链，不能据此宣称所有内置入口的 runs.start hook 已覆盖。HTTP/SDK 的现有会话删除共用删除 hook；内部仓储清理不作为新的用户删除请求再次执行 hook。

hook 可按授权作用于内置 Agent 的 Run。插件停用或故障清理时撤销其 hook；已在执行的 hook 失败按上述规则结束当前请求，后续请求使用更新后的 hook 快照。核心授权规则不依赖插件 hook，不能因插件故障失效。

## 7 服务贡献与其他扩展入口

| API | 合约 |
| --- | --- |
| `ctx.services.provide(token, implementation)` | token 包含发布者、服务名、major 和方法 schema；激活时检查冲突 |
| `ctx.services.use(token)` | 返回 RPC 代理，版本必须满足 manifest 依赖；不能获取服务内部实例 |
| `ctx.commands.register(definition, handler)` | 插件注册并自行处理输入框命令，按现有格式返回；宿主仅发布目录、鉴权转发并绑定执行上下文，详见 §3.4；已实现激活期注册、聊天租约的 `runtime.commands.replace` 和 Web 文本调用，其他入口待迁移 |
| `ctx.http.route(definition, handler)` | 方法、相对路径、输入输出 schema、访问范围、限额；提供 ExecutionContext |
| `ctx.scheduler.register(definition, handler)` | 持久化计划、执行身份、时区、重叠策略和幂等任务 ID |
| `ctx.storage` | 插件命名空间内的事务 KV/文档接口；区分 profile 和插件公共数据 |
| `ctx.secrets` | 只列引用/状态；声明的秘密按使用策略传给受管调用，不列出平台所有密钥 |
| `ctx.lifecycle.onDispose(fn)` | 正常结束时执行；宿主独立持有资源清单应对 worker 已崩溃的情况 |

服务依赖在激活前形成 DAG，缺依赖或版本冲突时 blocked，循环依赖直接拒绝。可选依赖通过显式可用状态与服务变更通知处理，不能启动后无限等待注入。跨服务 RPC 传递收窄后的调用上下文、trace、deadline 和取消，禁止凭 service token 增权。核心服务名不可覆盖。

开发版已实现 `PluginContext.services.provide(ServiceToken, implementation)` 与 `use(ServiceDependency)`。token 包含带 major 的 namespaced ID、精确版本和方法 schema；dependency 包含同一 ID、semver 范围及可选标记。`use` 返回 `status()` 与 `call(executionContext, method, input)`；后者只接受宿主发给该 worker 的存活上下文。跨服务转发保留主体与资源绑定，领域能力取调用链 grants 的交集。状态诊断和当前范围见[服务实施记录](studio-plugin-progress.md#t03-进展服务依赖rpc-与激活诊断)；服务变更通知尚未实现。

插件路由统一位于 `/api/studio/plugins/{pluginId}/...`，由宿主先认证再路由；插件只能提交相对路径。公开 Webhook 等入口需要单独声明及宿主验证策略，不能自行移除认证。请求体、流长度和并发受限，禁止把 Koa 实例交给插件。路由 schema 汇入 OpenAPI 与 MCP 发现；未声明的插件方法不自动全部暴露给模型。

管理接口拟采用 `/api/studio/plugins` 和 `/api/studio/agent-types`、`/api/studio/agent-instances`；接口定义由 schema 生成，后续实施按现有 OpenAPI 流程维护。已有 `/api/coding-agents/*` 继续作为协议适配，调用同一管理服务。

插件管理 DTO 返回 `installationPolicy` 及各操作的可用状态/原因。卸载与删除在统一管理服务内先校验安装策略；系统插件返回 `SYSTEM_PLUGIN_PROTECTED`、`retryable: false`，不先停用、清理资源或修改记录。HTTP、MCP、SDK、批量与 force 路径使用相同校验，不能仅靠前端隐藏按钮。配置重置或数据清理也不能删除系统安装和保留的类型定义；原生 CLI 管理仍按自身能力处理。

## 8 Manifest 与包生命周期

本节及第 9 节仅约束 Coding Agent 插件和第三方插件。Hermes/Ekko 的内置注册、应用启停和原生引擎管理不进入以下状态机；插件管理 API 不接受对它们执行安装、升级或卸载。

### 8.1 工件描述

```json
{
  "schemaVersion": 1,
  "id": "acme.research",
  "version": "1.0.0",
  "engines": { "studioSdk": "^1.0.0", "rpc": 1 },
  "backend": "dist/index.js",
  "activation": "global",
  "contributes": {
    "agents": ["acme.research/assistant"],
    "commands": [],
    "events": [],
    "services": []
  },
  "requires": {
    "capabilities": ["agents.register", "events.subscribe:run.completed", "hooks.before:runs.start"],
    "services": []
  },
  "configSchema": "schemas/config.json",
  "dataSchemaVersion": 1
}
```

每个实例的 profile 由启用配置决定。工件路径必须位于工件根目录中；拒绝绝对入口、路径穿越、逃逸 symlink、重复解压路径和超限归档。SDK/RPC 版本是拟议首版标识，真实发布时与实现同步确定。配置中的秘密只保存 secret reference，展示与导出时不返回明文。

### 8.2 状态

```text
discovered → staged → installed → activating → active
                ↘ failed             ↘ failed
installed ↔ disabled                 active → draining → disabled
installed/disabled → uninstalling → removed
任意未激活版本 → blocked（版本、依赖、权限或平台不满足）
```

`uninstalling → removed` 仅适用于 user 安装；system 安装禁止进入卸载状态。首次启动和升级迁移根据受信任随包清单幂等登记全部 14 个系统插件，校验工件并保留已有全局配置、实例和能力授予；旧 profile 配置一致时合并为全局状态，冲突时保留原记录并阻止自动激活。缺少原生 CLI 或登录仅影响运行就绪状态，不能使插件安装记录消失；随包工件损坏则保留目录并报告诊断及修复路径，不降级成可删除的用户插件。

安装状态与各 profile 的启用状态分别持久化。安装前只读 manifest，不导入代码探测元数据；校验来源、摘要、依赖和平台后写入不可变 generation。生产依赖在 staging 中准备，默认不执行未知生命周期脚本；需要构建/原生依赖的工件必须有明确的安装策略和日志，不能隐式使用实时 `latest`。

激活时建立 worker、握手、加载入口、暂存所有贡献、验证依赖和能力，再原子发布目录 revision。任一步失败回滚该代注册并清理资源，不撤销其他健康插件。没有部分 Agent 已发布而其服务未就绪的状态。

### 8.3 升级和卸载

升级产生新 generation。新启动的 RuntimeSession 使用新版本；已有会话租约和活动 Run 固定旧 generation。下一轮切换必须验证 checkpoint schema、native session 兼容和配置迁移；不能把旧进程直接换成新工件。

旧 generation 在租约归零后回收。用户可选择排空后切换，或显式取消其所有关联 Run 和 runtime 后切换。新版本激活失败保持旧版本可用；旧版本数据 schema 已发生不可逆改变时禁止自动回滚。

数据迁移作用于版本化快照/独立命名空间。发布前确保旧代仍在运行时不会同时写不兼容数据；不支持并行读写的迁移必须先排空。持有原生会话的外部文件兼容性也纳入判断，不能只回滚插件目录。

停用先撤销新调用入口，再排空或取消已有执行、停止计划触发、清理订阅与服务、关闭 worker 和受管子进程。系统插件也可全局停用，但保留安装工件和静态目录。用户插件卸载检查权限、安装策略、依赖和租约，默认保留插件配置/数据、历史 Run 和消费游标；“清除插件数据”是单独操作，不影响 Studio 会话历史和用户原生 Home，也不能删除系统插件安装定义。

系统插件默认版本随 Studio 发布清单更新，替换工件必须通过受信任的系统更新/修复路径；普通同 ID 安装不能覆盖它。更新与回滚沿用上述租约和数据兼容规则，保护策略始终保留。垃圾回收只清理无租约且不再承担当前版本/回滚保留职责的旧 generation，不能清掉当前系统插件或将其标记 removed。

## 9 Worker RPC 与运行环境

宿主与 worker 使用独立控制通道，stdout/stderr 只作日志。callback 和 factory 不直接 JSON 序列化，由 SDK 注册 handler ID，通过 RPC 分发。握手校验协议 major、工件摘要、全局 generation 和声明能力；运行及管理 RPC 的 owner/profile 由宿主按调用单独注入。

RPC envelope 包含 request ID、method、scope handle、deadline 和关联 trace。scope handle 由宿主发放并在连接/generation/生命周期内绑定，worker 不能通过修改 payload 伪造主体。AbortSignal 和流通过 ID 映射控制消息，不传递进程内对象。

文本流采用有界窗口和确认序号，支持批量发送；流发送者必须遵守 backpressure。超过窗口、帧大小或持续不确认时中断对应调用并给出诊断。文件与图片使用受控 artifact 引用，不在控制通道反复传大块 base64。

worker 崩溃使租约失效，当前 Run 标记 interrupted，未确认 RPC 明确失败。只自动重建无副作用的 worker 基础设施；不能自动重跑已经接受的 Agent 输入。历史 Run 通过宿主持久化日志恢复观察，只有运行时声明并验证原生恢复能力时才允许继续。

插件使用标准 Node/Electron Node-mode runner。新托管 MCP 启动必须显式设置 `ELECTRON_RUN_AS_NODE=1`，不能污染桌面 GUI 的环境。跨平台命令使用参数数组，Windows shim、PTY、Unicode 路径和进程树退出纳入验证。

协议驱动依赖 SDK 的 ProcessHandle、字节流和取消接口。宿主的原始 ChildProcess/PTY 对象不跨 RPC；stdout、stdin、resize、exit 等映射为句柄操作。厂商必须写入原生 auth 配置时，插件提交受控配置模板与 secret reference，由获准的宿主执行环境注入；确需明文秘密的插件能力单独授予，不能借运行准备读取整个平台凭据。

当前已实现 runtime `processes.spawn` 和 `ProcessHandle.read/write/end/stop/dispose`；读取为有界长轮询，返回 stdout/stderr 字节、截断标志与退出结果，空批次不表示 EOF。`spawn` 可显式指定 `terminal: { cols, rows }` 分配 PTY，随后 `resize(cols, rows)` 改变尺寸（各维 2–1,000）；管道实例拒绝 resize。PTY 合并 stdout/stderr 到 stdout 字节块，单次读取最多四个 16 KiB 块，输出缓冲最多 256 KiB 并暂停原生读取。PTY 不支持单独关闭 stdin，调用 end 明确返回不支持；停止使用 stop/dispose，不猜测 EOF 控制字符。

PTY 与管道共用 `processes.spawn` 权限、runtime 归属、总数配额、环境白名单、取消与进程树清理；宿主不选择 shell。每次写入最多 64 KiB；node-pty 无原生写入 drain 回执，因此每个 PTY 累计最多接纳 1 MiB 输入，超过返回 `RESOURCE_EXHAUSTED`，不能把写入接纳视为原生命令完成。没有可用原生 PTY 模块时返回 `CAPABILITY_UNSUPPORTED`。stdio MCP 继续只使用管道。当前真实验收为 macOS/arm64；Windows/Linux 实机矩阵、秘密注入及旧厂商驱动切换仍需后续验收。实现限制和退出语义见[受管进程实施记录](studio-plugin-progress.md#t05-进展runtime-受管管道进程)。

当前 runtime 还提供 `mcp.connect(McpConnectInput)`，插件须声明并获授 `mcp.connect`。此权限包含启动 MCP 子进程或连接显式 HTTP 端点、调用工具和访问该服务声明的 resources/prompts；不自动扩展账户或 profile 凭据。stdio 使用 `{ type: 'stdio', command, args, cwd, env? }`，HTTP 使用 `{ type: 'streamable_http', url, headers? }`，可选 `timeoutMs`（100 ms–300 秒，默认 30 秒）和 `supportsParallelToolCalls`。

返回句柄通过 `listTools()` 读取模型可用的工具定义，通过 `callTool(name, arguments)` 取得文本、图片及 JSON 结果，`dispose()` 等待连接实际关闭。非法模型工具名沿用公共 MCP 提供者的代理工具表示，调用方应使用返回的工具名和 schema。连接归 runtime 租约所有，可跨成功轮次复用；其他用户/runtime/hook 不能借用。宿主和 RPC 前后重查授权，空闲撤权也会回收连接；关闭后迟到的结果不再交付。调用失败不自动重发可能已有副作用的工具。

同一连接还提供 `listResources(cursor?)`、`listResourceTemplates(cursor?)`、`readResource(uri)`、`listPrompts(cursor?)` 和 `getPrompt(name, arguments?)`。列表返回 `{ items, nextCursor? }`，每次只请求原生一页，不自动遍历，首次不发送空 cursor；每页最多 256 项，cursor 最多 4 KiB。未声明所需能力时返回 `CAPABILITY_UNSUPPORTED`，已支持但目录为空时返回空 items。资源支持文本与 base64 blob；prompt 支持标准文本、图片、音频、嵌入资源与资源链接，其他内容类型显式拒绝，不由宿主执行 prompt。规范字段以外的远端 `_meta` 等附加数据不跨公共边界。

每个 runtime 最多 16 个连接，宿主最多 64 个；默认单个进行中请求，显式允许并行时最多四个。工具定义最多 256 个，工具输入最多 128 KiB，prompt 参数最多 64 KiB/64 项，DTO 结果最多 512 KiB，stdio 帧和 HTTP 响应流最多 1 MiB。HTTP 不跟随重定向。取消连接、工厂失败、worker 退出和 runtime 清理均等待所持连接及请求结算，未确认的清理保留租约隔离。平台交互凭据绑定、订阅/补全及其他协议操作仍需后续迁移。

### 9.1 聊天绑定的运行状态基础

可信应用适配器可通过 `AgentRunAdmission.startInChat` 请求聊天绑定运行；该目标不属于公开 `AgentRunStartInput`，也不能通过普通 `ctx.runs.start` 丢弃资源绑定后启动。协调器要求宿主提供 `authorizeChat`，在准入、hook 后、实际派发和读取/控制时重新检查当前用户、profile、实例及目标。缺少宿主适配时返回能力不支持。生产聊天路由、消息投影及客户端接入尚未完成。

`AgentRunRecord.sessionId/conversationId` 是宿主持久化的运行元数据。同一实例的不同聊天及原有独立运行分别缓存物理租约并保存 checkpoint；稳定 conversation ID 不等于物理 runtimeSessionId。实例级配置和资源目录继续共享，配置更新/登录/资源写入排空该实例全部物理租约；不支持复用某个聊天的原生 checkpoint 去启动另一个聊天。兼容 revision 的原子推进覆盖各 conversation；不兼容 revision 不采纳旧 checkpoint。

Run、原始/effective 输入、逻辑 conversation 和目标关联共用接受事务；幂等摘要包括实际聊天目标。公开读取和控制须匹配 scope.sessionId（存在时）及当前宿主授权。一个旧租约清理尚未确认时，另一聊天已接受的 Run 可等待或取得失败回执，不能开启重叠的原生运行。原有独立运行的数据键和准入行为保持兼容。

### 9.2 原生 Studio MCP 的逐轮注入

独立 Agent 实例可显式保存 `studioMcp: { enabled: true, api?, browser?, devices?, use? }`；缺省关闭，启用后各未指定工具集默认开启。准入前检查适配器的 `capabilities.nativeMcp` 及宿主原生上下文工厂；签发、注入和实际请求时另校验插件当前声明并获授的 `mcp.studio`。独立 Run 尚无 Studio 聊天交互上下文，因此此配置不开放任务卡、会话目标或澄清工具集。现有原生 Home 中的历史全局 MCP 配置不在本增量中迁移或删除。

宿主构造 `AgentRunContext.nativeContext`，仅经可信 run.start RPC 注入，不从 Run 输入接受。其内容包括受管 stdio 配置、工具使用指引和每轮 `turnInstructions`；不含原始令牌。Qwen 在 ACP 会话参数和当前提示词中应用，Codex 在线程配置及每轮末尾的独立文本块中应用。Studio 同名受管条目覆盖实例保存的同名定义；其他显式原生 MCP 定义仍由插件适配。

原生进程可缓存 MCP 启动配置，宿主因此为 runtime 创建私有稳定凭据文件路径，每轮签发独立 context/令牌并在完成、取消、撤权或关闭时回收。目录权限 0700，凭据来自宿主生成的 0600 文件；旧轮次清理确认后才能签发下一轮。运行主体、profile、实例、提供方 generation、当前 grants 和 Run 状态在实际 HTTP 请求时重新校验。

原生启动器要求每次工具调用携带当前 `context_id`，包括 compact 工具集包装器。调用起始时固定该值，内部异步 OpenAPI 获取及后续请求都按同一 context 读取凭据；文件轮换后，迟到请求不能取得下一轮令牌。浏览器工具通过 Studio 已认证代理访问 broker，不能绕过逐请求鉴权。正常全局 MCP 启动模式不启用这一原生专用要求。

Codex 的 `mcpServer/elicitation/request` 当前只支持无字段的 form 确认，投影为持久化的允许一次/拒绝审批；取消返回 cancel。带输入字段、URL、秘密或其他 schema 的请求在发布交互前明确拒绝，不能把普通持久化问答当作凭据输入。完整交互绑定和凭据专用契约仍待实现。

## 10 配置和权限

权限至少区分安装管理、类型贡献、领域读写、事件订阅、hook、路由、模型调用、文件、受管进程、网络和秘密引用。插件能力授予以全局 plugin/generation 为范围；具体调用再与宿主注入的 owner/profile 和资源约束取交集，安装者身份不授予执行权限；新版本增加能力时需重新满足授予条件。

每次调用以宿主实际身份解析，不以插件传入的 actor/profile 为准。配置更新使用 revision，保存后对新 Run 生效；当前 Run 的配置和权限快照可审计，但权限撤销仍应立即阻止后续敏感调用。

对本地受信任插件，原生代码的 OS 权限与 Studio API 权限分开说明。没有容器/系统沙箱时，不能宣传“未授予 files 就无法读磁盘”。隔离策略的升级应保留现有 SDK，不要求插件再次改写业务接口。


## 图片工件增量契约

`POST /api/studio/agent-images?profile=…` 接收 `application/octet-stream` 原始图片，返回
`{ ok: true, data: { id, mediaType, byteLength } }`。身份与 profile 来自认证入口，不接受路径、URL、owner 或 provider 覆盖。
宿主检测类型并实际解码校验像素；目前支持单帧 PNG/JPEG/WebP/GIF，单图最多 4 MiB/4,000 万像素，
每 Run 最多 8 张、合计 6 MiB。原始字节与元数据写入 SQLite，随数据库备份；用户合计限 64 MiB/256 张，宿主限 256 MiB/4,096 张。

运行输入使用 `{ type: 'image', artifactId, mediaType }`，原始与有效输入随 accepted Run 同事务保存。
准入和延迟派发均校验所属用户/profile及媒体类型。`DELETE /api/studio/agent-images/:id` 只删除自有未使用上传；
已被原始或有效 Run 输入引用的工件保留，返回 `REVISION_CONFLICT`。历史清理/发布迁移仍属于后续工作。

`ctx.artifacts.read(id, offset = 0)` 要求 manifest 声明并获授 `artifacts.read`，只允许当前 live Run 有效输入中的图片，
不赋予任意上传目录或其他 Run 读取权。每次返回最多 192 KiB 的 base64 块和 `offset/nextOffset/done`，
取消、终态、撤权与 owner/profile 不匹配拒绝；worker RPC 返回前再次检查授权。
公共 `readAgentImages(content, ctx)` 负责有界分块重组、格式和进度检查，独立 SDK 不依赖宿主或 Node Buffer。

模型网关返回宿主解析的可选 `images` 能力，缺失视为未知。scoped 图片输入只接受 `images: true`；
Qwen 将其投影到原生 `generationConfig.modalities.image`，Codex 使用原生 image data URL，Qwen 使用 ACP inline image。
global 模式由原生模型配置决定视觉支持。该能力不等于图片输出、通用文件输入或聊天 UI 已迁移。
