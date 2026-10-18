# Ekko 聊天任务计划

状态：首期已实现，2026-09-08。范围为 Studio 中 Ekko 聊天的计划工具、快照入库、工具调用记录、实时任务卡片及历史恢复。

## 目标与界面

Ekko 在处理多步骤任务时维护一份有序计划。创建计划、开始步骤、完成步骤或修改计划时，发布结构化事件，Studio 显示同一张任务卡片的最新状态。

```text
任务计划                                 1 / 3 已完成
✓ 查看现有实现                              已完成
◉ 增加事件和状态存储                         进行中
○ 验证刷新后的显示                           未完成
```

任务卡片放在聊天消息流中，默认展开；用户可以折叠。每个计划只显示一张卡片，更新时不重复追加。完成后保留卡片与完成数量。状态同时使用图标和文字，不能只靠颜色区别。

首期范围是 Ekko 单聊的步骤进度跟踪。步骤由 agent 依照正常工具执行流程完成；计划本身不负责调度或启动任务。现有消息队列、Hermes Kanban、定时任务保持各自的数据与行为。用户的“触发 event”在这里解释为更新计划后推送显示事件；外部事件自动启动工作流属于独立的调度需求。

## 现有代码与接入点

实际修改目标是 `studio/packages/ekko-agent`，这是仓库声明的 canonical runtime；上级目录中另一个 `ekko-agent` 不作为本方案实现位置。

| 层 | 当前文件 | 计划变更 |
| --- | --- | --- |
| 内置工具 | `packages/ekko-agent/src/tools/registry.ts` | 注册 `update_plan` 工具；新增 `tools/plan.ts` 处理校验与更新 |
| 工具上下文 | `packages/ekko-agent/src/tools/types.ts` | 增加当前 run 的计划更新能力，避免把状态放在共享工具实例里 |
| Runtime | `packages/ekko-agent/src/runtime/runtime.ts`、`events.ts` | 保存 run 内计划快照，发出 `plan.updated`，终止时处理尚未完成的步骤 |
| 提示词 | `packages/ekko-agent/src/runtime/system-prompt.ts` | 工具可用时注入使用规则：多步骤任务建立计划，开始和完成时及时更新 |
| Studio 适配 | `packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run.ts` | 接收计划事件，完成持久化后通过现有 emit 通道广播 |
| 持久化 | `packages/server/src/modules/studio/repositories/` | 新增计划快照 repository，通过既有数据库迁移机制建表 |
| 会话恢复 | `packages/server/src/modules/studio/sockets/chat-run.ts` 及会话历史响应 | 返回计划快照，覆盖重连、运行结束、服务重启后的恢复 |
| 客户端传输 | `packages/client/src/api/studio/chat.ts` | 定义事件和快照类型，注册 `plan.updated` 监听并按 session 分发 |
| 客户端状态 | `packages/client/src/stores/hermes/chat.ts` | 按 session、plan ID 保存快照，统一处理实时事件、恢复快照和历史加载 |
| 显示 | `packages/client/src/components/hermes/chat/` | 新增 `TaskPlanCard.vue`，接入实时和历史消息列表；补齐所有语言文案 |

当前 runtime 已定义 `tool.started`、`tool.completed`、`subagent.*` 和 run 生命周期事件，尚未定义步骤计划事件。Studio 已有 Socket.IO 转发与恢复机制。

特别注意：`handle-ekko-agent-run.ts` 中的临时事件缓冲最多保留 200 条，且在运行结束时清空。因此不能把该缓冲作为计划的唯一数据源。当前工具消息会持久化，但工具调用以完整工具组写入；计划快照应独立保存，避免同组其他工具尚未结束时刷新丢失已展示的计划。

## 工具与事件协议

工具名称为 `update_plan`。首期一个 run 对应一份计划，`plan_id` 由 runtime 使用当前 run ID 确定；后续更新同一份计划。跨 run 的用户“继续”请求可以根据历史建立新计划，旧计划保留。跨 run 原地续办暂不承诺。

模型提交完整步骤列表，不提交数据库 ID、版本或 session ID：

```json
{
  "explanation": "接口已完成，开始做界面",
  "plan": [
    { "id": "inspect", "step": "查看现有实现", "status": "completed" },
    { "id": "implement", "step": "增加事件和状态存储", "status": "in_progress" },
    { "id": "verify", "step": "验证刷新后的显示", "status": "pending" }
  ]
}
```

服务端对外发送完整快照。字段命名沿用聊天事件的 snake_case：

```json
{
  "event": "plan.updated",
  "session_id": "session-example",
  "run_id": "run-example",
  "plan_id": "run-example",
  "revision": 2,
  "execution_state": "running",
  "explanation": "接口已完成，开始做界面",
  "plan": [
    { "id": "inspect", "step": "查看现有实现", "status": "completed" },
    { "id": "implement", "step": "增加事件和状态存储", "status": "in_progress" },
    { "id": "verify", "step": "验证刷新后的显示", "status": "pending" }
  ],
  "updated_at": 1788832800000
}
```

Runtime 内部事件沿用既有 camelCase，再由 Studio 转为传输字段。`revision` 单调递增，由 runtime 管理；客户端只接受比本地更新的版本，忽略重复或乱序的旧版本。完成数直接从 `completed` 步骤数量计算。

## 更新规则

- `pending` 显示“未完成”，`in_progress` 显示“进行中”，`completed` 显示“已完成”。
- 步骤 ID 非空且唯一，标题非空，最多 30 个步骤、每个标题最多 200 字符、说明最多 1000 字符。至多一个步骤为 `in_progress`；agent 可在当前步骤内部执行多个工具。
- 更新工具按串行工具执行。无效输入返回工具错误，不更新快照、不发布成功事件。
- 只有 agent 明确更新为 `completed` 才勾选完成；单次工具成功、回复结束或子 agent 返回均不能自动勾选全部步骤。
- agent 可增加、删除、调整顺序或重新打开步骤。相同步骤保持 ID；改动范围或撤回完成标记时填写说明。完整快照代表当前完整计划。
- `execution_state` 与步骤状态分开：`running`、`ended`、`interrupted`、`failed`。全部步骤是否完成从列表推导，不能把 `ended` 当作任务全部完成。
- 运行结束、失败或用户停止时，已完成的步骤保持完成，将还在 `in_progress` 的步骤恢复为 `pending`，保留其他未完成步骤，并注明运行结束或中断原因。终止更新也递增版本、持久化并广播。
- 服务重启后，只有在确认所属 run 已无法恢复执行时，才把残留的 `running` 快照标记为 `interrupted`，避免恢复后一直显示进行中。
- 首期子 agent 的计划不合并进主计划。主 agent 根据收到的实际结果更新主计划，避免子任务使用自己的步骤覆盖主任务。

## 存储与恢复

Studio 保存最新快照，使用 `(session_id, plan_id)` 唯一键，保存 run ID、revision、执行状态、步骤 JSON、说明、创建时间和更新时间。使用现有 Studio 数据库中的 `task_plans` 表，不写入 Ekko 源码目录或用户的任务工作区。

同一个计划更新采用事务和版本比较，数据库更新成功后再发布对外事件。持久化失败时不得向客户端声称快照已可靠保存，应走明确的失败处理；实现使用同步 SQLite 写入：`AgentRuntimeRunInput.onPlanUpdate` 提交快照成功后，runtime 才发布 `plan.updated`。提交失败会返回工具错误，不发布成功更新。

历史工具调用继续走原有消息存储，保留模型理解计划变更所需的上下文；计划快照用于界面恢复。无需首期实现专门的变更历史界面。

Resume 响应包含当前运行的计划，以及当前消息页所涉及 run 的计划。历史分页响应随页附带关联计划，不能依赖最新 150 条消息中恰好包含计划工具调用。客户端按 plan ID 合并，避免 Socket 重放和历史读取生成重复卡片。

删除会话时一并删除其计划记录。聊天中的普通工具折叠、隐藏工具轨迹设置不能隐藏任务卡片。

## 实施顺序与验收

1. 增加工具、输入校验、run 内计划状态和 runtime 事件；验证连续更新、非法输入、run 之间隔离和子 agent 隔离。
2. 增加 Studio repository、迁移、事件适配和终止处理；验证写入失败、重启恢复、不同 session 隔离及完成标记不被误改。
3. 接入客户端传输、store、resume 和历史加载；验证重复事件、乱序事件、刷新、多标签页、运行结束后的计划恢复。
4. 增加任务卡片和多语言文案，用 mock API/Socket 的浏览器测试检查 0/3 → 1/3 → 3/3、停止后未完成、折叠、长标题、历史分页及隐藏工具轨迹时的显示。
5. 运行相关 Ekko runtime、Studio chat、客户端 store 测试与聊天浏览器测试，再执行 `npm run harness:check` 和 `npm run build`。协议或公共 Ekko 类型变更同步更新包内 API 文档。

验收的核心是：每次有效更新后，同一份计划即时显示准确状态；刷新或重开会话后状态一致；任务未完成时绝不因为运行结束而显示全部完成。

## 实现补充

- 一份计划保存一行最新快照，正常工具调用及返回结果继续通过现有消息持久化链路保存。
- `taskPlans` 随 Socket resume 与聊天历史分页响应返回；最新页还附带最近一份计划，覆盖计划已提交但工具组消息尚未保存的窗口。
- 取消信号立即提交 `interrupted`，在聊天流关闭前广播未完成状态。进程启动时，在建表之后恢复上次进程遗留的 running 计划。
- `TaskPlanCard.vue` 同时用于聊天与历史界面，独立于工具轨迹的显示开关；所有 11 个语言文件均已添加文案。
- 当前完成标记由 AI 主动调用工具维护，用户不能通过任务卡片手动修改；新一轮任务创建新的计划，历史计划保留。
- 聊天与历史界面将计划卡片显示在所属轮次的消息末尾；新输出到来时卡片随之移动，不依赖再次调用计划工具。优先按 run ID 定位，缺少标记的旧历史按创建时间及用户/命令边界定位。仅调整显示顺序，不改变原始消息、时间戳或快照缓存。

## 验证结果

- 构建与 `npm run harness:check` 通过。
- 任务计划专项及聊天适配器：49 项测试通过；另检查了现有 runtime、工具注册、会话存储与客户端聊天逻辑。
- 任务计划、历史恢复和下载页浏览器复验：11 项通过；此前完整浏览器回归 175 项通过，下载页单项复验通过。
- `PORT=8648 npm run test:coverage -- --maxWorkers=4`：5119 项通过，44 项失败，6 项跳过。将这 44 个失败与未修改的 HEAD 隔离检出逐项比较，失败名称完全一致，没有新增失败。
- 浏览器使用模拟模型事件与 API；未调用真实模型供应商或修改用户聊天数据。
