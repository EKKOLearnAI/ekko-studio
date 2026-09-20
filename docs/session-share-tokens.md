# App 单聊分享 token

分享后的消息、历史、文件和终端复用现有单聊接口与 Socket 协议。消息仍走原来的单聊流程，不新增访客消息类型或另一套聊天接口；Studio 在入口增加临时 token 鉴权。本次实现后端接口，App 页面及云端接收人转发通道不在此改动内。

## 记录与生命周期

- SQLite `session_shares` 每次分享新增一条记录，绑定唯一 session；群聊和 workflow session 不可使用此功能。
- Token 为 `sst1_` 加 32 字节安全随机数的 Base64URL。数据库只保存 SHA-256，创建时返回一次明文；其他响应不返回 token 或哈希。App 按登录账号隔离存储，分享链接使用 fragment，不能使用 query 携带凭据。
- 从创建起固定 30 天过期；领取和修改权限不续期。
- 接收人登录 App 并明确确认后，SQLite 条件 UPDATE 原子绑定第一位接收人的 App 用户 ID、名称快照和领取时间。相同接收人重试幂等成功，其他人返回 409。不允许改绑；再次分享创建新记录。
- 分享者及接收人均使用云端 App 用户 ID；另存 `created_by_user_id` 作为 Studio 本地执行账号，不能混用。名称快照由服务端验证后记录，不参与授权。
- 撤销保留记录。session 删除、移至其他 Profile、创建人被禁用或失去 Profile 授权时，访问失效。

## 身份与传输

HTTP 使用两个请求头：

```http
X-Session-Share-Token: sst1_...
X-App-Access-Token: <接收人的 App 云端 access token>
```

现有 `/chat-run` 和 `/terminal` Socket.IO 连接使用：

```json
{
  "auth": {
    "shareToken": "sst1_...",
    "appAccessToken": "<接收人的 App 云端 access token>"
  }
}
```

直连也支持 HTTP `Authorization: Bearer sst1_...` 或 Socket `auth.token=sst1_...`，仍需 App 云端凭据。经过已有 App Relay 时优先使用独立分享字段，防止 relay 注入本地 JWT 时覆盖 token。分享凭据优先：同时携带普通 JWT 不会扩大分享权限。URL query 不接受分享 token。

Studio 向自身配置的 App 线路 `/api/app/auth/me` 核验账号状态、ID 和名称，不接受客户端提交的身份或任意验证 URL。身份缓存最多 10 秒且不超过 access token 到期时间；云端故障时失败关闭。这里的“仅 App”由登录身份和产品入口定义，不以 User-Agent 作为鉴权依据。

管理接口另外需要 `Authorization: Bearer <Studio app_access JWT>`。普通网页账号 JWT 和分享 token 都不能创建或管理分享。

## 分享管理 API

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/studio/sessions/:sessionId/shares` | 创建；`{ permissions?, extraPaths? }`；201 返回 `{ share, token }` |
| `GET /api/studio/sessions/:sessionId/shares` | 当前分享者的记录，包括过期和撤销记录 |
| `PATCH /api/studio/sessions/:sessionId/shares/:shareId` | 部分修改 permissions；extraPaths 提供时替换白名单 |
| `DELETE /api/studio/sessions/:sessionId/shares/:shareId` | 幂等撤销，保留记录 |
| `POST /api/studio/session-shares/claim` | `{ "confirm": true }` 主动领取 |
| `GET /api/studio/session-shares/access` | 当前 session 绑定、权限和到期元数据 |
| `POST /api/studio/session-shares/check` | `{ action, sessionId }` 权限预检 |

管理操作同时核验本地 Profile 权限和原分享者的 App、本地账号。预检结果不能代替业务接口鉴权。未知字段和自定义过期时间、用户 ID 均被拒绝。HTTP 分享响应设置 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。

## 现有接口的权限映射

领取后的基本 `read` 权限可以读取绑定 session 的历史、上下文、用量并恢复消息流。七项可配置权限默认 false：

| 字段 | 现有接口或操作 |
| --- | --- |
| `input` | `POST /api/studio/chat-run/runs`；Socket `run`、`abort`、排队操作、批准和澄清回复 |
| `upload` | `/api/studio/uploads` 和 `/api/studio/app-uploads` 的创建、分片、完成、取消 |
| `download` | `/api/studio/files/download`、session 导出、`workspace-file/content?download=1` |
| `workspaceRead` | session 的 `workspace-files/list`、文件读取、预览、diff 和运行文件变更 |
| `workspaceWrite` | session 的文件写入、mkdir、删除、rename、copy |
| `outsideWorkspace` | 在额外目录白名单内应用文件权限；不单独授予整个文件系统访问能力 |
| `terminal` | 现有 `/terminal` Socket 协议，`source=single`、`sourceId=绑定的 session` |

压缩导出会调用模型，因此除 `download` 外还需 `input`。

只允许明确列出的 session 路由；全局列表、搜索、设置、其他会话、分享管理和会话删除等接口被拒绝。Socket 只允许 `resume`、`app.resume` 和上述输入事件，不订阅全局 App 事件或 Profile 广播。基本读取不返回父会话的标题和消息预览。

发送消息必须提供绑定的 `session_id`，不能创建新会话。执行配置从现有 session 获取；客户端不能通过此请求覆盖 Profile、工作区、模型凭据、MCP、群聊或 workflow 上下文。管理会话的斜杠命令不开放给分享 token。

终端仍走原协议并使用现有宿主机权限，创建人也须具备现有终端权限。终端归属包含 share ID，接收人不能附着主人或另一条分享记录的终端；同一分享重连可恢复自己的 PTY。

## 文件范围与执行权限边界

额外目录格式为 `extraPaths: [{ path: "/absolute/directory", writable: false }]`，最多 16 项，必须存在且由本地超级管理员授权。`outsideWorkspace=true` 要求非空白名单。工作区和额外目录固定真实路径，文件入口检查路径穿越、符号链接越界及已知凭据路径（`.env*`、`.token`、`.model-run-token`、`auth.json`、`.ssh` 等）。rename/copy 同时校验两端。工作区改变后需重新分享。

分享上传写入由服务端按 session 划分的附件目录；上传分片还绑定具体 share ID。`upload` 不等于工作区写权限。下载只允许授权工作区/额外目录或该 session 的分享上传目录，不能按任意路径读取整个 Profile 的附件。历史附件如位于这些范围之外，需要明确的目录授权，不根据聊天文本中的路径自动授权。

**按本功能约定，权限只限制 App 对接口的直接调用。Agent 和终端沿用既有执行权限，不引入文件系统或工具沙箱。** 开启 `input` 后，Agent 能执行原有工具；开启 `terminal` 后，shell 能执行宿主机账号允许的命令。因此 `outsideWorkspace=false` 不限制 Agent/shell 的间接文件访问，关闭 `download` 也不是对已显示内容的防复制措施。

## 校验、缓存与撤销

每次 HTTP 请求和 Socket 命令都检查接收人、到期、撤销、绑定 session 和动作权限。分享策略按 token 哈希缓存，最多 1024 项、10 秒 TTL；session/创建人的授权状态仍读取当前数据。修改和撤销提交后同步清理缓存并通知观察者，使用 `policy_version` 条件更新避免并发覆盖。

待执行消息在出队时重新校验 App 身份和输入权限，不因换了处理队列的连接而继承其他账号权限。已接受并开始执行的 Agent 任务沿用现有运行生命周期，撤销阻止新的接口操作和后续排队消息，不回滚已发生的执行副作用。

Socket 和 PTY 通过 `watch` 监听策略变化；本进程权限修改会关闭连接，过期和创建人失权的定时复查间隔为 1 秒。App 身份也持续复查，受最多 10 秒身份缓存约束。已断开连接但仍存活的 PTY 同样在撤销后终止。正常断开只解除 writer，保留仍有效的终端以支持重连。

多个 Studio 进程共用数据库时，其他进程的策略缓存最多滞后 10 秒；跨进程即时撤销需要额外广播。路径检查并非操作系统沙箱，无法替代对有宿主机执行权限的并发进程的隔离。

已有 App Relay 转发两个 HTTP 分享请求头及 Socket auth 字段；此次不修改云端设备绑定规则。未绑定目标设备的接收人需要可直达 Studio 的地址，或后续 App/云端提供接收人 relay 通道。

## 验证

相关测试包含 `session-shares`、`session-share-app-identity`、`session-shares-routes`、`session-share-access`、普通账号鉴权、排队执行、会话文件控制器、App 上传、Relay 和移动终端 Socket 测试。集成测试使用隔离 SQLite、临时目录和模拟云端身份/PTY，不创建真实分享或运行真实 Agent。
