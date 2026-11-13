# 插件开发规范与 harness

## Studio 负责维护宿主说明

Studio 修改插件架构、ctx、输入输出或事件结构时，开发者或开发 Agent 直接编辑
`packages/plugin-sdk/docs/ARCHITECTURE.md`、`STUDIO_CTX.md`、`STUDIO_RETURNS.md` 中对应的说明，
与接口代码一起提交；影响现有插件时，在相关段落写清默认行为、兼容方式或迁移要求。
这些都是普通 Markdown，不需要生成命令、哈希或额外变更参数。
字段变更同时维护 FIELD_REFERENCE.md，宿主方法变更同时维护 HOST_API.md。包括类型、含义、
必填/可空、默认值、单位、范围、权限、错误与兼容行为；不能仅把签名改成 Json 后省略业务约束。

创建插件时，CLI 将当前 Studio 版本的指南和 SDK 复制到项目中。精确类型直接查看项目根目录下
`sdk/src/index.ts` 和 `sdk/src/agents.ts`，不再维护一份重复的类型快照。
已创建项目保留当时的文档与 SDK；升级时一起更新，避免旧项目的行为被静默改变。

Studio 的常规 harness/build 检查文档是否存在，并检查 SDK 源码变化是否伴随架构、ctx 或回传说明修改。
本地检查未提交变化，Build CI 检查整个 PR 或 push 的变化；说明是否准确仍由代码审查负责。
无 Git 历史的发行包只检查文件完整性，插件作者无需运行宿主的文档同步检查。

## 插件开发规则

开发项目登记后会出现在 Studio 插件中心的统一卡片列表中。删除开发链接执行 `unlink`，
停止源码监听并移除登记，保留项目源码、已安装副本和插件数据；已安装副本仍可独立运行。
Studio 将每次安装或重建的运行副本放在独立的 UUID 目录中。请使用插件中心的卸载操作移除安装，
不要直接删除运行副本目录，否则安装记录仍会指向原路径。

1. 使用公开 ctx SDK；不导入 Studio 服务端内部路径，不读取宿主数据库/token。
2. 跨前后端、工具/动作输入输出、自定义事件、持久化记录和检查点的数据结构统一声明在
   `contracts/plugin.json`。每个模型、字段、操作写清 description；不使用的区段保留空对象。
3. 处理器使用同一声明校验输入、输出和存储边界；示例 RPC 使用 registerRpc，存储使用 validateModel。
4. 修改本插件的结构时，直接修改字段说明及 `docs/CONTRACTS.md` 中的行为说明，并补充测试。
   持久化不兼容变更必须提高 version、实现迁移，并在文档里解释旧数据如何处理。
5. namespace 由可信 run.identity 决定；配置是全局的；secret 不传前端、不输出日志。
6. 创建的进程、监听、定时器和连接注册 disposer；响应取消，不在调用结束后使用 run context。
7. 前端 bundle 自包含，使用宿主主题变量；事件/路由变化会重挂载，持久状态放在后端。
8. 发布成品入口与资源，保持 package/plugin 版本一致；安装不会执行生命周期脚本构建项目。

## 自动检查与测试

开发者直接改代码和文档，正常运行检查即可：

```bash
npm run harness:check
npm test
```

Studio 启用开发链接及源码重载时自动运行插件 harness；有 build 时在其前后检查，失败保留上一个成功版本。
生成项目的 prepack 和 CI 同样执行检查和测试。检查缺失字段描述、未知模型、缺失文件和版本不一致；
不会因为手动编辑了 Markdown 而拒绝加载。所有新项目都应声明并运行 harness。

harness 无额外 npm 依赖。测试至少覆盖有效输入、非法输入、错误输出、存储分区和关键失败路径。
Agent 还需覆盖流式与最终结果、中断、工具事件配对、审批拒绝、附件和检查点恢复。
自动检查不能推断任意 JavaScript 里的隐藏结构或判断自然语言是否准确，边界测试和审查负责实现与文档的一致性。
使用隔离临时状态，不访问真实用户目录和付费模型。

## 契约格式

models 支持 object/array/string/number/integer/boolean/null；每个字段必须有 description。
object 声明 properties、required、additionalProperties；array 声明 items。
支持 enum、minimum/maximum、minLength/maxLength/maxItems；拒绝未知关键字，不支持 $ref/anyOf。
操作的 input/output 引用 models 中的名称；事件声明 model 和 caller/plugin audience。
storage/checkpoints 声明 model、正整数 version 和 scope；迁移逻辑由插件实现。
宿主 inputSchema 是 SDK Schema 子集，支持 description；只有全部字段都属于 SDK Schema 子集时才可复用文档模型。
