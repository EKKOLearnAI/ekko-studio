# Grok 独立插件证据

日期：2026-10-25。独占改动为 `plugins/grok/**`、`tests/server/studio-grok-plugin.test.ts` 及本文件。共享 bundle/构建/CI/验证矩阵接入由主线程处理；此交付不关闭完整迁移验收，仍为 **0/14**。

## 原生事实与固定版本

官方 npm 当前版本核实为 `@xai-official/grok@1.0.70`。已独立下载到 `/tmp/studio-grok-native-qa`，直接解压本平台 `grok-darwin-arm64/bin/grok.br` 为临时可执行文件，版本及原生行为均在临时 `HOME`、`USERPROFILE`、`GROK_HOME` 下验证。没有登录、付费推理或显式读取真实账户文件。

官方参考：

- [官方 npm 包](https://www.npmjs.com/package/@xai-official/grok)
- [原生 headless/ACP](https://docs.x.ai/build/cli/headless-scripting.md)
- [设置及作用域](https://docs.x.ai/build/settings.md)
- [设置参考及模型/MCP 格式](https://docs.x.ai/build/settings/reference.md)

npm `bin/grok` 初始为 Node wrapper；Unix npm postinstall 会解压包内 `grok-native` 并改为包内链接。postinstall 另外写入 `GROK_HOME/bin` 和 `GROK_HOME/config.toml`。因此插件声明严格安装 plan：版本 `1.0.70`、`runner: binary`（Windows 为原生 npm Node launcher，跨平台待验）、`nativeHomeEnv: ['GROK_HOME']`。宿主提供私有安装 HOME、原生 HOME、npm cache/配置/prefix；此扩展由主线程实现。

探针操作记录：首次 `--help` 误经 npm wrapper 且未覆盖 HOME。只用 stat/链接元数据核对，`/Users/ekko/.grok/bin/grok` 仍为 10 月 14 日旧链接，指向 `grok-1.0.52`；`grok-1.0.70` 不存在，没有观察到该次操作新增的原生工件。该次 help **不作为 1.0.70 证据**。后续均固定临时二进制与临时原生 HOME；没有删除任何用户文件。

## 实现边界

- 只依赖公共 `@ekko-studio/plugin-sdk`、`@ekko-studio/agent-drivers` 与打包内 TOML parser，无 server/client 私有导入或宿主旧 runner。
- `--output-format streaming-json`、受限 NDJSON/严格 UTF-8、`--prompt-file`。图片使用原生 JSON text/image blocks。
- 新会话显式 UUID `--session-id`，后续显式 `--resume`；恢复引用只含原生 UUID。检查历史位于实例 host storage 内，缺失历史不创建替代会话。
- 原生 `end_turn`、匹配 session ID、退出 0、历史存在及进程/gateway/临时 prompt 清理完成后才 checkpoint。错误文本不会原样传播为 UI 错误。
- Global 使用独立 shadow `GROK_HOME`，复制 native 账户、配置、指令、Skills、扩展与策略，源文件保持不变，HOME 保留原生语义。Scoped 使用 host storage HOME，native 模型路由由 Responses gateway 替换，临时 token 仅传环境引用，不写 TOML；保留非路由设置和 native/project 资源。
- 官方文档声明项目 TOML 只处理 MCP/plugins/permission；插件对项目或 managed 路由冲突仍保守拒绝，避免依赖某版本的忽略行为。源文件保持原样。
- 原生 MCP stdio 与 HTTP 配置、动态 native `/` 命令目录、原生 compact 均保留。SSE 明确 unsupported。
- 延用旧集成 `--always-approve`，声明 approvals/clarifications 不支持，未伪造交互。原生 native login、有限模型元数据、账户状态 unknown/required、原生配置/Skills 位置均由插件提供。
- Global 原生 input 不含 cache，插件报告 input 总和并保留 cache/reasoning 明细。按模型拆分只在总量核对一致后替代 aggregate；Scoped 不写 runtime usage，由 host gateway 唯一计量。

## 已执行验证

`/tmp/studio-grok-worker-install.log`：14 项通过，包含第一次实际 host 私有安装。`AgentCliInstallations.stage` 执行 npm、原子选中包内原生二进制并探测 `1.0.70`，安装耗时约 18 秒；没有借用用户全局 `grok`。

`/tmp/studio-grok-worker-native-final.log`：13 项通过、1 项 install opt-in 未启用；真实 CLI **6 轮、18 次本地 Responses 请求**。Global/Scoped 各执行普通轮次、带图片的重启恢复轮次与原生 compact。已验证 `search_tool → use_tool → fixture__ping` 真正调用临时 MCP；图片实际进入模型请求；native 全局缓存/reasoning计量；Scoped 请求只携带临时 gateway token。

Worker fixture 另覆盖成功/失败/缺失终态/终态后进程失败、取消和清理、撤权和跨 profile 拒绝、恢复历史缺失、无 Run 的有限元数据、只读源 native 配置、敏感 token 不写文件、项目/managed routing 冲突和 SSE 拒绝。测试不放宽既有期限或断言；原生下载/安装是独立 opt-in，明确上限 60 秒。

最终全量 opt-in 验证 `/tmp/studio-grok-all-final.log`：**17 项全部通过**，同时包含真实 native 6 轮/18 个本地 Responses 请求及再次 host 私有 npm 安装（约 19 秒）。随后按 global/scoped 拆分原生场景，各自使用默认 5 秒期限，避免把两个独立运行入口塞在同一测试预算内；没有增加期限或移除断言。拆分后的 `/tmp/studio-grok-native-delivery-v2.log` 为 17 项通过、1 项 install opt-in 未启用；global/scoped 原生测试各约 1.6/1.3 秒，合计仍为 6 轮/18 个本地请求。

类型检查日志：`/tmp/studio-grok-types-handoff.log`，`npx tsc --project plugins/tsconfig.json` 通过。

## 限制与未关闭事项

- 原生 1.0.70 显式 compact 成功只发 `auto_compact_completed` 和无 usage 的 `end`；全局原生账户下 summary、title/background 调用用量不能从此 headless ledger 完整复原。没有估造 token 或把此前累计用量重复记账。Scoped host gateway 可观测这些请求。
- 原生会拒绝退化摘要。首次短文本本地摘要被 native 判为 `degenerate summary`，探针失败保留在 `/tmp/studio-grok-compact-direct.log`；使用含实际上下文的有效摘要后，原生 compact 成功，见 `/tmp/studio-grok-compact-direct-v2.log`。未将 native 失败改为成功。
- Windows npm 仍是 wrapper 形态，Linux/Windows、真实账号与历史迁移、完整业务入口/跨平台性能验收未完成；不能把 macOS 临时账户验证当作完整验收。
- 管理 UI、共享全量验证矩阵与最终 bundle 接入由主线程集成；不删除旧宿主链路。

## 资源持久化、清理屏障与只读管理修订

主线程交付审查发现原实现把 scoped 管理路径指向每轮生成的运行 overlay，保存的配置/指令会被覆盖，删除的 native Skill 也会再次导入。现改为独立持久 `grok-resources`：首次管理列举即可初始化，已有用户文件以不覆盖方式保留；只首次导入去模型路由/账户信息的 source 配置、指令与原生扩展。原生账户 `auth.json` 不导入 scoped。每轮运行只重建 `grok` overlay，读取持久资源后叠加当前模型租约和宿主 MCP/指令。共享只读 Skills 仍独立合并，原生导入 Skill 的删除不会被 source 再次补回；Global 管理继续编辑原 source。

真实原生验证同时揭示 Grok 1.0.70 的 `--resume` 会保留初始 user_rules 快照；仅更新 AGENTS 文件或额外 `--rules` 都未把新规则送入当前模型请求。失败证据保留为 `/tmp/studio-grok-resource-sticky-native.log` 与 `/tmp/studio-grok-native-rules-probe.log`。现对普通恢复轮通过原生 prompt-file 的 text/JSON block 明确附加当前可编辑指令作为**本轮上下文**，并已在本地模型实际请求中断言新指令出现。没有修改或删除原生历史，没有声称替换 native 缓存规则。所有 slash 命令原始参数保持不变；命令直接执行时仍有原生缓存规则限制。

Global/Scoped 的真实 worker 资源操作覆盖：首次运行前管理列举、保存配置/指令、review/remove Skill，下一轮与 coordinator 重启后仍使用保存内容；源账户配置与 scoped 凭据边界不变，共享只读 Skill 仍可见。原生验证从首轮模型请求取得真实 Skill 路径并成功读取；review/remove 后恢复轮中，该路径再次打开明确返回 ENOENT，持久资源路径也不存在。历史中的旧 Skill 描述允许保留，未将 prompt 提示冒充工具权限撤销。

进程、gateway、临时 prompt 任一清理阶段发生一次失败即标记该 runtime 不可复用；即使 finally 重试成功也拒绝新 Run。清理各阶段独立尝试，未确认的清理由 dispose 继续尝试。checkpoint 仅在全部清理完成且最终未取消时提交。新增三类实际边界故障测试：真实受管子进程 dispose 首次失败后重试成功、gateway dispose 首次失败后重试成功、原生 fixture 把临时 prompt 换为含文件目录使删除失败，修复目录后仍不能复用原 runtime。失败均不产生成功 checkpoint。

另以真实 1.0.70 在临时 Home 检查管理副作用：`--version` 不写文件；`models` 会修改 `config.toml`，并创建 agent_id、日志、文档、metadata/lock、sessions/session_search.sqlite 等。因此 inspect 现使用一次性 cwd/HOME/GROK_HOME，只复制去掉凭据的模型目录配置，不复制 native auth、不传账户 token 环境或加载项目目录；返回认证 unknown，不把 shadow 的未认证状态冒认为原账号状态。真实 probe 对原 native/project 整树逐项比较文件集合和内容，确认无新增、删除或修改，且没有创建 Run。原生写入均留在一次性目录并等待清理。

修订验证：`/tmp/studio-grok-resources-readonly-sticky-v2.log` 为 focused **22 项通过、4 项 opt-in 未启用**；`/tmp/studio-grok-resource-final-native-v3.log` 包含真实运行与管理探针，**25 项通过、1 项安装 opt-in 未启用**；类型检查 `/tmp/studio-grok-resources-readonly-sticky-types-v2.log` 通过。子 agent 未放宽既有测试期限、未改共享构建/UI/CI、未提交或推送。原有全局 compact/title 用量、真实账号及跨平台限制继续开放，完整验收仍 **0/14**。

## 主线程公共接入与扩大矩阵

已接入正式构建、受信任随包列表、移动管理页面和三平台 worker CI。通用真实 verifier 兼容 Grok 的 search_tool/use_tool、严格 Responses 字段、既有资源 etag 和转换后的工具别名。扩大矩阵发现原生标题请求强制选择 `session_title`，宿主跨协议适配器原先明确拒绝；主线程补齐当前已声明命名函数与 namespace 的选择映射，保持未知选择在任何上游调用前拒绝。参考官方 [OpenAI 工具选择](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 与 [Claude 工具选择](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)；未放宽 strict/schema 或其他不能表达的约束。

修正后实际矩阵 **14 轮 / 60 次本地模型请求 / 5 次 Studio MCP 通过**，包括 global/scoped、Chat/Anthropic 转换及跨轮切换、图片、宿主导入 Skills/指令、配置/MCP 修订、coordinator/provider 重建及两聊天隔离。日志 `/tmp/studio-grok-real-native-matrix-v10.log`；原失败日志仍保留，不能沿用为成功。公共网关/适配器 **73 项通过**，日志 `/tmp/studio-native-forced-tool-focused-final.log`。

最终重新构建后，无诊断重跑 `/tmp/studio-grok-real-native-final.log` 在 scoped 第二轮出现原生辅助请求 cancelled，宿主保存的该条 usage 为 final/host、input/output unknown；严格扩大矩阵因此返回失败。此时主聊天和原生历史成功，但不能据一次 14 轮通过宣布扩大矩阵稳定通过。没有把取消的调用伪造成 completed/零用量，也没有放宽该断言。原生后台请求取消和完整计量验收继续开放；最终源码另有 **95 项合并专项通过、4 项 opt-in 未启用**（Grok/网关/适配器），日志 `/tmp/studio-grok-parent-final-focused.log`。
