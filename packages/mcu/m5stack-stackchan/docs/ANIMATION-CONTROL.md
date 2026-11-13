# StackChan 动画控制方法设计

日期：2026-10-26。状态：接口设计草案，播放器与素材均未实现或验收。关联 [整机规划](ROADMAP.md) 与 [统一设备控制契约](DEVICE-CONTROL.md)。

固件提供独立的 AnimationService，管理本地动画目录、播放实例和默认状态表现。后续 Studio Agent 通过 MCP 查询并调用这些方法；Agent 下发动画 ID 和播放参数，单片机负责本地解码、调度和渲染。当前只定义接口，角色与动画素材制作继续暂停。

## 职责与控制链路

Studio 专用 Agent → Studio 动画 MCP 工具 → 统一设备控制服务 → 固件 DeviceControl → AnimationService → DisplayService/LVGL。

AnimationService 与 MotionService 并列：动画控制屏幕角色，动作控制舵机；两者共享请求、交互归属、优先级和取消规则。Agent 可组合点头与高兴动画，但多次工具调用不保证同时开始；需要精确同步时再设计本地组合调度。

本地状态机驱动默认动画，Agent 可请求临时播放其他动画。实际网络、监听、录音和播放状态仍由固件维护，不能通过选择一张“睡觉”或“说话”的动画改变麦克风或电源状态。

## 动画方法候选

名称与参数在正式实现前冻结，当前不是已发布接口。通用 requestId、commandId、bootId、交互代次、有效期和回执沿用统一设备契约。

| 固件方法 | 参数候选 | 结果与语义 |
| --- | --- | --- |
| `animation.list` | 可选 characterId、state，分页游标与条数 | 返回已安装且验证可用的动画、支持参数与素材版本；不把计划中的素材列为可播放 |
| `animation.get_state` | 无写入参数 | 当前动画/commandId、所属角色与交互、播放进度、循环次数、默认状态和最近失败原因 |
| `animation.play` | animationId、可选 characterId、repeat、durationMs、speedPct、queueMode | 校验后创建播放实例，返回 commandId；参数支持范围由能力表与动画元数据声明 |
| `animation.stop` | 可选 commandId，省略时仅作用于调用方获准范围 | 终止对应实例/队列项，返回取消结果，随后按当前真实状态选择默认表现 |
| `animation.set_default` | state、animationId、可选 characterId | 设置当前连接/交互范围内的默认动画映射；不改变状态机，也不持续写 NVS |
| `animation.restore_default` | 当前交互归属，可选目标 commandId | 释放当前临时动画覆盖，恢复当前真实交互状态对应的默认表现；不撤销有效的默认映射 |

`animation.play` 默认播放一次。repeat 必须为正整数且有上限；durationMs 可进一步限制总播放时长，两者同时指定时以先到者结束。queueMode 明确采用替换或有界排队；不支持的加速、参数或素材明确拒绝。Agent 发起的循环必须有限，持续循环的待机动画由本地默认状态管理。

`animation.set_default` 只接受开放的角色表现状态，不改写网络故障、麦克风开关等系统提示。交互打断撤销旧交互拥有的临时默认映射，连接断开或设备重启后恢复设备本地配置。需要长期保存的角色偏好后续通过明确的设置流程管理。

停止与恢复只释放调用方拥有的动画，不移除系统提示。停止的实例报告 cancelled；恢复默认成功表示完成了控制权切换，不表示默认循环已经播放完毕。

## 动画目录与素材契约

| 信息 | 用途 |
| --- | --- |
| characterId / characterVersion | 角色及兼容版本，避免不同角色的素材混用 |
| animationId / assetVersion | 稳定的逻辑标识与资源版本；Agent 不依赖本地文件路径 |
| semanticStates / tags | 适用状态与表现标签，用于选择素材；不是实际交互状态来源 |
| dimensions / format / frameCount | 尺寸、容器/编码和帧数量，供设备检查可解码性 |
| durationMs / frameTiming | 单轮长度与逐帧时序，支持固定或可变帧时长 |
| playbackLimits | 循环、时长、速度与队列上限，以及可用的切换方式 |
| checksum / byteSize / availability | 完整性、容量与实际可用状态 |

动画 ID 可以按角色和语义命名，例如 `ekko.happy`；这只是命名示意，不表示已有对应素材。具体帧序列/容器、解码方式和画质在存储、PSRAM 与音频并发测试后选择，不预先假定某一种动画格式已可用。

`animation.list` 支持分页；设备只返回必要元数据。Agent 根据枚举结果选择 ID，不能凭空拼接资源名或传任意文件路径、URL、图片字节与逐帧数据。素材安装、更新和校验属于独立的资源管理流程，不在每次播放时触发下载。

没有动画素材时可保留方法描述，并标明当前不可播放；查询返回实际空目录，播放请求返回 asset_unavailable。固件继续显示文字状态，不虚报动画播放成功。

## 播放调度与状态机

同一角色区域同一时刻由一个播放实例占用。系统连接/监听/故障提示使用受保护的界面层；默认状态动画和 Agent 临时动画由调度器管理，不能各自直接争抢 LVGL 控件。

| 事件 | 调度行为 |
| --- | --- |
| 没有临时动画 | 根据真实 waiting/listening/thinking/speaking 等状态选择有效默认映射；无素材则文字回退 |
| 收到播放请求 | 先校验素材和参数，再按 queueMode 接受、替换或返回 busy/queue_full；非法请求不打断当前有效播放 |
| 自然结束或达到请求的播放时长 | 报告 completed 与结束原因，释放实例，恢复当前状态默认表现或执行仍有效的队列项 |
| 用户停止、语音打断或交互代次变化 | 取消旧轮次实例、队列和临时映射，恢复新轮次的当前状态；不继续旧动画剩余循环 |
| 系统状态抢占角色区域 | 取消冲突的临时实例并报告 preempted 原因；独立系统提示始终可见 |
| 断线、重连、设备重启 | 释放旧连接的临时控制，恢复本地默认状态；不自动重放旧 Agent 动画 |
| 素材失效或运行中解码失败 | 报告 failed 与素材/解码原因，释放资源并回退到可用默认表现或文字状态 |

`display.set_state` 选择被允许的角色语义表现，交由同一个调度器处理；`animation.play` 选择具体素材并控制播放。两者都不修改真实交互状态，真实监听提示持续可辨。`animation.restore_default` 恢复的是此刻状态的默认表现：正在思考时恢复思考表现，不固定切回待机。

如后续做说话嘴型，时序跟随本机实际播放进度。停止语音后不得保留旧轮次的说话动画；仅播放 speaking 动画也不能报告音频已开始或已完成。

## 执行回执与资源预算

动画播放沿用 `accepted → running → completed / failed / cancelled`。running 在首个有效画面提交渲染后报告，completed 在最后一帧按时序完成或请求的播放时长到达后报告；入队时只回 accepted。需要严格面板显示确认时另测驱动行为，不把渲染提交等同于硬件可见的精确时间。

回执包含 animationId、素材版本、当前 commandId、交互归属与结束原因。进度按低频事件或按需查询提供，不逐帧经 MCP 上报。同一个 requestId 重试返回原实例，不重播；`command.get/cancel` 同样适用于动画。

解码、帧缓存和播放队列都有容量上限；渲染使用单一 UI 上下文，不阻塞录音、AEC/VAD、播放和本地打断。超出并发预算时拒绝新播放或按声明策略降帧，不能通过暂停监听维持动画。解码失败、队列满和素材缺失分别返回原因，不使整个设备重启。

## Studio MCP 工具映射候选

| MCP 工具 | 固件方法 |
| --- | --- |
| `stackchan_list_animations` | `animation.list` |
| `stackchan_get_animation_state` | `animation.get_state` |
| `stackchan_play_animation` | `animation.play` |
| `stackchan_stop_animation` | `animation.stop` |
| `stackchan_set_default_animation` | `animation.set_default` |
| `stackchan_restore_default_animation` | `animation.restore_default` |

MCP 从认证上下文注入 deviceId 与交互代次，按统一设备契约处理参数、结果和取消。Agent 可查询动画目录，再发起播放；只有设备确认运行或结束后，才能分别报告已开始或已完成。上述工具沿用 [设备 MCP 设计](DEVICE-CONTROL.md)，不另建一套身份或取消机制。

## 实施阶段与验收

P2 定义方法、能力和回执契约，可用模拟适配验证无素材、非法参数、取消和默认回退。播放器与表现联动纳入 P4；素材仍需在恢复制作后逐组确认，未通过的素材不进入可用目录。Studio 专用 Agent/MCP 在后续阶段接入已有方法。

验收覆盖有限循环、定时结束、替换/排队、重复 requestId、停止、默认恢复、缺失/损坏素材、跨角色不兼容、断线和重启。语音打断与系统抢占后，旧轮次的动画不能恢复；真实麦克风和连接提示不能被遮蔽。与 AEC/VAD、Opus 和音频播放同时运行时，记录帧时序、内存和欠载，确认动画不会阻塞实时交互。

当前交付仅为设计文档，不生成动画、不编写播放器、不修改固件与 Studio 代码。
