# 本插件的数据结构

这是可直接编辑的项目说明，与代码一起维护。字段类型、必填项和字段含义统一定义在
`contracts/plugin.json`；这里解释调用行为及数据兼容方式，不复制另一套字段定义。

## 设置 RPC

- `get-settings`：输入为 null，返回当前用户及 Profile 的 settings。
- `save-settings`：输入为 settings，替换当前用户及 Profile 的记录；持久化成功返回 `{ ok: true }`。
- settings 包含 greeting（问候语，字符串，最长 1000 字符）及 compact（紧凑布局，布尔值），两者必填。
- 输入、输出和读取到的记录都校验字段；非法数据抛出错误，不写入存储。

## 存储与兼容

设置存放在 `namespace(String(run.identity.userId), run.identity.profile)` 的 settings 键中，
当前格式版本为 1。记录不存在时返回 `{ greeting: 'Hello', compact: false }`。
首次创建无历史记录需要迁移。增加字段时说明缺失值的默认行为；改变存储含义时在这里写清迁移方案，
同步修改实现及边界测试。
