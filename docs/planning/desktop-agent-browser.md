# 桌面端 Agent 内置浏览器规划

日期：2026-07-22

实现状态：已确定并实现首版架构。嵌入式浏览器直接使用
<code>webContents.debugger</code>，不通过 <code>agent-browser</code>，也不开放
远程调试端口。

## 一、结论

Hermes Studio 桌面端新增一个基于 Electron <code>WebContentsView</code> 的内置浏览器。
普通浏览器打开的 Web UI、VPS 部署的 Web UI 都不提供浏览器功能。

浏览器有两条控制链路，最终都汇入 Electron 主进程中的
<code>BrowserManager</code>：

~~~text
用户手动操作：
Vue 浏览器界面
  → 可信 Preload API
  → Electron IPC
  → BrowserManager
  → WebContentsView

Agent 操作：
Ekko / Hermes / Codex / Claude Code
  → MCP（stdio）
  → 本地 Browser Broker（私有 RPC）
  → BrowserManager / BrowserAutomation
  → 同一个 WebContentsView
~~~

MCP 只是 Agent 的统一工具协议，不直接控制 Electron。真正控制浏览器的是
Electron API 和 CDP：

- 标签页、导航、前进、后退、刷新：Electron <code>webContents</code> API；
- DOM 快照、点击、输入、滚动、截图：由每个标签页自己的
  <code>webContents.debugger</code> 直接发送固定 CDP 命令；
- DOM 元素选择和任意区域框选：
  <code>executeJavaScriptInIsolatedWorld()</code>；
- 不创建 Browser 级 CDP Endpoint，不在进程参数、文件或 RPC 中传递 CDP URL。

## 二、目标

- 在 Hermes Studio 桌面端提供可见的内置浏览器。
- 支持多个标签页，并保留每个标签页独立的导航状态。
- 用户与 Agent 操作同一个可见页面，而不是另外启动隐藏浏览器。
- Ekko Agent、Hermes Agent、Codex、Claude Code 共用同一套浏览器工具。
- 复用 CDP Accessibility/DOM/Input/Page 协议，并由桌面端维护短期元素引用。
- 用户可以实时看到 Agent 的点击、输入、滚动和跳转。
- 用户可以随时停止 Agent 并接管当前标签页。
- 支持点击 DOM 元素进行批注。
- 支持从任意方向拖动，框选任意矩形区域进行批注。
- 截图要作为真实图片发送给支持视觉的模型，不能只返回本地路径。
- 浏览器登录状态保存在 Hermes 自己的独立 Profile 中。
- Profile 数据目录和下载目录可以由用户配置。
- 支持创建和切换多个完全隔离的 Profile。
- 远程网页不能访问 Node、Electron IPC、本地文件和 Web UI 登录凭据。

## 三、不做的内容

- 不做完整 Chrome 替代品。
- 不直接复用用户本机 Chrome 的 Profile 目录。
- 第一版不支持 Chrome 扩展、密码导入、书签同步和浏览历史同步。
- 普通 Web UI 和 VPS Web UI 永久不提供内置浏览器功能。
- 不把 CDP 地址、Electron 对象或原始 IPC 暴露给 Agent。
- 不允许 Agent 在没有确认机制的情况下执行购买、发布、删除数据、
  上传文件、输入敏感凭据等高风险操作。
- 不向局域网或互联网提供浏览器画面流。

## 四、现状

### 4.1 Ekko Agent

<code>packages/ekko-agent/src/tools/browser.ts</code> 已经提供：

~~~text
browser_navigate
browser_snapshot
browser_click
browser_type
browser_scroll
browser_back
browser_press
browser_get_images
browser_vision
browser_console
~~~

这些工具通过安全的参数数组启动 <code>agent-browser</code> CLI。
目前 <code>browser_vision</code> 只把截图路径作为文本返回，图片内容没有真正进入
模型请求。

### 4.2 MCP

仓库已有 <code>bin/hermes-studio-mcp.mjs</code>，当前按以下 toolset
向 Ekko 和 coding agent 注入工具：

~~~text
api
devices
use
~~~

本功能新增第四个 toolset；配置在所有 Web UI 运行方式下统一存在，但能力只有本机
Desktop Browser Broker 有效时可用：

~~~text
browser
~~~

### 4.3 Electron

当前桌面端只有主 <code>BrowserWindow</code> 和宠物窗口，没有
<code>WebContentsView</code>，也没有浏览器标签页、Browser Broker 或浏览器 IPC。

## 五、平台边界

内置浏览器只存在于可信 Electron 环境：

- Electron 主进程拥有标签页、<code>WebContentsView</code>、Profile、权限、
  截图、DOM 注入、CDP 和生命周期。
- <code>packages/client</code> 可以放浏览器界面，因为桌面端复用同一个 Vue
  客户端。
- 浏览器界面必须检测完整且可信的 Desktop Browser Bridge，并采用懒加载。
- 普通 Web UI 不显示入口，不允许访问路由，也不初始化相关 Store。
- 普通 Web UI Server 不注册浏览器 Koa 路由、OpenAPI、Socket.IO namespace、
  CDP Relay 或截图流。
- 环境变量、URL 参数、Local Storage 和 User-Agent 都不能开启该功能。
- 没有可信 Preload Bridge 时，直接访问桌面浏览器路由必须跳回安全页面。

浏览器界面代码可以存在于共享 Client 包中，但浏览器能力本身不存在于普通 Web
环境。

## 六、MCP 工具设计

### 6.1 为什么使用 MCP

浏览器不只给 Ekko Agent 使用，还需要提供给 Hermes Agent 和 coding agent。
MCP 是这些 Agent 都能接入的统一协议，比为每一种 Agent 单独实现一套私有接口
更合适。

MCP 不负责创建 <code>WebContentsView</code>，也不持有 Electron 权限；
它只把经过校验的语义化操作转发给 Electron Browser Broker。

### 6.2 按类目加载工具

<code>tools/list</code> 只暴露一个类目入口
<code>hermes_studio_browser_toolset</code>，避免把所有浏览器 Schema 长期放入
模型上下文。入口支持三个动作：

~~~text
list      返回紧凑的操作名称和说明
describe  按名称返回一个操作的完整 Input Schema
call      按名称和 arguments 调用该操作
~~~

类目内部保留 8 个聚合操作：

~~~text
browser_tabs
  action: list | create | activate | close

browser_navigate
  action: open | back | forward | reload | stop

browser_snapshot
  返回紧凑的可访问性树和稳定元素引用

browser_read_text
  从当前快照的元素分页读取文本

browser_interact
  action: click | type | press | scroll

browser_batch
  actions: 1–50 条 click | type | press | scroll，按顺序执行

browser_screenshot
  返回视口或整页截图

browser_console
  action: read | clear
~~~

选择 1 个类目入口和 8 个内部聚合操作的原因：

- 常驻上下文只有类目说明和入口 Schema；
- 模型只在需要时读取一个具体操作的完整 Schema；
- 8 个语义操作仍比十几个按钮级操作更稳定；
- Action 枚举较小，参数校验更明确；
- 后续容易单独限制高风险操作。

所有页面操作都携带明确的 <code>tab_id</code>，结果也必须返回
<code>tab_id</code>。创建标签页只能通过 <code>browser_tabs</code>，其他操作不会
隐式跟随用户当前标签页。Snapshot 返回 <code>snapshot_id</code>，click/type 必须
回传该 ID；页面变化后旧引用立即失效。

批量调用使用 `ekko_studio_browser_batch`，一次提交同一标签页的多条指令：

~~~json
{
  "tab_id": "tab-id",
  "snapshot_id": "current-snapshot-id",
  "actions": [
    { "action": "type", "ref": "@e2", "text": "example" },
    { "action": "click", "ref": "@e4" },
    { "action": "click", "ref": "@e7" },
    { "action": "scroll", "direction": "down", "pixels": 400 }
  ]
}
~~~

- click/type 的所有 ref 都来自提交时的同一份最新快照。只有按键/滚动时可以省略 snapshot_id。
- 执行前验证全部参数和初始引用；每步重新获取快照并按原始 DOM 节点身份定位，不复用可能已变号的 ref，也不猜测替代元素。
- 整批占用同一标签页的操作队列；其他标签页仍可并发。单步工具保持兼容。
- 首次失败、目标消失、页面导航/刷新、用户接管或 30 秒执行预算耗尽时，停止后续动作。已有的高风险操作确认逐步生效，确认等待结束后再次检查取消状态与预算。
- 返回 `completed`、`total` 和 `results`；每项带从 0 开始的 `index`、动作类型及 `completed` / `failed` / `skipped` 状态。成功的步骤不会回滚，失败步骤也可能已产生部分效果，请根据结果决定是否重试。
- 能读取时返回执行后的 `snapshot`；无法读取时返回 `snapshotError`。部分执行会在 MCP 结果标记 `isError: true`，仍保留逐步结果。页面跳转后的操作需要根据新快照再次提交。

### 6.3 MCP 配置统一注入，能力由桌面 Broker 决定

新增托管 MCP Server：

~~~text
hermes-studio-browser
command: hermes-studio-mcp
args: [browser]
~~~

Web UI、Ekko Agent、Hermes Agent 和 coding agent 都注册相同的
<code>hermes-studio-browser</code> 托管配置，不再根据
<code>HERMES_DESKTOP</code> 增删配置，避免多个 Web UI 进程反复改写同一份 Profile。

实际能力仍由本机 Browser Broker 决定：存在有效 Broker 时，
<code>tools/list</code> 返回 browser 类目入口；普通 Web UI、VPS 或 Broker 已失效时
返回空工具列表，强行调用只返回明确的不可用错误，不影响 Web UI 主进程。

桌面模式下 Ekko Agent 也使用这套 MCP 工具。原有 Ekko 浏览器工具只作为
非桌面环境或桌面 Browser Broker 不可用时的独立浏览器回退方案。工具注册器
必须显式选择其中一种，不能依赖同名工具覆盖顺序。

## 七、进程通信

### 7.1 Agent 到 MCP

Agent 的 MCP Client 启动：

~~~text
hermes-studio-mcp browser
~~~

Agent 和 MCP 进程之间使用 MCP 标准的 JSON-RPC，通过子进程
<code>stdin/stdout</code> 通信。

### 7.2 MCP 到 Electron

MCP 进程不能直接调用 Electron <code>ipcMain</code>，因此 Electron 主进程需要
启动一个很小的 Browser Broker RPC Server。

通信链路：

~~~text
Agent MCP Client
  -- MCP JSON-RPC / stdio -->
hermes-studio-mcp browser
  -- 私有 JSON-RPC / 127.0.0.1 随机端口 -->
Electron Browser Broker
  --> BrowserManager / BrowserAutomation
~~~

Broker 使用 Node 内置 HTTP 即可，不需要新增网络依赖，也不需要第二条
WebSocket。浏览器操作状态通过 Electron IPC 推送给 Vue 界面。

### 7.3 Broker 安全

Browser Broker：

- 只监听 <code>127.0.0.1</code> 随机端口；
- 每次桌面程序启动时生成新的高强度 Token；
- 所有请求必须携带 Token；
- 校验固定的 RPC Method 和严格参数 Schema；
- 拒绝浏览器页面 Origin 发起的请求；
- 不支持 CORS；
- 不返回 CDP 地址；
- Electron 退出时立即关闭；
- 不经过普通 Web UI Server。

Broker 描述文件：

~~~text
$HERMES_WEB_UI_HOME/desktop-browser/broker.json
~~~

示例：

~~~json
{
  "schema": 1,
  "desktopPid": 12345,
  "endpoint": "http://127.0.0.1:49152/v1",
  "token": "<random-per-launch-token>",
  "instanceId": "<random-per-launch-instance>",
  "createdAt": "2026-07-22T00:00:00.000Z"
}
~~~

要求：

- 目录权限仅当前用户可访问；
- 文件权限为 owner-only；
- 启动时清理旧文件；
- 退出时删除；
- MCP 严格校验 schema、loopback 地址和固定 RPC 路径；Broker Token 每次启动更新；
- 文件内容不进入日志、聊天记录或模型上下文；
- 这是临时发现信息，不是用户配置。

### 7.4 调用者身份与控制租约

MCP 进程可以跨多个 Run 复用，因此不能把 Run ID 当成调用者身份。每个
<code>hermes-studio-mcp browser</code> 进程先用启动发现 Token 向 Broker 注册，
由 Broker 签发不可由模型传入的 <code>client_session_id</code> 和独立会话令牌；
每次 RPC 再生成独立 <code>operation_id</code>。
Run ID 只允许作为可选审计元数据，不参与授权。

Browser Broker 使用 <code>client_session_id + tab_id</code> 管理控制租约：

- 同一标签页同一时间只能有一个 Agent 控制；
- MCP 注册自身进程 PID；进程退出后 Broker 立即回收其租约，旧版客户端仍按租约 TTL 回收；
- 用户点击“接管”时先中止当前 Agent 操作；
- 另一个 Agent 需要显式申请控制权；
- 用户切换 UI 标签页不会改变 Agent 绑定的标签页。
- 同一标签页内部操作排队，不同标签页可并发执行，并设置全局并发上限。

## 八、代码文件规划

### 8.1 MCP

~~~text
bin/hermes-studio-mcp.mjs
  现有 MCP stdio 入口；识别新的 browser toolset。

bin/mcp/browser-tools.mjs
  1 个类目入口、8 个内部操作 Schema、参数规范化、Broker 描述文件读取、
  Broker RPC Client 和 MCP 图片结果转换。
  这里不包含 Electron 或 CDP 权限。
~~~

### 8.2 Electron

~~~text
packages/desktop/src/main/browser/browser-manager.ts
  管理标签页、WebContentsView、Session、导航、Bounds 和状态。

packages/desktop/src/main/browser/browser-broker.ts
  启停本地 RPC、认证、参数校验、调用者身份和控制租约。

packages/desktop/src/main/browser/browser-automation.ts
  仅通过 webContents.debugger 执行快照、交互和截图；不接受任意 JS。

packages/desktop/src/main/browser/browser-profile-store.ts
  Profile 元数据、Session 目录、下载目录、切换和清理。

packages/desktop/src/main/browser/browser-types.ts
  标签页、Broker、租约、选择结果和浏览器状态类型。
~~~

### 8.3 Client

~~~text
packages/client/src/views/hermes/DesktopBrowserView.vue
  “工具 → 浏览器”纯配置页面；只管理 Profile、下载、权限和数据清理，不显示网页。

packages/client/src/components/hermes/chat/DesktopBrowserPanel.vue
  对话右栏里的纯浏览器面板；只包含标签页、地址栏、网页、接管和多选区批注会话。

packages/client/src/components/hermes/chat/ChatPanel.vue
  在“工作区 / 终端”右侧工具面板中按需加载浏览器第三个 Tab；确认后的截图与隐藏结构化批注写入当前 Composer。

packages/client/src/utils/desktop-bridge.ts
  完整 Bridge 能力检测；普通 Web UI 不创建浏览器 Tab，也不加载面板 Chunk。
~~~

具体文件名实现时可根据现有 Client 目录结构调整，但职责边界不能改变。

## 九、BrowserManager

### 9.1 职责

- 每个标签页创建一个 <code>WebContentsView</code>；
- 把活动标签页挂载到主窗口；
- 隐藏非活动 View，但保留页面状态；
- 同步 Vue 占位区域的 Bounds；
- 管理 URL、标题、图标、加载状态、前进和后退状态；
- 管理多个 Hermes Browser Profile 和对应 Session；
- 管理权限、弹窗、下载和崩溃；
- 为每个标签页维护独立 Debugger 会话和 Snapshot 引用；
- 保存仅 Electron 内部可见的 Target Record；
- 向 Vue 和 Browser Broker 发布状态。

### 9.2 WebContentsView 安全配置

~~~ts
const browserSession = session.fromPath(profile.sessionPath)
browserSession.setDownloadPath(profile.downloadPath)

new WebContentsView({
  webPreferences: {
    session: browserSession,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
  },
})
~~~

远程网页 View 不加载 Preload。所有高权限操作只能从 Hermes Studio 主 Renderer
经过可信 Preload IPC 到 Electron 主进程。

### 9.3 标签页模型

~~~ts
interface DesktopBrowserTab {
  id: string
  profileId: string
  title: string
  url: string
  faviconUrl?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  agentControl: 'idle' | 'active' | 'waiting-for-user'
}
~~~

第一版最多 8 个标签页。关闭标签页时：

- 销毁对应 <code>WebContentsView</code>；
- 删除内部 Target Record；
- 中止绑定该标签页的 Agent 操作；
- 释放租约；
- 删除临时截图和未完成批注；
- 不影响其他标签页。
- 允许关闭最后一个标签页并保持空标签栏，用户可通过“+”重新创建标签页。

## 十、Web UI 与桌面端 IPC

浏览器的工具栏和标签栏在 Vue 中，网页内容是 Electron 原生
<code>WebContentsView</code>，不是 Vue DOM 子节点。

### 10.1 Typed Preload Bridge

~~~ts
interface DesktopBrowserBridge {
  open(): Promise<DesktopBrowserState>
  listProfiles(): Promise<DesktopBrowserProfile[]>
  createProfile(input: BrowserProfileCreateInput): Promise<DesktopBrowserProfile>
  chooseProfileRootDirectory(defaultPath?: string): Promise<string | null>
  inspectProfileSwitch(profileId: string): Promise<BrowserProfileSwitchImpact>
  switchProfile(
    profileId: string,
    confirmationId?: string,
  ): Promise<DesktopBrowserState>
  renameProfile(profileId: string, name: string): Promise<DesktopBrowserProfile>
  updateProfile(
    profileId: string,
    input: BrowserProfileUpdateInput,
  ): Promise<DesktopBrowserProfile>
  listDownloads(profileId: string): Promise<DesktopBrowserDownload[]>
  cancelDownload(downloadId: string): Promise<DesktopBrowserState>
  openProfileDirectory(profileId: string): Promise<void>
  openDownloadDirectory(profileId: string): Promise<void>
  clearProfileData(
    profileId: string,
    dataTypes: BrowserDataType[],
  ): Promise<void>
  listSitePermissions(profileId: string): Promise<BrowserSitePermission[]>
  revokeSitePermission(profileId: string, permissionId: string): Promise<void>
  deleteProfile(profileId: string): Promise<void>
  createTab(url?: string): Promise<DesktopBrowserTab>
  activateTab(tabId: string): Promise<DesktopBrowserState>
  closeTab(tabId: string): Promise<DesktopBrowserState>
  navigate(tabId: string, url: string): Promise<DesktopBrowserTab>
  back(tabId: string): Promise<DesktopBrowserTab>
  forward(tabId: string): Promise<DesktopBrowserTab>
  reload(tabId: string): Promise<void>
  stop(tabId: string): Promise<void>
  setBounds(bounds: BrowserBounds): Promise<void>
  setVisible(visible: boolean): Promise<void>
  startAnnotation(
    tabId: string,
    mode: 'element' | 'region',
  ): Promise<BrowserSelection>
  cancelAnnotation(tabId: string): Promise<void>
  clearData(): Promise<void>
  stopAgentControl(tabId: string): Promise<void>
  onStateChanged(
    listener: (state: DesktopBrowserState) => void,
  ): () => void
}
~~~

不能暴露：

- 原始 <code>ipcRenderer</code>；
- CDP 命令；
- CDP 地址；
- Electron 对象；
- 任意 JavaScript；
- 任意文件路径读写。

Profile 和下载目录必须由 Electron 原生目录选择器选择。Renderer 只能请求打开
选择器，不能直接提交任意路径让主进程读写。

每个 <code>ipcMain</code> Handler 都必须验证 Sender 是可信 Hermes Studio
Renderer。

### 10.2 Bounds

Vue 页面提供一个布局占位容器，通过 <code>ResizeObserver</code> 把位置和大小
发送给 Electron，Electron 调用 <code>WebContentsView.setBounds()</code>。

以下情况必须隐藏原生 View：

- 浏览器页面或面板关闭；
- 主窗口隐藏或最小化；
- 显示批注截图编辑器；
- 全局 Modal 覆盖浏览器区域。

原生 View 会盖住 Vue 的 Popover 和 Modal，不能只依赖 CSS
<code>z-index</code>。

### 10.3 对话页浏览器 Tab

实际网页放在对话页右侧工具面板中，与“工作区 / 终端”并列：

~~~vue
<button
  v-if="hasDesktopBrowserBridge()"
  @click="activeToolPanel = 'browser'"
>
  {{ t('browser.title') }}
</button>

<DesktopBrowserPanel
  v-if="hasDesktopBrowserBridge() && activeToolPanel === 'browser'"
  @attach="handleBrowserAttachment"
/>
~~~

面板使用异步组件；只有完整可信的 Desktop Browser Bridge 存在时才显示并加载。
面板负责标签页、地址栏、网页操作、Agent 接管和批注，并在工具栏显示当前 Profile
选择器和下载入口。Profile 可在面板内立即切换；下载入口显示实时进度并允许取消。
目录、代理和权限等完整配置仍放在独立配置页。

左侧“工具 → 浏览器”保留桌面专属动态路由，但该页面只负责配置：

~~~ts
{
  path: '/hermes/browser',
  name: 'hermes.browser',
  component: () => import('@/views/hermes/DesktopBrowserView.vue'),
}
~~~

普通 Web UI 中：

- <code>router.hasRoute('hermes.browser')</code> 为 <code>false</code>；
- “工作区 / 终端”面板不显示浏览器 Tab；
- 左侧“工具”分组不显示浏览器入口；
- 不加载 <code>DesktopBrowserView</code> Chunk；
- 不调用 Profile、下载或浏览器 Bridge。

<code>DesktopBrowserView</code> 是纯配置中心：

1. **Profile 设置**
   - Profile 使用与模型配置一致的响应式卡片网格，展示当前活动状态、目录和下载策略；
   - 每张卡片可直接切换、编辑和删除；
   - 新建与编辑使用独立 Modal，避免配置表单长期挤占列表空间；
   - 显示规范化后的 Profile 目录；
   - 新建时选择空的 Profile 根目录；
   - 已有 Profile 实时切换到新的空根目录；
   - 每个 Profile 独立配置直连、系统代理或固定代理；
   - 打开 Profile 目录。
2. **下载设置**
   - 当前 Profile 下载目录；
   - 下载前始终询问；
   - 重名处理策略；
   - 当前下载任务和进度；
   - 取消进行中的下载；
   - 打开下载目录。
3. **隐私与权限**
   - 清除 Cookie；
   - 清除 Cache；
   - 清除站点数据；
   - 重置当前 Profile；
   - 重置所有 Profile。
   - 查看当前 Profile 已授权站点；
   - 单项撤销；
   - 全部撤销；
   - 第一版没有允许列表时保持默认拒绝。

进入配置路由时，对话页浏览器面板卸载并隐藏原生 <code>WebContentsView</code>，
配置页自身从不设置 View Bounds，也不显示网页。

该页面不使用普通 <code>settingsStore.saveSection()</code>，也不调用 Web UI
Server。所有数据来自 Typed Preload Bridge，并由 Electron 主进程落盘。

新建 Profile 使用 Electron 生成的 UUID。用户输入显示名称，并通过主进程原生
目录选择器选择一个空的 Profile 根目录，不能使用普通文本框直接编辑路径。根目
录下固定创建 <code>data/</code> 和 <code>download/</code>。

切换 Profile 前，界面展示 BrowserManager 返回的影响摘要：

~~~ts
interface BrowserProfileSwitchImpact {
  activeAgentRuns: number
  activeDownloads: number
  pendingAnnotations: number
  openTabs: number
  requiresConfirmation: boolean
}
~~~

如果存在 Agent 操作、下载或未完成批注，必须先确认或处理，不能直接强制切换。
主进程负责最终判断，Renderer 中的确认状态不能绕过 Broker 租约和下载检查。

已有 Profile 更换存储位置时也必须选择空目录，不迁移或删除旧数据。主进程先
保存标签页 URL，销毁该 Profile 的全部 <code>WebContentsView</code>，更新为新
根目录下的 <code>data/</code> 和 <code>download/</code>，然后立即重建标签页。
目录修改和 Profile 切换都不要求重启 Electron。

侧边栏名称、页面标题、4 个 Tab 和所有操作文案必须补齐
<code>en/zh/zh-TW/ja/ko/pt/es/ru/de/fr</code> 等全部现有 Locale。

## 十一、Agent 自动化

### 11.1 CDP 标签页隔离

每个 <code>WebContentsView.webContents</code> 拥有自己的 Debugger 会话。自动化层
只接收已由 BrowserManager 解析出的标签页对象，并在该对象上调用
<code>debugger.sendCommand()</code>。它没有枚举或切换其他 Target 的能力。不同标签页
可以并行，同一个标签页必须经过 Broker 队列串行执行。

### 11.2 CDP 凭据

实现不创建 Target WebSocket URL，也不调用
<code>app.commandLine.appendSwitch('remote-debugging-port')</code>。因此不存在可写入
<code>broker.json</code> 或返回给下列进程的 CDP 凭据：

- Web UI Server；
- MCP 进程；
- Ekko Agent；
- Hermes Agent；
- coding agent；
- 模型。

Browser Broker 先校验 MCP 客户端身份和标签页租约，再把语义化操作交给桌面自动化
执行器；Broker 响应永远不包含 Electron 对象或 CDP 信息。

## 十二、实时查看和接管

Agent 操作的是当前可见 <code>WebContentsView</code>，所以桌面预览不需要额外画面流。

界面显示：

- 当前 Agent；
- 当前动作，例如“正在点击登录”；
- 被控制的标签页；
- Agent/用户控制权；
- 停止并接管按钮；
- Target 断开、超时和页面崩溃状态。

第一版采用明确接管：

1. 用户点击“接管”；
2. Broker 中止当前 Agent 操作；
3. 释放 Agent 租约；
4. 用户输入恢复为权威输入。

不允许 Agent 输入和用户输入静默竞争。

## 十三、DOM 选择与区域框选

### 13.1 代码归属

- Electron Desktop：注入脚本、页面选择、编号标记、清理、截图和坐标转换，并通过远程网页原生右键菜单提供“选择 DOM / 框选区域”；
- Client：冻结的整页标注截图、贴近选区左下方的说明输入框、多标注会话、发送确认和 Composer Attachment；
- Preload：只提供 start/cancel/clear/result Typed IPC；
- Agent/MCP：只负责截图和模型图片输入，不负责用户批注交互。

注入实现不能放进普通 Web UI Bundle，也不能接受 Renderer 传入的 JavaScript
源码。

### 13.2 DOM 元素选择

使用 <code>executeJavaScriptInIsolatedWorld()</code> 注入固定脚本：

- Capture Phase 监听 Pointer Move；
- 使用 <code>document.elementsFromPoint()</code> 找到候选元素；
- 忽略注入的 Overlay；
- 使用 <code>getBoundingClientRect()</code> 绘制高亮；
- Capture Phase 拦截最终点击，避免触发网页真实操作；
- 返回标准化坐标和安全元素元数据。

### 13.3 任意区域框选

- Capture Phase 监听 Pointer Down/Move/Up；
- 支持任意方向拖动；
- 坐标限制在当前 Viewport；
- 对反向拖动结果进行标准化；
- 小于最小尺寸时视为误操作；
- 返回 Viewport 坐标和页面滚动位置。

### 13.4 Overlay 与清理

- 使用隔离世界中的固定 Overlay；持久编号和说明放入 Closed Shadow Root，远程页面脚本不能读取标注文本；
- 不提供 Node、IPC、文件、Cookie、Storage 或 Clipboard 能力；
- 单次选择完成后清理交互 Overlay 和 Pointer Listener，但保留不可交互的编号框；
- 点击“发送/清除”、取消、导航、切换标签页、关闭标签页、页面崩溃时清理整个标注会话；
- 同一个标签页可以顺序添加多个 DOM 或区域标注，不能并发启动两个选择器。

第一版只选择顶层 Document。跨域 iframe 可以作为一个矩形元素选择，但不能读取
iframe 内部 DOM。

### 13.5 批注流程

1. 用户在远程网页右键菜单选择“选择 DOM”或“框选区域”。
2. 主进程通知当前浏览器面板，并在当前标签页注入对应选择器。
3. 用户点击元素或拖动矩形。
4. 为选区绘制顺序编号并由 Electron 截取完整可见 Viewport，不裁成只有选区的小图。
5. 保存 URL、标题、Tab ID、Viewport、缩放、编号、坐标和安全 DOM 元数据。
6. 清理当前选择器、隐藏原生 View，并在冻结截图中把说明输入框定位到选区左下方；输入框标题使用相同编号。
7. 输入框失焦或点击“完成”后，将说明保存到当前标注会话并恢复原生 View；“编号 + 说明”气泡固定显示在框体外侧，用户可继续右键添加多个 DOM 或区域标注。
8. 点击标注会话的“发送”后，Composer 只显示包含全部编号高亮的整页截图和折叠数据入口；说明写入 JSON，不追加到 Composer 文本输入框。
9. JSON 中每条说明通过 <code>marker</code> 与截图编号关联。模型输入额外携带 <code>&lt;browser_selection_context format="json"&gt;</code>
   结构化文本，展示/存储输入使用独立 <code>display_input</code>，不把 JSON 混入正文。
10. 截图进入 Composer 后，真正发送消息仍由 Composer 的发送按钮决定。

持久标注不能停留在浏览器视口中的旧坐标。DOM 标注保留所选元素引用，并在标注会话的渲染帧中重新读取 `getBoundingClientRect()`；自由框选转换为页面坐标，再换算为当前视口坐标。这样页面滚动、内部滚动容器滚动、窗口尺寸变化或 DOM 布局变化时，标注都能跟随目标；清空标注会同时停止跟踪循环。

~~~ts
interface BrowserAnnotationSession {
  tabId: string
  url: string
  title: string
  viewport: {
    width: number
    height: number
    scaleFactor: number
  }
  annotations: Array<{
    marker: number
    mode: 'element' | 'region'
    note: string
    region: { x: number; y: number; width: number; height: number }
    element?: {
      role?: string
      name?: string
      tag?: string
      id?: string
      classNames?: string[]
      selectorHint?: string
    }
  }>
}
~~~

元素元数据不能包含：

- Input Value 或密码；
- 隐藏文本；
- Dataset；
- Script；
- Event Handler 源码；
- Cookie、Header 或 Storage；
- 无长度限制的页面文本。

## 十四、截图与模型视觉输入

<code>browser_screenshot</code> MCP 工具返回：

- 标准 MCP Image Content；
- 小型 JSON/Text 摘要；
- Tab ID、URL、Viewport 等非敏感信息。

Ekko 的 MCP Client 和模型 Provider Adapter 必须保留图片内容，不能把图片降级为
本地路径文本。

内部可以使用：

~~~ts
interface AgentToolAsset {
  type: 'image'
  path: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  purpose: 'browser_screenshot' | 'browser_annotation'
}
~~~

要求：

- OpenAI Responses、OpenAI-compatible Chat、Anthropic、Gemini 分别测试；
- 不支持视觉的模型回退到可访问性快照；
- Base64 图片不能写入消息正文、日志、Socket.IO Event 或工具摘要；
- 临时图片使用 owner-only 目录；
- 超过 TTL 或 Session 结束后删除。

## 十五、浏览器 Profile

### 15.1 Profile 存储位置

Electron 支持两种持久化 Session：

~~~text
session.fromPartition('persist:hermes-browser:<profile-id>')
session.fromPath('<absolute-profile-path>')
~~~

如果只需要 Hermes 管理默认位置，可以使用 <code>fromPartition()</code>。
如果要允许用户明确配置 Profile 目录，应使用
<code>session.fromPath(absolutePath)</code>，然后创建
<code>WebContentsView</code> 时通过 <code>webPreferences.session</code>
传入该 Session。

默认 Profile 目录：

~~~text
$HERMES_WEB_UI_HOME/desktop-browser/profiles/<profile-id>/data
$HERMES_WEB_UI_HOME/desktop-browser/profiles/<profile-id>/download
~~~

用户可以通过 Electron 原生目录选择器修改某个 Profile 的存储位置。要求：

- 必须是绝对路径；
- 创建 Session 前完成路径解析和权限检查；
- 使用 <code>realpath</code> 防止符号链接绕过；
- 不允许选择 Web UI 数据库、Hermes Agent Home、应用安装目录或其他
  Profile 的子目录；
- 不能直接选择系统 Chrome 的 <code>User Data</code> 或
  <code>Default</code>；
- 路径变更后不能继续复用旧 Session 对象。
- 用户选择的根目录必须为空；不复制旧目录内容。

~~~ts
interface DesktopBrowserProfile {
  id: string
  name: string
  rootPath: string
  sessionPath: string
  downloadPath: string
  proxyMode: 'direct' | 'system' | 'fixed_servers'
  proxyRules: string
  askBeforeDownload: boolean
  downloadConflictPolicy: 'ask' | 'uniquify'
  createdAt: string
  lastUsedAt: string
}
~~~

Profile 配置元数据保存在：

~~~text
$HERMES_WEB_UI_HOME/desktop-browser/profiles.json
~~~

它只保存 Profile ID、名称和规范化后的目录，不保存 Cookie、密码或 Broker
Token。Session 数据保存在各自根目录的 <code>data/</code> 中，下载保存在同一
根目录的 <code>download/</code> 中。

Chromium 的普通持久 Cookie 仍由 Session 自己写入 <code>data/</code>。为覆盖
Electron 不跨应用启动保留 session cookie，以及自定义 Session 未及时生成 Cookie
数据库的情况，Desktop 额外监听每个 Profile 的 Cookie 变化，将该 Profile 的全部
Cookie（包含原过期时间）镜像到仅限当前系统用户读取的
<code>data/.hermes-session-cookies.json</code>，并在恢复标签页之前写回。该文件
不使用操作系统钥匙串加密，因此 Cookie 值以明文保存在本机 Profile 目录中。日志、
IPC 和 MCP 结果都不能包含 Cookie 名称或值。

### 15.2 多 Profile 切换

支持多 Profile，但一个已经创建的 <code>WebContentsView</code> 不能原地更换
Session。Session 必须在创建 View 时确定。

第一版采用“一个活动 Profile 对应一组标签页”：

1. 用户选择另一个 Profile。
2. 中止当前 Profile 的 Agent 操作并释放所有租约。
3. 如果存在下载或未完成批注，要求用户先处理。
4. 记录当前 Profile 的标签页 URL 和恢复信息。
5. 销毁当前 Profile 的全部 <code>WebContentsView</code> 和内部 Target。
6. 通过目标 Profile 的绝对路径创建/获取 Electron Session。
7. 使用新 Session 重建该 Profile 的标签页。
8. 恢复该 Profile 自己的标签页状态。

切换或重建活动 Profile 前必须调用 <code>Session.flushStorageData()</code> 和
<code>Session.cookies.flushStore()</code>，确保 Cookie、登录态和 DOM Storage 已
写入该 Profile 的 <code>data/</code>。<code>BrowserManager</code> 在运行期间持续持有
每个已打开 Profile 的 Session，切回时复用同一实例，不能只保存 Session 路径后
立即释放对象。Cookie 变化后的本地快照在运行期防抖写入，不能只依赖退出流程；
退出时的最终保存和 flush 必须设置 2 秒上限，超时后记录告警并继续退出，不能
无限阻塞 Electron 主进程。

不要为了快速切换而长期保留多个 Profile 的全部隐藏 View，避免内存占用和
Agent 误操作。所有 Tab、Target、截图、下载和租约都必须带
<code>profileId</code>。

Profile 切换、创建、删除和路径修改只能由用户在桌面 UI 中执行，不作为 MCP
工具暴露给 Agent。

### 15.3 下载位置

下载目录属于 Profile，固定为 Profile 根目录下的：

~~~text
<profile-root>/download
~~~

创建 Session 后调用：

~~~ts
browserSession.setDownloadPath(profile.downloadPath)
~~~

同时监听 Session 的 <code>will-download</code>：

- 下载前确认使用 Electron 自带保存对话框，并在 <code>will-download</code> 回调内
  同步调用 <code>setSaveDialogOptions()</code>；
- 可使用 <code>DownloadItem.setSavePath()</code> 设置单个文件位置；
- 不能暂停后等待独立异步对话框再设置路径，否则 macOS 可能留下无法完成重命名的
  <code>.com.github.Electron.*</code> 临时文件；
- 处理重名、非法文件名、目录逃逸和覆盖；
- 显示来源域名、文件名、类型和大小；
- 工具栏下载入口与配置页都显示实时字节数、百分比和任务状态；
- 进行中的任务可以通过主进程持有的 <code>DownloadItem</code> 取消；
- Agent 发起的下载必须获得用户确认；
- Profile 切换或删除前处理进行中的下载。

远程网页和 Agent 不能指定任意本地下载路径。

### 15.4 Profile 代理

每个 Profile 独立保存代理模式：直连、系统代理或自定义固定代理。自定义代理规则
传给该 Profile 的 <code>Session.setProxy()</code>，支持 HTTP/HTTPS/SOCKS 规则。
创建、编辑或切换 Profile 时，在加载页面前完成代理设置；编辑活动 Profile 的代理
会立即销毁并重建其页面视图，不影响 Web UI、Hermes 或其他 Profile 的网络请求。

### 15.5 隔离与清理

每个 Profile 与 Web UI Session、Hermes Agent 状态、其他 Browser Profile 和
系统 Chrome Profile 完全隔离。

不能直接使用 Chrome 的 <code>User Data</code> 或 <code>Default</code>：

- Chrome 和 Electron Chromium 版本可能不同；
- Chrome 会锁定正在使用的 Profile；
- 密码和 Cookie 可能使用安装相关加密；
- 直接复用有数据损坏风险。

“工具 → 浏览器”配置页面提供：

- 与模型配置一致的 Profile 卡片列表和当前活动标记；
- Profile 创建、重命名、切换和删除；
- Profile 新增与编辑 Modal；
- Profile 空根目录选择；
- 每个 Profile 的代理配置；
- 清除 Cookie 和站点数据；
- 清除缓存；
- 重置当前 Profile；
- 重置所有 Hermes Browser Profile；
- 下载前确认；
- 站点权限查看。

删除 Profile 属于破坏性操作，必须二次确认。优先移动到系统废纸篓或先创建可恢复
备份，不能直接静默删除目录。

## 十六、安全要求

- 每个远程 View 使用
  <code>sandbox: true</code>、
  <code>nodeIntegration: false</code>、
  <code>contextIsolation: true</code>、
  <code>webSecurity: true</code>。
- 远程 View 不加载 Hermes Desktop Preload。
- 顶层导航只允许规范化后的 HTTP/HTTPS 和明确的内部 Blank/Error Page。
- 开发环境允许 localhost，但继续拦截云 Metadata 地址和疑似 Token URL。
- 默认拒绝摄像头、麦克风、定位、通知、MIDI、USB、Serial、Bluetooth、
  Clipboard、屏幕捕获和文件权限。
- 显式处理 Popup、新窗口、协议处理和下载。
- Browser Broker 不支持 CORS，拒绝网页 Origin，所有请求必须认证。
- MCP 类目入口只能发现和调用固定 8 个浏览器语义操作。
- MCP 和模型不能看到 Broker Token、CDP URL、Cookie、Storage、IndexedDB、
  Authorization Header 或密码。
- 注入脚本固定在 Desktop 代码中，IPC 只允许 element/region 枚举。
- 页面文本属于不可信 Agent Context。
- 提交敏感表单、删除、发布、购买和权限修改必须由用户确认。
- 日志中隐藏输入秘密、CDP 地址、Broker Token 和状态文件路径。

## 十七、失败处理

- View 崩溃：显示可恢复错误，用户确认后重建。
- 页面导航或 DOM 操作：先作废 Snapshot 引用，再接受新的元素操作。
- Broker 描述文件过期：MCP 返回明确的桌面浏览器不可用错误。
- Debugger 断开：保留页面，作废引用并把控制权返回用户。
- 单个工具超时：只中止本次操作，不破坏页面。
- 截图失败：返回可访问性快照和本地化说明。
- 关闭被控制标签页：中止该标签页操作，不影响其他标签页。
- Profile 切换：先中止该 Profile 的全部 Agent 操作，处理下载和批注，再重建
  View。
- Profile 目录不可用：保留配置并显示修复入口，不能自动回退到另一个目录造成
  用户误以为数据丢失。
- 应用重启：保留 Profile，不恢复旧租约、Broker Token 或 Snapshot 引用。

## 十八、测试

### 18.1 单元测试

- URL 规范化和危险 Scheme 拒绝；
- Metadata 地址和疑似 Token URL 拦截；
- Preload 只暴露文档中的 Browser API；
- IPC Sender 校验；
- 普通 Web UI 无浏览器路由、Store 和 Lazy Import 激活；
- 标签页创建、切换、关闭、状态保留和 8 个上限；
- Profile 创建、重命名、切换、删除和目录冲突校验；
- 浏览器路由只在完整 Desktop Browser Bridge 存在时动态注册；
- 普通 Web UI 没有浏览器路由和侧边栏入口；
- Profile 列表、切换影响摘要、下载进度和数据清理状态正确；
- Profile 迁移使用 pending 状态、重启执行、失败回滚并保留旧目录；
- Profile 切换会销毁旧 View，并使用新 Session 重建；
- 不同 Profile 的 Cookie、Cache、Tab、Target 和下载目录完全隔离；
- Renderer 不能直接提交任意 Profile 或下载路径；
- Bounds 限制；
- 权限默认拒绝；
- Broker 文件 PID、Token、地址、过期时间和权限校验；
- Broker 拒绝非法 Origin 和未认证请求；
- MCP 仅在有效 Desktop Broker 存在时暴露 1 个 browser 类目入口；
- browser 类目只能列出、描述和调用固定 8 个内部操作；
- 模型参数不能覆盖 Launcher 注入的 Caller ID；
- MCP 结果不包含 Token 和 CDP 地址；
- 同一标签页并发租约冲突；
- MCP 进程退出后，其标签页租约可被下一客户端立即回收；
- Agent 操作不跟随 UI 标签页切换；
- Annotation IPC 拒绝任意脚本和 Selector；
- 元素元数据敏感信息过滤；
- 反向区域拖动标准化和边界限制；
- 所有取消和异常路径都清理注入状态；
- 图片 TTL 清理；
- 各 Provider 的图片 Payload 转换。

### 18.2 桌面集成测试

- 打开本地 Fixture；
- 测试地址栏、前进、后退、刷新、标题和 Loading；
- 创建、切换、关闭多个标签页；
- 第九个标签页返回本地化错误；
- Ekko、Hermes、一个 coding agent 分别操作同一个可见页面；
- UI 切换标签页后，Agent 仍绑定原标签页；
- Agent 不能访问 Hermes Studio 主 Renderer；
- Profile Cookie 持久化且与 Web UI 隔离；
- 全部 Profile Cookie 使用操作系统安全存储加密镜像、运行期保存，并在重启后于首个请求前恢复；
- 退出时的 Profile 保存超过 2 秒会继续退出，不会无限等待；
- 创建两个 Profile，验证登录状态、标签页和下载目录互不共享；
- 切换 Profile 时验证 Agent 操作、租约、批注和下载处理；
- 修改 Profile 目录后验证 Session 使用新路径；
- 下载前确认、重名处理、目录限制和进度状态正确；
- 浏览器 Tab 的所有操作只经过 Preload IPC，不产生 Koa 或
  Socket.IO 浏览器请求；
- 所有 Locale 都包含新增 Browser Page 文案；
- 窗口缩放、最大化、恢复后 Bounds 对齐；
- 全局 Modal 能正确隐藏原生 View；
- DOM 元素选择正确；
- 四个方向的矩形拖动正确；
- 跨域 iframe 只能选择外框；
- 取消批注后无残留 Overlay 和 Listener；
- 同一页面可连续添加多个编号标注，输入失焦后仍能继续选择；
- 框体外的“编号 + 说明”、截图编号、折叠 JSON 的 <code>marker</code> 和说明一一对应；
- 标注说明不写入 Composer 文本输入框；
- Composer 收到真实图片和结构化批注；
- “接管”能中止当前 Agent 操作。

### 18.3 手动安全检查

- 测试 <code>javascript:</code>、<code>file:</code>、<code>data:</code>；
- 测试 Metadata 地址和带 Token URL；
- 测试摄像头、麦克风、定位、通知、Clipboard、下载和 Popup；
- 检查日志和进程参数是否泄漏 Broker/CDP/秘密；
- 从未认证本地进程请求 Broker；
- 确认重置 Browser Data 不影响 Web UI 和系统 Chrome；
- 浏览器直接打开普通 Web UI，确认没有入口、路由、Bridge、API、Stream 或
  MCP Browser Toolset。

## 十九、实施阶段

### Phase 0：CDP 标签页隔离（已完成方案选择）

- 创建最小 <code>WebContentsView</code>；
- 验证 <code>webContents.debugger</code> 仅操作所属标签页；
- 验证多标签页隔离；
- 确定使用 <code>webContents.debugger</code>，不开放调试端口。

### Phase 1：可见浏览器 MVP

- 实现 BrowserManager；
- 实现标签页和导航；
- 实现 Vue 浏览器界面；
- 实现 Typed Preload IPC；
- 实现 Bounds 同步；
- 实现独立 Profile 和权限策略；
- 实现可配置 Profile/下载目录和多 Profile 切换；
- 动态注册桌面专属 Browser Route，并在侧边栏“工具”分组增加入口；
- 实现只包含 Profile、下载、隐私与权限的独立配置页面；
- 在对话页“工作区 / 终端”旁增加纯浏览器 Tab；
- 完成桌面端专属 Gate；
- 先支持用户手动浏览。

### Phase 2：多 Agent 控制

- 实现 Browser Broker；
- 实现 Broker 描述文件和认证；
- 实现 1 个 Browser MCP 类目入口和 8 个内部操作；
- 向 Web UI、Ekko、Hermes、Codex、Claude Code 统一注入 browser MCP 配置；
- 没有有效 Desktop Browser Broker 时返回空工具列表；
- 实现 Caller ID、Tab Binding、Lease、Abort 和 Action Status；
- Agent 操作同一个可见 View。

### Phase 3：批注和视觉

- 实现隔离世界 DOM 元素选择；
- 实现任意区域框选；
- 实现清理机制；
- 实现截图冻结、选区左下方评论编辑和多标注会话；
- 接入 Composer；
- 实现标准 MCP Image Content；
- 修复非桌面 <code>browser_vision</code> 只返回路径的问题。

### Phase 4：加固

- 权限管理；
- Browser Data 设置；
- 下载策略；
- 崩溃恢复；
- 跨平台桌面测试；
- 评估标签页按 Chat 分组或恢复。

## 二十、验收标准

- 桌面用户可以在 Hermes Studio 内打开多个本地或 HTTPS 页面。
- 标签页切换后各自状态保持。
- Ekko、Hermes、Codex、Claude Code 使用同一套 MCP 工具。
- 所有 Agent 操作的是同一个可见页面，不启动第二个 Chrome。
- Agent 操作始终绑定指定标签页。
- Agent 不能访问 Hermes Studio 主 Renderer。
- 用户能看到操作并随时接管。
- 浏览器登录状态只保存在 Hermes Browser Profile。
- 用户可以创建和切换多个 Profile，各 Profile 的登录状态和下载目录隔离。
- 用户可以通过桌面原生目录选择器配置 Profile 数据目录和下载目录。
- 用户可以在对话页“工作区 / 终端 / 浏览器”面板中浏览和操作网页。
- 用户可以在“工具 → 浏览器”页面管理 Profile、下载、数据和站点权限，该页面不显示网页。
- 用户能点击 DOM 元素或任意拖动矩形，并在同一页面连续添加多个编号批注。
- 说明输入框显示在对应选区左下方；失焦后保存为框体外的标注气泡并恢复浏览器，直到用户统一发送。
- 批注以带全部编号高亮的整页截图进入 Composer；说明不进入文本框，JSON 默认折叠可展开，并作为隐藏结构化模型上下文发送。
- Screenshot 向视觉模型提供真实图片。
- 普通 Web UI 和 VPS 没有入口、路由、Bridge、API、Stream、Broker 或浏览器
  MCP Toolset。
- macOS、Windows、Linux 的安全和集成测试通过。

## 二十一、后续增强

- 标签页是否永久独立于 Chat，还是后续按 Chat 分组？
- 哪些高风险站点或操作必须二次确认？
- 各模型 Provider 对 MCP Image Content 的兼容方式是什么？
- 是否在当前明确“接管”按钮之外，增加用户在页面内点击时自动接管。
