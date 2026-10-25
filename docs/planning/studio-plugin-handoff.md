# Studio 插件迁移交接

## 当前阶段交付（按用户要求收束此 PR）

用户确认插件全局归属：安装、启停、配置、worker 和贡献注册不属于任何 profile 或账号。先前“恢复聊天所属 profile 的插件”方案已撤回，续聊改为确保全局插件就绪，再按原会话、实例和实际调用者执行；SDK 插件身份不再含 profile。全局插件不能借用安装者账号：数据事件从宿主持久记录解析执行上下文，纯生命周期通知只有服务身份，不能读取账号数据或启动模型工作。旧 profile 配置仅迁移读取，一致则归并；冲突时保留原始行并报告 blocked/REVISION_CONFLICT。可靠消费者合并旧游标及待投递记录，不重放已确认事件。

普通单聊已增加内部绑定和真正的插件执行入口，保留原 Agent → 全局／模型流程及用户主动 CLI 安装更新。十四个系统插件启动时默认全局登记并启用，不自动安装原生 CLI；显式全局停用与撤权保持有效。所有 Coding Agent 默认免工具授权，用户问题继续走提问交互。用量只在终态关联最终回答，前端清除旧工具消息上的缓存摘要；真实 Qwen worker 重建后沿用原会话续聊。完整迁移仍为 0/14。

用户要求先提交当前改动，本轮在这里收束。构建、harness、SDK/driver 包外消费通过；相关服务端专项 1,149 项、后补同版本 worker 重载等专项 96 项、会话设置控制器 123 项通过。浏览器多工具/刷新专项 12 项、十四 Agent 入口 14 项通过。完整迁移验收仍为 **0/14**，未进行真实账号与全部入口验收，PR 保持 draft。

独立 QA 的当前功能快照生产构建通过（`/tmp/studio-global-qa-build2.log`）。完整 coverage/browser 首轮在用户收束前未取得最终全绿结果，不能记为通过：coverage 发现一处旧 composer 源码断言，已更新并专项 12 项通过；浏览器已发现 34 处旧发送协议断言，已按内部绑定与受管事件更新，专项 55 项通过、1 项 DSH 旧模型字段断言在该次执行后修正。最后 DSH 文件复验尚未取得完整结束结果。全量及最后专项按未完成记录；保留日志 `/tmp/studio-global-qa-{coverage,browser}.log`、`/tmp/studio-chat-protocol-browser.log`、`/tmp/studio-dsh-provider-browser-final.log`，不加期限、不删除有效行为断言、不把旧冻结结果当作本轮结果。

后续需在新提交上核对 CI 并完成当前版本的完整回归，再继续其余迁移。测试使用独立 QA 自身依赖，没有在测试中切换 checkout；用户要求移除的 Electron 设备切换自动测试没有恢复。


更新：2026-10-25。用户授权继续自主推进全部迁移；本文件记录实际进展，不表示总目标完成。

## 新窗口先读

- **普通“新建单聊”仍走旧执行链路，尚未迁移到插件。** 十四个独立插件和受管聊天链路已经实现；不能把插件目录、卡片界面或专项通过等同于日常对话已经切换。完整迁移验收仍 **0/14**。
- 最新功能代码已推送 `517912311`；它恢复原有卡片和单聊流程。`5769871bb` 修复 Windows ACL 探针，`c9292e9de` 修复 CRLF/路径/目录别名，`969ce5f09` 集成十四插件。后续仅更新交接文档的提交不改变此代码冻结；以 `git log` 核对当前 HEAD。
- 用户已明确：Coding Agent 页面直接列出全部插件，沿用原卡片，由用户主动安装、更新 CLI；新建单聊沿用“选择 Agent → 全局／模型”。**不要恢复管理实例按钮、实例选择器、JSON 配置或授权表单作为使用前置条件。** 实例绑定由宿主内部完成。
- 当前下一优先项：让原有单聊入口在内部完成可信插件/实例绑定并实际调用新协调器；同时保证账号/模型、工作区、MCP/Skills、图片、恢复、取消和计量语义不变。插件默认登记是必要配套，原生 CLI 仍由用户决定是否安装。
- `517912311` 的本地单测 **34 项**、生产浏览器专项 **41 项**、完整生产构建和 harness 通过。最新已核对该代码提交的 **Coding agent platforms 三平台、Device processes 三平台及锁文件 CI 均通过**，Windows ACL 问题已在真实 Windows CI 验证。Build、浏览器六分片和 runtime 当时仍运行，新窗口先查最终结果，不宣称全绿。
- 独立完整回归属于旧冻结：`969ce5f09` 的 **10,102 项 coverage / 980 项浏览器**，`c9292e9de` 的 **10,114 项 coverage**。不能冒充最新 UI 提交的全量结果。QA 副本当前停在 `c9292e9de`，没有测试进程需要保留；后续运行时仍禁止中途 checkout。
- 七个专属子 agent 的独立实现已集成交付；本窗口最后的 Grok 只读诊断被中断，没有新的生产代码待合并。延迟标题探针 `/tmp/studio-grok-lifecycle-delayed-title.log` 记录到 CLI 先关闭未完成请求、宿主随后取消、最后插件 dispose；合法 forced `session_title` 响应对照尚未完成，不能据此直接改网关或放宽计量断言。

## 当前状态

- 仓库 `/Users/ekko/Desktop/git/hermes-studio/studio`，分支 `feat/studio-plugin-context`。
- PR #3513 保持草稿：<https://github.com/EKKOLearnAI/ekko-studio/pull/3513>。不合并，不自动转 ready。
- 最新功能提交与待续重点见上方摘要；更早的厂商实现、公共包和验证修复均已提交推送，完整历史以 `git log` 核对。
- 原工作区 Kimi、共享 ACP、依赖构建改动全部保留并提交。不能 reset/clean 后续未提交工作。
- 已有 **14 个独立插件实现**：Qwen、Codex、Kimi、Qoder、CodeBuddy、Copilot、OpenCode、Pi、DSH、Claude Code、Antigravity、Cursor、Grok、ZCode；完整迁移验收仍为 **0/14**。实现数量不代表完整验收。
- 用户已要求余下每个 Agent 各由一个专属子 agent 并行迁移；当前主线程加三个子 agent 的额度采用滚动批次。分工和进度见 `studio-plugin-agent-owners.md`，不得把排队任务记为已启动。
- 需求真源：`studio-plugin-architecture.md`、`studio-plugin-contracts.md`、`studio-plugin-execution.md`。实际证据：`studio-plugin-progress.md`。

## 已验证的增量

### Kimi 与公共包

Kimi 固定 CLI 2.1.1，global/scoped、图片、审批、恢复、原生命令和 Studio MCP 已有真实联调。临时 `KIMI_MODEL_NAME` 模型不调用只接受 TOML alias 的持久模型选择器；普通 native alias 保留选择行为。

SDK/driver 为两个 npm workspaces，driver 显式依赖 SDK 0.1.0。类型检查先生成 SDK 声明；宿主/测试构建使用源码别名，避免错误类出现两份。`pack:plugins` 构建独立 SDK/driver tarball，`verify:plugins:packages` 在仓库外实际安装、严格 TypeScript 编译及加载。主应用 tarball 去掉不随包发布的 workspace 元数据。没有执行 npm publish。

最初遗漏了 `studio-plugin-processes.test.ts` 中两处直接 esbuild 调用的 SDK alias，三平台 CI 发现后已修复；移开 SDK dist 后该文件 16 项通过。`900e7aa22` 的三平台 Coding agent platforms 与 Build 已通过；其余 CI 当时仍运行，不能沿用旧 HEAD 的 13 项通过声明。

冻结 `15a6371a1` 的独立 QA 回归：自己的 npm ci/PTY rebuild/生产 build，coverage **942 文件 / 9,821 项通过**，12 文件 / 33 项按原条件跳过，2 workers、默认时限，469.15 秒；生产浏览器 **968 项通过**，4 workers、无重试，10.8 分钟。日志 `/tmp/studio-kimi-qa-{install,rebuild,build,coverage,browser}.log`，报告 `/tmp/studio-kimi-qa-coverage`。

### Qoder

固定 CLI 1.1.78，保留 global-only 与 Windows ARM64 限制。真实受管 CLI 版本/ACP metadata/登录计划/资源检查通过；inspect 仅发送 initialize，不创建原生会话，不推断已登录。真实 worker fixture 验证运行、resume、命令、审批、取消、崩溃和撤权。管理页生产浏览器通过；真实账号/远程推理未验收。重现：`STUDIO_QODER_COMMAND=/absolute/path/to/qodercli.js npm run verify:plugins:qoder`。

### Chat Completions 与 CodeBuddy

公共网关新增 Chat Completions 原生直通和到 Responses/Anthropic 的转换，三种协议六个转换方向齐全；Run 鉴权/取消/计量归属不变。Chat 的 finish_reason、迟到 usage 和 `[DONE]` 一起等待计量提交；缺失计量保持 unknown，截断失败。网关/适配专项 68 项通过，连同三个 ACP 插件共 108 项通过，包外消费验证通过。

CodeBuddy 固定 CLI 2.175.0；原生 ACP 服务保留 watcher，使用通用 `managed-stop` 策略确认关闭。真实 fixture 通过 ToolSearch/DeferExecuteTool 发现并调用延迟 MCP。最终真实 CLI **14 轮聊天、47 次本地模型请求、5 次 Studio MCP 请求通过**，含 global/scoped、图片、Skills/指令、配置、恢复、协调器/提供方重启、两种转换及跨轮切换。日志 `/tmp/studio-codebuddy-real-native-final.log`。

CodeBuddy 最终构建/harness/类型/公共包外消费验证通过；服务端专项 55 项及协议/进程专项 105 项通过；管理页生产浏览器 11 项通过。三平台 CI 新增 Kimi、Qoder、CodeBuddy 的 worker 和环境专项。日志 `/tmp/studio-codebuddy-{focused,final-focused,browser,final-build,final-harness,types,packages}.log`。本地模型 fixture 不等于真实账号或远程付费服务。

### Copilot

固定 CLI 1.0.91；标准 ACP 加插件自己的原生配置/Windows PowerShell 检查。Claude scoped 用 Anthropic canonical ID，其他模型用 Chat Completions；Anthropic 基址去除末尾 `/v1`，真实 CLI 已验证路径为租约下 `/v1/messages`。临时模型 token 不写文件。原生 MCP 采用 `--additional-mcp-config @file`，按 runtime 租约生成、进程清理后删除。global 获得宿主辅助目录但不覆盖原生账号 Home。

inspect 使用 ACP metadata 和 Content-Length JSON-RPC SDK `auth.getStatus`/`models.list`；未认证模型目录是 `authentication_required`，不创建会话或 Run，丢弃账号标识及私有字段。公共 transport 新增有界 framing，默认 JSONL 不变。

最终真实 CLI 14 轮、19 次本地模型请求、5 次 Studio MCP 通过，含 global/scoped、图片/资源、重启恢复、三种协议及跨轮切换；OpenAI 与 Claude 两种模型选择各有通过证据。服务端专项 95 项、其他插件/上下文/目录/网关专项 120 项、生产管理浏览器 12 项通过；完整构建、harness 和包外 SDK/driver 验证通过。日志 `/tmp/studio-copilot-{final-focused,regressions,browser,final-build,final-harness,packages,real-final}.log`。未验收真实账号。

### OpenCode

固定原生 CLI 1.19.4，使用正式 ACP；global 保留原生配置和账号，scoped 隔离 Home/XDG/配置/数据库，以 Chat Completions 接入 bundled provider，token 仅在环境中。原生文件保持用户编辑，资源含多配置层/JSONC/Skills/指令；inspect 只 initialize，认证 unknown，登录 `opencode auth login`。

真实 CLI 14 轮/26 次本地模型请求/5 次 MCP 通过；实际公布的 Skill 命令 global/scoped 共 2 次与 14 轮矩阵通过（28 次模型请求/5 次 MCP），同一原生会话。原生未公布 compact/compress，压缩探针失败并保留不支持；没有伪造支持。宿主实际固定版本安装两个 binary CLI，通过版本/原子选择后完成 global/scoped 7 轮、16 次本地模型、5 次 MCP。worker/随包专项 15 项，生产管理浏览器 13 项、生产构建/插件类型/harness 通过；没有真实账号验收。日志 `/tmp/studio-opencode-real-{native,commands,skill-command-v2,managed}.log` 与 `/tmp/studio-opencode-{final-focused,browser,final-build,types,final-harness}.log`。

### Pi 与共享契约

固定 Pi 1.4.0，原生 RPC/公开 native extension，global 保留原生账户 Home，scoped 使用独立配置和宿主 Responses gateway；等待 agent_settled、干净退出、managed history header 与 nonce ready 回执。worker 28 项通过；真实 compact 和 Skill 各 14 轮 + 2 命令 / 21 本地请求 / 5 MCP，实际固定版本安装 2 次后 7 轮 / 12 请求 / 5 MCP 通过。首轮后压缩因原生保留规则拒绝，改由真实两轮历史后执行，默认保留设置不变。完整证据见 `evidence/studio-plugin-pi.md`。

共享事件新增 cache/reasoning 可选明细，保持 runtime 总输入已含缓存、不重复累计，scoped 宿主唯一写入。安装契约新增受限 preferDedupe，手动安装 setup 可展示官方 HTTPS 文档；Gemini 纯 codec 移到公共 driver，旧 proxy 兼容复用，不增加宿主厂商分支。Pi/管理/随包 76 项、用量/模型/聊天 95 项、安装 21 项、旧 Gemini/图片/边界 14 项通过；手机管理生产浏览器 15 项、client/server 类型、前端生产构建、harness 和包外消费通过。全部插件整体验证及冻结 coverage/browser/build 仍需在集成提交上完成。

### 六个新增独立插件的集成

DSH、Claude Code、Antigravity、Cursor、Grok、ZCode 的专属子任务均已交接，主线程完成公共构建、受信任随包列表、管理浏览器和三平台 worker CI 接入。十四插件构建/类型和 harness 通过；合并专项 **290 项通过、8 项真实 CLI opt-in 未启用**，生产管理浏览器 **21 项通过**，公共网关/适配器 **73 项通过**。完整迁移仍为 **0/14**，没有默认安装或切换旧业务入口。

DSH 扩大矩阵 **14 轮 / 19 本地请求 / 5 Studio MCP**，Grok 一次扩大矩阵 **14 轮 / 60 本地请求 / 5 Studio MCP**；后者推动公共适配器补齐已声明命名函数选择，避免原生标题请求被拒。Grok 最终构建后无诊断重跑又出现原生后台调用 cancelled/unknown usage（`/tmp/studio-grok-real-native-final.log`），严格脚本仍失败，不能称其扩大矩阵稳定通过。Claude Code 实际 **10 轮 / 12 本地请求 / 2 MCP**，ZCode 实际 **6 轮 / 10 本地请求 / 2 MCP / 2 Skill**。Antigravity 双版本图片/恢复已有实际证据，但无账户 MCP 严格探针仍失败；Cursor 仅完成原生认证失败边界，真实账号推理尚未验收。不能把上述本地模型与 worker 视为真实账号证据。

集成审查补齐清理失败后永久阻断 runtime、全部清理后再推进 checkpoint、Grok 持久可编辑资源与运行 overlay 分离、普通恢复轮新指令投递及隔离只读 metadata probe。安装 SDK 的受限 `nativeHomeEnv` 由宿主设置私有路径，已在实际 Grok 固定版本安装中验证。各厂商版本、复现及限制见 `evidence/studio-plugin-*.md`；最终冻结全量结果在后续验证后补记。

### 最新冻结回归

Pi 与公共契约已随 `0d93d39c3` 推送；`fb957010c` 修复干净构建的 driver 声明顺序，其独立 QA 生产构建通过（`/tmp/studio-eight-plugins-qa-build-v2.log`），该 HEAD 的 **16 项 CI 通过**，PR 仍为 draft。冻结 coverage 首轮 947 文件 / 9,943 项通过、1 文件 / 1 项失败；macOS Helper 进程受桌面 Electron 依赖的规范路径影响，QA 需显式指定 `EKKO_TEST_ELECTRON_EXECUTABLE`。同一断言以正确环境单独复验 9 项通过。第二轮完整 coverage 仍为 947 文件 / 9,943 项通过、1 文件 / 1 项失败，唯一失败变为 Ekko 普通终端命令误报告既有 Skill 元数据；两轮均不记为全绿。日志 `/tmp/studio-eight-plugins-qa-coverage{,-v2}.log`。

`b26b756c4` 将文件 watcher 事件作为提示，再比较命令前后的 Skill 校验签名，避免迟到/合并事件或缓存文件写入触发旧元数据告警；原断言保留，并补缓存写入场景，runtime 专项 **67 项通过**。

十四插件集成已随 `969ce5f09` 推送。独立 QA 使用自身依赖/工作区链接及显式 Electron 路径，生产 build 通过；完整 coverage **956 文件 / 10,102 项通过，13 文件 / 43 项条件跳过**，2 workers、默认期限，283.43 秒；完整生产浏览器 **980 项通过**，4 workers、无重试，11.1 分钟。日志 `/tmp/studio-fourteen-plugins-qa-{build,coverage,browser}.log`，报告 `/tmp/studio-fourteen-plugins-qa-coverage`。两个实际 npm tarball 均检查到全部 14 个 manifest、每个声明的 backend 和 Pi native 资源，未发布；输出 `/tmp/studio-fourteen-plugins-npm`。浏览器结束后才将 QA checkout 到后续修复提交。

`969ce5f09` 的生产浏览器六个 CI 分片、Build 和设备进程三平台通过，Coding agent worker CI 的 Linux/macOS 通过，Windows 有 30 项失败，未记为全绿。专属子 agent 已修复 DSH CRLF 私有 adapter 匹配、Antigravity 故障注入路径和实际 Windows ACL 检查，以及 ZCode 同一目录别名被误判的真实运行时问题；主线程修复 Grok 的跨平台路径断言。原清理/取消/身份断言保留，合并专项 **109 项通过 / 8 项原生 opt-in 未启用**，插件构建、server 类型和 harness 通过。修复需推送后重新验证 Windows，macOS 的 CRLF/目录别名复现不替代 Windows 执行。日志 `/tmp/studio-windows-plugin-fixes-{focused,build,types,harness}.log`；各专属 native 证据见厂商记录。

修复随 `c9292e9de` 推送。该冻结独立 QA 的生产 build、完整 coverage 再次通过：**956 文件 / 10,114 项通过，13 文件 / 43 项条件跳过**，2 workers、默认期限，279.79 秒；日志 `/tmp/studio-fourteen-windows-fix-qa-{build,coverage}.log`，报告 `/tmp/studio-fourteen-windows-fix-qa-coverage`。客户端与 e2e 目录的 Git tree 均与 980 项通过的浏览器冻结一致。重新制作的两个 npm tarball 同样验证全部 14 个 manifest/backend 和 Pi native 资源，检查结果 `/tmp/studio-fourteen-windows-fix-npm-inspection.json`，包在 `/tmp/studio-fourteen-windows-fix-npm`，未发布。

`c9292e9de` 的 Coding agent Linux/macOS 与设备三平台通过；Windows 变为 **724 项通过 / 1 项失败 / 9 项条件跳过**，DSH、Grok、ZCode 及全部 Antigravity 清理场景均已通过。剩余失败发生在 ACL 判定前的 `Get-Acl` 模块自动加载。专属子 agent 改用 .NET Framework 直接读取同一文件的 owner/DACL，保留读取授权、负例与取消删除断言，本地 39 项和严格类型通过，实际 Windows 仍待后续 CI 复验。不能将此 HEAD 记为 CI 全绿。

用户明确要求延续原有卡片和单聊流程。本轮移除总览、设置和聊天页的 `AgentInstanceManager` 入口与资源实例选择器，保留十四张 Agent 卡片及用户主动安装/检查更新/更新 CLI 的操作；创建单聊仍由用户选择 Agent 和“全局／模型”。默认配置页不再发现实例；内部已有资源绑定的 Skills/文件编辑、冲突保护及受管聊天图片/审批继续保留。单测 **34 项**、生产浏览器专项 **41 项**、完整生产构建与 harness 通过，检查明暗、壁纸/区域透明度及手机布局；日志 `/tmp/studio-agent-familiar-ui-{unit,browser,build,harness}.log`。旧表单浏览器用例已改为用户要求的卡片/CLI/模式交互，图片、审批、资源读写与冲突断言保留。新的整体冻结回归待本轮提交后进行。

该界面收敛不等于底层业务迁移完成。普通新建单聊仍使用原准入/运行路径，内部实例自动绑定、默认插件登记及各入口统一依旧待实施；不能把撤掉实例按钮当作这些交付已完成。后续实现这些能力必须保持上述用户操作方式，不得再次暴露创建实例或授权表单。

冻结 `7d9e36248` 的独立 QA 生产构建和完整生产浏览器 **972 项通过**（4 workers、无重试，11.1 分钟）；coverage 为 947 文件 / 9,897 项通过、1 文件 / 1 项失败，12 文件 / 33 项条件跳过（2 workers、默认时限，501.82 秒）。唯一失败是既有 Electron 设备切换集成测试的 55 秒子进程退出期限，单独复测仍失败。用户明确要求去掉该测试，现删除其自动化测试文件，保留其他设备切换测试、产品实现和手动验证脚本使用的 fixture；临时诊断已撤去。上述冻结 coverage 不记为全绿。日志 `/tmp/studio-seven-plugins-qa-{build,browser,coverage,desktop-focused}.log`。

`01114c99f` 独立 QA build/coverage 通过：944 文件 / 9,853 项，12 文件 / 33 项条件跳过，2 workers、默认时限，413.00 秒。生产浏览器首轮 969 通过 / 1 失败；主题编辑器已有 inert，测试 fill 绕过加载锁定，`68fa9cc1b` 修复测试等待，原断言/期限未改、产品源码未改。专项 light/dark 通过；冻结 `68fa9cc1b` 完整重跑为 968 通过/2 失败，11.1 分钟；APNG/版本预览两项单独复测通过，两轮全量均不记为全绿。日志 `/tmp/studio-five-plugins-qa-browser-v2.log`；不要把首轮记为全绿。

页面就绪修复：APNG 测试等待现有 inert 锁；版本预览刷新等待状态/标签两请求 settle 后再解除初始化，并报告错误。新增延迟请求单测与 PageLoading 共 6 项、原失败浏览器 2 项、相关完整浏览器文件 42 项、client 类型/harness 通过。Copilot 的 macOS/Linux native CI 通过，Windows 既有 Codex 审批等待在默认 vi.waitFor 阶段出现一次 starting/等待状态不符；未修改期限或预热测试，继续跟踪下一提交。

## 继续顺序

1. 普通新建单聊的内部插件绑定和真实执行已实施，先完成当前快照的整体回归并核对新提交 CI，再验收旧历史接管。插件全局注册，owner/profile 仅约束会话、Run、凭据和原生目录；幂等与唯一写入由宿主保证，用户 Agent → 全局／模型操作流程不变。`2bab0a51e` 的构建、设备/Agent 三平台、Windows ARM64 和锁文件 CI 通过；浏览器唯一失败来自 8 个仍点击已移除实例入口的用例，本轮已按十四 Agent 原流程替换，相关原生 PTY 协议测试保留。`517912311` 的部分完整流程为 cancelled，不能称其全绿。
2. 统一旧单聊/历史接管、群聊、工作流、全局任务及 API 的运行协调器；父子 Run、共享取消/预算、计量归属、唯一写入和完成屏障。当前 `services/agents/context-runs.ts` 仍明确拒绝带 Run/workspace 绑定的启动；需先补可信父子关系、持久化及清理/预算传播，不能只删除该授权保护。旧引擎持久化和新协调器投影需完成唯一写入后再切换入口。
3. 厂商能力仍按证据逐项补齐：DSH 专属插件/预设管理和 context 占用事件、Antigravity 无账户模式实际 MCP、Grok global 后台/压缩用量及 cancelled/unknown 辅助调用、ZCode 原生 MCP cwd 组合，以及 Cursor 和其他厂商真实账号。独立目录和本地模型不能替代功能对等；详见各 `evidence/studio-plugin-*.md`。禁止插件导入 server/client 私有源码，禁止宿主万能厂商 runner。
4. 补齐 SDK 完整 ctx、事件/限额/诊断，Web/Desktop/App 动态目录和管理/聊天协议。已有 PTY、MCP resources/prompts、Studio MCP、Skills 包导入删除不应再列为待开发。管理必须继续使用用户确认的卡片和原流程。
5. Hermes/Ekko 保持 builtin 身份接入相同 Agent 契约；插件宿主故障不能影响内置引擎，避免重复写入。
6. 全部 14 个系统插件已在启动时默认全局登记并启用、不可卸载；继续版本锁定、排空升级、迁移/回滚、历史保留、Desktop/npm/Docker 和 SDK/driver 分发准备。私有 CLI 旧版本清理/回滚仍未实现；插件默认登记不等于自动安装原生 CLI。
7. 真实数据副本迁移、真实账号/远程服务、跨平台恢复与性能，图片/Skill 删除故障恢复；功能对等后清理旧链路。QA 副本使用自己的 node_modules，禁止在测试中切 checkout；用户要求删除的 Electron 设备切换自动测试已随 `ce45554ce` 推送，不能恢复它，手动验证脚本及 fixture 保留。

完整迁移每项只按真实交付证据关闭。单项 fixture、目录注册或独立包数量不能替代最终验收。

## 验证环境

- Node 24.22.1：`/tmp/node-v24.22.1-darwin-arm64/bin/node`。
- 构建/测试清理 HERMES_、EKKO_、ELECTRON_、AUTH_TOKEN、PORT、NODE_OPTIONS；外部包验证另清理 NODE_PATH；NODE_ENV=test。
- PATH 首位 Node 24.22.1，再 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`，保留 Homebrew ffmpeg。
- 当前辅助运行器 `/tmp/studio-plugin-run-clean.py` 接收日志路径和命令；全量 `npm run test:coverage -- --maxWorkers=2` 保持默认时限，不加超时/删断言/跳过失败。
- 用户已要求移除自动运行的 Electron 设备切换集成测试；手动脚本 `packages/desktop/scripts/verify-native-device-switcher.cjs` 及其 fixture 保留。
- QA：`/Users/ekko/.cache/studio-plugin-chat-foundation-qa`，自身 npm ci 已完成；禁止重新共享主工作区 node_modules 或跨工作区的 SDK 链接。浏览器 root 4173、QA 4183，独立客户端缓存。
- QA macOS Helper 测试需显式 `EKKO_TEST_ELECTRON_EXECUTABLE` 指向主仓库已安装的实际 Electron；辅助运行器通过 `STUDIO_QA_ELECTRON=1` 设置。仅此桌面二进制可规范化到主仓库路径，不共享 SDK、driver 或根 node_modules。
- 实际 CLI 路径：Kimi `/Users/ekko/.nvm/versions/node/v24.16.0/bin/kimi`；Qoder `/tmp/studio-qoder-native-qa/node_modules/@qoder-ai/qodercli/bundle/qodercli.js`；CodeBuddy `/tmp/studio-codebuddy-native-qa/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`；Copilot `/Users/ekko/.nvm/versions/node/v24.16.0/bin/copilot`；OpenCode `/tmp/studio-opencode-native-qa/node_modules/opencode-ai/bin/opencode.exe`（macOS 也是此文件名，实际 Mach-O binary）。均用临时 Home 和本地模型，不读真实用户账号。
- 原已推送 `ead6a4c3f` 的 9,802/967 只是旧冻结结果；不能冒充本轮或后续提交结果。
- 每轮读取自己的 session tasks，使用最新输入的 context_id，不复用旧 context/session。完整用户目标保持 open，PR 保持 draft。
- 长轮次中 interaction 同步曾返回 Unauthorized，默认、default、tester 均未恢复；没有复制 token 或绕过认证。已有 durable goal 保持 open；后续恢复后按实际证据更新，期间以本文件保存进度。
