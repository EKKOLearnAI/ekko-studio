# Echo Agent 插件示例

此目录可直接安装，入口为 `index.cjs`。它不导入 Studio server 私有实现，在 `apply(ctx)` 中注册 Agent 和完成事件回调。插件可以只贡献事件回调；贡献 Agent 时必须注册 manifest 声明的全部类型。

## 开发验证

先在仓库运行 `npm run build:plugins`，再启动隔离开发服务。使用已有认证客户端调用以下接口；请求示例省略认证信息，身份由 Studio 中间件提供。

1. `POST /api/studio/plugins`：`{"path":"/absolute/path/to/plugins/example-echo"}`。
2. `PUT /api/studio/plugins/example.echo/profile?profile=default`：

   ```json
   {
     "enabled": true,
     "config": { "prefix": "Echo: " },
     "grants": ["agents.register", "events.subscribe:run.completed"],
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
