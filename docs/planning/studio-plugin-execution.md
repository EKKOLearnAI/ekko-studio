# Studio 插件体系实施与验收计划

日期：2026-10-23

状态：规划 v0.3，实施中。源码基线为 `8f215f59d`；实际进度和未完成项见[实施记录](studio-plugin-progress.md)。与[架构总案](studio-plugin-architecture.md)、[接口契约](studio-plugin-contracts.md)共同定义完整交付范围。

## 1 交付方式与约束

本项目完整迁移后作为统一架构发布。任务编号表示工程依赖和可审查的提交边界，不表示可以把任意中间状态宣布为插件化完成。

插件化范围为 14 个 Coding Agent 及后续第三方扩展。Hermes/Ekko 保留内置模块、现有引擎发布方式和原生管理，只接入统一 ctx、Agent 契约及运行协调器；不交付二者的 Studio 插件包。

这 14 个 Coding Agent 全部为随 Studio 默认安装、不可删除或卸载的系统插件。第三方插件按用户安装策略管理。默认安装指 Studio 插件包；原生 CLI 的手工安装、登录和凭据规则不变，安装状态、profile 启停与运行就绪分别呈现。

开发期允许只在隔离环境使用旧实现适配器和切换开关，用于建立行为对照。一次真实输入只能进入一条执行链，禁止为比较输出而向两个真实 Agent 重复发起有副作用的请求。协议录制 fixture 可以离线对照，两条生产业务链不能长期保留。

本计划不预估未经测量的固定工期。T00 产出每个模块的工作量、依赖和风险评估后再安排里程碑；任何缩减完整交付范围的决定必须修改本计划及完成标准，不能在实施中悄悄把剩余迁移改称“后续优化”。

## 2 现有功能迁移归属

| 当前职责 | 最终位置 | 保留的行为 |
| --- | --- | --- |
| CLI 安装发现、登录、配置文件、厂商模型目录 | Coding Agent 插件的 management/config；Hermes/Ekko 保留各自内置管理实现 | 手动安装限制、global/scoped、原生配置优先级和登录流程 |
| 通用进程启动、PTY、Windows shim、退出树 | 平台受管进程服务和 SDK 句柄 | 参数数组、退出超时、重启和非 ASCII 路径 |
| ACP/JSONL 等协议传输 | 独立驱动库 | 协议帧、断线、超限输入和权限请求语义 |
| 厂商事件解析、参数、原生恢复/压缩 | 对应 Coding Agent 插件或 Hermes/Ekko 内置运行适配 | 原生会话、上下文恢复、特殊用量格式 |
| 消息、工具结果、Run 状态、usage、工作区差异 | 统一运行协调器及领域服务 | 唯一落库、持久化屏障、幂等终态 |
| HTTP/Socket/App 协议和旧字段 | 核心传输/兼容适配 | 已发布协议可用、客户端断线不误取消后台任务 |
| 群聊、工作流、全局 Agent 的调度 | Studio 领域编排 | 预算、队列、节点证据、参与者权限和任务回传 |
| MCP/Skills 注入 | 平台提供作用域资源，内置模块或插件适配各自原生配置 | Studio 交互上下文、共享 Skills 只读、独立环境和凭据清理 |
| 推送、Webhook、插件通知 | 统一事件来源加消费者投影 | 目标隔离、重试和幂等；不重复发布 |
| 主题、媒体、设备、文件、模型等其他后端能力 | 对应领域服务加 ctx 门面 | 原有权限、路径、资源和用户确认策略 |

### 2.1 Coding Agent 插件迁移清单

“迁移完成”包含类型定义、配置、管理、执行、事件、原生状态、测试和工件；不能只移动 definition 文件。下表的特殊关注项来源于当前目录和调用链，完整功能开关以 T00 冻结的证据矩阵为准。

| Agent | 当前专属源码 | 必须核对的行为 |
| --- | --- | --- |
| Claude Code | [claude-code](../../packages/server/src/modules/coding-agents/services/claude-code) 及共享运行器分支 | 流式协议、scoped/global、代理、原生恢复、审批、配置和系统提示词 |
| Codex | [codex](../../packages/server/src/modules/coding-agents/services/codex) 及共享运行器分支 | auth/TOML、代理、恢复、压缩、reasoning、累计与修正用量 |
| Pi | [pi](../../packages/server/src/modules/coding-agents/services/pi) 及共享运行器分支 | RPC/JSONL、thinking、运行内交互、压缩、队列和持久化 |
| Grok | [grok](../../packages/server/src/modules/coding-agents/services/grok) | 原生会话发现、turn process、事件转换和模型配置 |
| OpenCode | [opencode](../../packages/server/src/modules/coding-agents/services/opencode) | 原生服务、turn/事件连接、运行配置、依赖、错误传播 |
| DSH | [dsh](../../packages/server/src/modules/coding-agents/services/dsh) | ACP、源 Profile、原生插件/预设、管理进程、浏览器配置面板和用量 |
| Cursor | [cursor](../../packages/server/src/modules/coding-agents/services/cursor) | global-only、手动安装、原生 MCP、会话命令和不支持的 compact |
| Antigravity | [antigravity](../../packages/server/src/modules/coding-agents/services/antigravity) | 手动安装、scoped/global、凭据来源、图片和事件转换 |
| Qwen Code | [qwen](../../packages/server/src/modules/coding-agents/services/qwen) | 标准 ACP、scoped 配置、环境探测 |
| Kimi Code | [kimi](../../packages/server/src/modules/coding-agents/services/kimi) | 标准 ACP、配置和环境准备 |
| CodeBuddy | [codebuddy](../../packages/server/src/modules/coding-agents/services/codebuddy) | ACP、模型 API 模式和配置映射 |
| Qoder | [qoder](../../packages/server/src/modules/coding-agents/services/qoder) | global-only、平台检查、ACP |
| GitHub Copilot | [copilot](../../packages/server/src/modules/coding-agents/services/copilot) | 登录、模型、运行环境、ACP 和 API 模式 |
| ZCode | [zcode](../../packages/server/src/modules/coding-agents/services/zcode) | 手动安装、专属 turn 路径、原生恢复和当前能力限制 |

### 2.2 内置 Agent 接入清单

以下两项仍纳入功能回归，但保留内置实现与直接工厂注册，不进入插件打包、worker 和包生命周期验收。

| Agent | 保留的源码位置 | 必须核对的行为 |
| --- | --- | --- |
| Hermes | [hermes](../../packages/server/src/modules/hermes) | Python bridge、原生 Profile/管理、历史、Skills/MCP、权限和运行时升级 |
| Ekko | [服务集成](../../packages/server/src/modules/ekko) 与 [引擎](../../packages/ekko-agent/src) | 规范库 API、模型/工具、记忆、Skills/MCP、后台任务、交互和上下文 |

Hermes/Ekko 由 bootstrap 注入统一目录，向协调器提供相同 `AgentRuntime` 接口及规范事件。原生运行适配是长期内置实现；只删除其中迁入协调器的重复持久化和广播逻辑，不要求移动到插件目录。DSH 与 Hermes 自身的原生插件都不是 Studio 插件，各套生命周期、依赖目录和版本要明确区分。

## 3 实施任务和依赖

下表定义任务及完成条件，实际状态以实施记录为准。代码、验证记录和清理项齐全后才能完成；仅新增类型或通过编译不能完成涉及业务迁移的任务。

| ID | 任务与交付物 | 依赖 | 完成证据 |
| --- | --- | --- | --- |
| T00 | 冻结现有能力矩阵、源码/运行时版本、协议 fixture、数据库样本、性能基线 | 无 | 14 个 Coding Agent 与 2 个内置 Agent 的功能/入口/平台清单，标明支持、明确不支持和待验证项 |
| T01 | SDK DTO、schema、Agent/Run/事件契约、公共错误、模块边界和版本规则 | T00 | 独立包编译、正反向 schema 测试、边界检查拒绝私有导入；文档与 schema 对应 |
| T02 | 领域服务与执行上下文 factory；迁出 controller/Socket 内的通用业务用例 | T01 | 每个 ctx namespace 有实现映射、权限/副作用表；HTTP 与直接调用结果一致 |
| T03 | 插件 worker、RPC、作用域、注册事务、依赖图、资源清理 | T01、T02 | 激活失败回滚、跨 scope 拒绝、背压和崩溃回收测试 |
| T04 | 类型化事件、事务事件表、通知、可靠消费、hook、旧投影 | T01、T02 | 提交屏障、重放、幂等、队列溢出、hook 超时及授权测试 |
| T05 | 提取共享进程/MCP/模型调用能力和协议驱动 | T01、T02 | 通用库不依赖厂商分支；保持运行参数、环境和 MCP 凭据隔离 |
| T06 | 统一运行协调器、内置工厂/插件代理接入、runtime lease、输出归并、交互、取消、用量和恢复 | T02、T03、T04、T05 | 同一 Run 单一写入者；状态机竞态、完成屏障和故障测试；启动不依赖插件 worker 存活 |
| T07 | 开放 Agent ID、动态目录、实例、历史别名映射及安装策略投影 | T01 | 未知类型、别名、缺失插件和历史读取测试；保留系统类型定义，无固定枚举执行路由 |
| T08 | 迁移首个 ACP Agent 与 Codex 复杂样例，修正契约 | T05、T06、T07 | 两种不同协议达到冻结功能基线；独立工件无 server 私有依赖 |
| T09 | 完成其余 Coding Agent 的独立包和管理适配，全部纳入系统分发清单 | T08 | 全部 14 个逐项签收且默认安装、不可卸载，旧厂商实现的搬迁/删除清单为零遗漏 |
| T10 | Hermes/Ekko 内置模块接入统一契约、后台任务与原生管理 | T06、T07 | 保留原生功能和内置生命周期；插件宿主停用时仍可用，共用协调器且无重复写入 |
| T11 | HTTP/Socket、群聊、工作流、全局任务及 Web/Desktop/App 目录接入 | T07、T08 | 五类执行入口和动态管理界面验收；旧协议投影兼容 |
| T12 | 系统插件自动安装与删除保护、用户插件安装卸载、升级、数据迁移、诊断和发布工件 | T03、T04、T05、T07 | 14 个系统插件随包安装，所有入口拒绝删除；排空升级、失败回滚、用户插件卸载保留历史，三种分发形式通过 |
| T13 | 真实数据副本迁移演练、跨平台运行验收、容量和兼容测试 | T09、T10、T11、T12 | 验收矩阵全部关闭；迁移与回滚报告、性能对比和兼容报告 |
| T14 | 删除临时适配及旧执行路径，完成独立开发者样例和发布验收 | T13 | 清理检查通过，外部样例接入无需改核心；最终 broad checks 与工件验证通过 |

实现中可以按依赖并行推进模块。对共享数据库、SDK 或运行协调器的改动需由同一契约 revision 约束，避免各模块自行定义不兼容字段。

T06 对 T03 的依赖表示需要完成插件代理集成，并非核心启动依赖插件 worker。内置工厂与插件代理是统一目录的两种提供方式；插件宿主故障后核心服务继续运行。T14 不删除 T10 保留的内置模块和长期运行适配。

### 3.1 T00 必须冻结的内容

对每个 Agent 记录：提供方类型、CLI/引擎版本、内置实现版本或插件版本、OS/架构、安装与更新方式、scoped/global、登录和凭据来源、模型与 reasoning 参数、图片、恢复、compact、审批、澄清、插队、Skills/MCP、文件/差异、用量、断线、后台任务、五类入口和管理页面。

fixture 包括原始协议帧和对应规范输出，去除秘密与私人会话内容。多轮、异常退出、累计用量、重复工具结果和取消竞态必须有样本。涉及真实 CLI 且不能在当前环境验证的项标记 blocked，不用 mock 通过替代真实兼容性证据。

### 3.2 T02 的迁出标准

优先使用会话删除、启动 Run、工作流执行三个完整用例检验边界，再覆盖总案能力目录。每个用例记录：身份来源、资源读取、校验、事务、外部副作用、事件、补偿/恢复和最终响应。

例如 `sessions.remove` 需要搬迁目前 controller 中的原生清理、数据库删除、工作区记录处理和通知。若 HTTP 与 SDK 分别实现一遍这套流程，任务仍未完成。`runs.start` 不允许通过回连本地 Socket 或构造假 Koa ctx 执行业务。

领域服务可以继续使用现有 repository 和稳定引擎库；数据格式迁移与服务拆分分提交执行，便于判定行为差异。所有对外 ctx 方法的错误与取消语义必须可测试。

已完成会话单删/批删的服务迁出与 `ctx.sessions.remove` 接入专项核验，范围、限制及证据见[实施记录](studio-plugin-progress.md#t02-进展会话删除共用领域服务)。新 Agent 实例 HTTP 启动与 `ctx.runs.start` 也已共用领域服务，见[启动实施记录](studio-plugin-progress.md#t02-进展agent-实例启动共用领域服务)；只覆盖独立实例、文本输入及持久化回执。旧聊天启动、工作流和其余 namespace 继续保持未完成，T02 不整体勾选。旧聊天准入/排队/推送及失败清理现已迁入无传输对象的服务，原 Socket 通过端口注入执行器，见[准入实施记录](studio-plugin-progress.md#t02-进展旧聊天启动准入服务)。HTTP 的执行事件/等待结果端口现已接入，已移除本机 Socket 回环且未创建假 Socket，见[直调实施记录](studio-plugin-progress.md#t02-进展旧聊天-http-直接调用)。直调入口已补齐宿主 ExecutionScope、输入/身份快照和准入前取消，见[作用域实施记录](studio-plugin-progress.md#t02-进展直调入口的宿主作用域与输入快照)。旧聊天 SDK 的文本启动、持久化结果回执、owner 授权和定向取消已接入并有真实 worker 验证，见[SDK 实施记录](studio-plugin-progress.md#t02-进展旧聊天-sdk-接入)。旧宿主组合与原执行器暂存，不把内部调用者类型或假 Socket 适配暴露给 SDK；工作流等入口及完整统一运行继续保持未完成。

T02 为 Run 相关能力先建立应用服务端口和作用域约束，迁移期可注入旧实现以维持行为；T06 完成统一协调器后替换该实现。临时适配不能进入插件公共 API，最终由 T14 删除，避免让 T02 反向依赖尚未完成的 T06。

### 3.3 T08 和 T09 的职责交接

先从已有标准 ACP 路径较清晰的 Agent 建立独立包，再用 Codex 验证复杂恢复、配置、用量和控制能力。首个 Agent 只证明通用契约可运行；不能据此推断剩余 13 个已经可迁移。

每个 Agent 采用以下交接记录：

1. 定位其在 `services/index.ts`、`run-manager.ts`、聊天及工作流中的全部分支。
2. 为每项行为标注最终负责方：核心领域服务、协议驱动或厂商插件。
3. 插件输出规范事件，协调器接管对应写入和通知；同一次 Run 不双写。
4. 从旧路径删除已经转移的逻辑，并使用 fixture 比对副作用次数和内容。
5. 通过原有功能与独立包测试，再交接管理 API 和目录元数据。

共享的 ACP、PTY、Windows 进程工具可以被多个插件依赖。共享包不得再次形成按 `codex/pi/dsh` 分支执行全部业务的新大型运行器。

## 4 端到端验收矩阵

下表是未来实现的验收要求，不是已执行测试结果。每项记录关联提交、fixture/工件、平台、测试输出和残留限制。

| 编号 | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| A01 | 外部仓库只依赖发布 SDK，实现自定义 Agent | 打包装载后可发现、配置和运行；无需修改核心 enum 或分支 |
| A02 | 五类入口使用同一 Agent 实例 | 单聊、群聊、工作流、全局任务、API 均通过协调器，保持入口权限和预算 |
| A03 | 同时安装两个插件，注册相同类型或服务 | 冲突插件激活失败且回滚；已有插件继续可用 |
| A04 | apply 中先注册 Agent 后抛异常 | Agent、路由、事件、任务均不可见，无残留资源 |
| A05 | 回调、任务和 Run 跨 profile/用户访问资源 | 按授权拒绝，不因事件发起者是管理员而提升插件权限 |
| A06 | 两个用户并发运行相同模型 | ctx 元数据、原生会话、凭据、输出和用量不串用 |
| A07 | 各 Agent 原生恢复和配置变化 | 支持范围内延续正确原生会话；不支持的恢复显式失败，不重放副作用 |
| A08 | 工具、文本 delta、最终 snapshot、迟到事件 | 文本和工具结果不重复，旧 Run 事件不污染新 Run |
| A09 | result 提前到达，输出或 usage 延迟 | 等待完成屏障；持久化成功后只发布一个终态 |
| A10 | cancel 与完成同时到达 | CAS 决定唯一终态；取消确认符合原生实际结果 |
| A11 | 用户响应审批/澄清，重复或过期响应 | 只作用于绑定的 interaction/run/provider 引用/runtime lease；后台无人值守策略明确 |
| A12 | usage 增量、累计、最终和修正，包含 ctx.models | 同一模型调用只计一次，聚合与修正可解释 |
| A13 | worker 崩溃、原生 CLI 退出、核心重启 | Run 可诊断为 interrupted/failed，历史可读，无自动重复执行 |
| A14 | 普通通知回调超时/异常/队列溢出 | 主业务结果不改变，故障可观测，内存有界 |
| A15 | 可靠事件提交后进程崩溃、消费后确认前崩溃 | 可重放且允许重复，幂等消费不重复副作用；游标过期明确报告 |
| A16 | hook 修改输入、拒绝、超时、试图改 actor | 顺序稳定，允许补丁重新校验，越权字段拒绝，失败无业务副作用 |
| A17 | 插件升级时仍有多轮会话和活动 Run | 旧 generation 保持租约，新代按兼容策略接入；无热替换污染 |
| A18 | 安装中断、依赖缺失、恶意路径归档 | 半成品不执行，原有插件仍可用，路径不能逃逸 |
| A19 | 用户插件停用、卸载、重装 | 入口、任务、订阅和进程正确清理，历史及默认保留数据可读 |
| A20 | SDK/RPC/数据 schema 不兼容或升级失败 | blocked/rollback 原因可见，不运行不兼容实现 |
| A21 | 插件服务依赖循环、调用时提供者停用 | 激活失败或可判断 unavailable；不无限等待，不保留僵尸代理 |
| A22 | DSH 原生插件及配置页面 | 与 Studio 插件分层，现有管理和主题/会话行为保持 |
| A23 | 动态目录、缺失插件、旧会话、旧 App | 历史仍可读；未知 Agent 无静默替换；新客户端可选新类型 |
| A24 | MCP、Skills、模型授权、交互上下文 | 保留注入行为及适用范围；不向插件或日志广播秘密 |
| A25 | 干净的 Desktop/npm/Docker 安装 | 14 个系统插件全部默认安装，无需逐个添加或联网下载插件包；SDK、runner、内置模块、驱动和资源完整，原生引擎就绪单独判断 |
| A26 | Windows/macOS/Linux 的进程、PTY、Unicode 路径 | 支持平台上的行为符合基线，退出不遗留受管进程树 |
| A27 | 反复启停插件、长文本流、大文件和慢消费者 | 资源与内存有界，流可取消，不因慢订阅阻塞所有 Agent |
| A28 | 任务计划/会话目标、分享会话和后台回传 | revision、上下文有效期、owner 和原有使用入口限制保持 |
| A29 | 数据库迁移中断后重试与整库回滚 | 无半映射会话、丢失历史或重复任务；新旧二进制兼容边界清楚 |
| A30 | 随包 Coding Agent 插件和第三方样例静态依赖扫描 | 插件无 server 私有导入；Hermes/Ekko 遵守 server 模块边界，核心编排无厂商专属执行分支 |
| A31 | 插件宿主停用或故障清理后运行 Hermes/Ekko | 内置目录、执行、事件投递、原生管理和清理正常；无插件安装记录/generation，插件管理拒绝对二者执行包生命周期操作 |
| A32 | UI、HTTP、MCP、SDK、批量和 force 请求删除系统插件 | UI 无卸载入口；后端返回 SYSTEM_PLUGIN_PROTECTED，插件运行、工件、记录和目录不发生删除副作用 |
| A33 | 现有数据升级、重复启动、系统插件停用及原生 CLI 缺失 | 自动幂等登记全部 14 个插件，配置/实例/profile 启停选择保留；系统目录持续存在，CLI 缺失显示未就绪 |
| A34 | 系统插件更新、失败回滚、旧代回收与同 ID 覆盖安装 | 系统身份及删除保护不变；受管更新保留可用/回滚版本，普通覆盖安装被拒绝；用户插件仍可正常卸载 |

完整功能矩阵按“Agent × 支持的模式 × 支持的入口 × 平台”展开。原本不支持的能力使用明确 unsupported 验收；不能通过把原本支持项改为 unsupported 来规避迁移。

## 5 数据迁移与切换演练

新增数据的最小登记表：

| 记录 | 关键内容 |
| --- | --- |
| 插件安装与 generation | 来源、宿主确定的 system/user 策略、版本、摘要、SDK/RPC 范围、状态、工件位置 |
| profile 启用与授予 | 插件/profile、能力范围、owner/服务身份、配置 revision |
| Agent 实例 | type ID、实例 ID、owner/profile、配置和提供方归属 |
| 原生会话租约 | 实例、工作区、provider 引用、native resume 引用、有效状态 |
| Run 扩展 | 实例、provider 引用、配置/能力快照、终态 revision、外部操作关联 |
| 事务事件与消费 | 稳定 event ID、partition/sequence、投递游标、重试与死信 |
| 插件数据 schema | 插件/profile/generation 兼容范围、迁移状态、快照位置 |

provider 引用遵循接口契约的判别联合：Hermes/Ekko 记录内置实现版本；Coding Agent 和第三方插件记录 plugin ID、版本与 generation。数据库约束按提供方校验，不对内置记录要求插件外键。

切换步骤：

1. 在真实数据副本运行只读预检，统计全部会话、群成员、工作流快照和未知 Agent 标识。
2. 从随包清单幂等登记 14 个受保护的系统插件，建立既有类型/别名映射，保留原字段；为已有记录回填实例和配置引用，保留既有启停选择。以迁移 journal 和唯一键保证可重入。
3. 创建备份并校验可恢复。覆盖 Studio 数据库、插件安装记录、配置、插件数据和被迁移的原生恢复引用；不默认写入用户原生 Home。
4. 暂停新写入、调度和消费，对活动 Run/原生会话排空或按明确策略中断，再实施需要静止状态的迁移。
5. 运行数据一致性和状态恢复检查，启用唯一新执行路径，恢复调度与事件消费。
6. 检查迁移前后记录数、内容摘要、使用量、别名解析、历史读取、一次新 Run 和一次恢复 Run。
7. 注入升级/迁移中断验证可重试；执行回滚演练。若旧版本不能读取新 schema，恢复成套备份并说明备份后写入如何保全，不能直接启动旧二进制。

可靠事件投递可能已经产生外部副作用，数据库回滚不能撤销它们。切换与回滚报告必须保留 delivery ledger 和幂等键，避免恢复旧游标后再次发送；无法保证外部幂等的动作需暂停并人工核对。

## 6 客户端与发布协调

Web/桌面共用前端改用后端目录、实例配置和有效能力。移除以厂商 ID 决定可执行性的列表；图标、标签、配置 schema 和可用操作来自目录。既有专属管理页面可保留展示组件，但业务操作走统一管理服务，不能依赖插件源码或成为执行旁路。

目录明确标示内置与插件提供方。Hermes/Ekko 保留原生管理操作，不显示 Studio 插件安装、停用、升级、卸载按钮；插件管理页面只操作 plugin 类型。禁止把原生引擎更新误映射为插件更新。

14 个 Coding Agent 显示“系统插件”，默认已安装且无卸载按钮；插件安装策略和可用操作从后端返回，不由客户端厂商名单推断。停用时仍保留目录及启用入口，原生 CLI 未安装或未登录单独展示引导。第三方显示“用户插件”，提供符合权限和依赖条件的卸载操作；后端删除保护必须独立于 UI 生效。

新第三方插件使用通用配置表单、标准登录/操作交互与输出渲染。DSH 等已有嵌入页面由对应插件贡献受控管理能力，沿用其隔离载体。任意新第三方前端 JavaScript 插件不是本轮前置条件。

App 位于相邻仓库，动态 Agent 目录、未知类型展示和新增实例选择需要对应提交与版本协商；这是一项明确的跨仓库依赖。旧 App 和已发布 MCU 协议继续由兼容投影支持。App 尚未完成相关验收时，不能声称全部客户端已经支持自定义 Agent。

插件适配包和其调用的原生 CLI 分别显示版本与更新状态。随 Studio 发布的 14 个系统插件有锁定清单并全部包含于发布工件，首次启动离线完成安装登记。其默认版本随 Studio 清单更新，普通安装接口不能覆盖或删除；更新/修复与旧代回收保留系统身份和当前/回滚版本。Hermes/Ekko 内置集成随 Studio 发布，引擎管理保留各自策略。npm/Docker/Desktop 打包必须包含 SDK、runner、驱动和各平台所需资源，并验证从生产工件执行而非源码工作区执行。

## 7 临时路径删除清单

T14 必须逐项检查并记录结果：

- 移除核心 `run-manager` 中厂商特有解析、配置和命令分支；通用资源管理迁至相应服务。
- 移除聊天/群聊/工作流以具体 Agent ID 选择执行器的分支，保留经登记的协议别名映射。
- 移除新的 ctx 方法对 controller、Socket 对象和本地 HTTP 回环的依赖。
- 移除插件直接写 Studio session/usage/run 表及直接调用 Socket broadcast 的路径。
- 移除重复生成 run.completed、消息、usage 和 App/Webhook 通知的生产者。
- 移除已替代的全局可变 dependency 门面和仅供迁移使用的适配器。
- 移除运行目录固定枚举的校验方式，改为 schema 与有效目录检查；历史兼容映射单独列明。
- 移除生产双链开关与“旧路径回退”；保留经过验证的工件/数据回滚流程。
- Coding Agent 旧模块中剩余 HTTP 兼容转发不得承载已迁入插件的业务实现；文档说明保留原因和协议退役条件。Hermes/Ekko 继续保留内置业务与运行适配，领域持久化和广播统一交给协调器。

## 8 验证策略与证据要求

沿用[仓库验证规范](../harness/validation.md)。现有测试是行为基线，改造测试夹具时不得同时删除被覆盖的业务要求。

| 层次 | 验证方式 |
| --- | --- |
| SDK/契约 | schema 正反例、独立 TypeScript 编译、序列化、版本兼容和私有依赖扫描 |
| 平台服务 | 权限、revision、幂等、事务、副作用归属和取消测试 |
| 插件宿主 | 真实子进程 fixture、崩溃、超时、激活回滚、资源泄漏和协议帧测试 |
| Agent 适配 | 脱敏原生协议 fixture 对照、原有 server 测试、声明能力专项测试 |
| 完整应用 | 真实核心协调器加 fixture 插件；浏览器测试 mock 外部厂商，不绕过协调器 |
| 原生兼容 | 每个 Agent 在声明支持的平台/模式用固定 CLI 版本执行真实冒烟 |
| 迁移发布 | 数据副本演练、旧客户端契约、干净环境工件验证和回滚演练 |

可复用的当前测试包括 [business-events](../../tests/server/business-events.test.ts)、[chat-webhooks](../../tests/server/chat-webhooks.test.ts)、[模块边界](../../tests/server/server-module-boundaries.test.ts)、[Pi RPC](../../tests/server/pi-rpc-real.test.ts)、[Windows 真实进程](../../tests/server/coding-agent-run-manager-windows-real.test.ts)、[原生 Agent 环境](../../tests/server/native-coding-agent-environment.test.ts)、[工作流界面](../../tests/e2e/workflow-native-agents.spec.ts)与 [DSH 插件界面](../../tests/e2e/dsh-plugins.spec.ts)。需新增宿主、SDK、统一协调器、生命周期、数据迁移和开发者样例的专门测试。

完整实施交付前执行：

```bash
npm run harness:check
npm run test:coverage
npm run test:e2e
npm run build
```

另须执行真实 CLI、安装工件和跨平台验收；上述命令通过不等于这些验收通过。Desktop 环境运行测试时遵循验证规范中的环境隔离规则，不更改当前运行应用的环境。

性能基线由 T00 在同机、同协议 fixture、同并发和相同数据规模下测量。建议初始门槛为首个文本事件的 p95 平台额外延迟不超过基线 10% 或 50 ms 两者较大值，持续流吞吐退化不超过 10%；每个 worker 的空闲内存、最大活跃数量和队列上限在 T00/T03 的容量报告中给出实际预算。门槛是拟议验收条件，不能作为已达到的性能声明。

## 9 交付清单

最终应包含：发布的 SDK 和契约文档、核心 ctx/协调器/宿主、14 个默认安装且不可卸载的 Coding Agent 系统插件及分发清单、Hermes/Ekko 两个内置契约适配、通用协议驱动、管理与动态目录接入、独立插件样例、数据迁移/回滚工具、插件开发指南、兼容清单、测试与工件证据。

实施过程中出现的契约调整需同步修改三份规划文档及对应 schema。若某一现有 Agent 或客户端尚未达到已冻结的功能范围，项目保持未完成状态，不能仅凭插件注册和示例运行成功宣布整体交付。
