# Ekko Agent 单一记忆系统

Ekko 只维护一种可操作的长期记忆：`memory_nodes` 中的记忆卡片。不存在独立的审批队列、
后台记忆评审或隐藏的 Session 摘要。`memory_messages` 只保存受信任的对话证据，供来源追溯，
不会形成另一套记忆。

## 运行链路

```text
Ekko Agent turn
  -> 保存当前用户消息证据
  -> 按宿主授权的 scope 检索 active memory_nodes
  -> 可选 JEV 分类补充与候选重排（默认关闭，失败使用原结果）
  -> 按原 token 预算注入相关记忆卡片
  -> 主模型调用 memory_search / memory_get / memory_write / memory_forget
  -> memory_write 可选 JEV 证据校验，随后原子提交；memory_forget 保持原规则
  -> 在当前 run 中直接生效
  -> run 完成后仅补录助手消息证据
```

任何记忆增删改都只有这条前台链路。工具失败时 Runtime 立即返回真实错误，不允许模型继续
声称操作成功。

## 增删改规则

- 创建时模型提交受控 `kind` 和可选 `itemKey`，服务端生成 canonical key。
- 相同 scope、相同 canonical key 最多只有一条 active 卡片。
- 同槽位同内容返回 noop；同槽位新内容建立下一 revision 并 supersede 旧版。
- 更新、过期和按 id 删除必须携带当前 `expectedRevision`，防止并发覆盖。
- `sourceMessageIds` 只能来自宿主提供的当前用户证据，模型不能伪造来源。
- soft delete 保留审计状态；hard delete 同时清理节点、FTS 和 embedding。
- 增删改直接写入 `memory_audit_events`，没有待审批状态。

## 检索规则

- 自动召回受 token budget 和宿主授权 scope 限制，不能视为完整记忆库。
- 已知类别优先使用结构化 `kinds`；开放问题使用 `queryText`。
- 枚举全部记忆使用 `memory_search({ all: true })`。中文“所有/全部记忆”和英文
  “all/every memories”等旧式 list-all 查询也会自动转成全量枚举，不做相关性过滤。
- 没有匹配结果时，Agent 不得据此宣称整个记忆库为空，除非执行过全量枚举。

JEV 的配置、运行隔离与回退约定见 [memory-jev.md](memory-jev.md)。

## 删除规则

- 用户明确要求忘记某条内容时，调用一次 `memory_forget` 精确删除。
- 用户明确要求清除全部记忆时，调用一次 `memory_forget({ all: true })`。
- “清掉、清除、清空、删除、忘掉”等表达都属于明确删除意图。
- 不再经过确认弹窗或审批任务；权限边界仍由当前用户意图和宿主授权 scope 保证。

## 数据库

数据库位于 `<baseDirectory>/.ekko/ekko.db`，记忆相关表为：

- `memory_messages`：受信任的用户/助手对话证据。
- `memory_nodes`：唯一的长期记忆卡片集合。
- `memory_audit_events`：创建、覆盖、过期和删除审计。
- `memory_embeddings`：语义检索数据。

memory schema version 8 会删除旧的 `memory_review_jobs`、`memory_summaries` 和
`memory_session_state` 表，但不会删除 `memory_nodes` 中现有的记忆卡片。

数据库迁移逐版本运行在 `BEGIN IMMEDIATE` 事务中。锁冲突最多尝试三次，每次受
`busy_timeout` 约束；仍被占用时直接阻止启动，不会在旧进程仍写入时重建。其他迁移错误
会先把原数据库及 WAL/SHM 移到带时间戳的备份，再创建新库，并按兼容列恢复记忆、证据、
审计和 Ekko 会话，随后重建 FTS。若新库本身也无法建立，则恢复原数据库并终止启动。
整个过程不会以禁用 Memory 或切换到临时空库作为降级方案。
