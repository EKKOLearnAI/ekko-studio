# 插件开发规范与 harness

## 必须遵守

1. 插件独立开发，使用公开 ctx SDK；不导入 Studio 服务端内部路径，不读取宿主数据库/token。
2. 跨前后端、工具/动作输入输出、自定义事件、持久化记录和检查点的数据结构统一声明在 `contracts/plugin.json`。
   每个模型、字段、操作都必须有 description；不使用的 rpc/tools/commands/actions/events/storage/checkpoints 保留空对象。
3. 处理器使用统一声明校验输入、输出和存储边界；示例 RPC 使用 registerRpc，存储使用 validateModel。
   新能力也要这样接入，不能在实现代码中另造一套未登记的对外结构。
4. 新增、删除、改名、类型、必填项、枚举、权限、存储范围、版本等契约变化，先更新字段说明，
   再记录“变更内容”和“兼容/迁移方式”，生成文档，并补充行为测试。持久化不兼容变更必须提高相应 version 并实现迁移。
5. namespace 由可信 run.identity 决定；配置是全局的；secret 不传前端、不输出日志。
6. 创建的进程、监听、定时器和连接注册 disposer；响应取消，禁止后台使用已结束的 run context。
7. 前端 bundle 自包含，使用宿主主题变量；事件/路由变化会重挂载，持久状态放在后端。
8. 发布成品入口与资源，保持 package/plugin 版本一致；安装不会执行生命周期脚本构建项目。

## 项目命令

```bash
npm run harness:check
npm test
npm run docs:update -- --summary "为设置增加主题字段及默认值" --compatibility "新增可选字段，旧记录读取时填入默认主题，无需重写历史数据"
npm run harness:check
```

harness 不依赖额外 npm 包，只需要 Studio 支持的 Node。`npm install` 用于本地 SDK 类型。
`docs:update` 依据真实契约生成 `docs/CONTRACTS.md`；摘要与兼容说明会追加到 `contracts/changes.json`。
修改字段后旧说明的摘要不再匹配，检查失败；缺少字段 description、未知模型、过期 SDK 参考、
缺失文档也会失败。只改生成文档或只替换摘要不会自动构成完整更新。

`docs/ARCHITECTURE.md`、`STUDIO_CTX.md`、`STUDIO_RETURNS.md` 和本文件来自项目内 SDK，
请将插件特有设计写在自己的文档中。`docs/CONTRACTS.md` 和 `sdk/docs/SDK_REFERENCE.md` 为生成文件。
更新宿主 SDK 时复制完整的 SDK 包，然后为插件执行 docs:update；不要只替换几个类型文件。

Studio 在开始调试及源码重载前运行 harness，build 存在时再运行 build 并复查 harness；失败保留上一个成功版本。
新脚手架的 marker 会使缺失 harness:check 的项目被拒绝加载。普通旧插件未声明 harness 的仍可加载。
`prepack` 和随项目提供的 GitHub Actions 执行 harness 与测试，提交代码时把说明、契约和变更记录一起提交。
构建目录使用 dist/build，运行数据使用宿主管理存储。

## 契约格式

`models` 使用明确的 JSON 类型 object/array/string/number/integer/boolean/null；
object 必须声明 properties、required、additionalProperties；array 必须声明 items。
支持 enum、minimum/maximum、minLength/maxLength/maxItems，拒绝未知关键字，不支持 $ref/anyOf。
操作的 input/output 是 models 中的名称；事件的 model 是载荷模型，audience 必须是 caller/plugin。
storage/checkpoints 使用 model、正整数 version 和 scope；这只是声明，迁移仍由插件实现。
宿主 inputSchema 是 SDK Schema 子集，不能直接传入含 description 的文档模型。

## 检查范围与测试责任

自动检查覆盖集中声明的插件契约、清单以及完整 SDK 类型源码的文档一致性。
它不推断任意 JavaScript 里的隐藏结构，也不能判断自然语言说明是否准确；开发规范禁止绕开契约声明，
代码审查与边界测试负责验证实现和语义。内部局部临时变量不属于公开数据契约。
不要把“检查通过”当作运行权限、网络或数据迁移正确性的证明。

测试至少覆盖有效输入、非法输入、错误输出、存储分区，以及新增能力的关键失败路径。
Agent 还需覆盖流式结果与最终结果、中断、工具事件配对、审批拒绝、附件和检查点恢复。
测试使用隔离临时状态，不访问真实用户目录和付费模型。不要为通过检查而修改旧历史或删除 harness。
