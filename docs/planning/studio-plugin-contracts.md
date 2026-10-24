# Studio 上下文与插件接口契约

日期：2026-10-23

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

PluginContext 绑定插件、generation 和启用 profile，管理贡献及资源。它不具有“当前登录用户”。激活期不能通过 `ctx.sessions` 读取任意用户会话；业务服务通过宿主派发的 ExecutionContext 使用。

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

插件激活期的 storage 仅保存明确属于插件/profile 的公共配置或内部索引。用户私有业务数据通过执行上下文的 storage 访问，默认追加 owner 隔离。共享数据必须由服务契约明确声明可见范围，不能把“同一 profile”自动等同于“全部用户互相可读”。

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

当前 SDK 另提供 `ctx.models.gateway({ model, protocol })`，要求 `models.gateway` 授权与已有 Run 绑定。`protocol` 为 `responses` 或 `anthropic`。同协议保持原生直通；跨协议复用旧 Coding Agent proxy 提取的共享适配器，支持 Responses→Chat Completions/Anthropic，以及 Anthropic→Chat Completions/Responses。返回 `{ baseUrl, token, model, protocol, transport, images, dispose }`，其中 token 是本机网关临时凭据，上游密钥不离开宿主。每次 HTTP 请求重新解析模型配置；用户、profile、session、Run 归属均由宿主固定。请求中的 model 不能覆盖实际目标。

`transport` 为 `native` 或 `translated`，同一 Run 内改变传输类型会拒绝请求。转换路径支持文本、图片及普通函数工具；保留命名空间身份并按上游原始用量与结束状态计量，不以旧适配器补出的零或 EOF 作为权威结果。厂商托管工具、custom grammar、严格工具/schema 输出与强制工具选择不属于通用转换契约，明确拒绝；厂商私有推理签名不承诺跨协议重放。Codex 转换模式禁用原生 web search。其他模型协议仍明确拒绝，Gemini 等后续单独验收。

网关只监听 loopback，租约最长 10 分钟；每请求 120 秒，16 MiB 输入、32 MiB 输出、1 MiB SSE 帧；最多 64 个租约/请求、每租约 4 个请求。只支持前台完整历史请求，不支持服务端历史引用、后台任务、压缩端点和 WebSocket。HTTP 重试视为新模型调用，不承诺推理副作用幂等。原生成功帧在权威用量写入后交付；缺失计量保留 unknown。`dispose()` 撤销准入并等待请求和记账；Run 取消、worker 退出、授权撤销、超时和宿主关闭也自动回收。清理/记账不确定时不得当作成功屏障。

`AgentRuntimeContext.stateDirectory` 为可选宿主能力：scoped 实例获得按提供方版本、owner、profile、实例和配置 revision 隔离的持久目录。路径不可由执行参数覆盖，worker 重启保持稳定。插件在其中管理自己的原生配置/历史；目录隔离不是操作系统沙箱。新 revision 不复用旧目录，历史清理和升级迁移仍未完成。

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

同实例输入当前串行运行；`persistentSession` 是显式能力，成功轮次才保留 runtime，空闲 60 秒后释放。运行输入 deadline 包含排队等待。checkpoint 只在成功终态事务中提交，并仅在提供方引用和配置 revision 相同且支持 resume 时用于下一次创建；未完成输入不会自动重放。结果返回后的输出收尾期限为 5 秒，领取 `finalizing` 后拒绝取消并返回 `RUN_FINALIZING`。

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

当前实例配置更新使用 `PUT /api/studio/agent-instances/:id`，提交 `{ revision, config, mode }`。只允许当前 profile 的所有者修改；活动/排队运行返回冲突，不隐式取消。宿主在空闲租约回收期间阻止新执行，确认退出、重新授权并确认提供方不变后以 revision/CAS 写入。更新创建新的配置 revision，保留既有运行历史；后续执行从新的原生会话开始，不自动跨配置复用旧 checkpoint。该接口不替代厂商原生登录或配置文件管理。

`AgentRunInput` 包含内容块、已授权历史/上下文引用、模型选择、预算、超时和必要的来源信息。host 私有 token、数据库行和任意 sessionMap 均不进入参数。原生多轮会话使用 checkpoint 恢复；恢复失败应返回可判断错误，不能悄悄重放有副作用的工具调用。

### 3.2 能力协商

| 能力组 | 字段示例 | 缺失时 |
| --- | --- | --- |
| 输入与输出 | text、images、files、streaming、reasoning | 预检拒绝不支持的输入；单次文本结果仍可用 |
| 原生状态 | persistentSession、resume、contextUsage、compact | 禁用对应操作，明确恢复语义 |
| 交互 | approvals、clarifications、steering、queueInsertion | UI 不提供不存在的控制；不伪造批准或插入成功 |
| 模型与模式 | scoped/global、模型目录、reasoning 参数 | 保持现有模式和原生配置优先级 |
| 工具接入 | MCP、Skills、工具事件、后台任务 | 仅在有实现和配置的情况下启用 |
| 管理 | detect、install、update、uninstall、login、config、terminal | 不支持时给出原因或明确手工操作方式 |

静态声明是最大支持集合，运行时探测形成当前实例的有效集合；插件不能通过探测扩大 manifest 授权。内置 Agent 同样受静态声明、平台授权及实例范围约束。与 OS、CLI 版本或模型有关的结果包含 provenance 和 revision。用户不能在请求中自报 capabilities。

`AgentManagementAdapter` 提供状态探测、安装/更新操作、配置文档、登录流程、模型列表、Skills/MCP 管理等可选能力。操作返回统一 operation/interaction 句柄和 DTO；原生 CLI 密钥、Home、配置覆盖规则由对应内置模块或插件处理。Studio 的共享 Skills 只读约定、global/scoped 边界以及人工安装策略必须保留。这里的原生管理操作不等于 Studio 插件包管理；Hermes/Ekko 继续提供原有引擎管理能力，不显示插件安装或卸载操作。

当前已实现的管理子集是 `management.inspect(input, context): Promise<AgentInspection>`。目录仅公开 `{ management: { inspect: true } }`，不会序列化函数。input 由宿主根据自有实例生成，包含 `instanceId/config/configRevision/mode`；context 使用独立短期资源作用域，没有当前聊天身份或领域服务。HTTP 入口为 `POST /api/studio/agent-instances/:id/inspect`，不接收配置、路径、owner 或 provider 覆盖。要求实例空闲；检查期间拒绝新运行及配置修改，不创建 Run、checkpoint 或原生聊天会话。

检查结果仅允许原生名称/版本、认证状态及方法 ID/名称、模型 ID/名称/默认项/推理级别，并附宿主 provider/configRevision 快照。认证状态区分 `authenticated/required/not_required/unknown`；模型发现区分 `available/unsupported`，不会把未知当成未登录或空目录。适配器不得借检查执行登录、刷新凭据、推理或改写配置。结果上限 256 KiB、512 个模型、32 个认证方法；宿主检查字段、重复 ID 和大小。并发上限 16，执行期限 25 秒；撤权、取消、断连和关闭均回收资源。取消后最多等待 5 秒确认回调与受管资源清理，不合作的 worker 会被终止；清理未确认时保留实例占用，不能启动下一轮。

Codex 使用 `account/read`（`refreshToken: false`）和有界分页 `model/list`，不返回账号标识、原生 Home 或秘密。Qwen 仅执行 ACP v1 initialize，投影客户端信息和认证方法；该握手不提供当前认证状态，无会话模型发现不支持。登录/退出、配置文件、安装升级、终端、Skills/MCP 管理与相应交互仍未实现，不将此检查接口计为完整原生管理迁移。

### 3.3 一个最小插件

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
  "activation": "profile",
  "contributes": {
    "agents": ["acme.research/assistant"],
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

`uninstalling → removed` 仅适用于 user 安装；system 安装禁止进入卸载状态。首次启动和升级迁移根据受信任随包清单幂等登记全部 14 个系统插件，校验工件并保留已有配置、实例、授权和 profile 启停选择。缺少原生 CLI 或登录仅影响运行就绪状态，不能使插件安装记录消失；随包工件损坏则保留目录并报告诊断及修复路径，不降级成可删除的用户插件。

安装状态与各 profile 的启用状态分别持久化。安装前只读 manifest，不导入代码探测元数据；校验来源、摘要、依赖和平台后写入不可变 generation。生产依赖在 staging 中准备，默认不执行未知生命周期脚本；需要构建/原生依赖的工件必须有明确的安装策略和日志，不能隐式使用实时 `latest`。

激活时建立 worker、握手、加载入口、暂存所有贡献、验证依赖和能力，再原子发布目录 revision。任一步失败回滚该代注册并清理资源，不撤销其他健康插件。没有部分 Agent 已发布而其服务未就绪的状态。

### 8.3 升级和卸载

升级产生新 generation。新启动的 RuntimeSession 使用新版本；已有会话租约和活动 Run 固定旧 generation。下一轮切换必须验证 checkpoint schema、native session 兼容和配置迁移；不能把旧进程直接换成新工件。

旧 generation 在租约归零后回收。用户可选择排空后切换，或显式取消其所有关联 Run 和 runtime 后切换。新版本激活失败保持旧版本可用；旧版本数据 schema 已发生不可逆改变时禁止自动回滚。

数据迁移作用于版本化快照/独立命名空间。发布前确保旧代仍在运行时不会同时写不兼容数据；不支持并行读写的迁移必须先排空。持有原生会话的外部文件兼容性也纳入判断，不能只回滚插件目录。

停用先撤销新调用入口，再排空或取消已有执行、停止计划触发、清理订阅与服务、关闭 worker 和受管子进程。系统插件也可按 profile 停用，但保留安装工件和静态目录。用户插件卸载检查权限、安装策略、依赖和租约，默认保留插件配置/数据、历史 Run 和消费游标；“清除插件数据”是单独操作，不影响 Studio 会话历史和用户原生 Home，也不能删除系统插件安装定义。

系统插件默认版本随 Studio 发布清单更新，替换工件必须通过受信任的系统更新/修复路径；普通同 ID 安装不能覆盖它。更新与回滚沿用上述租约和数据兼容规则，保护策略始终保留。垃圾回收只清理无租约且不再承担当前版本/回滚保留职责的旧 generation，不能清掉当前系统插件或将其标记 removed。

## 9 Worker RPC 与运行环境

宿主与 worker 使用独立控制通道，stdout/stderr 只作日志。callback 和 factory 不直接 JSON 序列化，由 SDK 注册 handler ID，通过 RPC 分发。握手校验协议 major、工件摘要、generation、profile 和声明能力。

RPC envelope 包含 request ID、method、scope handle、deadline 和关联 trace。scope handle 由宿主发放并在连接/generation/生命周期内绑定，worker 不能通过修改 payload 伪造主体。AbortSignal 和流通过 ID 映射控制消息，不传递进程内对象。

文本流采用有界窗口和确认序号，支持批量发送；流发送者必须遵守 backpressure。超过窗口、帧大小或持续不确认时中断对应调用并给出诊断。文件与图片使用受控 artifact 引用，不在控制通道反复传大块 base64。

worker 崩溃使租约失效，当前 Run 标记 interrupted，未确认 RPC 明确失败。只自动重建无副作用的 worker 基础设施；不能自动重跑已经接受的 Agent 输入。历史 Run 通过宿主持久化日志恢复观察，只有运行时声明并验证原生恢复能力时才允许继续。

插件使用标准 Node/Electron Node-mode runner。新托管 MCP 启动必须显式设置 `ELECTRON_RUN_AS_NODE=1`，不能污染桌面 GUI 的环境。跨平台命令使用参数数组，Windows shim、PTY、Unicode 路径和进程树退出纳入验证。

协议驱动依赖 SDK 的 ProcessHandle、字节流和取消接口。宿主的原始 ChildProcess/PTY 对象不跨 RPC；stdout、stdin、resize、exit 等映射为句柄操作。厂商必须写入原生 auth 配置时，插件提交受控配置模板与 secret reference，由获准的宿主执行环境注入；确需明文秘密的插件能力单独授予，不能借运行准备读取整个平台凭据。

当前已实现 runtime `processes.spawn` 和管道 `ProcessHandle.read/write/end/stop/dispose`；读取为有界长轮询，返回 stdout/stderr 字节、截断标志与退出结果，空批次不表示 EOF。身份、runtime 生命周期和能力来自宿主；PTY/resize、秘密注入及厂商驱动切换仍为后续范围。实现限制和退出语义见[受管进程实施记录](studio-plugin-progress.md#t05-进展runtime-受管管道进程)。

当前 runtime 还提供 `mcp.connect(McpConnectInput)`，插件须声明并获授 `mcp.connect`。此权限包含启动 MCP 子进程或连接显式 HTTP 端点及调用工具；不自动扩展账户或 profile 凭据。stdio 使用 `{ type: 'stdio', command, args, cwd, env? }`，HTTP 使用 `{ type: 'streamable_http', url, headers? }`，可选 `timeoutMs`（100 ms–300 秒，默认 30 秒）和 `supportsParallelToolCalls`。

返回句柄通过 `listTools()` 读取模型可用的工具定义，通过 `callTool(name, arguments)` 取得文本、图片及 JSON 结果，`dispose()` 等待连接实际关闭。非法模型工具名沿用公共 MCP 提供者的代理工具表示，调用方应使用返回的工具名和 schema。连接归 runtime 租约所有，可跨成功轮次复用；其他用户/runtime/hook 不能借用。宿主和 RPC 前后重查授权，空闲撤权也会回收连接；关闭后迟到的结果不再交付。调用失败不自动重发可能已有副作用的工具。

每个 runtime 最多 16 个连接，宿主最多 64 个；默认单个进行中请求，显式允许并行时最多四个。工具定义最多 256 个，输入最多 128 KiB，DTO 结果最多 512 KiB，stdio 帧和 HTTP 响应流最多 1 MiB。HTTP 不跟随重定向。取消连接、工厂失败、worker 退出和 runtime 清理均等待所持连接及请求结算，未确认的清理保留租约隔离。旧厂商原生配置注入、平台交互凭据绑定和 MCP resources/prompts 等其他协议操作仍需后续迁移。

## 10 配置和权限

权限至少区分安装管理、类型贡献、领域读写、事件订阅、hook、路由、模型调用、文件、受管进程、网络和秘密引用。授予范围包含 plugin、generation 策略、profile、owner/用户范围和必要的资源约束；新版本增加能力时需重新满足授予条件。

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
