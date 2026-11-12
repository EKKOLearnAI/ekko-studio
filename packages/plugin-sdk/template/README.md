# Studio 独立插件

本项目由 ekko-studio plugins create 生成。先阅读：

- [架构](docs/ARCHITECTURE.md)：包格式、加载、页面隔离、RPC 与 Agent 运行。
- [ctx 能力](docs/STUDIO_CTX.md)：后端、前端、普通运行及 Agent 上下文。
- [回传约定](docs/STUDIO_RETURNS.md)：各回调的返回结构、事件和最终结果。
- [开发规范](docs/DEVELOPMENT.md)：结构变更规则、测试与发布。
- [插件数据契约](docs/CONTRACTS.md)：本项目的输入输出、存储及变更说明。
- [SDK 完整结构](sdk/docs/SDK_REFERENCE.md)：与当前宿主匹配的字段和类型。

```bash
npm install                 # 本地 SDK 类型依赖；harness 本身不需要安装包
npm run harness:check
npm test
npm run dev
```

在 Studio → 插件中心 → 开发插件 中点击“开始调试”。宿主先检查文档与数据结构，
再运行可选 build，监听源码并重载。失败保留当前运行版本；停止调试保留安装副本和数据。
此 .mjs 模板无编译步骤。TypeScript/UI 框架项目自行配置 build，并将清单入口指向编译产物。

数据结构变动时编辑 contracts/plugin.json，补充描述和实现，再执行：

```bash
npm run docs:update -- --summary "描述数据结构的具体变化" --compatibility "说明旧数据如何读取、默认值及迁移方式"
npm run harness:check
npm test
```

示例有 get-settings/save-settings 两个 RPC，按真实用户与 Profile 保存 greeting/compact。
输入、输出、存储都通过同一份契约校验。任意 JSON 不再被当作有效设置直接写入。
