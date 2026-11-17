# Studio 独立插件

本项目由 ekko-studio plugins create 创建，随附当前 Studio 的开发说明：

- [架构](docs/ARCHITECTURE.md)：包格式、加载、页面隔离、RPC 与 Agent 运行。
- [ctx 能力](docs/STUDIO_CTX.md)：后端、前端、普通运行及 Agent 上下文。
- [回传约定](docs/STUDIO_RETURNS.md)：各回调的返回结构、事件和最终结果。
- [字段手册](docs/FIELD_REFERENCE.md)：必填、可空、默认值、单位、权限、大小限制和兼容行为。
- [宿主业务参数](docs/HOST_API.md)：八个 host 模块的方法输入、返回包装及业务并发约束。
- [开发规范](docs/DEVELOPMENT.md)：文档维护、测试与发布。
- [插件数据说明](docs/CONTRACTS.md)：本项目的输入输出、存储及兼容行为。
- [SDK 类型](sdk/src/index.ts) 与 [Agent 类型](sdk/src/agents.ts)：精确字段和签名。

```bash
npm install                 # 本地 SDK 类型依赖；harness 本身无需安装依赖
npm run harness:check
npm test
npm run dev
```

在 Studio → 插件中心 → 开发插件 中点击“开始调试”。宿主运行检查及可选 build，
监听源码并重载；失败保留当前运行版本，停止调试保留安装副本和数据。
此 .mjs 模板无需编译。TypeScript/UI 框架项目自行配置 build，并将清单入口指向编译产物。

文档是普通 Markdown，直接编辑并与代码一起提交。本插件的数据结构定义在 contracts/plugin.json，
变化时同步修改字段描述、docs/CONTRACTS.md 的相关说明及行为测试，无需文档生成步骤。
Studio 提供的指南由 Studio 主仓库维护；升级 SDK 时一起更新这些指南。

示例有 get-settings/save-settings 两个 RPC，按真实用户与 Profile 保存 greeting/compact。
输入、输出、存储都通过同一份契约校验。

## SDK 许可

随附 SDK 的代码、类型、harness、模板和全部宿主指南统一采用 [MIT](sdk/LICENSE)，
包括 STUDIO_CTX.md、STUDIO_RETURNS.md。来源与贡献者署名见 [SDK 声明](sdk/NOTICE)。
docs/SDK-LICENSE 与 docs/SDK-NOTICE 保留指南的许可文本与署名。
本项目业务代码的许可由插件作者自行选择，SDK 的 MIT 许可不改变 Studio 核心的许可。

插件名称、描述和每个入口标题必须在 plugin.json 的 i18n 中按 PLUGIN_LOCALES 列出的全部 Studio 语言填写。界面按 ctx.locale 切换语言；新项目缺少任意 Studio 语言将检查失败，回退仅用于旧插件或未知语言；不要用“中文 / English”拼接名称。旧清单字符串保留作兼容回退。
