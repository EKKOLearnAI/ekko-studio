<p align="center">
  <strong>Ekko Studio</strong>
  <a href="./README.md">English</a>
</p>

<p align="center">
  本地优先的 AI 工作区，支持多 Agent 聊天、编码和可视化工作流。<br/>
  提供桌面应用和可自托管的 Web 控制台，支持<br/>
  <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>、Ekko Agent、Claude Code、Codex、Pi、Grok、OpenCode 和 DeepSeek Harness（DSH）。<br/>
  在同一个工作区中管理对话、群组协作、语音、文件和设备。
</p>

<p align="center">
  <a href="https://github.com/EKKOLearnAI/ekko-studio/releases/latest">下载 Ekko Studio 桌面版</a>
  ·
  <a href="https://ekkostudio.xyz/#/docs/getting-started">使用文档</a>
  ·
  <code>npm install -g ekko-studio && ekko-studio-web start</code>
</p>

<p align="center">
  <img src="./docs/screenshots/overview/workspace.png" alt="Ekko Studio 工作区与示例对话" width="960"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ekko-studio"><img src="https://img.shields.io/npm/v/ekko-studio?style=flat-square&color=blue" alt="npm 版本"/></a>
  <a href="https://github.com/EKKOLearnAI/ekko-studio/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/ekko-studio?style=flat-square" alt="许可证"/></a>
  <a href="https://github.com/EKKOLearnAI/ekko-studio/stargazers"><img src="https://img.shields.io/github/stars/EKKOLearnAI/ekko-studio?style=flat-square" alt="Star"/></a>
</p>

Ekko Studio 原名 Hermes Studio / Hermes Web UI。GitHub 仓库为
`EKKOLearnAI/ekko-studio`。主 npm 包名为 `ekko-studio`，启动命令为
`ekko-studio-web`；旧的 `hermes-web-ui` 包和命令继续保留，并同步发布相同版本。

## 界面预览

以下为 Ekko Studio **v0.7.18** 的界面截图（2026-09-10）。聊天和工作流使用演示数据。

| 可视化工作流 | Agent 管理 |
| --- | --- |
| [![可视化工作流：研究、编码与审核](./docs/screenshots/overview/workflow.png)](./docs/screenshots/overview/workflow.png) | [![统一管理七种 Agent 运行时](./docs/screenshots/overview/agent-manager.png)](./docs/screenshots/overview/agent-manager.png) |
| 连接多个 Agent 节点，并设置人工审批。 | 在同一界面管理 Agent 安装、设置和更新。 |

<details>
<summary>查看技能管理界面</summary>

浏览已安装的技能、阅读使用说明，并按需启用。

![Ekko Agent 技能管理与 GitHub 技能说明](./docs/screenshots/overview/skills.png)

</details>

## 核心能力

| 模块 | Ekko Studio 能做什么 |
|---|---|
| 多 Agent 运行时 | 运行 Hermes、Ekko、Claude Code、Codex、Pi、Grok、OpenCode 和 DeepSeek Harness（DSH），支持流式回复、工具调用轨迹、生成文件预览、持久化会话和桌面独立聊天窗口。 |
| Studio 工作区 | 为不同 Agent 运行时提供统一的单聊、群聊、Global Agent、工作流、文件、语音、媒体、设备、主题、日志、用量和 App 连接能力。 |
| Agent 控制面 | 将 Hermes 的 Profile、Provider、模型、记忆、技能、插件、任务、Kanban、渠道和运行时管理保留在对应的 Agent 模块内。 |
| 自动化 | 构建可执行的可视化工作流，通过定时任务、审批节点、群聊房间、平台渠道和 MCP Server 连接受支持的 Agent 运行时。 |
| 工作区工具 | 提供文件浏览器、Web 终端、桌面 Agent 浏览器、语音输入输出、Coding Agent、设备发现、学习轨迹和性能视图。 |
| 分发形态 | 支持 Windows/macOS/Linux 桌面应用、npm CLI 包和 Docker 镜像。 |

## Agent 与平台边界

Ekko Studio 为受支持的 Agent 运行时提供统一工作区，
这些运行时归入三个 Agent Family：

| Agent Family | 运行时 | 负责的能力 |
|---|---|---|
| Hermes | Hermes | Profile、Provider、模型、技能、插件、记忆、任务、Kanban、渠道、MCP、终端和 Hermes Runtime 集成。 |
| Ekko | Ekko | Ekko 执行、审批、澄清、记忆、MCP 和 Provider Runtime。 |
| Coding | Claude Code、Codex、Pi、Grok、OpenCode、DSH | Coding Agent 的安装、配置、代理、会话和进程执行。 |

Studio 负责三个 Family 共用的能力：单聊、群聊、Global Agent 编排、工作流、
Webhook、会话、文件与上传、TTS/STT、媒体、宠物、主题、设备、网络、日志、
用量、认证和 App 连接。Studio 所有的 HTTP API 使用 `/api/studio/*`，
Hermes 控制面 API 使用 `/api/hermes/*`。已经发布的旧版移动 App 路径由
一个集中兼容层处理，不再保留重复的旧 Controller。

## 功能特性

### AI 聊天

- 聊天前端通过 Socket.IO `/chat-run` 实时流式更新；Studio 通过运行时适配器将任务分发给 Hermes、Ekko、Claude Code、Codex、Pi、Grok、OpenCode 或 DSH
- 多会话管理 — 创建、重命名、删除、切换会话
- **自建会话数据库** — Studio 会话使用本地 SQLite；Hermes state.db 仅作为只读来源用于 Hermes 历史 API
- 按来源分组会话（Telegram、Discord、Slack 等），可折叠手风琴面板
- 活跃会话实时指示器 — 正在进行的会话置顶并显示旋转图标
- 按最新消息时间排序会话列表
- Markdown 渲染，支持语法高亮和代码复制
- 工具调用详情展开（参数 / 结果）
- 按 Profile 隔离的文件上传、剪贴板图片/文件粘贴和工作区附件
- 文件下载支持 — 按解析后的路径下载用户上传文件和 Agent 生成文件，兼容 local、Docker、SSH、Singularity 等多种 terminal backend
- 可直接预览 Agent 生成的 HTML、PDF、DOCX、PPTX、XLSX、CSV、图片、Markdown 和源码文件
- 会话搜索 — Ctrl+K 搜索 Studio 本地会话库；不包含只读 Hermes 历史会话
- 会话分类、消息引用、压缩进度和可持久恢复的后台委派结果
- 按账号授权 Profile 汇总模型选择器 — 只展示当前账号可访问的 Hermes Profile 中可用的模型
- 每个会话显示模型标签和上下文 Token 用量

### 平台渠道

在一个页面统一配置 **10 个平台**：

| 平台 | 功能 |
|---|---|
| Telegram | Bot Token、提及控制、表情回应、自由回复聊天 |
| Discord | Bot Token、提及、自动线程、表情回应、频道白名单/黑名单 |
| Slack | Bot Token、提及控制、Bot 消息处理 |
| WhatsApp | 启用/禁用、提及控制、提及模式 |
| Matrix | Access Token、Homeserver、自动线程、私信提及线程 |
| 飞书 | App ID / Secret、提及控制 |
| 钉钉 | Client ID / Secret、提及控制 |
| QQBot | App ID / Secret、提及控制 |
| 微信 | 扫码登录（浏览器扫码，自动保存凭证） |
| 企业微信 | Bot ID / Secret |

- 凭证管理写入 `~/.hermes/.env`
- 渠道行为设置写入 `~/.hermes/config.yaml`
- 每个平台已配置/未配置状态检测

### 用量分析

- Token 总用量明细（输入 / 输出）
- 会话数及日均统计
- 预估费用追踪及缓存命中率
- 模型使用分布图
- 30 天每日趋势（柱状图 + 数据表格）

### 定时任务

- 创建、编辑、暂停、恢复、删除 Cron 任务
- 立即触发执行
- Cron 表达式快捷预设

### Kanban

- 按 Profile 管理的 Kanban 看板，用于规划和跟踪 Agent 工作
- 可在仪表盘中创建任务、更新任务并移动状态
- 复用 Studio 本地状态和认证体系

### 可视化工作流

- 基于 Vue Flow 的画布，支持 Hermes、Ekko、Claude Code、Codex、Pi、Grok、OpenCode、DSH 节点以及文件/图片附件
- 支持有向连线、结构化条件、成功/失败路由、循环和审批门
- 工作流定义可导入/导出，并支持按 Profile 管理工作区
- 支持运行预算、截止时间、停止、重跑和持久化执行历史
- 可在画布回放冻结的运行快照、节点对话、路径选择和执行证据

### 模型管理

- 从凭证池自动发现模型（`~/.hermes/auth.json`）
- 从每个 Provider 端点获取可用模型（`/v1/models`）
- 添加、更新、删除 Provider（预设和自定义 OpenAI 兼容）
- 支持 OpenAI Codex、Nous Portal、xAI、Claude 和 GitHub Copilot 的 OAuth/设备授权
- Provider URL 自动检测，支持非 v1 API 版本（如 `/v4`）
- Provider 级模型分组、可见模型控制、别名、刷新和默认模型切换
- 在模型页分别管理 STT 与 TTS Provider

### 多配置文件

- 创建、重命名、删除、切换 Hermes 配置文件（Profile）
- 克隆现有配置文件或从归档导入（`.tar.gz`）
- 导出配置文件用于备份或分享
- 按 Profile 隔离配置、缓存、上传、会话、任务、用量、记忆、技能、插件、Provider 和模型可见性
- 账号绑定 Profile 权限：超级管理员可以管理全部 Profile；普通管理员只能查看和使用分配给自己的 Profile

### 文件浏览器

- 浏览远程后端文件（local、Docker、SSH、Singularity）
- 上传、下载、重命名、复制、移动和删除文件
- 上传文件保存到当前选择/请求的 Hermes Profile 目录下；下载按真实路径解析，支持下载上传目录外的 Agent 产物
- 创建目录
- 预览和编辑支持的文件并提供语法高亮，还可把工作区文件附加回聊天

### 群聊

- 多 Agent 聊天房间，通过 Socket.IO 实时通信
- @提及路由 — 提及 Agent 触发上下文回复
- 上下文压缩 — 历史消息超过 Token 阈值时自动摘要压缩
- 输入状态和回复进度指示器
- 房间创建、删除和邀请码管理
- Agent 管理 — 添加/移除房间中的 Agent，支持独立 Profile
- SQLite 消息持久化
- 移动端响应式布局，可折叠侧边栏

### Coding Agents

- 在仪表盘中安装、配置、启动和监控 Claude Code、Codex、Pi、Grok、OpenCode 与 DeepSeek Harness（DSH）
- 内置 Coding Agent 终端、会话历史、工作区选择、图片输入和文件 Diff
- 提供独立代理路由和 API 模式，适配不同 Provider/模型
- 支持桌面独立聊天窗口，并持久化输出和 reasoning 元数据

#### DeepSeek Harness（DSH）

- 支持单聊、群聊和工作流节点，可使用 Studio 选择的 Provider/模型，也可使用 DSH 原生全局配置。
- 新建会话、添加群聊成员或配置工作流节点时可选择 Agent 预设，恢复会话时保留原有选择。
- 复用原生 `web` profile 的插件。**插件配置**嵌入插件自带的设置界面并跟随黑白主题，**插件列表**管理已安装的包；Agent 预设使用独立的 Studio 管理页。
- 管理 DSH 设置、指令、MCP 和私有技能。共享 `~/.agents/skills` 在所有 Coding Agent 页面中仅展示，禁止编辑和删除。

通过 Agent 管理器，在运行 Studio 后端的机器上安装 DSH。安装原生插件还需要该机器的 PATH 中有 `pnpm`。配置方式、Profile 复用和兼容性说明见 [DSH 接入文档](docs/dsh-management.md)。

### 桌面 Agent 浏览器

- 桌面端多标签浏览器，Agent 可通过托管 MCP Server 进行导航和交互
- 支持隔离浏览器 Profile、标签控制租约、代理、下载、Cookie 和权限管理
- 支持可访问性快照、截图、控制台日志和页面标注

### 技能与记忆

- 浏览和搜索已安装的技能
- 查看技能详情和附件
- 安装和管理 Skill Bundles，并查看按 Profile 统计的技能用量
- 用户笔记、Ekko Agent 持久记忆和按 Profile 管理的记忆
- 学习轨迹关系图，支持技能/记忆关系、分类筛选、详情查看和播放

### 主题自定义

- 支持明暗模式、界面风格、基础字号、文字颜色和选中颜色
- 支持按账号保存背景图片，并在整个工作区实时预览

### 日志

- 查看 Agent / Server / Error 日志
- 按日志级别、日志文件和关键词过滤
- 结构化日志解析，HTTP 访问日志高亮

### 管理与运行时

- 设备和局域网 Peer 页面，用于本地网络发现和 Peer 工具能力
- MCP 管理器，用于托管的 `ekko-studio-*` Server、Profile 自动注入和 `api` / `browser` / `devices` / `use` 工具集
- Runtime Version 和 Version Preview 工具，用于隔离测试新版本
- 面向超级管理员的性能监控视图

### 认证

- 基于 Token 的认证（首次运行自动生成或通过 `AUTH_TOKEN` 环境变量设置）
- 用户名/密码登录，并在设置页提供账户管理
- 默认登录名/密码为 `admin` / `123456`；登录后会提示尽快修改默认账户和密码
- 超级管理员可以管理用户和 Profile 绑定；普通管理员只能管理自己的账户信息

CLI 维护命令：

```bash
# 删除持久化的登录 IP 锁记录
ekko-studio-web clear-login-locks

# 删除登录锁并重启正在运行的 Studio 服务
ekko-studio-web clear-login-locks --restart

# 创建或重置默认超级管理员登录名/密码为 admin / 123456
ekko-studio-web reset-default-login
```

`clear-login-locks` 会删除 `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/.login-lock.json`。如果服务正在运行，需要重启服务才能清理内存中的锁定状态。`reset-default-login` 会更新 Studio 账户数据库；如果已存在 `admin` 用户，则会把密码重置为 `123456`，并启用为超级管理员账户。

### 设置

- 显示（流式输出、紧凑模式、推理过程、费用显示）
- Agent（最大轮次、超时时间、工具强制执行）
- 记忆（启用/禁用、字符限制）
- 会话重置（空闲超时、定时重置）
- 隐私（PII 脱敏）
- 模型设置（默认模型 & Provider）
- Profile 和 Provider 配置

### 语音 / TTS / STT

- 在模型 → STT 和模型 → TTS 中管理语音 Provider；旧的设置 → 语音入口会跳转到这里。
- TTS 适配器：Edge、OpenAI 兼容、MiMo、豆包、ElevenLabs、Gemini、xAI、Mistral、MiniMax、DeepInfra。
- STT 适配器：浏览器、OpenAI 兼容、豆包、Groq、Mistral、xAI、ElevenLabs、DeepInfra。
- 可在聊天输入框使用可编辑的回合制语音输入，也可打开全屏实时语音舞台进入连续的语音交互体验。
- Provider Key 和 MiMo 音色复刻音频保存在服务端，浏览器只接收脱敏后的 Secret 状态。
- 开始新的语音输入会先停止 Assistant 播放，但不会隐式取消正在执行的 Agent Run。
- 支持的设置项、安全边界和当前非目标范围见 [`docs/voice-dialogue.md`](./docs/voice-dialogue.md)。
- 实时语音舞台不代表同时听说的全双工通话；电话接入和常驻唤醒词监听仍不在当前范围。

### Web 终端

- 集成终端，基于 node-pty 和 @xterm/xterm
- 多会话支持 — 创建、切换、关闭终端会话
- 通过 WebSocket 实时传输键盘输入和 PTY 输出
- 支持窗口大小调整

### 桌面应用与自动更新

- Windows、macOS 和 Linux 原生 Electron 桌面壳
- 内置 Studio 运行时，并自动启动本地服务
- 桌面自动更新优先使用 Cloudflare 下载端点获取更新元数据和安装包
- 如果 Cloudflare 更新源不可用，会回退到 GitHub Releases `latest` 资源
- Windows 升级时会先尝试关闭已有 Ekko Studio 进程，再替换文件

---

## 快速开始

### 桌面应用（推荐）

从 [GitHub Releases](https://github.com/EKKOLearnAI/ekko-studio/releases/latest)
下载最新的 **Ekko Studio** 桌面安装包。

桌面版会发布 macOS、Windows 和 Linux 构建；适用时会区分不同 CPU 架构。
桌面应用内置 Studio 运行时；在 Windows、macOS 和 Linux 上，Hermes Agent 数据统一保存到 `~/.hermes`。

桌面壳自身的 Studio 状态会单独保存到 `~/.hermes-web-ui`，除非设置了
`HERMES_WEB_UI_HOME`。

打包后的桌面应用启动后，会安装受管命令 shim，避免桌面应用、内置 Hermes Agent CLI
和内置服务端 CLI 的命令互相冲突：

| 命令 | 说明 |
|---|---|
| `ekko-studio` | 打开 Ekko Studio 桌面应用 |
| `ekko-studio cli ...` | 运行内置 Hermes Agent CLI |
| `ekko-studio web ...` | 运行内置 `hermes-web-ui` 命令 |
| `ekko-studio -h` | 显示 wrapper 帮助 |
| `ekko-studio-mcp [api\|browser\|devices\|use]` | 运行指定的受管 Studio MCP 工具集 |

桌面命令统一为 `ekko-studio`；安装新命令时会移除旧的受管 `hermes-studio` 命令，不保留兼容别名。

使用 `ekko-studio cli -h` 查看 Hermes Agent CLI 帮助，使用
`ekko-studio web -h` 查看服务端 CLI 帮助。`ekko-studio-mcp` 默认暴露
`api` 工具集；按任务选择 `browser`、`devices` 或 `use`，可以缩小 MCP 暴露面。

桌面自动更新会优先读取 `https://download.ekkolearnai.com/latest`。
如果该端点不可用，更新器会回退到
`https://github.com/EKKOLearnAI/ekko-studio/releases/latest/download`。

### npm 安装

```bash
npm install -g ekko-studio
ekko-studio-web start
```

旧包 `hermes-web-ui` 会继续同步更新。两个包都提供 `ekko-studio-web` 和原有命令。
选择其中一个包安装即可；全局命令有重叠，切换包名时请先卸载原包再安装新包。
用户数据仍保存在 `~/.hermes-web-ui`。

打开 **http://localhost:8648**

### Docker Compose

单容器部署，内置 Hermes Agent 运行时：

```bash
# 使用预构建镜像（推荐）
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d

# 或从源码构建
docker compose up -d --build

docker compose logs -f hermes-webui
```

打开 **http://localhost:6060**

- Hermes 持久化数据目录：`./hermes_data`
- Studio 认证 Token 存储在 `./hermes_data/hermes-web-ui/.token`
- 首次启动并开启认证时，Token 会打印到容器日志中
- 运行参数全部由 `docker-compose.yml` 环境变量驱动

更详细的说明与排错见：[`docs/docker.md`](./docs/docker.md)

### Hermes Agent 运行时发现

Studio 启动后端聊天能力时，会优先使用包含 `run_agent.py` 的源码目录，例如
`~/.hermes/hermes-agent`。如果找不到源码目录，会退回到已安装 `hermes` 命令所使用
的 Python 环境，再退到系统 Python。因此源码安装和 `pip install hermes-agent` 这类
包安装方式都可以兼容。

## Studio 环境变量

这些变量用于配置 Ekko Studio、本地 Hermes Runtime 集成以及开发/预览辅助能力。Provider API Key 和 Hermes Agent 相关设置通常仍通过 Hermes Profile 管理；这里列出的变量是进程级覆盖项。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8648` | Studio 服务监听端口。 |
| `BIND_HOST` | `0.0.0.0` | Studio 服务绑定地址。如需 IPv6，可显式设置为 `::`。 |
| `HERMES_LAN_ADVERTISE_URL` | 未设置 | App 局域网二维码使用的可访问 Studio 地址。Docker 中若通过 `localhost` 打开，请设置为宿主机局域网 URL，例如 `http://192.168.1.20:6060`。 |
| `HERMES_APP_ENTITLEMENT_REQUIRED` | `true` | App 局域网 Relay 必须携带有效的云端签名。仅在临时兼容排查时设置为 `false`。 |
| `HERMES_APP_ENTITLEMENT_PUBLIC_KEY` | 内置 | 可选的 RS256 App 签名 PEM 公钥覆盖。签名 issuer 为 `hermes-studio-server`，audience 为 `ekko-studio`。 |
| `HERMES_WEB_UI_HOME` | `~/.hermes-web-ui` | Studio 数据目录，用于认证 Token、登录凭据、日志、数据库和默认上传目录。兼容支持 `HERMES_WEBUI_STATE_DIR` 作为别名。 |
| `HERMES_WEBUI_STATE_DIR` | 未设置 | `HERMES_WEB_UI_HOME` 的兼容别名。 |
| `HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT` | 未设置 | 关闭启动时向 Hermes profile 配置自动注入托管的 `ekko-studio-*` MCP server。 |
| `HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT` | 未设置 | 当 `HERMES_WEB_UI_HOME` 位于临时目录（例如 Version Preview runtime）时，仍允许托管 MCP 自动注入。 |
| `UPLOAD_DIR` | `$HERMES_WEB_UI_HOME/upload` | 覆盖上传根目录。文件会保存在按 Profile 隔离的子目录下。 |
| `CORS_ORIGINS` | 仅同 host | HTTP、Socket.IO、WebSocket 跨源 allowlist，支持逗号或空格分隔。只有明确需要旧版 wildcard CORS 时才设置为 `*`。 |
| `AUTH_TOKEN` | 自动生成 | 显式指定 Bearer Token。未设置时，Studio 会在 `HERMES_WEB_UI_HOME` 下自动生成。 |
| `AUTH_JWT_SECRET` | `AUTH_TOKEN` | 用户名/密码会话的 JWT 签名密钥覆盖。 |
| `HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN` | `30d` | 用户名/密码会话 JWT 有效期。支持秒数或 `s`/`m`/`h`/`d` 后缀，例如 `12h` 或 `7d`。 |
| `PROFILE` | `default` | 启动/默认 Hermes profile。运行时请求使用前端当前选择且当前账号有权限访问的 Profile。 |
| `LOG_LEVEL` | `info` | Server 日志级别。 |
| `BRIDGE_LOG_LEVEL` | `$LOG_LEVEL` 或 `info` | Bridge 日志级别。 |
| `MAX_DOWNLOAD_SIZE` | `200MB` | 最大文件下载大小。 |
| `MAX_EDIT_SIZE` | `10MB` | 最大可编辑文件大小。 |
| `WORKSPACE_BASE` | 当前用户 Home 目录 | Workspace 浏览根目录。 |
| `HERMES_HOME` | `~/.hermes` | Windows、macOS 和 Linux 上的 Hermes 数据目录。 |
| `HERMES_BIN` | `hermes` | 自定义 Hermes CLI 二进制路径。 |
| `HERMES_AGENT_ROOT` | 自动发现 | 包含 `run_agent.py` 的 Hermes Agent 源码目录。 |
| `HERMES_AGENT_BRIDGE_PYTHON` | 自动发现 | 用于启动 agent bridge 的 Python 解释器。 |
| `HERMES_AGENT_BRIDGE_UV` | 自动发现 | 可用时用于启动 agent bridge 的 `uv` 可执行文件。 |
| `UV` | 自动发现 | `uv` 可执行文件 fallback。 |
| `PYTHON` | 自动发现 | agent bridge 的 Python 可执行文件 fallback。 |
| `HERMES_AGENT_BRIDGE_ENDPOINT` | 平台默认值 | Agent bridge broker endpoint。Windows 默认 `tcp://127.0.0.1:18765`；macOS/Linux 默认 `ipc:///tmp/hermes-agent-bridge.sock`。 |
| `HERMES_AGENT_BRIDGE_TIMEOUT_MS` | `120000` | Node 请求 bridge broker 的响应超时。 |
| `HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS` | `5000` | 连接 bridge socket 失败时的短重试窗口。 |
| `HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS` | `120000` | 等待 Python bridge ready 的超时。 |
| `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN` | 开启 | Studio 关闭和重启时是否停止 Bridge Broker；设为 `0`、`false`、`no` 或 `off` 才会在重启时保留 Broker。 |
| `HERMES_AGENT_BRIDGE_AUTO_RESTART` | 开启 | bridge broker 意外退出后是否自动重启；设为 `0`、`false`、`no` 或 `off` 可关闭。 |
| `HERMES_AGENT_BRIDGE_RESTART_DELAY_MS` | `1000` | bridge 自动重启退避的基础延迟。 |
| `HERMES_AGENT_BRIDGE_PLATFORM` | `cli` | 传给 Hermes Agent 的 platform 标识。 |
| `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT` | 平台默认值 | Profile worker transport。设为 `tcp` 使用 loopback TCP；设为 `ipc`/`unix` 使用 Unix domain socket；默认 Windows TCP、macOS/Linux IPC。 |
| `HERMES_AGENT_BRIDGE_WORKER_PORT_BASE` | `18780` | TCP worker endpoint 起始端口。 |
| `HERMES_BRIDGE_PROVIDER` | profile/默认值 | bridge 运行时的 provider 覆盖。 |
| `HERMES_BRIDGE_TOOLSETS` | profile/默认值 | bridge 运行时的 toolset 覆盖。 |
| `HERMES_BRIDGE_MAX_TURNS` | profile/默认值 | bridge 运行时的最大轮数覆盖。 |
| `HERMES_BRIDGE_SUPPRESS_PLATFORM_HINT` | `cli` | 控制传给 Hermes Agent 的 bridge platform hint suppression。 |
| `HERMES_OPENROUTER_APP_REFERER` | `https://ekkostudio.xyz` | bridge 运行发送给 OpenRouter 的 attribution referer。 |
| `HERMES_OPENROUTER_APP_TITLE` | `Ekko Studio` | Bridge 运行发送给 OpenRouter 的 Attribution Title。 |
| `HERMES_OPENROUTER_APP_CATEGORIES` | `cli-agent,personal-agent` | bridge 运行发送给 OpenRouter 的 attribution categories。 |
| `HERMES_WEB_UI_MANAGED_GATEWAY` | 默认开启 | 控制 Studio 托管 Hermes Gateway 进程；设为 `0`、`false`、`no` 或 `off` 时改用 `hermes gateway start`。 |
| `HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART` | 未设置 | 跳过启动时的 gateway 检查/自动启动；dashboard-only 部署中如果由其它服务管理 Hermes gateway，可设为 `1`、`true`、`yes` 或 `on`。 |
| `HERMES_WEB_UI_DISABLE_SKILL_INJECTION` | 未设置 | 跳过启动时的内置 Skill 注入；如果内置 Skills 由 Studio 外部管理，可设为 `1`、`true`、`yes` 或 `on`。启用注入时，Studio 只更新自己此前安装的 Skills 或内容完全相同的既有内置副本；本地修改和用户拥有的同名 Skills 会跳过。 |
| `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN` | 默认开启 | Studio 关闭时仅停止由当前 Studio 进程启动并登记的 Gateway；设为 `0` 或 `false` 可让它们分离运行。外部探测到的 Gateway 不会被收编或关闭。 |
| `HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS` | `10000` | Studio 的短暂资源清理窗口；超时后会强制结束自己持有的进程树再退出。 |
| `HERMES_DESKTOP_STOP_TIMEOUT_MS` | `20000` | Desktop 宿主原有的整树强制结束期限，独立于 Web UI 的 10 秒清理预算。 |
| `GATEWAY_HOST` | `127.0.0.1` | 旧 gateway 兼容配置中写入 profile 的默认 gateway host。 |
| `HERMES_WEB_UI_PREVIEW_REPO` | package repository | Version Preview 使用的 GitHub 仓库。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT` | 平台默认值 | Version Preview broker transport。设为 `tcp` 可让预览环境在 macOS/Linux 上也使用 loopback TCP；未设置时会跟随 `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT=tcp`。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_ENDPOINT` | 隔离的预览 endpoint | 直接覆盖 Version Preview 的 broker endpoint。 |
| `HERMES_WEB_UI_BACKEND_PORT` | `8648` | Vite dev proxy 使用的后端端口。 |
| `HERMES_WEB_UI_FRONTEND_PORT` | `8649` | 前端 Vite dev server 端口。 |

### CLI 命令

原有 `hermes-web-ui` 命令仍可作为下列 `ekko-studio-web` 命令的别名使用。

| 命令 | 说明 |
|---|---|
| `ekko-studio-web start [port]` | 后台启动；支持位置端口或 `--port <port>` |
| `ekko-studio-web client [port]` | 为远程客户端启动，关闭 Gateway 自动启动并允许跨域 |
| `ekko-studio-web restart [port]` | 重启；默认会关闭 Bridge Broker |
| `ekko-studio-web stop` | 停止后台进程 |
| `ekko-studio-web status` | 查看运行状态 |
| `ekko-studio-web clear-login-locks [--restart]` | 清理持久登录锁，可选择重启 |
| `ekko-studio-web reset-default-login` | 创建或重置默认管理员登录 |
| `ekko-studio-web update` / `upgrade` | 更新到最新版本并重启 |
| `ekko-studio-web version` / `-v` | 显示版本号 |
| `ekko-studio-web -h` | 显示帮助信息 |
| `hermes-web-ui-mcp [api\|browser\|devices\|use]` | 运行一个受管 Studio MCP 工具集（等同于 `ekko-studio-mcp`） |

如不希望自动打开浏览器，可在 `start` 或 `client` 后添加 `--no-open`。

`restart`、`update` 和 `upgrade` 默认会停止 Agent Bridge broker，避免重启或更新后的服务复用旧 Python bridge 进程。只有明确希望保留 broker 和正在运行的 bridge session 时，才在重启前设置 `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0`。

`update` / `upgrade` 会先尝试执行 `npm cache clean --force`，再根据当前安装的包名升级 `ekko-studio@latest` 或 `hermes-web-ui@latest`，并重启对应包。Web UI 的版本检查也使用相同的包名。缓存清理失败时会提示警告，但不会中止升级安装。

### 自动配置

启动时 BFF 服务器会自动：

- 初始化 Studio 数据目录、本地数据库和内置技能
- 启动 `/chat-run` 使用的 Hermes agent bridge
- 启动成功后自动打开浏览器；设置 `--no-open` 时跳过

---

## 开发

```bash
git clone https://github.com/EKKOLearnAI/ekko-studio.git
cd ekko-studio
npm install
npm run dev
```

- 前端：http://localhost:8649
- BFF 服务器：http://localhost:8647

```bash
npm run harness:check
npm run test
npm run build   # 构建输出到 dist/
```

贡献命令见 [DEVELOPMENT.md](./DEVELOPMENT.md)，完整的 Package 与状态模型见
[ARCHITECTURE.md](./ARCHITECTURE.md)。

## 架构

```text
浏览器 / Desktop / App
          │ HTTP + Socket.IO
          ▼
Koa Bootstrap（仅负责组装）
          │
          ├─ Studio 平台 ── 单聊、群聊、Global Agent、工作流、
          │                 会话、文件、语音、设备、Webhook
          ├─ Hermes Family ─ Profile、模型、技能、记忆、任务、
          │                  Kanban、渠道、终端、Hermes Bridge
          ├─ Ekko Family ─── Ekko Runtime 与 Agent 自有服务
          └─ Coding Family ─ Claude Code、Codex、Pi、Grok、OpenCode、DSH 适配器
```

服务端按业务归属组织在
`packages/server/src/modules/{studio,hermes,ekko,coding-agents}`。Route 保持轻量，
Controller 处理 HTTP 关注点，Service 负责可复用业务行为，只有
`packages/server/src/bootstrap` 可以组装具体模块和 Adapter。跨 Agent 的能力归
Studio；不能因为某项公共功能当前使用 Hermes，就把它放进 Hermes 模块。

Studio 状态与 Hermes Agent 状态彼此独立。Studio 默认使用
`~/.hermes-web-ui`，Hermes Profile 数据仍保存在 Hermes Home 下。完整目录归属、
依赖规则和 API 迁移约束见
[`docs/harness/server-module-boundaries.md`](./docs/harness/server-module-boundaries.md)。

## 技术栈

**前端：** Vue 3 + TypeScript + Vite + Naive UI + Pinia + Vue Router + vue-i18n + SCSS + markdown-it + highlight.js

**后端：** Koa 2 + Socket.IO + SQLite + node-pty

## 许可证

[BSL-1.1](./LICENSE)

该许可证覆盖 Ekko Studio、`hermes-web-ui` npm 包和 CLI、桌面应用、
固件、发布产物、文档以及本仓库内的关联文件。

MCP 主入口为 `bin/ekko-studio-mcp.mjs`，工具名统一使用 `ekko_studio_*` 前缀。旧的 `hermes-studio-mcp` / `hermes-web-ui-mcp` 命令及 `hermes_studio_*` 调用继续兼容。重启 MCP 客户端后可发现新工具名；Studio 会将托管服务配置迁移为 `ekko-studio-api`、`ekko-studio-browser`、`ekko-studio-devices` 和 `ekko-studio-use`。
