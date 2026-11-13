# Studio 插件与 ctx SDK

当前为 SDK v1，清单使用 apiVersion: 1 和 permissions，Agent 使用 agentApiVersion: 1 和 features。
逐字段契约见 [字段手册](../packages/plugin-sdk/docs/FIELD_REFERENCE.md)，
业务输入与返回见 [宿主业务参数](../packages/plugin-sdk/docs/HOST_API.md)，两者随独立项目一起创建。
模块规范见 [SDK 架构](../packages/plugin-sdk/docs/ARCHITECTURE.md)，全部上下文及 CDP 用法见 [能力指南](../packages/plugin-sdk/docs/STUDIO_CTX.md)。

宿主业务按 models、agents、sessions、bots、groupChats、workflows、files、browser 八个模块开放。
单聊和 BOT 通过 `host.sessions.connect` / `host.bots.connect` 复用核心聊天实时协议，
保留流式文本、工具、排队、审批、澄清与恢复快照；页面通过宿主 Socket 桥接，不使用业务观察事件轮询代替实时会话。
已安装清单不满足当前契约时显示失败并允许更新/卸载，插件中心仍可正常访问。

Studio 插件用于定制工作台页面、设置页面、独立工作区、Agent 运行时、工具、命令和自动化动作。
插件中心在主导航中开放，位于自定义插件业务入口之前、API Key 之前。插件页面与其他 Studio 页面复用固定页头。
插件中心与 Hermes、DSH 各自的原生插件管理分开。插件安装、启用、配置和运行实例属于整个 Studio，所有账号、Profile 和任务均可使用，无需重复安装。

## 内置插件与 OMP

内置插件使用与第三方插件相同的 `plugin.json`、SDK、管理和运行通道。
OMP 源码在独立仓库 [ekko-studio-plugin-omp](https://github.com/EKKOLearnAI/ekko-studio-plugin-omp) 维护，
Studio 通过 `package.json` / `package-lock.json` 固定提交的包依赖引用；映射在 `plugins/builtin/packages.json`。
源码开发从已安装依赖读取，构建复制到 `dist/plugins/builtin/<id>`，随 npm 包和桌面端分发，运行时无需联网获取插件。
升级内置 OMP 时同步更新依赖及锁文件；调试独立仓库使用 `ekko-studio plugins link /absolute/path/ekko-studio-plugin-omp`。
Studio 启动后以有效超级管理员身份安装缺失的内置插件，首次安装默认启用。后续随 Studio 更新插件版本，保留禁用状态和数据；用户主动卸载后不自动装回，可在插件中心使用 `builtin:omp` 重新安装。无有效管理员时等待首次登录，再在读取插件或 Agent 列表时初始化。

当前内置 **Oh My Pi（OMP）**，Agent ID 为 `plugin:omp/omp`：

1. 进入 Agent 管理，OMP 引擎未安装时直接点击“安装”；宿主查询可用版本并调用插件的安装维护方法。完成后显示版本和“检查更新”，发现新版本后可升级。
2. 安装从 OMP 官方 GitHub Release 下载当前系统架构的独立可执行文件，校验 SHA-256 和实际版本，保存到本插件数据目录。不会修改系统 Bun、全局 CLI 或用户已有 OMP 目录。网络失败会保留原来的引擎选择。
3. 点击“设置”打开插件自己的前端与 RPC 后端。也可填写已有 OMP 可执行文件的绝对路径；这种情况下引擎由用户维护，Studio 不替换该文件。
4. scoped 模式直接使用 Studio 当前选择的模型和本轮代理凭证，无需在插件内重复填写模型密钥。
5. 删除只清理受管引擎及其选择记录，保留插件、设置和会话；受管安装可以开启自动更新，自定义可执行文件不支持删除或自动更新。
6. 全局模式在 OMP 设置页填写原生 `models.yml` 的 JSON 等价结构。配置按真实调用账号与 Profile 分区，密钥只返回遮蔽值；保留遮蔽值后保存会保持原密钥。

例如“模型与凭证（JSON）”：

```json
{
  "providers": {
    "custom": {
      "api": "openai-completions",
      "baseUrl": "https://your-provider.example/v1",
      "apiKey": "YOUR_API_KEY",
      "models": [{ "id": "your-model", "name": "Your model", "input": ["text", "image"] }]
    }
  }
}
```

默认模型可填 `custom/your-model`，也可留空后从 OMP 返回给 Studio 的模型目录选择。
“OMP 运行设置（JSON）”使用原生 `config.yml` 结构。scoped 模式由插件将宿主注入的 `apiMode/baseUrl/token/model` 写成临时原生模型配置；默认及辅助模型角色均绑定本轮 Studio 模型。每轮结束删除临时配置，原生会话文件保留供续接。

OMP 使用官方 stdio RPC：文本和推理流、原生工具事件、图片、文件路径读取、会话检查点、用量、取消、受管 MCP 和交互请求通过 SDK 接入。引擎实例及会话按宿主的用户、Profile、模式与会话隔离；私密输入不通过普通问答收集。
实现以 OMP 18.19.0 的协议验证，自动升级下载时仍会检查目标版本与平台资源。

### 开发测试夹具

原来的五个演示包已移入 `tests/fixtures/plugins`，只用于开发回归，不随正式插件目录发布：`session-dashboard`、`notebook`、`activity-digest`、`tool-demo`、`custom-agent`。
演示包只作为测试夹具，产品启动只加载当前内置插件清单。

开发新插件使用 `node scripts/create-plugin.mjs /absolute/path/my-plugin my-plugin`，生成最小设置页面与 RPC 模板，不再复制演示业务。
测试时可在插件中心安装夹具的绝对路径，再启用；本地安装复制目录，源码改动后需要重新安装，重载只执行已安装版本。

插件安装支持本地目录、`package@1.2.3` 或 `github:owner/repository#完整40位提交`。
远程安装禁止生命周期脚本，必须提供编译后的入口。版本必须是精确版本。
启停、配置、升级、回滚和卸载使用版本号防止同时修改。升级激活失败会恢复旧版本。
依赖使用 manifest 中的精确版本，启用前必须先启用依赖；禁用依赖前要禁用使用它的插件。
卸载释放运行资源，但保留数据与历史包目录，方便恢复；它不是清除磁盘数据操作。

## 独立项目开发与调试

安装包含此功能的 Studio 版本后，使用 `ekko-studio plugins`；`ekko-studio-web plugins` 与
`hermes-web-ui plugins` 也支持同一组命令。源码开发时可以用 `node bin/hermes-web-ui.mjs plugins ...`。

```bash
# 创建独立项目并登记到当前 Studio
ekko-studio plugins create my-plugin

# 指定源码目录，或登记已有项目
ekko-studio plugins create another-plugin /absolute/path/another-plugin
ekko-studio plugins link /absolute/path/existing-plugin

# 查看所有已登记项目（含目录缺失的记录）
ekko-studio plugins list

# 按 ID 或目录选择项目，显示 Studio 中的启用入口
ekko-studio plugins dev my-plugin
ekko-studio plugins dev /absolute/path/existing-plugin

# 只移除登记；不删除源码、已安装副本或数据
ekko-studio plugins unlink my-plugin
```

命令与 Studio 服务端必须使用相同的 `HERMES_WEB_UI_HOME`（兼容 `HERMES_WEBUI_STATE_DIR`）。
默认数据目录是 `~/.hermes-web-ui`，其中：

- `plugin-projects/<id>/`：未指定目标路径时的默认源码目录；可以单独初始化 Git 仓库。
- `plugins/development/<id>.json`：所有通过 CLI 创建或登记的项目索引，保存真实绝对路径。
- `plugins/global/`：宿主管理的已安装运行副本、配置和数据；无需手动修改。

已安装列表读取 `plugins/global/state.json`，开发链接读取 `plugins/development/<id>.json`；
列表不是通过扫描源码文件夹生成。每次安装或重建复制到 `plugins/global/versions/<UUID>/package`，
以隔离 ESM 缓存并支持回滚。删除目录不会自动卸载插件，应使用插件中心的卸载操作清理安装记录；
副本缺失时宿主将其标记为不可用，并停止提供该副本的 Agent、工具和页面入口。

源码可放在任意独立仓库。CLI 不修改 Studio 的源码、依赖列表或内置插件目录。
不同项目不能登记相同 ID；移动项目后先 `unlink`，再从新位置 `link`。
CLI 的 `create/link/dev` 只登记项目，不执行插件，不读取登录 token。

进入 **插件中心**，已安装列表展示实际安装副本，开发插件列表展示登记的源码项目。
尚未构建的项目也显示清单中的名称、图标与版本。只有正在使用同一开发目录的安装才关联其运行状态；
同 ID 的市场版与开发项目分开展示，启用或重载市场版不会触发开发构建。
卡片和详情使用普通的 **启用**、**禁用** 与 **重载** 操作，源码目录位于详情中。
首次启用开发链接时需要信任项目及其构建脚本，随后 Studio 构建、安装并启用插件；
如果存在同 ID 的安装，会替换该安装并保留配置与数据。已信任同一目录后，启用和重载直接执行。
开发链接启用后自动监听源码变化；普通本地目录安装后不会自动同步源码。

**卸载** 移除安装记录并停止运行，保留插件数据、开发源码与登记；市场随即重新提供安装入口。
**解除开发链接** 仅移除登记并停止源码监听，保留已安装副本。保留副本标记为本地版本，
不会被当成已安装的市场版；需要彻底停止使用时仍可直接卸载。两项操作在卡片中明确分开。
显式卸载后，即使此前从未安装内置版本，列表刷新或宿主重启也不会自动恢复同名内置插件。

开发链接启用期间宿主每秒检查源文件，稳定两次后执行可选的 `npm run build`，再复制到新的运行目录。
没有 build 脚本的 JavaScript 模板直接加载；同版本的源码修改也会生效，无需反复提高版本号。
后端旧实例被释放，前端通过已有插件事件重新挂载；这是整个插件的重载，不保留页面内存状态。
嵌套模块也从新的运行目录加载，不会继续使用旧 ESM 缓存。每个开发项目保留当前和上一个运行副本。

构建或加载失败时，开发列表显示错误，已运行的成功版本继续服务。
修复源码后自动重试，也可以点 **重载**；**禁用** 保留最后安装版本及数据并停止监听。
禁用或卸载会停止同步；回滚同时退出调试，以免源码立即覆盖回滚结果。
退出 Studio 会停止监听，重启后恢复仍启用的开发项目。取消登记后不再同步，已安装副本仍可使用。
源码缺失、登记路径改变或激活管理员失去权限时不会继续执行构建。

卡片或详情中的 **删除开发链接** 等同于 `unlink`：移除登记并停止源码监听，
保留源码目录、已安装副本与插件数据。如果已安装副本仍存在，它会继续作为普通插件显示；
仅有开发链接的项目会从列表消失。取消确认或操作失败不会移除登记。

生成的项目包含与宿主匹配的本地 `sdk/`，`npm install` 后可通过
`import type { PluginContext, ClientContext } from '@ekko-studio/plugin-sdk'` 使用类型，
不需要克隆 Studio 源码或依赖尚未发布的 npm SDK。运行时辅助代码应由插件自己的构建打包。
模板本身为可直接执行的 `.mjs`，无需先安装依赖才能在宿主中运行。

使用 TypeScript、Vue 或 React 时，在项目内配置 build 脚本，并将清单入口指向
`dist/server.mjs`、`dist/client.mjs` 等产物。将生成文件放在 `dist/` 或 `build/`；
监听忽略这些目录、`node_modules`、`.git`、`coverage` 和 `.cache`，不跟随符号链接。
开发源目录最多检查 20000 个条目；运行数据应保存在 `ctx.state.plugin` 或 `ctx.paths.dataDir`。
Studio 不自动安装项目的构建依赖；先在独立项目运行相应的依赖安装命令。

前端可在浏览器 DevTools 的插件 iframe 中调试；后端使用 `ctx.log` 和插件详情的日志入口，
断点附加到 Studio 的 Node 进程。Agent 插件启用后出现在 Agent 管理及已有会话入口中。
远程部署时，登记目录必须位于 Studio 服务端所在机器；这组命令不会把本机源码上传到远端。

### 随项目提供的文档与开发 harness

新项目附带 AGENTS.md、README.md、架构、ctx 能力、回传协议和开发规范。
宿主指南在 Studio 的 `packages/plugin-sdk/docs` 直接维护：修改接口及数据结构时，
同步编辑对应 Markdown 并一起提交。创建项目自动复制当前版本的指南及 SDK，无需文档生成命令。
精确字段和签名直接查看 `sdk/src/index.ts`、`sdk/src/agents.ts`。

本插件的跨边界和持久化结构统一声明在 `contracts/plugin.json`；每个模型、字段及操作都有描述。
示例 RPC 和存储实际使用这些声明校验数据。`docs/CONTRACTS.md` 是可直接编辑的行为与兼容说明，
修改插件结构时同步修改相关段落及测试。文档、检查器、测试和 GitHub Actions 均随 npm 包分发。

Studio 的 harness/build 检查 SDK 变化是否同时修改了架构、ctx 或回传说明；
本地检查未提交变更，Build CI 检查整个 PR/push。检查只能确认文档随代码更新，语义准确性由审查负责。

开发宿主在可选 build 前后运行插件 harness，检查字段说明、模型引用和文件完整性，失败保留当前运行版本。
手动编辑 Markdown 不会导致拒绝加载。生成项目的 prepack 和 CI 同样运行检查与测试；插件必须满足当前契约。
已创建项目保留创建时的 SDK 和文档，升级时一起更新。

## 插件中心与使用入口

插件中心使用卡片、名称/描述/作者/标签搜索、能力分类和状态筛选管理全局已安装插件，不是公共社区目录。详情展示作者、许可证、仓库、主页、文档、问题反馈和更新记录。安装与维护操作收进弹窗和详情抽屉；进入中心不会加载所有插件业务页面。

插件中心入口在主导航显示。页面声明与使用入口相互独立：`views` 只定义页面，`navigation.main` 和 `navigation.settings` 分别定义主侧栏与设置侧栏入口。
未声明某类导航列表，或列表为空，该侧栏就没有入口。页面仍可由直接地址、插件中心链接或 Agent 设置按钮打开。禁用或卸载移除对应入口和挂载实例；移动端使用相同声明。

- `page`：独立页面，路由 `/studio/plugins/:pluginId/:viewId`。
- `settings`：自定义设置页面，路由 `/studio/plugin-settings/:pluginId/:viewId`，不自动注册设置侧栏。
- `workspace`：插件工作区页面，路由同 page；同类页面组成专属配置侧栏。
- `agent-settings`：Agent 设置页面，路由 `/studio/plugin-agent-settings/:pluginId/:viewId`；同类页面组成专属配置侧栏，返回 Agent 管理，不自动注册任一全局入口。

`views[].title/icon/order` 定义页面标题、专属导航图标和排序。workspace 和 agent-settings 页面必须声明宿主命名线条 icon。
导航项包含 `viewId`、必填 `icon`，以及可选的 `title/order`；标题默认使用目标页面标题，顺序默认 0，同序保持声明顺序。
同一页面可以分别注册到两类全局导航，两类导航独立设置标题、图标及排序。主侧栏接受命名 icon、包内 PNG/JPEG/WebP/GIF 或 base64 图片；设置侧栏只接受命名 icon，统一颜色、尺寸和描边。
命名 icon 为 `settings/skills/mcp/code/terminal/bot/folder/book/chart/grid/history/chat`；原始 SVG、远程图片和缺少 icon 的导航声明会被拒绝。

`workspace.sidebar` 可指定一个不与页面 ID 重复的动态侧栏视图，调用同一个客户端入口，`ctx.slot === 'workspace-sidebar'`。
`ctx.location.path/query` 提供页面路由，`ctx.ui.navigate()` 可切换页面或查询参数；路由变化重新挂载视图，持久化状态应存于后端。
插件中心和业务页复用宿主固定页头，内容区独立滚动。插件不挂载到单聊 Session 列表、聊天侧边或消息下方。

视图 slot 只决定页面布局；全局入口必须显式声明 navigation。Agent 设置使用专属 agent-settings 页面。

例如 `/#/studio/plugins/session-dashboard/sessions` 和 `/#/studio/plugins/notebook/notes`。独立页面使用完整内容区。切换 Profile 后插件列表与导航入口不变，页面重新绑定当前调用上下文。全局禁用或卸载会移除各账号的入口与挂载实例；不存在的页面显示返回中心的提示。`ctx.ui.navigate('/studio/plugins/notebook/notes')` 可跳到其他已声明页面，实际访问仍受目标插件状态约束。

### 提交插件审核

插件中心提供“提交插件”入口，填写仓库地址、名称、描述后发送给云端管理员审核。
所有能进入插件中心的账号均可提交；成功提示等待审核，不改变本机已安装列表。

客户端直接向 `https://api.ekkostudio.xyz/api/studio/plugins/submissions` 发送普通 JSON，
仅包含 repository/name/description，不携带本机 Authorization、cookie 或 Profile。
名称最多 160 字符，描述最多 4000 字符；仓库地址最多 2048 字符，使用 HTTP(S)，
不含账号密码、查询参数或锚点。提交时校验字段并禁止重复点击，失败保留输入。
网络中断或超时无法证明服务端没有收到，因此提示结果未确认且不自动重试。

云端审核、目录和固定提交的安装更新流程见本文的 Published directory and installed-plugin updates。

### 全局安装与调用上下文

全局注册表位于 Web UI 状态目录的 `plugins/global/state.json`。一个插件只激活一个后端实例，依赖检查、配置、版本并发控制和启停均为全局；定时器不会因切换账号或 Profile 重复启动。插件自身定时任务使用最近激活它的管理员默认 Profile。该身份失去权限时相应后台 API 调用会被拒绝，不影响其他合法账号调用插件。

RPC、工具、聊天命令、钩子、业务事件和工作流始终使用实际调用者的账号、Profile、会话和任务上下文。宿主通过异步调用上下文绑定 `ctx.identity / host / signal`，并发请求使用各自的调用者权限。`state.plugin` 提供插件共享存储，`state.user/profile/session/agentSession` 提供显式分区；业务数据选择哪个作用域由插件决定。现有 Studio API 仍按实际调用者校验访问权限。

## 包格式

每个插件必须在包根目录提供 `plugin.json`，它是唯一的插件清单来源。`package.json` 保留 npm 包信息和 npm 依赖，
插件版本必须与其中声明的包版本一致。缺少 `plugin.json` 时安装失败。

示例 `plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "A plugin with its own workspace",
  "author": { "name": "Example team", "url": "https://example.com" },
  "repository": "https://github.com/example/my-plugin",
  "homepage": "https://example.com",
  "documentation": "https://example.com/docs",
  "issues": "https://github.com/example/my-plugin/issues",
  "changelog": "https://github.com/example/my-plugin/releases",
  "license": "MIT",
  "keywords": ["collaboration"],
  "icon": "assets/icon.png",
  "server": "dist/server.mjs",
  "client": "dist/client.mjs",
  "permissions": ["api.read", "api.write", "ui"],
  "views": [
    { "id": "overview", "title": "Overview", "slot": "page" },
    { "id": "rooms", "title": "Rooms", "slot": "workspace", "icon": "chat", "order": 1 },
    { "id": "history", "title": "History", "slot": "workspace", "icon": "history", "order": 2 },
    { "id": "preferences", "title": "Preferences", "slot": "settings" }
  ],
  "navigation": {
    "main": [{ "viewId": "overview", "icon": "assets/icon.png" }, { "viewId": "rooms", "title": "Team rooms", "icon": "chat" }],
    "settings": [{ "viewId": "preferences", "icon": "settings" }]
  },
  "workspace": { "sidebar": "room-list" }
}
```

`server` 和 `client` 至少声明一个。使用 ES module `.mjs` 最直接；`.js`
需要包声明 `type: module`。客户端必须是一个自包含 bundle，资源内联为 data/blob URL，
React/Vue 等框架可一并打包。配置 JSON Schema 支持对象、数组、基础类型、必填、枚举、
默认值、数值和长度范围，以及 `secret`。不支持的关键字会报错，不会被静默忽略。
`secret` 字段不会传给客户端；未提交该字段时保留已保存的密钥，显式空字符串是新值，后端仍可读取完整配置。

作者和项目链接仅允许不含账号密码的 HTTP(S) 地址。图标允许包内相对路径的 PNG/JPEG/WebP/GIF
（每个文件不超过 256 KB）或相应的 base64 data URL；安装器读取并内联，拒绝越界路径和符号链接。
项目信息均可选。`apiVersion` 声明 SDK 兼容版本，当前只接受 `1`。

发布前由作者构建前后端，发布包需包含 `plugin.json`、`package.json` 和所有入口/资源。
npm/GitHub 安装在独立版本目录安装生产依赖，禁止安装脚本；本地目录安装只复制成品。
清单的 `dependencies` 表示其他 Studio 插件，`package.json.dependencies` 表示普通 npm 库。
原生依赖和系统工具需自行满足运行平台要求；宿主不会在安装时构建 Vue/React/TypeScript 源码。

TypeScript 契约位于 `packages/plugin-sdk/src/index.ts`；可将
`packages/plugin-sdk` 作为本地开发依赖安装。类型导入应使用 `import type`，
运行时辅助函数随自己的包打包。SDK v1 不需要插件导入 Studio 服务端实现。

## 后端 ctx

```js
export function apply(ctx) {
  ctx.extensions.tools.register({
    name: 'hello', description: 'Return a greeting', readOnly: true,
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async execute({ name }, run) {
      return { ok: true, content: `Hello ${name} in ${run.identity.profile}` }
    }
  })
  return () => { /* 关闭自己创建的资源 */ }
}
```

| 入口 | 用途 |
| --- | --- |
| `ctx.plugin / identity / config / signal` | 全局包信息与配置、当前调用者身份与生命周期；启动时使用激活身份 |
| `ctx.host.request(path, options)` | 当前用户权限下调用现有 JSON 后端接口 |
| `ctx.host.sessions / groupChats / workflows / files` | 单聊、群聊、工作流和文件操作 |
| `ctx.host.models.list / respond` | 已配置模型及 Responses API；返回完整响应，使用现有用量统计 |
| `ctx.state.plugin` | 插件级全局 JSON 存储；`namespace(...)` 显式分区 |
| `ctx.extensions.tools.register` | 注册跨 Agent 工具；返回 `{ok, content, data?, error?}` |
| `ctx.extensions.agents.register` | 注册可在 Agent 管理、新建会话、群聊和工作流使用的 Agent 运行时 |
| `ctx.extensions.commands.register` | 注册 `/插件id:命令 参数` 聊天命令 |
| `ctx.extensions.rpc.register` | 为前端注册后端函数 |
| `ctx.events.on(type, handler)` | 订阅 Studio 业务事件，支持精确名称、`chat.*`、`chat.run.*` 等前缀及 `*` |
| `ctx.extensions.hooks.register` | 注册 Ekko 输入、上下文与工具拦截钩子 |
| `ctx.extensions.actions.register / ctx.scheduler.every` | 工作流可用动作、非重叠定时执行 |
| `ctx.lifecycle.acquire / add` | 追踪异步资源获取与清理 |
| `ctx.log` | 写入管理页可查看的最近 200 条插件日志 |

注册返回 disposer；宿主会在禁用、重载、升级、卸载或启动失败时自动清理。
定时任务由启用状态恢复，重启后从当前时间重新计时，不补跑离线期间的任务。
插件自己创建的监听、连接和定时器必须通过 `lifecycle.acquire` 或 `lifecycle.add` 管理。

工具、命令、RPC、钩子和动作收到独立的 `run` context。它带有本次会话、工作区、
运行标识及取消信号，操作最长 120 秒；结束后 context 失效。不要缓存后继续调用。
`ctx.state.plugin` 与 `run.state.plugin` 访问同一份插件级存储。根上下文的身份与 API 在每次调用中自动绑定实际调用者，异步代码也保持此绑定。
`run.session.get()` 读取当前会话；`run.workspace.read/write()` 使用会话工作区接口；
`run.tools.call('插件id/工具名', args)` 调用插件工具；`run.messages.notify/emit` 向页面发事件。
共享记录的 read-modify-write 需要插件串行处理，Notebook 测试夹具展示了这一点。
`ctx.paths.dataDir` 是本插件稳定的私有文件目录，升级与重载后不变，供原生引擎、配置和缓存使用；卸载保留它。优先使用 `ctx.state.plugin` 保存普通结构化数据。

### 数据范围由插件决定

```js
// 同一插件的所有账号、Profile、任务共享。
await ctx.state.plugin.set('announcements', [])

// 以下是开发者主动选择的分区，可以任意组合或使用项目、团队等业务维度。
const user = run.state.plugin.namespace('users', String(run.identity.userId))
const profile = user.namespace('profiles', run.identity.profile)
await profile.set('preferences', { compact: true })
```

命名空间可累计，最多 16 段，每段 1–256 个字符；段边界保留，不能利用路径字符访问其他插件。每个命名空间都支持 `get/set/delete/keys`。插件之间使用独立存储，命名空间本身是数据组织方式，不是访问控制。

前端直读存储需要开发者在 manifest 声明 `storage.client`，该能力开放本插件的全部存储及命名空间。无需直读时不声明，通过 RPC 暴露业务操作，例如由后端根据可信 `run.identity` 选定私有分区；不要使用浏览器传入的账号 ID 决定私有数据归属。`ctx.config` 是全局配置，不应放用户私有偏好。

```js
// 不声明 storage.client：客户端只能调用开发者定义的操作。
ctx.extensions.rpc.register('preferences', async (_input, run) => {
  return await run.state.plugin.namespace('users', String(run.identity.userId)).get('preferences') ?? {}
})
```

插件发出的 `run.messages.emit(type, data)` 默认发给当前账号/Profile 下匹配会话的页面；共享业务可以显式广播：

```js
run.messages.emit('notebook.updated', { id: note.id }, { audience: 'plugin' })
```

`audience: 'plugin'` 让所有账号/Profile/会话中的本插件页面收到事件，数据及事件中的调用身份都会对它们可见。`run.messages.notify` 仍是调用者提示；已有 Studio 业务事件按宿主原有权限分发。

工作便签示例选择全局共享；Activity Digest 示例自行按账号和 Profile 分区。数据位于 `plugins/global/data`，由插件 ID 和命名空间数组确定文件名。

## 前端 ctx

`ctx.locale` 是 Studio 当前界面语言，插件可据此渲染自己的文案；切换语言会重新挂载页面。前端通过受限桥接访问现有后端 API。

```js
export async function mount(element, ctx) {
  const result = await ctx.host.sessions.list()
  element.textContent = JSON.stringify(result)
  const unsubscribe = ctx.messages.on('notebook.updated', event => {
    element.textContent = JSON.stringify(event.data)
  })
  return unsubscribe
}
```

前端可以调用已有后端接口，无需复制一套业务接口：

```js
const result = await ctx.host.request('/api/studio/sessions', { query: { limit: 20 } })
await ctx.rpc.call('append', { text: 'A note' })
```

宿主提供认证和 Profile 绑定，插件拿不到 token。普通请求限相对 `/api/` 路径和 JSON，
并沿用各接口原有的权限校验；不能通过此入口管理账号、密钥或插件，也不能切换 Profile。
`api.read` 授予 GET，`api.write` 授予写操作。SDK 不把原始数据库、路由器、密钥仓库注入前端。
模型 `respond` 使用非流式响应；底层二进制下载和 SSE 不属于此 JSON API 入口。

### 会话、群聊与工作流操作

前后端使用同一份 `ctx.host` SDK；写操作需要 `api.write`，读操作需要 `api.read`。
返回值保留对应 HTTP 接口的 JSON 结构，不自动解包。

| 命名空间 | 方法 |
| --- | --- |
| `sessions` | `list(query?)`、`get(id)`、`create({title?,agent?,mode?})`、`run(id,input,options?)`、`stop(id)`、`remove(id)`、`rename(id,title)`、`archive(id,archived?)`、`setModel(id,model)`、`setWorkspace(id,path)`、`messages(id,query?)` |
| `groupChats` | `list()`、`get(id)`、`create({name,inviteCode,...})`、`update(id,config)`、`remove(id)`、`send(id,content,mentions?)`、`stop(id,agentName)`、`messages(id,query?)` |
| `groupChats.agents` | `list(roomId)`、`add(roomId,config)`、`update(roomId,agentId,config)`、`remove(roomId,agentId)` |
| `workflows` | `list()`、`get(id)`、`create({name,nodes?,edges?,...})`、`update(id,definition)`、`remove(id)`、`run(id,input?)`、`stop(id,runId)`、`runs(id)`、`getRun(id,runId)` |
| `workflows.schedules` | `list(workflowId)`、`create(workflowId,config)`、`update(workflowId,scheduleId,config)`、`remove(workflowId,scheduleId)` |

```js
// 创建空会话不会发起模型调用；默认 Agent 为 ekko-agent。
const { session } = await ctx.host.sessions.create({ title: '每日摘要' })
const accepted = await ctx.host.sessions.run(session.id, '整理今日进展', {
  provider: 'custom:my-provider', model: 'my-model', apiMode: 'chat_completions'
})
// accepted.status 为 running 或 queued；后续通过事件或会话历史获取结果。
await ctx.host.sessions.stop(session.id)

const { room } = await ctx.host.groupChats.create({ name: '写作组', inviteCode: 'writing-team' })
await ctx.host.groupChats.send(room.id, '请开始整理')
// 按群内 Agent 名称中断，沿用群聊界面的中断权限。
await ctx.host.groupChats.stop(room.id, 'Writer')

const { workflow } = await ctx.host.workflows.create({ name: '每日整理', nodes: [], edges: [] })
// 配好节点与边后调用 run；运行记录可用 runs/getRun 查询，stop 需要该次 runId。
```

`sessions.run` 默认在启动或入队后返回；传 `wait:true` 可等待终态，仍受插件调用的 120 秒生命周期约束。
Ekko/Coding Agent 首次运行需提供完整的 `provider/model/apiMode`；后续可沿用会话保存的模型配置。
`sessions.stop` 返回 `{ok,session_id,stopped}`，只中断当前运行，保留会话和历史，队列行为与聊天界面的停止一致。
群聊消息接口复用认证后的 Socket 操作，不接受伪造的发送者；停止指定 Agent 不删除房间。
群聊历史支持 `limit/offset` 或 `before` 消息游标。配置及工作流节点、定时字段沿用 OpenAPI 定义。

### 可订阅事件

后端使用 `ctx.events.on(pattern, (event, run) => ...)`，前端使用 `ctx.events.on(pattern, event => ...)` 订阅业务事件，自定义页面消息使用 `ctx.messages.on`。
两者均支持 `*` 和以 `.*` 结尾的前缀匹配；同一函数匹配多个订阅时只执行一次。
全部内置事件名导出为 SDK 的 `PLUGIN_EVENT_TYPES`，也可继续订阅插件自定义的前端事件。

| 范围 | 事件 |
| --- | --- |
| 单聊 | `chat.session.created/removed`、`chat.message.created/delta`、`chat.reasoning.delta` |
| 单聊运行 | `chat.run.queued/started/updated/completed/failed/stopped` |
| 工具与任务 | `chat.tool.started/completed/failed`、`chat.task.created/completed`、`chat.plan.updated` |
| 群聊 | `group.message.created/started/delta/completed`、`group.reasoning.delta`、`group.run.updated/failed/stopped`、`group.plan.updated` |
| 工作流 | `workflow.run.started/updated/completed/failed/stopped`、`workflow.plan.updated`；节点共享运行事件仍使用 `chat.*`，通过 `source` 和 `subject.workflow_id` 区分 |
| 审批与澄清 | `chat.approval.requested/resolved`、`chat.clarification.requested/resolved`，群聊对应 `group.*` |
| Person | 保留原有 `person.run.completed/failed/updated` 和审批、澄清事件；不公开私有工作会话、工具细节和文本流 |

```js
ctx.events.on('chat.run.*', async (event, run) => {
  const { subject, summary, state } = event.data
  run.messages.emit('dashboard.run', { type: event.type, subject, summary: summary ?? null, state: state ?? null })
})
ctx.events.on('group.message.delta', event => {
  ctx.log.info(`${event.data.subject.room_id}: ${event.data.delta}`)
})
```

事件有 `id/type/timestamp/identity/data`；`data.subject` 保存会话、运行、群聊、工作流等标识。
文本增量位于 `data.delta`，生命周期摘要位于 `data.summary`，运行快照位于 `data.state`；字段随事件类型变化。
消息/完成文本使用规范化且可能截断的 `data.content`，需要完整记录时读取历史。
`chat.session.created` 当前指通过空会话创建接口创建的会话；群聊 `message.completed` 指流片段结束，最终持久化消息另发 `message.created`。

插件事件不再受 App 通知展示条件过滤。普通会话按 Profile 访问权限分发，群聊还校验成员或房间访问权限；
审批、Person 和工作流保留原有所有者限制。事件身份来自当前接收用户，不借用安装者权限。
群聊向接收者有权使用的 Profile 上下文分发，不要求成员拥有群摘要模型的 Profile；
`data.profile` 仍标识事件来源。同一业务事件可能按多个用户/Profile 分发，跨上下文自动化应按事件 ID 去重。
事件是内存中的实时观察，前端轮询仅保留最近 500 条，不保证离线补发、严格顺序或恰好一次；
高频流可覆盖较早事件，插件应按事件 ID 去重并用历史接口恢复状态。观察回调不阻塞原始运行；
需要拦截时使用 `ctx.extensions.hooks`。自定义 `messages.emit` 发给前端，不重新进入后端 `ctx.events.on`。

前端还可使用 `ctx.state.plugin`、`ctx.host.models`、`ctx.ui.notify/confirm/prompt/navigate`、
`ctx.events.on` 和 `ctx.lifecycle.add`。页面布局类型为 `page`、`settings`、`workspace`、`agent-settings`；
动态工作区侧栏挂载时的 `ctx.slot` 为 `workspace-sidebar`。这些页面不绑定当前单聊会话，
需要访问会话时由插件通过 SDK 显式指定 ID，宿主照常检查当前调用者权限。
页面挂在独立 iframe 中，复用宿主主题变量，通过消息桥调用功能。iframe 不共享 DOM、
localStorage 或登录凭证；HTTP 请求统一通过 `ctx.host`。

## Agent 与工作流

默认情况下，启用的工具放在共享的 `ekko-studio-plugins` MCP 服务中。插件可在 `plugin.json` 中选择独立服务名：

```json
{
  "permissions": ["tools"],
  "mcp": { "name": "notebook-tools" }
}
```

这是清单片段，需与插件原有的 ID、版本、入口等字段合并。不声明 `mcp`，或显式声明
`"mcp": { "name": "ekko-studio-plugins" }`，均使用共享服务。声明独立名称后，
本插件工具只出现在该 MCP，不再出现在共享服务，也看不到其他插件的工具。插件仍通过
`ctx.extensions.tools.register` 注册工具，无需自行实现或启动 MCP 服务。

独立名称为 1–64 个小写字母、数字、下划线或连字符，必须以字母开头；不能使用 Studio
保留前缀（`ekko-studio`、`hermes-studio`、`hermes-web-ui`）或另一已安装插件占用的独立名称。
安装与升级时检查重名，禁用的插件也保留名称。避免与自己配置的外部 MCP 重名；Hermes/Ekko
若发现同名非托管服务，会保留用户配置并跳过该 Profile 的自动同步。

Studio 在安装、升级、回滚和卸载后同步 Hermes/Ekko 的 MCP 配置，Coding Agent 在生成运行配置时
使用当前插件服务名。各服务在 MCP 管理页可独立启停；插件禁用后保留服务配置及其开关，
工具列表为空，卸载后移除托管服务。服务名称变更会使 Coding Agent 的空闲运行失效，正在执行的
运行在当前轮结束后重新准备。

Studio 会将插件变更通知所有已启动的 Hermes Worker，包括群聊和任务使用的隔离 Worker，
不会为清理操作启动新的 Worker。Worker 空闲时复用现有 MCP 删除逻辑清理已卸载或改名的独立服务，
并刷新仍在使用的插件 MCP；共享的 `ekko-studio-plugins` 保留，只更新工具目录。
同名的非托管服务不受影响。若该 Worker 仍有前台运行或后台任务，连接刷新延后到空闲边界；
插件宿主仍立即拒绝已卸载插件的新调用。刷新完成后，已有会话在下一轮重建 Agent 实例以读取新工具，
保留会话历史、运行记录和后台任务状态；原生工具注册表残留的旧工具名也会从新快照中过滤。
刷新失败会保留待处理状态，在后续请求或运行结束时重试。Studio Bridge 之外的现有 MCP 客户端
仍需自行刷新或重连以读取新服务。

共享和独立服务均由 `ekko-studio-mcp plugins` 启动，通过 `HERMES_MCP_SERVER_NAME` 选择工具集合；
直接运行且未设置该变量时使用共享集合。`ekko-studio-api` 只保留接口文档和接口调用工具。
工具名使用 `插件ID__工具名`，例如 `notebook__append`、`tool-demo__hello`，独立服务也保持此格式，
并附带插件描述。为兼容各 Agent，标识符中的下划线和点分别转义为 `_u`、`_d`；名称超过 64 个字符时保留两端可读前缀并附加稳定的防重名后缀。
适用于启用了该 MCP server 的 Hermes、Ekko 和已接入 Studio MCP 的 Coding Agent。升级后刷新 MCP 管理页，已有 Agent 连接需重新连接或新开一轮运行，以加载独立服务和新工具名。外部运行时可能缓存工具目录，
安装/启用后刷新 MCP 或开始新一轮运行；禁用后即使目录缓存仍在，调用也会被拒绝。

`input.transform` 接收本轮输入消息，`context.transform` 接收每次模型调用的消息副本，
`tool.before` 接收 `{name,input}`，`tool.after` 接收 `{name,input,result}`。
返回 `{value}` 修改内容，或 `{deny: 'reason'}` 阻止操作。同一插件按 priority 升序，
插件间按 ID 排序。工具名不可替换，修改参数后仍经过正常授权。失败或被拒绝的工具
不会进入 `tool.after`。这些深度钩子仅支持 Ekko；其他 Agent 提供共享工具与业务事件，
不会伪装为具有模型内部控制能力。Pi/DSH 原生插件不是无需修改就兼容此 SDK。

工作流节点可选择插件动作，填写 JSON 参数。动作 schema 声明 `input` 且参数未提供它时，
宿主填入节点任务及上游输出。节点复用现有审批、分支、循环、状态、重试和取消机制，
结果保存到节点会话。调度工作流使用调度创建者身份；没有有效用户身份的任务不能调用插件。
外部系统可通过已认证的 `POST /api/studio/plugins/:id/invoke` 调用动作。

## 运行与权限边界

只有超级管理员的交互登录可以安装和修改可执行插件。Agent 运行凭证不能安装插件。
后端插件是可信 Node.js 代码，拥有 Studio 进程的操作系统权限；manifest capability
约束 SDK 使用，不是 Node.js 沙箱。只安装可信包。前端 iframe 有独立的浏览器隔离。
宿主状态保存在 Studio 应用目录下的 `plugins/`，不写入 Hermes Agent 状态目录。

验证命令：`npx vitest run tests/server/studio-plugins.test.ts tests/server/studio-plugin-*.test.ts tests/ekko-agent/plugin-hooks.test.ts`；
浏览器旅程：`npm run test:e2e -- tests/e2e/studio-plugins.spec.ts tests/e2e/studio-plugin-navigation.spec.ts`。

## 注册 Agent 运行时

插件清单声明 `agents` 能力，后端在 `apply(ctx)` 中调用 `ctx.extensions.agents.register(definition)`。
注册 ID 是插件内部 ID；Studio 生成完整 ID `plugin:<pluginId>/<agentId>`，与内置 Agent ID 分开。
`vendor` 表示管理卡片上的开发方；模型配置中的 `provider` 仍表示模型提供商。
文本、图片、文件都是必需输入，不提供 `images/files/supportsImages` 等开关。
类型契约在 `packages/plugin-sdk/src/agents.ts`。

```js
export function apply(ctx) {
  const registration = ctx.extensions.agents.register({
    id: 'assistant', name: 'My Agent', vendor: 'My Team', agentApiVersion: 1,
    getStatus: async () => ({ installed: true, version: '1.0.0' }),
    management: {
      settings: () => ({ viewId: 'agent-settings' }),
      checkUpdate: async () => ({ currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false }),
      // upgrade: async ({ version, expectedVersion }, management) => ...,
    },
    modes: {
      global: { listModels: async () => ({ status: 'ready', source: 'sdk', scope: 'builtin', models: [{ id: 'native', name: 'Native', isDefault: true }] }) },
    },
    features: { surfaces: ['chat', 'group-chat', 'workflow', 'api'], streaming: true, resume: false },
    runtime: {
      createSession(session) {
        return {
          async run(input, run) {
            // Replace this local example with the plugin's own engine/SDK/CLI.
            const parts = []
            for (const part of input.input) {
              if (part.type === 'text') parts.push(part.text)
              else parts.push(`${part.name}: ${(await run.attachments.read(part.assetId)).byteLength} bytes`)
            }
            const text = parts.join('\n')
            await run.output.emit({ type: 'text.delta', text })
            return { content: [{ type: 'text', text }], finishReason: 'stop' }
          },
          dispose() {},
        }
      },
    },
  })
  return () => registration.dispose()
}
```

该片段展示全局本地运行时。包含 scoped 模型代理调用的完整示例见
`tests/fixtures/plugins/custom-agent/server.mjs`。实际 scoped 引擎必须把模型请求发送到宿主注入的代理。

### 管理与设置

`getStatus` 返回 `{installed, version, source?, path?, error?}`。普通目录不暴露安装路径。
管理页的操作绑定 `management.settings/checkUpdate/upgrade/remove`；未提供的操作不显示。
同时提供 `checkUpdate/upgrade` 的插件 Agent，在 `installed:false` 时显示“安装”。点击后宿主先调用 `checkUpdate` 获取准确版本，再调用 `upgrade` 完成首次安装；安装期间禁用重复操作，成功后刷新状态。已安装时显示“检查更新”及可用的版本升级操作。
设置回调返回本插件清单中 `slot: 'agent-settings'`的 `viewId` 和可选查询参数；宿主拒绝跨插件页面。该回调与两类全局导航独立，三个 Agent 页面可只声明 agent-settings 与命名 icon，不注册 navigation。
页面继续通过 `client.mjs` 的 `mount(root, ctx)` 和服务端 `ctx.extensions.rpc.register` 实现。
生产安全策略允许视图加载 Blob 模块；iframe 保持不透明来源，自己的 CSP 禁止直接网络请求，业务调用仍经认证桥接。
插件负责配置持久化、校验、文件格式、环境变量和启动参数，不要求宿主生成设置表单。
私有设置应以 RPC 的实际 `run.identity` 分区；URL 查询参数不构成身份或权限依据。

`checkUpdate` 只检查 Agent 引擎，返回 `currentVersion/latestVersion/updateAvailable`。
`upgrade({version, expectedVersion}, ctx)` 更新引擎，返回 `installedVersion`。
`remove(ctx)` 删除插件自己管理的 Agent 引擎，成功后不返回业务数据；保留插件源码、配置、账号凭证和会话数据。
宿主要求删除请求带 `expectedVersion`，版本改变、正在运行或正在维护时拒绝操作，完成后重新确认 `installed:false`。
删除回调为可选能力；未提供时管理页不显示删除按钮。

`supportsAutoUpdate(ctx)` 返回当前安装是否支持无人值守更新，缺省为 false；必须同时提供 `checkUpdate/upgrade`。
使用自定义可执行文件、外部包管理器或必须交互登录时返回 false，能力查询和开关由宿主提供：
`GET/PUT /api/studio/agents/{id}/update-policy`，写入体为 `{autoUpdate:boolean}`，读回包含 `autoUpdateSupported`。
删除引擎使用 `POST /api/studio/agents/{id}/remove`，请求体 `{expectedVersion:string}`。
这些维护接口只允许超级管理员的交互登录，运行凭证和共享链接不能调用。
开关属于整个宿主，独立持久化在 `plugin-agent-update-policy.json`；插件禁用时保留偏好，删除引擎会关闭自动更新。
定时更新使用插件激活身份，和普通 Coding Agent 共用检查、互斥及连续空闲至少一分钟后再更新的策略；
每次更新前重新确认能力和版本并阻止新运行，插件禁用或移除后不继续更新。
成功检查的常规间隔为六小时，失败后五分钟重试。手动检查成功会刷新共享策略并清除旧错误，
页面立即读回状态；插件重载会作废旧运行实例的检查结果，保留自动更新偏好。
手动检查使用真实调用身份；调用者与激活账号/Profile 不同时，其结果仅返回该调用者，
宿主另以激活身份刷新自动更新策略，防止其他账号的安装信息成为全局更新目标。
它们与 Studio 插件包的版本和升级操作独立。安装维护沿用超级管理员权限，运行凭证不能调用管理操作。
宿主在升级前重新检查当前版本和可用版本，拒绝在途运行，清理空闲实例，升级后重新探测实际版本。
失败不意味着外部二进制已经回滚，插件应自行实现其引擎的恢复策略。

管理上下文含当前 `identity`（账号、Profile、Agent ID）、`signal`、`log`、`lifecycle.add` 和
`progress({message, percent?})`。管理操作不绑定会话，其普通调用上限为 120 秒。

### global 与 scoped

- `global`：插件通过 `modes.global.listModels(ctx)` 提供原生模型目录，Studio 展示并回传模型 ID 和推理参数。
  目录可返回 `ready/empty/not_installed/auth_required/unsupported/timeout/error`。
  宿主不注入 scoped 代理地址，不替插件改写原生全局配置。
- `scoped`：Studio 按实际用户的 Profile 解析选定模型，提供 `provider/model/apiMode/baseUrl/token`、
  `reasoningEffort` 和 `contextWindow/outputLimit`。其中 token 是 Studio 代理凭证，上游 API key 保留在 Studio。
  `apiMode` 是引擎到 Studio 的协议，与上游提供商协议独立；插件在 `protocols` 声明其支持的请求协议。
  宿主负责代理的协议转换、用量记录和凭证撤销，插件负责如何写配置并使引擎请求该代理。

两种模式都不增加账号、Profile 或工作区权限。模式或绑定改变时，插件根据本轮上下文重配或重建原生引擎。

### 实例、输入与运行上下文

`createSession(session)` 收到可信的 `identity`、`mode`、`paths.runtimeDir/workspaceDir`、实例生命周期 `signal`、
`log`、`lifecycle.add` 及可选 `resumeState`，返回 `run`、`dispose` 和可选 `checkpoint`。
实例按插件运行版本、Agent、用户、Profile、会话、模式隔离，同实例串行执行。
运行资源在 `run.lifecycle` 追踪，长期资源在 `session.lifecycle` 追踪。
声明 `resume: true` 时必须实现 `checkpoint()`；检查点需包含正整数 `schemaVersion` 和 JSON `data`。
升级后检查点格式的兼容处理由插件的 `createSession` 负责；恢复不等于重放尚未确定结果的操作。

`run(input, run)` 的输入包含本轮 `input`、不含本轮输入的历史 `history`、宿主 `instructions` 和 `options`。
内容块为文本 `{type:'text',text}` 或附件 `{type:'image'|'file',assetId,name,mediaType}`。
宿主统一处理上传与权限，插件用 `run.attachments.resolve(assetId)` 获取元信息和本地路径，
或用 `read(assetId)` 读取二进制。插件必须把图片和文件传给其引擎或工具处理，不得丢弃或仅用占位文本冒充处理。
格式、文件大小和模型侧限制应明确报告为运行错误。

本轮上下文还包含：

| 字段 | 语义 |
| --- | --- |
| `identity` | 当前实际用户、Profile、会话、运行、Agent 和来源；不借用安装者权限 |
| `mode / model` | 按模式区分的原生模型选择或 Studio 代理绑定 |
| `signal / deadlineAt` | 当前取消和超时；Agent 运行独立于普通 RPC 的 120 秒上限，单次运行上限为一小时，父任务可更早停止 |
| `host / tools / workspace` | 现有插件 SDK 的当前用户能力，继续受 manifest 和原业务接口权限约束 |
| `state.agentSession` | 当前 Agent、账号、Profile、会话及模式的分区存储；插件全局共享存储仍使用根 `ctx.state.plugin` |
| `mcpServers` | 由 Studio 生成的本轮受管 MCP 配置，带短期运行凭证文件；引擎配置格式由插件适配 |
| `interactions.approve` | 请求审批并返回 `approved/denied/cancelled/timeout`；只有显式 approved 才能继续相应操作 |
| `interactions.clarify` | 返回 `answered` 和文本，或 `dismissed/cancelled/timeout` |
| `output.emit / log / lifecycle` | 过程事件、运行日志与本轮资源清理 |

模型代理和 MCP 凭证在运行结束或取消时失效，不得记录到日志、前端或聊天历史。
异步回调中的根 `ctx.identity/host/signal` 也绑定当前调用者。运行结束后保存下来的上下文不可继续使用。
Node.js 插件仍是可信代码；取消信号无法强行中断同进程的无限循环，插件必须正确释放其进程和连接。

标准事件为 `text.delta`、`reasoning.summary.delta`、`status`、`tool.started/completed/failed`。
宿主生成运行 ID、校验事件，并以 Promise 提供背压。最终返回 `{content,finishReason,usage?,checkpoint?}`，
其中 `content` 是完整回复，增量只作预览，宿主只保存一份最终回复。
成功、失败、取消与持久化均由宿主控制；结束后的迟到事件不能写回。停止会保留已生成的部分内容。

### 既有 Coding Agent 兼容

统一管理入口为 `/api/studio/agents`，设置、检查更新和升级由宿主按注册来源分发。
内置适配器映射既有状态检测、更新协调器、原生模型发现器及设置路由。
原 `/api/coding-agents/*`、稳定 Agent ID、别名、会话和工作流引用继续保留；模型 `provider` 不改名。
内置 CLI/SDK/ACP、配置生成、安装删除、自动更新、回滚及运行管理器继续使用原实现。
插件 Agent 使用同一管理和模式约定，接入现有单聊、群聊、工作流的运行、停止、历史和事件通道。
名称与头像来自注册信息，新建单聊、会话恢复、群聊历史、Bot 执行任务、通知和用量页均保留插件 Agent ID。尚未加载或已卸载的插件使用保存的完整 Agent ID 首字母与纯色底头像；颜色由 ID 稳定生成，同一 ID 在消息和任务等页面一致。例如 `plugin:omp/omp` 显示 `P`。不保存额外头像快照。
Bot 的执行预设也从注册目录读取支持单聊的插件，并按实际账号、资源 Profile、安装状态和模式校验。Bot 自身的外观与执行 Agent 独立。插件原生模型目录及其缓存按账号、Profile 和 Agent 分区；原有 CLI 的原生目录仍共享。

## Published directory and installed-plugin updates

The plugin center opens on **Installed**, followed by **All**, which browses the
public cloud directory. Installed includes disabled and failed installations.
Administrators with linked projects also have a **Development plugins** tab;
registered projects without an installed snapshot are shown there, not as installed.
The directory is loaded lazily when All is selected, cached for five minutes,
and can be refreshed manually. All pages are fetched before applying search and
capability filters, so results are not limited to the first page. A failed load
keeps the last successful directory and does not block local plugin management.

Both lists classify plugins by `plugin.json` permissions: Agents → `agents`,
UI extensions (including settings views) → `ui`, Chat commands → `commands`,
Tools → `tools`, and Automation → `automation`. These are overlapping declared
permissions, not runtime registration counts; disabling a plugin does not change
its categories. Plugins without any of these permissions appear only under All types.

Market entries match the manifest ID and normalized repository, then distinguish
released packages from active development copies and retained local snapshots.
Local/development copies show their source type and offer **Install marketplace
version**, even if the published version is older. This explicit switch has its
own trust confirmation, shows both versions, warns about a possible downgrade,
stops source watching and preserves configuration, data and source files. A mere
development registration does not mark a marketplace entry installed.

Released packages offer an upgrade only for a higher version; a newer installed
package is labelled newer than the marketplace and is never silently downgraded.
A failed package at the published version offers reinstall. A different repository
with the same manifest ID blocks installation instead of replacing the local plugin.
Missing or incompatible releases remain browsable with installation disabled.
Install, switch, upgrade and uninstall recheck the selected installation identity
(including source, version and install time) after confirmation and use the latest
revision for the transaction. Install requests pass the immutable commit, expected
plugin ID and exact version. Failed operations retain the current installed state.

Installation confirmations use the normal themed primary action. While an install,
upgrade, switch or development build is pending, the confirmation shows a spinner
and waiting text, disables duplicate submission/cancellation and cannot be dismissed
by Escape or the mask. Errors remain in the dialog with retry available. Manual
source installs also lock their inputs and show progress until the request finishes.

The catalog uses compact rows: the icon, name, source/runtime state and short
description form the main identity; author, repository and version metadata stay
together, with primary actions separated from details and uninstall. Rows wrap
on narrow screens without hiding management actions. The header links directly
to development documentation and the plugin template. Plugin submission sits beside
installation in the catalog toolbar, with both actions kept together on narrow screens.
It also offers **Create a blank project** and **Link an existing project** guides,
with copyable CLI commands to run on the Studio server machine. Creating a project
includes a minimal settings-page example, SDK and development docs and registers
the project automatically; linking requires an existing `plugin.json`. Both guides
explain how to enable the project from the development tab and use the same Studio
data home as the CLI. Opening a guide or copying a command does not execute it.

Entries in both lists show the declared author, a direct repository link, cached
GitHub stars and version information. Stars come from the cloud directory's
`repositoryStars`, not from plugin-authored manifest fields or browser calls to
the GitHub REST API. Zero remains zero; missing/invalid counts display an em dash,
and non-GitHub repositories do not display GitHub stars. Missing authors and
repository links have explicit placeholders. Installed cards show the installed
version and a differing published version, with an update state visible to all
accounts. Failed or unmatched checks are unknown rather than “no upgrade.”
Development and local-only sources are identified separately. Failed refreshes
retain previously received stars; development metadata can be read without
enabling automatic upgrades for a development installation.

The independent cloud server reads root `plugin.json` when a submission is approved. It stores manifest metadata, a full snapshot, and an immutable source commit. Its periodic worker automatically publishes higher versions from the repository default branch.

The plugin center checks the public cloud directory when opened, refreshed, focused after five minutes, and every five minutes while mounted. Requests include only the normalized repository URL, with no local token, cookie, Profile, or referrer. Local lists remain usable when the cloud is unavailable. A matching repository, manifest ID and API version plus a higher semantic version produces an update badge. Development installations are excluded.

Only interactive super administrators can install an update, after confirming trust in the executable code. The selected immutable source and expected manifest version are sent to the existing installer, which verifies the ID and version before replacing the installation and preserves its configuration, enabled state, and rollback version. In addition to `github:owner/repo#<40-character-commit>`, published GitLab.com and Gitee packages use `git+https://<host>/<repository>.git#<40-character-commit>`; moving branch or tag references are rejected.
