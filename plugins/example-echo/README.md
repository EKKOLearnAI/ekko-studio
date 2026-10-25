# Echo Agent 插件示例

此目录可直接安装，入口为 `index.cjs`。它不导入 Studio server 私有实现，在 `apply(ctx)` 中注册 Agent、输入框命令和完成事件回调。插件可以只贡献事件回调；贡献 Agent 时必须注册 manifest 声明的全部类型。

## 开发验证

先在仓库运行 `npm run build:plugins`，再启动隔离开发服务。使用已有认证客户端调用以下接口；请求示例省略认证信息，身份由 Studio 中间件提供。

1. `POST /api/studio/plugins`：`{"path":"/absolute/path/to/plugins/example-echo"}`。
2. `PUT /api/studio/plugins/example.echo/profile?profile=default`：

   ```json
   {
     "enabled": true,
     "config": { "prefix": "Echo: " },
     "grants": ["agents.register", "events.subscribe:run.completed", "commands.register"],
     "revision": 0
   }
   ```

   `revision: 0` 用于首次配置；修改或重装时先 GET 同一路径并使用返回的 revision。

3. `POST /api/studio/agent-instances?profile=default`：`{"agentTypeId":"example.echo/assistant","config":{},"mode":"scoped"}`，记录返回的 `data.id`。
4. `POST /api/studio/agent-instances/{id}/runs?profile=default`：`{"input":{"content":[{"type":"text","text":"hello"}]},"idempotencyKey":"echo-example-1"}`，记录 Run 的 `data.id`。
5. GET `/api/studio/agent-runs/{runId}?profile=default` 和 `/api/studio/agent-runs/{runId}/output?profile=default&after=-1`，观察 `completed` 与 `Echo: hello`。
6. `DELETE /api/studio/plugins/example.echo` 卸载样例。运行尚未释放时返回冲突，可等待完成后重试；历史保留。

复用幂等键与相同输入会返回已有 Run；更换输入时必须使用新键。每次读取都检查当前用户及 profile，不允许靠 run ID 读取其他用户执行记录。

## 当前边界

SDK 和运行入口正在开发，尚未发布到公共 npm。新 Agent API 当前支持文本，尚未接入现有聊天选择器。`ctx.on` / `ctx.once` 是有界通知，进程重启不保证重放；持久化事件日志并不自动等于可靠订阅。配置中的日志回调没有外部通知副作用。

## 输入框命令

启用后，在同一 profile 下已有的自有直接聊天中输入 `/echo`，可选择 `/example.echo:echo` 并提交。插件自己的 handler 解析参数并返回 `session.command` payload；Studio 不处理 echo 的业务逻辑。无需先创建 Echo Agent 实例，也不调用模型。

`commands.register(definition, handler)` 的定义 ID 必须在 manifest 的 `contributes.commands` 声明；当前在激活期注册，Disposer 可撤销。handler 收到原始 `text`、实际命令名和保留空白/引号的 `rawArguments`，可返回结果，也可先 `await commandCtx.reply(result)` 发送中间结果，最后返回最终结果。异步工作必须在 handler Promise 完成前结束，已结束作用域不能继续回复。

结果沿用 `command/action/ok/message/started/terminal` 与原有结构化字段。作用域和会话信封由宿主绑定；`commandCtx.session.isWorking` 是派发时快照，运行中查询不得报告结束其他 Run。当前入口为 `/api/studio/commands` 和 `/api/studio/command-calls`，只支持已有自有直接聊天的文本命令；原生命令动态更新、草稿实例、群聊和 App 接入仍待迁移。
