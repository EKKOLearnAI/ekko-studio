# DSH 实施任务与验收契约

日期：2026-09-12

状态：规划 v0.2，已有原生预设清单、附加 ACP 包管理与 Web 后端配置/预设用于 ACP 的局部实现，范围和限制见[当前实现](dsh-plugin-management-implementation.md)；完整 M1–M3 尚未完成；T01/T02 首轮后端实验已通过，范围见[兼容性证据](dsh-compatibility-evidence.md)。作为[主规划](dsh-profiles-and-plugins.md)的实施附件，随 [PR #3011](https://github.com/EKKOLearnAI/ekko-studio/pull/3011)维护。下文 API、事件名、错误码及测试文件名均为拟议契约；源码核对不等于运行测试通过。

## 1. 本轮收敛的技术决定

| ID | 决定 | 依据与状态 |
| --- | --- | --- |
| D01 | 配置来源与启动入口分离；用户可选 Web 来源，Studio 启动自有 ACP 组合 | 最小后端组合已通过 M0；完整来源转换仍待 M1 |
| D02 | 一 owner 一进程一根原生会话；不按模型或 Profile 跨 owner 共享进程 | M0 已证明同进程状态保持；生产 owner 接入待 M2 |
| D03 | 预设只能在工厂 setup 中 mount，子 Agent composeFrom 父组合 | M0 已验证创建/恢复挂载；子 Agent 继承仍待 T06 |
| D04 | 默认准备版本固定的 Studio ACP 适配插件；官方将来提供等价接口再替换 | M0 已记录发布 API、MIT 许可及所需补丁；生产源码适配仍待实施 |
| D05 | 初版不自动继承 Web 浏览器执行能力，不自动导入官方会话历史 | 范围确定；后端兼容性不能替代浏览器验收 |
| D06 | 包修改产生新 revision，运行中的实例继续持有旧 revision | 设计确定；不得原地修改活动依赖 |
| D07 | 后端完成以输出排空、持久化屏障及 Studio 记录完成为准，不以子进程退出为准 | M0 已证明非销毁式 flush 后强杀可恢复；Studio 完成事务仍待 M2 |
| D08 | 浏览器优先尝试隔离页面复用官方客户端；不直接在 Vue 主页面执行插件 | 首选方案；仅 M0-C 实验通过后锁定交付实现 |

完整支持需要逐一回答四个问题：配置是否被继承、预设是否实际绑定、插件后端是否可运行、浏览器部分是否有可用载体。UI 和发布说明不得将四个答案压缩成一个“兼容 DSH”开关。

## 2. 第一版边界与用户路径

### 2.1 首次复用 Web 配置

1. 用户进入 DSH 设置，选择“使用已有配置”，指定后端机器上的 Home。
2. Studio 只读列出 Profile、预设元数据、插件来源；尚未加载的项目标为“未验证”。
3. 用户选 Web Profile 和具体预设。解析报告列出有效工具、Skills/MCP 来源、Studio 覆盖和不支持的能力。
4. 执行兼容性验证，成功后发布组合 revision；缺依赖或预设绑定失败时留在原页并保留选择。
5. 创建聊天时固定 source、Profile、preset、模型模式及 revision。首条消息启动对应 owner 的实例。
6. 第二条消息复用实例；面板明确区分“本轮已结束”和“运行环境仍在运行”。

第一版不直接管理官方 Desktop 自有 Profile，不默认修改用户 Home，不自动启用未验证的第三方组合。现有 ACP 用户无需先迁移或安装插件才能继续聊天。

### 2.2 能力处理矩阵

| 情况 | 第一版结果 | 后续可用路径 |
| --- | --- | --- |
| 基础 ACP，无预设 | 使用现有行为和新增多轮能力各自的兼容分支 | 用户可显式迁移到已验证来源 |
| 已验证 Web 来源 + 预设 + 无浏览器要求 | 正常运行 | 同一配置支持群聊与无交互工作流 |
| 双端包，后端已证明可独立工作 | 后端可用，浏览器部分显示未启用 | M4 启用官方兼容载体 |
| 后端工具必须等待浏览器 | 不发布该不可用工具，或调用时返回明确不支持；不能无限等待 | 启用已验证浏览器模式后重新建立能力目录 |
| 第三方包的依赖、表达式或入口无法判定 | 不发布新组合，保留报告和旧 revision | 补充兼容规则或使用其官方运行环境 |
| 本地只安装普通 npm 依赖 | 显示为依赖，不自动冒充插件实例 | 由有效 bundle/patch 明确引用 |

原始 source 内容始终可查看，但浏览器代码、完整 settings 和凭据不能通过诊断 API 无筛选返回。

## 3. 解析结果与 API 契约

### 3.1 解析是一份可解释的结果

`POST /api/coding-agents/dsh/config/resolve` 只处理登记过的 `sourceId`。浏览器不能通过任意路径参数让解析器访问其他 Home。参数包括 selection、期望 source revision 和 Studio override revision。

结果至少包括：

```ts
interface DshResolution {
  resolutionId: string
  revisions: DshResolvedRevision // 主规划定义的字段
  effectivePresetId: string | null
  compatibility: 'ready' | 'unverified' | 'blocked'
  capabilities: {
    presetBinding: boolean
    persistentSession: boolean
    flushBarrier: boolean
    browserRuntime: boolean
  }
  diagnostics: Array<{
    code: string
    severity: 'info' | 'warning' | 'error'
    scope: 'source' | 'profile' | 'preset' | 'plugin' | 'runtime'
    entryId?: string
    message: string
  }>
  effectiveEntries: Array<{
    entryId: string
    scopeId: string
    module: string
    sourceLayer: string
    configuredEnabled: boolean | 'conditional'
    containsBrowserPart: boolean | 'unknown'
    compatibility: 'ready' | 'unverified' | 'blocked'
    runtimePhase: string | null
  }>
}
```

上例省略敏感配置值，不表示所有配置都可通过列表返回。`runtimePhase: null` 不等于失败；没有活实例时只有静态配置状态。`capabilities` 来自该组合、版本和实例的验证，不接受客户端自报。

来源变化、插件删除或 override 改动使旧 resolution 失效。保存与启动均验证 revision，不能显示方案 A 的预览，却启动后来变化的方案 B。

### 3.2 保存、安装和错误响应

写操作使用 `If-Match` 携带目标 revision；不匹配返回 `412`，要求缺失时返回 `428`。用户保存草稿的目标还要明确为 Studio 覆盖或显式来源写回，不能从当前页面猜测。

包操作示例：

```json
{
  "target": { "sourceId": "registered-source", "sourceProfile": "web", "writeTarget": "studio" },
  "action": "install",
  "packageSpec": "@example/dsh-tools@1.2.3",
  "idempotencyKey": "client-generated-request-id"
}
```

服务器将逻辑目标映射到 Studio 管理的 staging Profile；该示例不表示直接往用户的 `profiles/web` 安装。接受后返回 `202` 和 operation ID，新增 `GET /api/coding-agents/dsh/plugin-operations/:operationId` 查询进度。

同一幂等键和同一请求返回同一 operation；同键不同请求返回 `409`。请求重试或网络断开不能重复执行安装。服务器重启后只能依据发布记录恢复 operation 状态，不能无条件重新执行包管理命令。

| HTTP | 稳定错误码示例 | 行为 |
| --- | --- | --- |
| 400 | `DSH_SELECTION_INVALID` | 非法 Profile、字段或包 spec；执行前拒绝 |
| 404 | `DSH_SOURCE_NOT_FOUND` | 来源已删除或当前用户不可见；不返回其他来源路径 |
| 409 | `DSH_OPERATION_CONFLICT` / `DSH_RUNTIME_BUSY` | 同一目标正在修改或运行状态不允许切换 |
| 412 | `DSH_REVISION_CHANGED` | 外部 Web 或另一个页面已修改来源，返回可重新读取的 revision |
| 428 | `DSH_REVISION_REQUIRED` | 缺少必需的 If-Match；重新读取目标 revision 后提交 |
| 422 | `DSH_PRESET_UNAVAILABLE` / `DSH_CAPABILITY_UNSUPPORTED` | 配置格式正确，但不能建立请求的能力 |
| 503 | `DSH_RUNTIME_LIMIT` / `DSH_DEPENDENCY_UNAVAILABLE` | 资源或 CLI/pnpm 不可用，可修复后重试 |

响应还包含 `retryable` 和脱敏 diagnostics；UI 不通过英文异常字符串猜错误类型。已有 auth 负责身份认证与资源可见性，DSH 服务不另造宽松的旁路。

## 4. 进程、轮次和浏览器事件契约

### 4.1 所有权与并发

owner key 由服务器根据现有授权上下文构造，至少区分单聊 session、群聊 room/member、工作流 execution/node。配置 revision、工作目录、模型路由是该 owner 实例的固定属性，而非跨 owner 复用的理由。

- 相同 owner 的首次启动采用 single-flight；两个同时到达的消息不能各自启动进程。
- 同一根原生会话最多执行一个主动 prompt，其余消息进入现有队列，不并行调用 ACP prompt。
- 运行时的关闭与启动互斥；关闭完成后才发布新的 generation。
- 多标签页共用同一服务端实例，不各自持有一个 DSH 进程。权限撤销后旧页面的实例控制能力失效。
- group/workflow 重试必须区分“恢复同一原生历史”和“重放节点副作用”。采用现有重试政策，不借进程恢复自动重发已完成工具调用。

### 4.2 能力握手

标准 ACP `initialize` 继续按标准处理；Studio 插件增加可版本协商的私有能力查询，例如 `_ekko/capabilities`，返回扩展版本、支持的预设绑定、事件标识、flush 屏障及浏览器通道。

方法名为提案，不是官方 ACP 已提供的方法。对方返回 method-not-found 时：基础 ACP 可继续；依赖私有能力的 Web 预设或浏览器模式明确失败，不自动降成另一个工具集合。第三方未经声明的字段不能被解释为同一扩展版本。

### 4.3 事件归属与完成顺序

新增扩展事件至少携带以下逻辑标识；具体字段与原生流事件映射在 M0 验证：

```ts
interface DshEventIdentity {
  runtimeId: string
  generation: number
  nativeSessionId: string
  sequence: number
  studioRunId?: string
  nativeTurnId?: string
  attemptId?: string
  pluginId?: string
  pluginRequestId?: string
  pageId?: string
}
```

`studioRunId` 的绑定由服务器建立。只有 session、generation 和本轮映射均匹配的事件进入聊天增量；插件后台事件、子 Agent 事件和浏览器状态走独立通道。现有流式扩展只有 session/attempt 等部分信息，多轮重构须升级协议，不能假设当前格式已经解决跨轮归属。

一轮完成顺序：

```text
原生 prompt 结算
→ 该轮 ACP/扩展输出排空到确定的事件序号
→ 非销毁式原生持久化屏障
→ Studio 历史与可用用量结算
→ 至多一次 run.completed / run.failed
→ owner 回到空闲并接收下一条队列消息
```

output 排空与屏障不能仅靠等待固定毫秒数实现。将失败尝试的 live prefix 与最终持久化消息区分：模型重试、取消或最终内容修正时，最终历史不能重复累加旧尝试；UI 可保留尝试状态，但不得把它当成新的已完成回复。

重新订阅插件通道先读取带序号的状态快照，再接续事件；发现序号缺口时重新读取快照，不从任意日志重放副作用。刷新页面不会重新执行 `cordis_run`。

### 4.4 取消和关闭

| 触发 | 行为 | 是否保留插件内存 |
| --- | --- | --- |
| 用户点聊天“停止” | 取消本轮，等待原生回到空闲，结算一次取消结果 | 原生可正常结算时保留 |
| 本轮模型报错 | 等待输出排空，报告本轮失败；验证会话仍可继续 | 原生会话健康时保留 |
| 取消无响应或协议损坏 | 标记实例不可复用，关闭并终止拥有的进程 | 不保留，显示中断 |
| 用户关闭运行环境 | 取消活动 prompt、关闭 session、EOF、必要时升级终止 | 不保留 |
| 网页刷新/退出页面 | 解除页面订阅和 page-local client 状态 | host 内存继续保留 |
| Studio 后端退出或桌面关闭触发后端退出 | 关闭所有本后端拥有的实例 | 不保留 |

初始工程超时预算提议：握手/创建 60 秒；取消等待 10 秒；session 关闭 10 秒；EOF 后终止宽限 3 秒。它们是可测试的上限，不是性能实测数据。prompt 不套用普通 60 秒 RPC 超时。实际值在 M0 根据跨平台结果调整并记录，不能将超时等同于成功取消。

## 5. 组合快照与更新事务

### 5.1 不能只“复制配置”

发布一个 revision 必须同时固定组合内容、依赖解析版本、预设资源、Studio 适配器版本和必要路径映射。还要记录缺失或未解析项目；包 manifest 不能取代完整的依赖锁定结果。

仅共享可证明不会被修改的包内容缓存。可写 settings、会话、插件状态、日志属于各 owner；不将来源 Home、运行目录或含凭据的 `.env` 硬链接到共享快照。符号链接、路径穿越和 Windows junction 必须在解析最终目标后执行规则，不能只检查字符串前缀。

凭据不属于公开 revision 内容，也不进入普通哈希诊断。只记录非敏感的凭据版本标识；凭据变化如何触发新实例或安全刷新有独立策略，旧实例不能因磁盘快照不可变而无限使用已撤销的凭据。

### 5.2 发布流程

```text
校验权限与期望 revision
→ 登记幂等 operation 并锁定逻辑目标
→ 创建 staging，执行包操作或配置变更
→ 静态解析、依赖验证、必要的显式启动测试
→ 再次校验来源 revision
→ 原子发布新 revision 与 active 指针
→ 完成 operation；原运行实例继续引用旧 revision
```

任何发布前失败均不改变 active 指针。发布后进程崩溃，重启从事务记录恢复“已发布”，不重复安装。维护操作锁超时、半写 manifest、安装子进程遗留和 Windows 文件占用均需要故障注入测试。

停止一个操作只能在定义好的边界中止；已经发布的操作不能伪称“取消成功”，应创建回退操作。快照 GC 只删除无运行实例、无 operation、无保留恢复引用的旧 revision；先回收临时文件，再回收历史依赖，不能删除用户来源。

## 6. 任务拆分与依赖

T01/T02 已完成固定 rc.1、macOS arm64 下的首轮原型与实验，维护决定和实际断言见[兼容性证据](dsh-compatibility-evidence.md)。T03–T16 仍待实施；实验完成不等于 M1/M2 生产接入完成。主要落点表示代码职责，不表示已经分配了子 Agent 或开发人员。

| 任务 | 交付物 / 主要落点 | 依赖 | 独立验收条件 |
| --- | --- | --- | --- |
| T01 / M0-A | rc.1 发布包 API 清单、组合差异报告、版本固定 ACP 适配原型；DSH services | 无 | 在工厂 setup 中挂载预设；缺 API 时产出明确维护范围，不能伪造成功 |
| T02 / M0-B | 同进程两轮、flush 与取消实验；真实 CLI fixture | 无 | PID/native session 不变；第二轮读到第一轮插件状态；kill 后已完成历史可恢复 |
| T03 / M0-C | 官方 client loader + runner 最小隔离页面实验 | T01 的有效 host 组合 | 双端插件一次 host.call 成功，拒绝后不运行，记录必需的 Remotes/slots |
| T04 / M1 | source catalog、revision 和迁移字段；coding-agents 服务及 Studio repository port | T01 | 旧会话默认基础 ACP；来源发现不执行插件，远程客户端选择后端来源 |
| T05 / M1 | 分层 resolver、相对路径锚点、包快照、有效报告 | T04 | 相同 revision 得到同一组合；来源变化使旧预览失效，删除文件不会残留 |
| T06 / M1 | preset adapter、Skills/MCP 来源、scoped 多模型约束 | T01、T05 | 实际模型请求含预设工具/Skills；子 Agent 继承同一组合代 |
| T07 / M1 | 来源、预设页面与单聊选择 | T04–T06 | 选项、错误及实际运行一致；明确区分静态启用与 live 状态 |
| T08 / M2 | 持久连接和每轮请求拆分；`acp-turn.ts` 后续模块与 DSH runner | T02、T06 | 首次 initialize 后多轮复用；第二轮不被旧通知污染 |
| T09 / M2 | 独立的 prompt 完成/关闭、owner 锁、取消及代理寿命 | T08 | 队列能继续，取消后可继续，退出只终止本服务拥有的实例 |
| T10 / M3 | plugin operations、staging、事务恢复、包/实例清单 | T05、T09 | 更新失败保留旧版本；活动实例不受卸载或更新原地破坏 |
| T11 / M3 | 插件页面、实例配置、来源写回与 revision 冲突 UI | T10 | 并发保存给出冲突且保留草稿；不修改其他 Profile |
| T12 / M4 | 私有能力协商、浏览器桥接、隔离页面构建与授权 | T03、T08–T09 | 主应用凭据不进入插件页面，跨 owner 调用被拒绝 |
| T13 / M4 | 动态插件面板、允许/拒绝、刷新、更新、停止与错误回传 | T12 | 双端状态可解释，多页面请求只结算一次，渲染失败回到同一会话 |
| T14 / M5-A | 群成员与无浏览器工作流接入、导入导出 | T06、T09–T11 | execution/member 隔离，导出不含本机 Home 和凭据 |
| T15 / M5-B | 明确等待用户的工作流浏览器节点 | T13、T14 | 等待、超时、取消和恢复均有定义；无人值守任务不被默默挂起 |
| T16 / 发布 | 兼容表、三平台验证、回退操作、用户文档及其他 Agent 回归 | 对应发布范围内全部任务 | 验收记录可复现；未验证功能不打开默认开关 |

建议提交顺序为：M0 证据与适配决定 → 来源/预设及单聊 → 持续会话 → 原生插件管理 → 无浏览器三入口 → 浏览器运行层与交互三入口。后端首版不必等待 T03、T12、T13、T15，但不能宣称已实现它们。

## 7. 可复现验收场景

每项在实施时附测试命令、DSH/平台版本、fixture revision、断言与日志位置。下表是生产发布的完整场景；M0 的局部实验结果见证据文件，不将整项生产验收标为通过。

| ID | 前置条件与动作 | 必须观察到的结果 |
| --- | --- | --- |
| A01 | Home 中有不同 web/acp patch；选择 Web 来源，启动 Studio 会话 | 有效设置来自 Web；ACP 可交互；官方 Web 端口没有被占用或关闭 |
| A02 | Web 预设包含只有该预设才有的测试工具和 Skill，分别创建/恢复会话 | 两条路径的真实模型输入均包含正确工具及 Skill 内容；基础 ACP 不冒出这些能力 |
| A03 | 第一轮定义递增计数的 host 插件，第二轮调用；记录 PID 和 native session | 同一实例返回递增值，初始化只发生一次，不通过历史工具重放实现 |
| A04 | 第一段模型 SSE 后阻塞最终响应；先检查 UI，再解除阻塞 | UI 提前显示增量；最终只出现一次文本；模型失败重试不把失败尝试写成重复最终回复 |
| A05 | 本轮工具执行中点击停止，再发消息 | 正常取消时下一轮继续使用同一实例；取消超时时明确关闭并提示状态中断 |
| A06 | prompt 返回并通过 flush 屏障后强杀子进程，再恢复 | 已完成历史存在；插件定义显示中断，不自动重放插件代码 |
| A07 | 两页面读取同 revision，页面 A 保存后页面 B 保存 | B 收到 412，保留草稿；active 指针只有 A 的 revision |
| A08 | 插件升级中模拟 pnpm 失败、服务器退出和发布后退出 | 失败前的 active 可用；恢复不重复安装；发布后恢复到新 revision |
| A09 | 浏览器模式关闭时尝试运行必须带 client 的动态插件 | 返回不支持并完成本轮，不等待隐藏的允许按钮、不假称浏览器运行成功 |
| A10 | 浏览器模式开启，允许后交互、刷新、修改版本、停止 | host/client 状态按各自生命周期变化；回调归属正确；资源和订阅被清理 |
| A11 | 两个页面同时回应一个允许请求，再用旧 request ID 重试 | 只结算一次；迟到请求无副作用；授权不会扩展到其他插件或版本范围 |
| A12 | 群成员 A/B 同名插件、不同预设；两个工作流 execution 使用同一节点 | 插件状态和消息不串成员/执行；结束执行不影响群成员实例 |
| A13 | 原生配置含额外模型路由，scoped 会话触发子任务或压缩 | 使用明确允许的 Studio 路由，或显式失败；不借来源凭据自动切换计费渠道 |
| A14 | 启动用户自己的 DSH Web，再运行/停止 Studio；最后退出 Studio | 用户 Web 仍存活；Studio 创建的进程树回收；没有残留运行锁或代理授权 |
| A15 | 同时运行其他 Coding Agent，执行原有恢复、取消、MCP 和输出测试 | 其他 Agent 不进入 DSH 私有协议、Profile 或生命周期分支 |

## 8. 发布门槛与下一步

后端首版的必要门槛：T01–T02、T04–T11、T14 完成，A01–A09、A12–A15 通过；其中 A09 验证浏览器关闭时的正确拒绝。浏览器版另外要求 T03、T12–T13 和 A10–A11 通过；工作流浏览器节点还需 T15。

每个版本发布前均须完成 T16 中适用于该发布范围的兼容记录、平台验证、回退说明和回归检查；尚未验证的平台或能力明确标为未支持。

版本兼容表必须按“实际 DSH 版本 + 平台 + 配置来源类型 + 后端/浏览器能力”记录。已安装版本高于已验证版本时标成未验证，不能仅按 semver 大小认为兼容。缺能力时保留现有基础 ACP，不静默伪装完整 Web 支持。

性能记录至少包含冷启动、首段延迟、两轮之间等待时间、空闲进程内存、取消与关闭耗时。多轮测试必须断言轮次之间没有 spawn、重复安装或整目录复制；模型响应时间单独统计，避免误判适配器开销。实例数量上限根据 M0 测量确定并配置化，首版不通过无提示淘汰活动插件来维持上限。

T01/T02 首轮实验现由 `dsh-m0-real.test.ts` 和独立锁定的 fixture 提供，已证明预设绑定、同进程状态保留、取消后继续及 flush 后强杀恢复。下一步进入 T04/T05；尚未验证的完整来源、平台、辅助模型及浏览器能力不据此放行。原有 `dsh-acp-real.test.ts` 仍是单轮进程/跨进程恢复基线。

已新增证据文件 `docs/planning/dsh-compatibility-evidence.md`，记录实际发布 API、最小组合差异、flush 实验和浏览器未验证状态。后续证据不通过就保持对应任务待完成，不把这份规划自身作为验收成果。

文档修订的完成条件是两份规划相互一致、链接有效、阶段边界明确，并提交到现有 PR；不要求在本次文档任务中执行任何安装或真实模型调用。
