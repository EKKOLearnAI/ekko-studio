# 插件开发指引

先读 README.md、docs/ARCHITECTURE.md、docs/STUDIO_CTX.md、docs/STUDIO_RETURNS.md、
docs/FIELD_REFERENCE.md、docs/HOST_API.md、docs/DEVELOPMENT.md 和 docs/CONTRACTS.md。
精确宿主类型见 sdk/src/index.ts 及其导出的模块；可选 JSON 字段不用时省略，不传 undefined。

- 跨边界及持久化数据结构声明在 contracts/plugin.json，写清每个字段及操作的含义。
- 使用契约校验实际输入、输出和存储，不在 handler 中另定义未登记的公开结构。
- 数据结构变化时直接修改相关 Markdown 和字段说明，解释默认值及兼容/迁移行为，并补充测试。
- 文档可直接编辑，与代码一起提交；无需生成命令或修改哈希记录。
- 完成前运行 npm run harness:check 和 npm test；存在 build 时也运行它。
- 宿主指南由 Studio 维护；升级 SDK 时一起更新，不修改宿主类型来绕过契约。
- 使用真实 run.identity 分区数据；登记资源清理并响应 signal。
- UI、工具及 Agent 使用已声明的 Studio 通道；不依赖宿主源码、数据库或登录凭证。
