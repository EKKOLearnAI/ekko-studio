# Cursor 独立插件证据

日期：2026-10-25。当前为独立实现与边界验证，完整迁移验收仍为 **0/14**。本文件不关闭真实账号、跨平台或最终迁移验收。

## 工件和真实能力

官方 [安装文档](https://cursor.com/docs/cli/installation) 和当天 `https://cursor.com/install` 脚本指向 `2026.10.22-27dcf5f`。下载地址：`https://downloads.cursor.com/lab/2026.10.22-27dcf5f/darwin/arm64/agent-cli-package.tar.gz`；SHA-256 `2f5b0a3dd5fb951cecffac813867d8a08d810e59837d59fd5f12d69b922398d7`。实际执行报告同一版本。工件仅放在 `/tmp/studio-cursor-native-qa`，没有升级或覆盖用户现有 CLI。

旧实现和 `cursor-global-mode.test.ts` 都明确为 global-only。插件保留此边界，拒绝 scoped。Cursor 使用原生 Cursor 账号/API；其 `--endpoint` 对接 Cursor 服务，并非 OpenAI/Anthropic 模型协议。没有把 Studio 临时 bearer 当成 Cursor API key，也没有虚构 scoped 网关支持。

安装契约为 manual，链接到官方文档；不提供 npm install/upgrade/uninstall 计划。登录为原生 `agent login`。验证工件保留版本身份，原生账号 Home 不被替换。运行加工件真实支持的隐藏 `--disable-auto-update`，避免一次聊天隐式升级运行文件；仍需统一宿主的外部手动工件锁定、升级和回滚验收。

## 实现

- 插件只导入公开 SDK/driver 与 Node 标准库，不使用宿主旧 runner。所有进程归 SDK 租约管理。
- 保留 `-p --force --output-format stream-json --stream-partial-output`、stdin 长提示、准确 `--resume` 和临时文件 `--image`。当前工件把图片选项隐藏在 help 中，实际发布代码仍注册该参数；没有据缺少 help 条目删掉图片能力。
- [原生输出文档](https://cursor.com/docs/cli/reference/output-format) 定义了 partial delta、工具调用和终态。插件忽略原生缓冲/最终 flush；工具与相同终态重复记录去重。会话 ID 改变、冲突终态、畸形或过大的 NDJSON、非零退出及缺少终态都失败。结果、退出零和全部清理后才保存检查点；清理失败阻断后续轮次。
- global 不覆盖原生 Home/账号，用户/项目 MCP、规则、Skills 和配置由 Cursor 自己加载。管理资源包含 native/workspace Skills、规则、命令目录、配置及指令。宿主 MCP 通过临时 `--plugin-dir` 装载，manifest 明确 `mcpServers: 'mcp.json'`；不会复制原生 MCP 导致重复启动，完成/失败/取消后移除辅助目录。每个 Studio 托管 stdio MCP 的 Node 标记由宿主配置提供并原样保留。
- print 协议不提供双向审批、澄清或运行时命令目录，故不宣称这些能力；`/compact` 明确拒绝。原生文件仍可由用户管理，不能据文件存在伪造命令执行成功。额外指令通过本轮 stdin 文本传入，未使用限内部团队的隐藏 system-prompt 替换开关。
- 原生 input/cacheRead/cacheWrite 是分离计数：runtime 总输入只求和一次，并携带可选 cache/reasoning 明细；缺失 usage 保持 unknown。scoped 不可执行，不会重复调用宿主网关计量。

## 只读管理

实际 `--version`/`--help` 会在全新 Home 初始化 `.cursor/cli-config.json`。管理版本探测因此使用可清理的一次性 Home/config/cache、文件凭据存储和空 Cursor 凭据，不触碰用户账号配置。inspect 不发 `status`、`models`、登录或聊天请求；认证返回 unknown，模型目录为 unsupported。setup 展示实际 executable 的版本和手动安装入口；资源路径检查不初始化账号状态。

这比伪造已登录/空模型成功更保守，但原生模型目录的只读账号探测仍需后续补充。若未来提供有效能力探测，应先验证不会刷新凭据或初始化原生配置。

## 验证

`tests/server/studio-cursor-plugin.test.ts` **22 项通过**，真实 plugin worker/host/coordinator 链路覆盖成功、进程重启后精确恢复、流式重复去重、缓存/推理用量、缺失用量、终态后等待退出、错误/迟到崩溃/畸形/截断/超限输出、取消、撤权、恢复 ID 不符、图片/192,000 字节 stdin、MCP 隔离、manual setup、资源路径，以及清理失败禁止下一轮。加旧 Cursor 流式/参数/配置/安装政策回归共 **46 项通过**，默认期限未修改。日志 `/tmp/studio-cursor-worker-final.log`；插件严格类型 `/tmp/studio-cursor-types-final.log` 通过。

真实官方 CLI 经隔离 plugin worker 验证：版本匹配、manual setup、资源路径，inspect 不建 Studio Run、原账号配置不变。运行只向本地 HTTP fixture 发送 `/auth/exchange_user_api_key`；本地明确返回 401，native Run 按预期失败且无成功检查点。此验证只证明原生账号/协议失败边界；**没有完成任何真实账号推理，也没有证明真实图片、Skills 或 MCP 执行成功**。日志 `/tmp/studio-cursor-real-native.log`。

复现：

```bash
STUDIO_CURSOR_COMMAND=/absolute/path/to/official/cursor-agent \
  python3 /tmp/studio-plugin-run-clean.py /tmp/studio-cursor-real-native.log \
  node scripts/verify-cursor-plugin-native.mjs
```

专属验证脚本自行构建临时插件和 runner；不会改共享构建列表或原生账号数据。完整共享 bundle、管理 UI、CI、冻结 coverage/browser/build 由主线程集成后验证。macOS arm64 以外平台及真实账号恢复/性能仍未验收。
