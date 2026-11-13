# Studio 内置插件

正式插件位于 `builtin/<id>`，每个目录是一个可直接安装的完整插件包。
构建复制到 `dist/plugins/builtin`，启动使用普通 PluginManager 安装或升级，不另设运行机制。

- 首次安装默认启用；后续升级保留启停状态、存储和 `ctx.paths.dataDir`。
- 主动卸载会保留内置插件记录，重启不自动恢复。需要时可安装 `builtin:<id>`。
- 修改发布内容时同步提高 `plugin.json` 和 `package.json` 的版本；不会仅靠源码变化覆盖用户已安装的同版本包。
- 设置前后端、模型配置、原生引擎安装与文件格式归插件负责；scoped 模型凭证和运行上下文由 Studio 注入。
- 测试插件只放在 `tests/fixtures/plugins`，不加入这里。

`builtin/omp` 是 Oh My Pi 的 Agent 插件，通过官方 RPC 接入。OMP 引擎按需下载，包内不包含二进制或用户凭证。
插件包装代码遵循项目许可证；图标和下载的 OMP 引擎保留上游 MIT 许可证，见包内 `OMP-NOTICE.txt`。
配置和用户操作见 [插件文档](../docs/plugins.md)。
