# ZCode 独立插件证据

更新：2026-10-25。独立实现已交付到工作区，完整迁移验收仍为 **0/14**，旧链路保留。

## 原生工件与协议

- 使用本机已安装、通过 Apple 签名校验的 ZCode Desktop **3.14.4** 内的 CLI **0.16.9**：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。没有下载、重新打包或分发厂商二进制。
- CLI SHA-256（本机实测）：`fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f`。这是本次验证工件的摘要，不冒充上游发布的独立 checksum 清单。
- `codesign --verify --deep --strict --verbose=1 /Applications/ZCode.app` 通过。签名主体为 Beijing Knowledge Atlas Technology Joint Stock Company Limited，Team ID `8A5X4JJ39T`，签名时间 2026-09-29。本地 CLI `--version` 在临时 Home 中返回 0.16.9。
- 官方仓库：[zai-org/ZCode](https://github.com/zai-org/ZCode)，许可证 Apache-2.0。只提供官方 HTTPS 手动安装说明和真实 `zcode login` 终端计划，不编造 npm 包、自动下载或登录回执。公开 GitHub Releases 当次查询只列出 Desktop v3.14.3，不将本地 Desktop 版本当作可自动获取的已锁定发布包。
- 使用公开 `app-server --stdio` / **ZCode Protocol 1**，有界 NDJSON，公共 `NativeRpcConnection` / `ManagedJsonRpcTransport` 和宿主受管进程。插件只依赖公开 SDK/driver；无私有 server/client 导入、旧宿主 runner 或自行 spawn 厂商进程。
- 官方协议/配置资料核对自仓库提交 `3c5b227649371507ddc4eb46ac5133afe6db1cab`：[协议](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md)、[原生配置](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/docs/usage/03-config.md)、[MCP](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/docs/usage/07-mcp.md)、[Skills](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/docs/usage/08-skills.md)。版本敏感字段另对实际 0.16.9 CLI 验证，未把 main 新字段当作本机能力。

## 实现和边界

- global 保留原生账号 Home、provider、配置、Skills、指令和会话库；PATH 中独立 CLI 优先，随后发现桌面 CJS 工件，显式命令/受管选择优先。全局模型/推理档位按原生 builtin、个人选择及有序规则解析，不改原生 provider 文件来切换模型。
- scoped 使用宿主 stateDirectory 下独立 Home/数据/会话存储，模型固定到宿主 Anthropic gateway；每轮短期 relay 只转发固定 lease URL 的 POST messages/count_tokens，验证原生凭据和模型、拒绝重定向，限制并发 4、请求 10 MiB、响应 64 MiB，取消和完成都等待关闭。
- **临时原生 relay 凭据例外**：0.16.9 的普通 API-key provider 不支持环境引用，实际 `session/send.modelExecution.requestAuth` 探针仍发送 provider 文件中的占位 key；该通道仅在原生特定账号路径消费，不能伪造 off-peak 账号语义。宿主 gateway bearer 始终只在插件内存中。原生 provider 临时文件保存的是另一把每 Run 的 loopback relay key，权限 0600，进程退出和 relay 撤销后删除。没有全局 fetch hook。
- 提示词经 NDJSON 写入 stdin，保留完整 Unicode、多行和长输入，避免旧 Windows argv/CJS 提示词桥限制；图片经 SDK 分块读取后使用 GUI 协议 `kind/localPath/mimeType` 附件，临时文件归本轮清理。
- 精确 `session/resume`，校验 checkpoint、返回 native session ID 与规范化工作区；不选择 latest，不在恢复失败时静默新建。完成等待 turn.completed、prompt_completed、读取到 idle 和 EOF 后退出 0；全部清理确认后才推进 checkpoint。迟到非零或清理失败不提交 checkpoint，清理失败令同一 runtime 永久不可复用；worker 与直接运行租约的失败注入均验证了该屏障。
- 文本、推理、工具开始/成功/失败和原生审批/澄清投影；原生撤回丢弃迟到应答，取消关闭实际进程树。global 按原生每 request ID 计量，缓存输入已计入总输入；scoped 不重复上报 runtime usage。
- Skills/AGENTS、配置和只读共享 Skills 作为原生资源公开；只读 inspect 仅版本命令和配置目录投影，不创建会话/Run，不回传原生凭据或账号标识，认证保持 unknown。
- 维持旧适配器的 nativeCompact=false，不把普通模型回答伪装成压缩成功。原生自定义命令由 native 目录发布，保留输入的斜杠前缀。

## 验证

Node 24.22.1，测试清理继承的 HERMES/EKKO/ELECTRON、AUTH_TOKEN、PORT、NODE_OPTIONS/NODE_PATH。所有 native Home、状态、模型服务和 MCP 都在临时目录和 loopback；不读取真实账号，不登录，不付费推理。

- 插件 worker + relay **31 项通过**（含两项实际 CLI 用例），加既有 ZCode 专项共 **59 项通过、无跳过**：`/tmp/studio-zcode-native-config-cleanup-final.log`。
- 插件、relay 及既有 ZCode 模型/命令/长提示词专项 **55 项通过**，两项实际 CLI 用例按环境门控：`/tmp/studio-zcode-focused-reviewed.log`。
- 实际 CLI global/scoped 各 **3 轮**，共 **6 轮 / 10 次本地模型请求 / 2 次真实 MCP tool call / 2 次真实 Skill 加载**：首轮、图片轮、恢复后 Skill+MCP 轮，每轮重建协调器；资源经宿主 resourceFiles 实际写入，验证指令和 Skill 正文、MCP 返回进入后续模型请求；第二轮编辑原生 config 禁用 Skill，实际模型工具目录不含 Skill，第三轮编辑重新启用并实际加载，证明 scoped 的源配置没有被短期 provider 重建覆盖；global/cache 用量准确且 scoped 无重复 runtime 写入；图片在下一轮协调器重启恢复后的模型请求中仍实际存在。日志 `/tmp/studio-zcode-real-final-v2.log`，缓存细分、恢复图片、原生配置编辑与清理失败验证最终日志 `/tmp/studio-zcode-native-config-cleanup-final.log`，独立图片恢复复验 `/tmp/studio-zcode-image-resume.log`。
- 严格插件 TypeScript、独立 bundle 构建、仓库 harness 通过：`/tmp/studio-zcode-final-types.log`、`/tmp/studio-zcode-final-build.log`、`/tmp/studio-zcode-final-harness.log`。
- 真实联调暴露并修正了 0.16.9 与当前 main 的差异：MCP schema 拒绝 alwaysLoad，create 不能替代逐轮 modelSelection 推理选项，GUI 附件使用 kind/localPath。global 图像 fixture 明确声明原生模型视觉能力；产品不强制绕过原生模型配置。原生配置规范化会调整 JSON 字段次序/格式，fixture 按原生 canonical 文件格式准备，保留完整字节相等断言；适配器不写全局源文件。

复现：

```sh
python3 /tmp/studio-plugin-run-clean.py /tmp/studio-zcode-worker.log npx vitest run tests/server/studio-zcode-plugin.test.ts tests/server/studio-zcode-plugin-relay.test.ts
STUDIO_ZCODE_COMMAND=/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs python3 /tmp/studio-plugin-run-clean.py /tmp/studio-zcode-native.log npx vitest run tests/server/studio-zcode-plugin.test.ts -t 'actual installed'
node plugins/zcode/scripts/build.mjs
```

## 未关闭事项

- **原生 MCP 自定义 cwd 与 managed MCP 注入组合**：不注入时完全保留 native 自己的发现/权限/配置链。有注入时合并工作树祖先、项目和用户配置，保留同名用户优先及 managed 覆盖；0.16.9 公开 MCP DTO 无 cwd，无法表示的工作目录明确拒绝，不丢字段、不新增 launcher spawn 链。这是尚未功能对等的能力差距，旧链路必须保留。
- **空 MCP 覆盖**：原生 protocol 将空 server 列表解释为无覆盖；若禁用操作会使覆盖列表为空并重新启用原生定义，插件明确拒绝，避免静默反转禁用设置。
- 真实账号、远程提供方、Windows/Linux 原生工件/恢复、全入口父子 Run/统一计量、完整分发版本锁定/升级回滚及性能验收未关闭。macOS 的本地 fixture 和独立实现数量不等于完整 14 项验收完成。

## Windows 工作区身份回归

首次集成的 Windows CI 出现 ZCode 多项运行在交互前失败；既有报告未包含 native 返回的工作区值，不能把本地验证称作 Windows CI 已通过。代码审查找到一侧规范化的错误：配置 `cwd` 经 `realpath`，原生 snapshot 的 `workspacePath` 则直接按原文比较。Windows 的短文件名/长文件名或其他真实目录别名可能因此被当作不同工作区。

新增真实 plugin worker、真实文件系统 symlink（Windows 使用 junction）回归，在原实现上 global/scoped 均复现 `INVALID_ARGUMENT: ZCode restored a different native conversation`，且尚未发送用户输入；修复后创建、精确恢复和最终读取均通过。运行前使用 canonical cwd 派发，初始/最终 snapshot 也各自经 `realpath` 后精确比较；未增加大小写猜测、前缀放行或身份校验例外。两个实际不同目录的负例分别覆盖初始和最终 snapshot，仍拒绝且不提交 checkpoint。原有期限和条件跳过保持不变。

回归红/绿日志：`/tmp/studio-zcode-workspace-alias-red.log`、`/tmp/studio-zcode-workspace-alias-green.log`。最终专项、真实 CLI、严格类型和 bundle 日志：`/tmp/studio-zcode-workspace-identity-final.log`、`/tmp/studio-zcode-workspace-types.log`、`/tmp/studio-zcode-workspace-build.log`。Windows 原生 CI 的实际短路径值与最终通过状态仍以新一轮 CI 回执为准。
