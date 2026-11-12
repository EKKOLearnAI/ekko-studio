# 插件开发指引

先读 README.md、docs/ARCHITECTURE.md、docs/STUDIO_CTX.md、docs/STUDIO_RETURNS.md、
docs/DEVELOPMENT.md 和 docs/CONTRACTS.md。精确宿主类型见 sdk/docs/SDK_REFERENCE.md。

- 所有跨边界及持久化数据结构统一声明在 contracts/plugin.json，写清每个字段及操作的说明。
- 使用契约校验实际输入、输出和存储，不在 handler 中另定义未登记的公开结构。
- 结构变动必须同步字段说明、变更摘要、兼容/迁移方案及行为测试。
- 用 npm run docs:update -- --summary "变更内容" --compatibility "兼容和迁移方式" 更新说明。
- 完成前运行 npm run harness:check 和 npm test；存在 build 时也运行它。
- 不删除检查、不手改生成摘要、不伪造通过结果；不要编辑 SDK 来绕过宿主契约。
- 使用真实 run.identity 分区数据；注册资源清理并响应 signal。
- UI、工具及 Agent 使用已声明的 Studio 通道；不依赖宿主源码、数据库或登录凭证。
