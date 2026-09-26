# PR 0：JEV 旁路基础设施详细设计

状态：设计稿，尚未实现。日期：2026-09-26。以评审工作树 `15c1e8f9` 的现有实现和本轮修订的 `jev-group-chat-workflow.md` 为基础。

## 1. PR 目标与交付边界

提供可复用的服务端配置快照、每次请求前的权威复核、累计 deadline、完整请求大小校验、有限内存队列和有限诊断。后续摘要、工作流质量与路由只能通过这条有约束的路径调用 provider。

PR 0 不接入群聊/工作流业务，不增加业务开关、业务表、自动分派、摘要修订或 UI。现有 `evaluateJev` 手动 API/连接测试和 Ekko memory/skill 的运行快照语义保持不变。新基础设施没有已登记的生产 consumer 时，不创建后台轮询、不调 provider；测试使用假 adapter。

业务 PR 1/3/5 分别登记摘要、工作流质量、分派开关与控件；PR 2/6 增加修订和 auto 模式。PR 0 的验收不等于这些业务已实现。

## 2. 当前代码与拟议文件

现有 `services/jev/client.ts` 中 `evaluateJev()` 每次读取凭据并创建 SDK 客户端；已有重试关闭、redirect:error、错误脱敏和 caller signal，但没有多阶段不可变快照、业务累计 deadline 或旁路队列。`settings.ts` 已支持 Profile 隔离及合并保存。

以下路径均相对 `packages/server/src/modules/studio/`，新文件名是拟议名称：

| 文件 | 职责 |
| --- | --- |
| `services/jev/client.ts` | 保留现有公共行为；抽出内部单请求 transport，共用 SDK timeout/错误映射 |
| `services/jev/snapshot.ts` | 私有凭据快照、只读公开描述、配置匹配检查；不允许浏览器构造快照 |
| `services/jev/sidecar-contract.ts` | stage、结果、原因码、授权 adapter、不可伪造 handle 的内部类型 |
| `services/jev/sidecar.ts` | 门控快照创建、评估、结果应用；每次实际 provider dispatch 前复核 |
| `services/jev/sidecar-budget.ts` | 累计预算、abort 合并、本地 race、迟到 promise 清理 |
| `services/jev/sidecar-queue.ts` | 有界排队、Profile 轮转、在途去重、物理请求槽、停机处理 |
| `services/jev/sidecar-payload.ts` | 纯 JSON 检查、canonical hash、完整 UTF-8 请求限额、可信模板封装 |
| `public/jev.ts` | 保留旧导出，只新增受控旁路工厂/类型；不导出无门控的 secret transport |

可将很短的纯类型并回相邻文件，避免为抽象拆文件。不得在公共基础设施里包含“哪些节点可评估”“如何选 Agent”“如何写摘要”等业务判断，业务通过有明确身份与权威读取职责的 adapter 接入。

## 3. 对外内部接口草案

以下为 TypeScript 设计草图，不是现有 API，也不提供 HTTP 入口：

```ts
type Stage = 'evaluate' | 'revision_generate' | 'reevaluate' | 'apply'
type Outcome<T> =
  | { kind: 'completed'; value: T; diagnostic: SafeDiagnostic }
  | { kind: 'skipped'; reason: SkipReason; diagnostic: SafeDiagnostic }
  | { kind: 'cancelled'; reason: 'caller_cancelled'; diagnostic: SafeDiagnostic }

interface IdentityRef {
  actor: VerifiedActorRef             // server-verified; never display name/socket ID
  authority: ProfileAuthorityRef      // direct grant or explicit room-scoped grant
  profile: string
  object: SourceIdentityRef
}

interface SidecarAdapter {
  integrationId: RegisteredIntegrationId
  policyVersion: string
  maxJevCalls: number
  maxGenerationCalls: number
  eligibility(input: BoundedSourceSnapshot): EligibilityDecision // pure prefilter
  readAuthority(ref: IdentityRef, stage: Stage, signal: AbortSignal):
    Promise<AuthorityDecision>
  // Decisions come from authoritative repositories, not a queued allow boolean.
}

interface SidecarTaskSpec {
  integrationId: RegisteredIntegrationId
  identity: IdentityRef
  sourceKey: string
  attemptId: string
  createdAt: number
  parentDeadlineAt?: number
  signal?: AbortSignal
  input: BoundedSourceSnapshot
  run(ctx: SidecarTaskContext): Promise<void>
}

interface SidecarTaskContext {
  snapshot(): Promise<Outcome<JevSnapshotHandle>>
  evaluate(handle: JevSnapshotHandle, request: TrustedQuestionRequest):
    Promise<Outcome<ValidatedJevResult>>
  apply<T>(expected: ExpectedSource, commit: () => T): Promise<Outcome<T>>
  // Generation stage is enabled only by a future registered revision adapter.
}

interface JevSidecar {
  trySchedule(spec: SidecarTaskSpec): ScheduleReceipt   // synchronous, no throws/I/O
  cancel(scope: CancellationScope): void
  close(): void                                      // no wait for a hung provider
}
```

`ScheduleReceipt` 只报告 accepted、duplicate 或 skipped(reason)，不表示质量通过，也不表示底层副作用已完成。登记是可信启动代码和静态 harness 的职责，不接受 API 传入任意 adapter 或 callback。未注册 integration / 缺授权 adapter 一律拒绝排队，没有默认 allow。

eligibility 仅作有限、无 I/O 的原始资格筛选（例如节点快照状态、是否显式 @），不能提供执行许可。即使它返回 eligible，后续每个请求和应用仍必须执行 readAuthority；state 中的自报身份/状态不能被升级成权威记录。

`JevSnapshotHandle` 为任务绑定的 opaque handle；Key/URL 等私有字段只存在受控模块的内存映射中，不放在 enumerable 对象、receipt 或诊断里。跨任务、跨 Profile、已销毁的 handle 均无效。只读描述可含 integrationId、configHash、policyVersion、非敏感预算，不能把整个快照 JSON 化。

`run` 回调属于可信业务服务，禁止在评估 promise 的内部或其迟到 continuation 直接写存储；结果应用必须通过 `ctx.apply` 和业务 CAS/claim。PR 0 不把这点假装成 TypeScript 能自动保证的安全属性：harness 限定调用边界，业务测试验证超时后没有副作用。

## 4. 配置快照与实时许可

### 4.1 创建快照

worker 开始后，通过原 Profile 的 `readJevCredentials` 读取配置。adapter 确认 integration 对应开关/局部模式有效、actor 与 Profile authority 有效、对象身份存在后，形成快照。读取和验证均受累计预算约束。

冻结 model、baseUrl、provider timeout、业务预算/阈值、问题模板版本、configHash 和内存中的 API Key。configHash 按版本化 canonical JSON 生成，排除 Key 及其散列。缺 Key、关闭或读取失败直接返回 skipped，不能去取另一个 Profile 或 Agent 本地设置。

### 4.2 每次发请求的权威门控

快照是计算参数，不是授权凭证。首次评估、修订模型请求和复评分别执行以下顺序：

1. 检查任务未终止、signal 与剩余预算、stage 调用次数。
2. 校验并冻结完整请求 payload，取得该 Profile 和全局物理请求槽。
3. 在 **实际 dispatch 前** 重新读取权威 Profile 设置、当前集成开关和业务 adapter 的身份/对象/权限状态；读失败返回 skipped，不使用上次 allow。
4. 检查共享 Key/地址未被替换、Key 未清空；不匹配则 configuration_changed/not_configured，结束旧任务。阈值/模型仍用原快照；当前更短的 provider timeout 可收紧本次上限，不能扩大累计预算。
5. 再检查 signal/预算，然后立即调用 transport。此门控不在并发槽等待前完成一次就算结束。SDK fetch 包装器对每个真实外发请求执行门控，retry=0、redirect:error，禁止隐式新增请求绕过 stage 次数限制。

权威来源包括当前用户 active/role/Profile grant，房间或节点模式，原对象与来源 hash，适用的 App/room 授权引用。actor 与配置授权主体分开：房间可提供有边界的 Profile 授权，但不能拿房主身份代替原请求者。

失败原因区分 disabled、not_configured、settings_unavailable、authorization_unavailable、profile_access_revoked、requester_access_revoked、source_changed。基础设施不解析英文权限报错，adapter 返回有限原因码。失败时释放未使用的请求槽，零 provider 调用。

最后一次权威读取是请求的放行时点，跨文件/数据库的权限变化无法与远端网络发送合成一个事务；关闭/撤权事件尽力 abort 已在途调用，应用前再次权威复核并执行 CAS。保证“检查失败不发新请求、失效结果不落地”，不声称能撤回已经发送的数据。任何观察到取消的任务都是终态，重新开关不会复活它。

### 4.3 应用结果

`ctx.apply` 先拒绝 terminal/expired 任务，再执行 stage=apply 的权威复核，然后进入业务提供的**同步短事务**。事务内部重新校验消息/成员/权限投影 hash 或原有 generation/version；不得含网络/文件 await，也不得绕过权限和数据校验。

数据源属于外部配置文件的字段在进入事务前权威读取，DB 字段在事务内再读。commit 失败变为旁路 skipped，不抛回原业务；原操作在调度前已经成功，不能由旁路回滚。应用成功后不允许同一 attempt 再次应用。即使纯观察多实例重复，副作用唯一仍依靠业务仓储 CAS/claim，而非内存 handle。

PR 0 仅用 fake commit 验证这个顺序，摘要与路由的实际事务在各自业务 PR 实现。

## 5. 输入、可信模板与 hash

全部 state 属于不可信数据：用户要求、criteria 文本、摘要、工具结果、Agent 输出、职责描述都不提升为控制指令。`TrustedQuestionRequest` 由服务器固定问题模板和受限候选 ID 构造，问题只按稳定 rule ID 引用 state 中的用户标准。模板统一说明忽略 state 内要求改规则、泄露信息、调用工具或更换目标的指令。

先接受普通 JSON DTO，拒绝循环、非有限数值、访问器/自定义 toJSON 等会执行代码的对象；明确处理 undefined。对象键递归排序，业务有序数组保持原序；明确为集合的 ID 才排序去重。字符串不 trim、不改 Unicode，projection/schema 版本参与 hash。

将有效 model 写入完整 request 后序列化，`Buffer.byteLength(serialized, 'utf8') <= 64_000` 才发送；不能只量 state，也不能先删减中文/工具证据再获得可靠判断。请求不得偷偷覆盖 snapshot.model。序列化失败为 invalid_input，超限为 input_too_large，均零 provider 请求。

入队 input 的上限为 256 KiB，可信生产者负责提供仅含该上限内数据的 DTO 或稳定引用；队列先验证预算声明与形状，worker 进行完整有界遍历，不能接受闭包捕获无限转录来绕过队列上限。闭包只引用受限 spec/模块服务。极深或异常对象直接拒绝，输入预检查必须有限工作量。

`inputHash = sha256(canonical({projectionVersion, identity, assembledInput, upstreamEvidence, output, criteria, evidenceIdsAndContentHashes}))`。模型答案只能从请求中的有限 ID 中选择；schema、范围、缺答/多余非法目标及证据引用需全部通过，再交业务 adapter 解释。模型置信值不是授权，也不是实测准确率。

## 6. 累计预算与物理请求生命周期

### 6.1 计时规则

使用可注入的单调时钟测耗时；wall clock 只作展示 createdAt/finishedAt。带 parentDeadlineAt 时在接受任务时转换为剩余时间上界，并在出站/应用前检查父状态；不能通过墙钟回拨增加原预算。

入队尚未读取配置时，使用登记上限建立 admission ceiling：普通任务最多 30 秒，允许修订的任务最多 60 秒。取得配置后立刻收紧为从接受时刻计算的实际预算；排队和读取配置已经耗掉的时间不能重置。这个 ceiling 不是新增用户参数，也不拖住原业务。

普通任务从接受到结束全部计入配置的 JEV 预算。摘要多阶段任务维护两个不增加的余额：JEV 余额（排队、配置/授权读取、首次检查、复评、应用）和生成余额（最多 30 秒）。只有进入修订生成阶段后的槽等待、授权读取和生成调用计生成余额；其余时间计 JEV。整个任务仍不超过接受时间 + 已配置 JEV 预算 + 30 秒，且受父 deadline 截断。

每一步 provider timeout = min(该阶段余额、任务硬截止剩余、snapshot provider timeout、当前 provider timeout)。开始新阶段不会恢复余额。没有剩余预算即 deadline_exceeded；无自动重试。后续允许摘要最多 2 次 JEV + 1 次生成，工作流和分派各最多 1 次 JEV，次数由可信登记适配器声明，PR 0 仅测模板，不注册这些生产消费者。

### 6.2 两种资源寿命

本地 race 结束使**逻辑任务**按时 terminal；它立即移出可运行队列、取消 timers/listeners、禁止执行新阶段及 apply。底层 Promise 的 resolve/reject 都被消费，迟到响应不触发第二次终态通知。

**物理请求槽**直到真实 request settle 才释放。provider 忽略 abort 时可以耗尽增强槽，但不能在每次逻辑超时后释放物理槽再发无限请求。摘要生成同样遵守；逻辑任务销毁后仅保留处理底层 Promise 所需的最小引用，不持续保留完整转录。超时底层无法取消时，后续增强跳过/到期，主业务继续。

同一事件循环内同时发生 cancel、deadline 和响应时，只允许一次终态转换；用户取消优先分类，其他失败按首先观察到的事件记录。provider_timeout 是 transport 先报告超时，deadline_exceeded 是本地累计余额用尽，两者不从错误英文文本猜测。

## 7. 队列与临时状态

内存等待队列全局 64 / 每 Profile 16，JEV 物理在途全局 4 / 每 Profile 1，生成物理在途全局 1 / 每 Profile 1。按 Profile 轮转，不让一个 Profile 的大队列饿死其他 Profile。队列满立即 receipt=skipped(queue_full)，不阻塞原业务、不写业务错误。

准备/worker 物理在途同样限制为全局 4 / 每 Profile 1，覆盖读取配置和授权等尚未进入 provider 的异步工作。逻辑任务超时后若底层读取仍未 settle，占用的物理 worker 槽不能反复释放并创建更多挂起 I/O；只释放 UI/逻辑任务资源，保留有限清理句柄直到 settle。这样资源上限同时覆盖“provider 不返回”和“权威读取不返回”。所有这些槽都只属于增强队列，不占用主业务调度槽。

生命周期为 queued → preparing → evaluating → 可选 generating/reevaluating → applying → completed；任一前置阶段可终止为 skipped/cancelled。这些都是旁路私有状态，不能写进 workflow run/node 的业务 status。状态转换和业务质量 decision 是两个不同字段。

`trySchedule` 同步只做有限资格/大小与在途去重，返回 receipt 后由 worker 读取配置、生成 inputHash/configHash、读取已有终态记录。完成记录唯一性由后续仓储实现。没有持久任务队列，不承诺重启补执行、不承诺集群至多一次纯观察调用。

close() 拒绝新任务、取消 pending/逻辑在途任务，不等待挂起 provider；迟到 promise 仍有 rejection handler。原对象删除、权限撤回和关开关可主动 cancel(scope)，每次请求前权威复核保证遗漏本地通知时仍拒绝失效任务。

临时状态 DTO（PR 0 只定义，不增加 Socket/API）：

```ts
{
  attemptId, sourceKey, ownerInstanceId, ownerBootId,
  eventSeq, phase, expiresAt, maxAgeMs
}
```

ownerBootId 每次进程启动新建，eventSeq 在 attempt 内单调递增。只有仍活跃且权限匹配的 owner 可以确认当前 phase，默认通知有效期 5 秒，续期不能越过任务硬截止。读取另一个实例、断线或过期不能当作重启证据；UI 清除临时 spinner，显示未评估/状态不可用。完成以仓储终态为准，不根据 phase=applying 推断成功。

首版没有 `process_restarted` 任务原因码；没有任务日志就没有恢复后追认旧任务失败的依据。也不将临时通知过期等同于 deadline_exceeded。新结果、sourceKey 变更或更大 eventSeq 到达后，旧通知不得复活原任务。

## 8. 业务接入必须携带的约束

| 后续消费者 | 身份/来源要求 | PR 0 边界测试 |
| --- | --- | --- |
| 摘要检查 | 已成功提交 S0 的 generation/version/hash；房间授权配置主体与 summaryProfile | 首轮后关开关则生成/复评零请求；变更来源后 apply 不调用 |
| Workflow 观察 | 仅 completed node session；完整 run/nodeSession/execution/iteration 身份、运行所属 Profile 的授权主体 | failed/canceled/blocked/approval_rejected 等 adapter 明确拒绝；完整矩阵在 PR 3 |
| 群聊 auto | 持久的原请求者认证 ID、member PK/userId、messageHash、授权引用和房间 Profile 授权 | 删除/禁用原请求者时门控拒绝；不允许凭 display name、worker 或房主补身份 |

消息、职责和权限依照总规划 4.5 的明确投影进行事务内 hash，不使用 timestamp 假装 revision。PR 0 提供 canonical/hash 纯函数及顺序测试，不修改这些业务表。auto 的持久身份上下文在 PR 6 落地，在可靠身份缺失时应跳过 auto，原 @ 业务仍可用。

取消/应用规则由消费者提供声明而非 JEV 决定。Adapter 不能把读取失败转换为 allow，不能把缺失 actor 替换为系统管理员；保存 configHash 或持有 snapshot handle 均不证明当前仍获授权。

## 9. 诊断与 harness

沿用总规划的原因码集合；只记录 integration/object IDs、hash、字节数/规则/候选数量、有限决定、阶段与耗时。PR 0 增加 authorityStage 区分请求前/应用前的拒绝，不能记录 Key、配置对象、原 state、provider 原始响应或完整错误文本。observer 抛错吸收，统计写失败不能引发主业务失败。

scripts/jev-harness.mjs 对新 snapshot/budget/queue 纯基础设施窄登记；只有实际调用 transport 的公共旁路文件可增加 evaluationInfrastructure 资格。不能把整个 services/jev 目录豁免；SDK 实例仍集中在 client.ts。

扫描器识别新旁路工厂/trySchedule/context evaluate 的业务入口及静态 integrationId，业务必须有独立开关、前端、参数和测试。新增负向 fixture：伪装基础设施的 consumer、未登记调用、可缺省的授权 adapter、遗漏每次请求门控的路径。AST 检查不证明完整数据流，运行时故障测试仍是必需项。

现有 registry 的 memory/skills、设置 API、所有本地默认值不变化。旧 `evaluateJev` 手动 API 行为保持，重构共用 transport 后用既有 tests/server/jev.test.ts 验证请求结构、超时、取消、错误脱敏和 Profile 隔离。

## 10. PR 内实施顺序与测试

| 步骤 | 改动 | 核心断言 |
| --- | --- | --- |
| 1 | 类型/原因码、纯 payload/canonical/hash | 中文按 UTF-8 字节；完整 request 超限零调用；排序稳定，有序数组不变；不执行恶意 toJSON/getter |
| 2 | 私有快照与共用 transport | snapshot 无凭据序列化；关闭/缺 Key/读取失败零请求；跨 Profile/任务 handle 不可用；旧 API 不回归 |
| 3 | deadline/race 和 stage 门控 | 每次实际出站后置于新授权读取；等待槽期间撤权、初评后关开关、凭据轮换、授权读取失败均零后续调用 |
| 4 | 内存队列、公平性、物理槽 | queue cap/per-Profile cap 生效；挂起 provider 不释放物理槽引发无限新增；逻辑取消不等待挂起请求 |
| 5 | apply、临时状态、diagnostic | 迟到 resolve/reject 不执行 commit；一次终态；旧 source/attempt/eventSeq 不覆盖；断线不产生 process_restarted |
| 6 | facade/harness 和回归 | 未登记业务无法接入；无生产消费者就零后台活动；已有 JEV API 与 memory/skill 测试通过 |

新增测试建议：`tests/server/jev-sidecar.test.ts`（流程/隔离）、`jev-sidecar-budget.test.ts`、`jev-sidecar-queue.test.ts`、`jev-sidecar-payload.test.ts`；可按实际复杂度合并。使用 fake clock、可控挂起 provider、可变权威仓储 fixture，不接真实 Key、不做真实 Agent 执行。

必须覆盖下列交错：

- 排队时开关开，取得槽前关闭；首次检查通过后撤权，修订和复评均不发生。
- sourceHash/授权投影在捕获后变化，门控或 apply 拒绝；同显示名换 member PK 不能重用身份。
- provider 超时后才 resolve 或 reject；observer 抛错；cancel 与正常返回同一 tick；阶段额度用完不发送下一次。
- 读取配置/授权挂起也受本地预算限制；不允许排队时间结束后重新开始一份完整预算。
- 不支持的终态 fixture 在排队前被业务 adapter 拒绝，拒绝不产生 provider 请求或业务写入。
- ownerBootId 改变、消息丢失、跨实例查询未命中时没有伪造完成/失败记录；状态过期清除 spinner。
- 纯观察重复完成由 fake 唯一仓储去重；自动副作用必须提供 CAS，不能以“本进程去重”替代。

迭代运行针对性测试与 tests/server/jev-harness.test.ts。提交前按共享基础设施变更执行 `npm run harness:check`、`npm run test:coverage`、`npm run test:e2e`、`npm run build`；原 JEV 设置 e2e 验证未新增不可用控件且旧保存流程保持。当前设计交付只跑文档检查，未来实现验收另行记录。

## 11. PR 0 完成定义

只有基础设施已实现、测试证明“权威门控/预算/资源/迟到结果”成立、旧业务测试未回归，且生产环境无额外 provider 请求，才算 PR 0 完成。权威业务 adapter、摘要/工作流仓储和 auto 事务不在此 PR 假装完成；后续每个消费者必须实现总规划中对应的领域契约后才能启用。

## 12. 编码前接口收敛补充

实现采用以下更窄契约，避免后续业务依赖隐式约定：

- adapter 的 `parsePolicy(settings)` 从同一次私有设置读取中解析 enabled、累计预算和无敏感策略；基础设施统一生成 configHash，业务不读取或返回 Key。
- `readAuthority(ref, expected, stage, signal)` 每次都显式接收 source/authorization/candidate 等预期 hash，不能只证明对象仍存在。
- 结果应用使用静态注册 adapter 的同步 `apply(ref, expected, request)` port；运行时拒绝 thenable，异常脱敏为旁路写入失败，不接受任意业务 commit callback 作为安全边界。
- fatal skip/cancel 会锁定任务终态，后续 snapshot/evaluate/apply 返回同一结果；任务结束、取消、deadline、配置变化或 callback 返回时销毁 opaque handle 的 secret 映射。
- 私有 handle 在内存中保留 credential identity 以检测轮换，但 Key 及其 hash 均不进入 configHash、诊断或持久数据。
- sidecar 暴露有限 `status()` 计数用于测试和生命周期观测，不暴露队列内容、输入或 secret。
