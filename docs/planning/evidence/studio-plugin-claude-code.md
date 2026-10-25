# Claude Code 独立插件实施证据

日期：2026-10-25。状态：独立实现与下列专项验证可交接；随包注册、统一生产入口、真实账号和完整迁移验收由主线程继续，完整迁移仍为 **0/14**。

## 固定原生版本与公开协议

- 官方 npm `@anthropic-ai/claude-code@2.1.310`，本机实际 `--version` 为 `2.1.310 (Claude Code)`。当前 npm bin 为 native `bin/claude.exe`，安装计划使用 `runner: binary`，不交给 Node 解释。
- 使用 Claude 原生双向 stream-json：`control_request/initialize`、`can_use_tool`、`control_cancel_request`、`user`、`stream_event`、`assistant`、`result`。公开 framing/进程代码来自 `@ekko-studio/agent-drivers`，插件只导入公共 SDK/driver 与 Node 内置模块。
- 官方资料：[CLI reference](https://code.claude.com/docs/en/cli-reference)、[settings precedence](https://code.claude.com/docs/en/settings)、[Agent SDK npm 工件](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.310)。协议字段由该官方 0.3.310 工件的 `sdk.d.ts` 与实际 2.1.310 CLI 交叉验证。

## 实现与真实观察

| 能力 | 实现及证据 |
| --- | --- |
| 原生账户与配置 | global 保持原生 Home/CLAUDE_CONFIG_DIR；插件不写原生设置或自动登录。scoped 仅用 host stateDirectory 私有 Home/配置目录。原生 CLI 自己的历史/偏好写入仍由 CLI 管理。 |
| 模型绑定 | scoped 申请 Anthropic gateway，临时 token 仅进程 env；非秘密 CLI settings 覆盖路由，发送用户输入前通过 `get_settings` 校验最终生效层。原生设置试图覆盖凭据/目录/credential helper 时明确拒绝且不修改文件；实际错误路由偏好可保留而由临时 overlay 正确覆盖。 |
| 多轮与恢复 | checkpoint 为稳定 `{sessionId}`；按原生 UUID 使用 `--resume`，历史缺失显式失败，不新建替代对话。两条 host chat 使用不同原生 UUID；兼容配置修改后保留正确原生历史。 |
| 计量 | global 在每轮用户输入前调用 `get_usage({skip_behaviors:true})` 读取当前原生累计基线，再对 `result.modelUsage` 求差；包括 cache 的总输入、总输出及 cache/thinking 分项。失败轮后恢复的 worker 回归为每轮输入 `[10,10,10]`，没有把已计入失败轮的累计用量再算一次。scoped 不投递 native usage，宿主 gateway 唯一计量。 |
| 文本及工具 | 原生每个完成 content block 单独发布 assistant，多个 envelope 可共享 message.id；按 delivery UUID 去重并合并块，保留 streaming delta 和最终 snapshot。实际 CLI 双文本块证明最终 snapshot 包含两块；工具开始/结束按原生 tool_use ID 对应。 |
| 完成及取消 | 等待 native result、stdio 排空和真实进程 clean exit 后才成功；result 后非零退出或迟到 API 错误均失败。worker 覆盖 cancel、崩溃、坏 JSON、受控退出屏障及下一轮恢复。 |
| 审批与问答 | `can_use_tool` 映射一次审批，`AskUserQuestion` 映射单选/自由文本，原始 input 与 answers 返回原生；拒绝伪造选项，处理原生撤销。无支持语义的交互明确失败。 |
| MCP 与上下文 | 原生 user/project MCP 层保留；额外 MCP 采用私有租约文件，结束/失败/取消后删除。真实 Studio nativeContext worker 证明 host 覆盖同名自定义伪 server，ELECTRON_RUN_AS_NODE=1、Run 凭据轮换/撤销与文件清理有效。实际 CLI 两种模式均实际执行本地 MCP tools/call。 |
| Skills/文件 | 原生与项目 Skills、Markdown commands、settings/MCP/CLAUDE.md/hermes-rules.md 位置由插件声明。实际 CLI 读取原生 CLAUDE.md 和 Skills；hermes-rules.md 的编辑内容按轮加载，不覆盖原文件。 |
| 命令 | 插件注册 static `/compact` 和原生 initialize/commands_changed 动态目录，命名空间/alias 都转为原生命令名并保留参数尾。worker 走完整 PluginCommands 服务验证异步 Run 提交回执。真实 CLI 执行 Skill 命令、带指令 `/compact`，并在压缩后继续读取原生总结。 |

## 管理只读边界

实际临时 Home 探针表明，2.1.310 的 `initialize --no-session-persistence` 和 `claude auth status` 都会在空 Home 创建 `.claude.json` 与 backup；因此均不用于管理只读检查。`inspect` 只探测 `--version`，认证返回 `unknown`，模型目录返回 `unsupported`，原生登录方法与显式安装/登录操作单独提供。真实 CLI 检查前后 nativeRoot 文件清单保持不变，worker 确认没有 auth/initialize/原生会话/Run。不能把凭据存在或本地 fixture 当作真实账号验收。

探针：`/tmp/studio-claude-auth-probe.py`、`/tmp/studio-claude-usage-probe.log`；临时 CLI 为 `/tmp/studio-claude-native-qa/node_modules/.bin/claude`。全部使用临时 Home 和本地测试凭据，未读取或登录真实用户账号。

## 验证记录

- worker 专项：`tests/server/studio-claude-code-plugin.test.ts`，**21 项通过**。日志 `/tmp/studio-claude-plugin-focused-final.log`。
- 实际 CLI：`STUDIO_CLAUDE_NATIVE_COMMAND=/tmp/studio-claude-native-qa/node_modules/.bin/claude npx vitest run tests/server/studio-claude-code-plugin-native.test.ts`，**2 项通过，两种模式共 10 轮、12 次本地 Anthropic 请求、2 次 MCP 实际调用**；包含图片、原生资源、双文本块、配置重建恢复、Skill 命令、native compact 及压缩后续聊。日志 `/tmp/studio-claude-plugin-real-final.log`。
- `npx tsc -p plugins/tsconfig.json --noEmit` 通过。日志 `/tmp/studio-claude-plugin-types-final-v2.log`。
- 构建测试单独 esbuild 当前插件，公共源码 alias 与正式构建一致；不改共享 bundle 列表。最终追加校验日志见下方交接补记。
- 初版真实 compact 探针发现 stdout 以 native user envelope 的 `<local-command-stdout>` 回传，已补正确投影；初版 scoped 设置探针发现 native env 覆盖行为，已增加临时路由和生效检查；初版双文本块探针发现 native summarizer 只取最后一块，因此总结请求 fixture 使用单块，普通对话保持双块。原失败日志保留，不把失败当成功。

交接前最终追加校验：两份测试合并执行 **23 项全部通过**，实际 CLI 仍为 10 轮/12 请求/两种模式 MCP；日志 `/tmp/studio-claude-plugin-delivery.log`。最终插件全量类型检查通过，日志 `/tmp/studio-claude-plugin-delivery-types.log`。以正式公共 alias 另行构建了 `dist/plugins/claude-code` 工件；依赖扫描未见 server/client 私有导入。没有修改共享构建列表、UI、CI 或总体交接文档，也未 commit/push。

### 清理失败复用修订

主线程 review 指出，旧实现会在清理失败后清空 current，却未永久阻断同一 runtime；同时内存中的 resume 提前于 finally 清理推进。已修正为：native result 先形成临时 checkpoint，process、gateway、租约配置清理全部成功后才更新 resume 并返回成功；任何清理失败永久标记当前 runtime unavailable，cancel 也等待结果的清理确认。

新增三个带实际 managed 子进程的故障注入：process.dispose 抛错、gateway.dispose 抛错，以及原生结束后将租约配置文件替换为目录，从而使真实 rm 非递归清理失败。各场景确认其他清理仍被尝试、结果不成功、同一 runtime 下一轮不会再次申请 gateway 或启动进程；另用完整 worker 验证原生已输出成功文本但 gateway 清理失败时，宿主只保留上次成功 checkpoint。

修订后专项 **25 项通过**，日志 `/tmp/studio-claude-plugin-cleanup-revision.log`；类型检查通过，日志 `/tmp/studio-claude-plugin-cleanup-types.log`。实际 CLI 隔离复验 **2 项通过、10 轮/12 本地请求/两种模式 MCP**，日志 `/tmp/studio-claude-plugin-cleanup-real.log`；保留全部原默认时限。主线程先前并行运行时 scoped 触发默认 5 秒时限的原始失败日志仍保留，本次隔离通过不覆盖该失败记录。无共享文件修改、commit 或 push。

## 未关闭项

管理 auth/model 原生只读目录、完整模型 context/output/压缩策略下发、估算 cost DTO、复选框/新增 user-dialog/带字段 MCP elicitation、真实账号、原生跨平台进程与 shell、全入口父子 Run 和唯一写入、旧历史/配置迁移、分发升级回滚、最终旧 runner 清理都未由这份证据验收。scoped 凭据 override 的历史配置需显式迁移或用户编辑；不自动删除/重写原生配置。
