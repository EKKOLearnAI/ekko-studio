# Pi 独立插件增量证据

日期：2026-10-25。此文件记录 Pi 独立实现的可复核增量，完整迁移验收仍为 **0/14**。

## 实现边界

- 固定 `@earendil-works/pi-coding-agent@1.4.0`，`pi` bin，受管安装 `runner: node`。插件只依赖公开 Studio SDK/driver 和 Pi 的公开 extension API，不导入 server/client 私有实现。
- 原生 RPC 按 LF JSONL 解析，关联命令有界、等待 `agent_settled`，不能把 `agent_end` 或 prompt admission 当完成。每轮 stdin EOF、确认退出码 0、核对 managed sessions 下的 session header 后才提交 checkpoint。
- global 使用用户原生 Home/`PI_CODING_AGENT_DIR`；scoped 使用 runtime state 下独立 Home/Pi agent directory 和 Studio Responses gateway。临时模型 token 只在进程环境，不写配置文件；scoped 的计量仅由宿主网关写入。
- managed extension 使用 Pi 的 `registerProvider`、`createMcpExtension`、`getAgentDir`。Native MCP global/project 配置由 Pi transports 消费，project 配置只在 Pi 判定 trusted 后读取；同名 managed 条目优先，不改用户原生文件。legacy SSE 明确拒绝；stdio/HTTP 沿用 Pi 原生能力。
- 私有逐轮描述文件带随机 nonce；extension 成功注册后写入 0600 `.ready` 回执，runtime 在发送用户输入前核对。Pi 会记录 extension load error 后继续启动，因此必须核对此回执，不能默默改用 native 默认值。成功/取消/异常清理描述文件、回执、gateway 和进程。
- 全局原生 assistant 及 compaction summary 的 usage 分别投影；`inputTokens` 包含原生 input/cacheRead/cacheWrite 总和，call ID 区分摘要和 assistant。缺失/非法 usage 不伪造；Pi 未提供独立 reasoning token 数。

## 已完成验证

| 验证 | 实际结果 | 日志 |
| --- | --- | --- |
| worker / IPC / 边界 | 28 项通过，4.48 秒，默认 Vitest 期限 | `/tmp/studio-pi-worker-final-v2.log` |
| Pi 源码 strict TypeScript | Pi 独立 include、沿用 plugins compilerOptions，通过 | `/tmp/studio-pi-types-only-final.log` |
| Native extension JavaScript | `node --check plugins/pi/native/studio.mjs` 通过 | 本轮直接执行 |
| 最终真实 compact 矩阵 | 14 轮聊天 + global/scoped 各 1 次 compact；21 次本地模型请求、5 次 Studio MCP，通过 | `/tmp/studio-pi-real-final-v2-compaction.log` |
| 最终真实 Skill 命令 | 14 轮聊天 + global/scoped 各 1 次 `skill:studio-resource-check`；21 次本地模型请求、5 次 Studio MCP，通过 | `/tmp/studio-pi-real-final-skill.log` |
| 实际私有 CLI 安装 | global/scoped 2 次固定 1.4.0 安装，7 轮聊天、12 次本地模型请求、5 次 Studio MCP，通过 | `/tmp/studio-pi-real-final-managed.log` |

矩阵使用实际原生 Pi CLI、临时 Home、本地模型服务和真实受管进程。覆盖 global/scoped、图片、原生指令/Skills、MCP 配置更新、coordinator/provider 重建、同会话恢复、两个聊天历史隔离、Responses/Chat/Anthropic 模型协议转换及跨轮切换。没有登录真实账号或调用远程付费模型。

worker 边界覆盖：迟到 retry/settled；confirm/select/input/editor 原生响应；原生问答期限和宿主取消；崩溃和 EOF 后非零退出；取消后可启动下一轮；检查 checkpoint 外部路径、symlink 逃逸、header 身份、文件缺失和未知字段；未加载 managed extension 时在 prompt 前失败；有限元数据不创建 Run/会话并拒绝非法目录；global 文件不变、scoped 临时凭据隔离、SSE 拒绝；managed/global/project MCP 合并及项目信任边界；摘要计量独立且 scoped 不重复写入。

## 保留的失败与修正

最初通用 native matrix 在第一轮后立刻 compact，原生拒绝：`Nothing to compact (session too small)`，诊断 `/tmp/studio-pi-compact-diagnostic.log`。Pi 默认保留最近 20k token；一条长输入仍可能没有可摘要的旧 span。没有将失败改为成功或调整产品 Pi settings。通用 verifier 增加 `STUDIO_NATIVE_COMMAND_AFTER_TURN=1`，前两轮都提供实际长上下文，在默认原生保留规则下产生可摘要历史，最终 global/scoped 两次真实 compact 均成功并保留同一 native checkpoint。

早期全 plugins typecheck 同时扫描尚在开发的 Claude Code/DSH，因这些 WIP 报错；日志 `/tmp/studio-pi-types-final.log` 不记为通过。Pi 独立 strict include 验证通过；主线程仍需在所有插件集成后跑整体构建。

## 主线程集成接口

- Agent/plugin IDs：`pi` / `studio.agent-pi`；manifest command `studio.agent-pi/compact`，runtime dynamic commands `pi`。
- modes：`global`、`scoped`；managed install：npm package `@earendil-works/pi-coding-agent`、version `1.4.0`、bin `pi`、runner `node`。
- login launch args：空数组。启动原生交互 Pi，用户在其中执行 `/login`；setup 提示 `/login`，不可把 `/login` 当 CLI 参数。inspect 仅 `--version` / `--offline --list-models`，认证状态 unknown。
- Native skills ID `native-skills`；共享只读 `shared-skills`；workspace `workspace-skills`、`workspace-shared-skills`。指令 ID `native-instructions` 指向原生 `AGENTS.md`；其他 native config IDs `native-config-0` settings.json、`native-config-1` models.json、`native-config-2` mcp.json、`native-config-4` APPEND_SYSTEM.md。
- optional native asset directory `plugins/pi/native` 必须随工件复制；私有安装、随包 registry/UI/CI 由主线程集成。
- 主线程已将原生 cache 明细接入公共事件/持久归并：`cacheReadTokens: usage.cacheRead`、`cacheWriteTokens: usage.cacheWrite`，保持总 inputTokens 语义，不虚构 reasoningTokens；Pi worker 与管理/随包专项合计 76 项通过。

复现（先构建 Pi 工件，使用清理环境的 Node 24.22.1）：

```bash
STUDIO_AGENT_VENDORS=pi STUDIO_PI_COMMAND=/absolute/path/to/pi/cli.js STUDIO_NATIVE_COMMANDS=1 STUDIO_NATIVE_COMMAND_AFTER_TURN=1 node scripts/verify-agent-plugin-native.mjs
STUDIO_AGENT_VENDORS=pi STUDIO_PI_COMMAND=/absolute/path/to/pi/cli.js STUDIO_NATIVE_COMMAND=skill:studio-resource-check node scripts/verify-agent-plugin-native.mjs
STUDIO_AGENT_VENDORS=pi STUDIO_MANAGED_CLI=1 node scripts/verify-agent-plugin-native.mjs
```

## 尚未验收

真实账号登录/刷新与远程付费服务、Windows/Linux 实机/恢复、真实 native extension 对话及第三方 OAuth 服务、历史数据迁移/回滚、整个业务统一 Run 与跨入口唯一写入、App/管理页总集成、压测和性能仍需后续验收。这里的 fixture 和实现数量不替代最终关闭依据。

公开 Pi 参考（实际实现依据为固定 1.4.0 安装包内 docs 和 dist 类型）：[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)、[MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)、[extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)。
