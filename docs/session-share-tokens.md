# App 单聊分享授权

本功能提供 Studio 后端的分享 token、领取和授权层。App 页面及访客会话的消息、文件、终端传输需要通过此授权层接入；本次不向现有账号级业务接口开放分享 token。

## 记录与生命周期

- SQLite `session_shares` 每次创建新增一条记录，即使分享者和 session 相同。
- 邀请为 `sst1_` 加 32 字节安全随机数的 Base64URL；数据库只保存 SHA-256，创建响应只返回一次明文。列表、领取、访问、修改和撤销响应不返回密钥或哈希。App 保存链接时应按当前登录账号隔离存储，发送链接应使用 URL fragment，不能使用 query 参数。
- 固定从创建时起 30 天过期；领取、昵称变更和修改权限不续期。不提供修改到期时间或重新绑定接收人的接口；另一次分享应创建新记录。
- 必须登录 App 后主动确认领取。一个 SQLite 条件 UPDATE 原子绑定第一位接收人的 App 用户 ID、名称快照、领取时间。重复由同一账号领取幂等成功，其他账号返回 409。SQLite 不可用时失败，不回退到非事务 JSON 存储。
- 分享者及接收人使用云端 App 用户 ID；`created_by_user_id` 另存 Studio 本地用户 ID，两者不能互换。名称是服务端验证得到的历史快照，不参与授权。
- 撤销保留记录。session 删除、移至其他 Profile、创建人被禁用或失去 Profile 授权后，授权失败。

## 身份与请求头

所有接口使用 `X-App-Access-Token` 携带 App 云端 access token。Studio 向自身配置的官方/Cloudflare App 线路 `/api/app/auth/me` 核验账号状态、ID 和名称，不接受请求体中的用户 ID、名称或任意验证服务器 URL。云端不可用时失败关闭；云端登录状态在最多 10 秒内重新核验，缓存不超过 access token 本身的到期时间。验证请求不跟随重定向，不记录凭据明文。

管理接口还需要 `Authorization: Bearer <Studio app_access JWT>`；普通网页 `access` JWT 不可创建或管理分享。管理操作同时要求本地用户对 session 的现有 Profile 权限，以及与原分享者相同的 App 和本地账号。

领取与接收人接口需要 `X-Session-Share-Token: <sst1_...>`，不需要绑定目标机器或取得其本地账号凭据。持有邀请但 App 账号不是已绑定接收人仍会被拒绝。Token 只在专用接口验证，不能登录普通 Studio API 或 `/chat-run`、`/terminal` Socket。

这里的“仅 App”指 App 登录身份和产品入口，不把 User-Agent 当作安全边界；能够合法持有相同凭据的 API 客户端具有相同权限。

## API

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/studio/sessions/:sessionId/shares` | 创建；请求 `{ permissions?, extraPaths? }`；201 返回 `{ share, token }` |
| `GET /api/studio/sessions/:sessionId/shares` | 当前分享者的记录，包括过期、撤销记录 |
| `PATCH /api/studio/sessions/:sessionId/shares/:shareId` | 部分更新 permissions；extraPaths 提供时替换整个白名单 |
| `DELETE /api/studio/sessions/:sessionId/shares/:shareId` | 幂等撤销，保留记录 |
| `POST /api/studio/session-shares/claim` | `{ "confirm": true }` 主动领取 |
| `GET /api/studio/session-shares/access` | 读取当前会话绑定和权限元数据，不包含会话历史或内部配置 |
| `POST /api/studio/session-shares/check` | `{ action, sessionId }` 权限预检；成功返回 `{ allowed, sessionId, policyVersion, expiresAt }` |

`check` 的成功响应不是可复用授权票据，不能用于跳过后续操作检查。接口拒绝未知字段，不能通过批量赋值修改归属、过期时间、工作区或撤销状态。响应使用 `Cache-Control: no-store`。

## 权限

`read` 是领取后的基本元数据访问操作；七项可配置权限均默认 false：

| 字段 | 含义 |
| --- | --- |
| `input` | 在绑定 session 发消息并触发运行 |
| `upload` | 上传该 session 的附件；不等于任意工作区写权限 |
| `download` | 下载归属于该 session 且在授权路径内的文件 |
| `workspaceRead` | 浏览及读取工作区 |
| `workspaceWrite` | 编辑工作区文件 |
| `outsideWorkspace` | 允许使用额外目录白名单；不能单独扩大整个文件系统访问权限 |
| `terminal` | 使用该分享自己的终端；不等于主人终端的附着权限 |

额外目录为 `extraPaths: [{ path: "/absolute/directory", writable: false }]`，最多 16 项，必须存在且由本地超级管理员授权。`outsideWorkspace=true` 必须同时有非空白名单。工作区及额外目录记录真实路径，阻止路径穿越和符号链接越界；工作区后来变更时除基本读取外的操作失败，需要创建新分享。已知运行凭据路径如 `.token`、`.model-run-token`、`.env*`、`auth.json`、`.ssh` 不作为文件共享资源。

## 缓存与业务接入

`SessionShareService.authorize` 统一检查接收人、30 天期限、撤销状态、session、操作权限和创建人当前权限。分享记录缓存以 token 哈希为键，最多 1024 项，10 秒 TTL，返回副本以免调用方修改缓存；session/创建人授权仍读取当前状态。所有分享写入必须经过同一服务。成功提交后主动清除对应缓存并通知观察者，`policy_version` 使用条件更新避免并发覆盖。数据库读取同步完成，不存在旧异步查询在失效后重新填充缓存的窗口。多个 Studio 进程共同服务同一数据库时，其他进程最多受 TTL 延迟影响；如需跨进程即时撤销，需要额外广播机制。

后续接入业务操作时必须：

1. 从验证结果获取绑定 session，不能信任请求中的 Profile、工作区、模型配置或会话 ID。实体资源必须由服务端查出归属，再传给 `authorizeResource`。
2. 文件操作调用 `authorizePath` 后，在实际 IO 边界防止路径被替换；不能将预检当成打开文件的原子保证。附件还要验证 session 归属，不能仅凭附件 ID 下载。图像预览、导出、原始工具结果也必须纳入同一资源策略。
3. 每次业务命令重新鉴权；排队任务实际执行前再次鉴权。长连接用 `watch` 注册清理回调，权限变更会立即通知，到期、所有者权限失效会在下一次检查时通知（定时兜底 1 秒）。回调由业务消费者关闭 Socket、PTY、流或排队任务；正常结束调用返回的 disposer。App 登录身份本身也必须由传输层持续重新验证，不能无限复用最初的身份结果。
4. 浏览器/手机隐藏按钮仅改善体验。普通账号业务接口保持拒绝 share token，不允许通过新建本地用户或注入分享者 JWT 绕过隔离。
5. `input` 和 `terminal` 是授权配置，不代表当前执行器已经具备隔离能力。接入前必须提供能强制限制文件和工具能力的执行环境；不支持时拒绝执行。现有宿主机 PTY 只设置 cwd，不是沙箱；不能直接向分享访客开放。分享触发的运行也不能复用主人 `.model-run-token`。

本次为已有 App Relay 的请求头白名单加入两个分享凭据头，以支持已建立连接的管理操作；不新增云端“分享访客”转发角色。没有目标设备绑定的接收人通过直达 Studio 的专用接口调用，云端访客通道及 App 页面属于后续业务接入。

## 验证

运行 `npx vitest run tests/server/session-shares.test.ts tests/server/session-share-app-identity.test.ts tests/server/session-shares-routes.test.ts tests/server/app-relay-client.test.ts tests/server/app-relay-server.test.ts`，以及 `npm run harness:check` 和 `npm run build`。测试使用隔离 SQLite 和模拟云端身份，不访问真实 App 账号、不创建真实分享、不启动 Agent 或终端。
