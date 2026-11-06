# StackChan 当前固件接口（2.9.1-voice.3）

日期：2026-11-05。本文描述**已经在实机上运行**的固件对外接口，供后续 Studio BOT/Agent 对接使用。它与 [设备动作接口规划](DEVICE-CONTROL.md)、[实时语音规划](VOICE-INTERACTION.md) 是“现状 ↔ 目标”的关系：规划中的方法目录、能力协商、执行回执与取消，本固件已有雏形但字段名和语义尚未按规划统一，差异见文末。

## 1. 组成与数据流

```
设备麦克风 ─ 能量门限 + 浊音检测断句 ─ WAV 上传 ─┐
                                              Studio（runtime=hermes，profile=stackchan）
                                              ├─ STT（豆包等，由 Profile 配置）
                                              ├─ Agent（模型由会话/Profile 决定）
                                              │    └─ MCP：bridge/pulse_mcp.py ──HTTP──> 设备 /api/control 等
                                              └─ TTS → ADPCM(HADP) ─> 设备下载播放
设备 ─ Socket.IO ─ Studio：会话阶段、转写、回复文字、音频 URL、播放事件回报
```

- **语音链路**：设备 ↔ Studio 的 MCU 语音通道（设备 JWT + Socket.IO 命名空间），由 Studio 现有 MCU 语音服务处理，不经过 MCP。
- **控制链路**：Agent 通过 MCP 工具调用 `bridge/pulse_mcp.py`，后者用局域网控制令牌直连设备 HTTP 接口。BOT 对接时可以复用这个 MCP 服务，也可以直接按第 3 节调用设备 HTTP 接口。

## 2. 配对、授权与凭据

| 凭据 | 用途 | 来源 | 注意 |
| --- | --- | --- | --- |
| 设备 JWT | 设备连接 Studio 语音通道 | 设备设置页输入 Studio 授权码换取，存设备 NVS | 不能放进源码或日志 |
| 局域网控制令牌 `control_token` | `Authorization: Bearer` 调用设备 HTTP 控制接口 | 受信 USB 串口 `{"op":"pairing"}` 读出 | 宿主必须私有保存（MCP 桥要求文件权限 `0600`） |
| 设置 PIN | 设备设置页 `X-Pulse-Setup` | 设备屏幕显示，配置窗口限时开放 | 5 次错误锁定 30 秒 |

MCP 桥从 `PULSE_CONNECTION_FILE`（默认 `~/.hermes/profiles/stackchan/pulse-connection.json`）读取：

```json
{ "endpoint": "http://<设备IP>", "control_token": "<来自 USB pairing>" }
```

**Agent 授权开关（agent gate）**：设备只有在用户明确开启后才会上传录音、进入 Agent 流程。voice.1 起，用户开启过的授权保存在 NVS，重启后保持；修改服务器地址、切换 runtime、清除授权时同时作废。开启方式：设置页“开启语音”，或 USB 串口 `{"op":"agent_gate","enabled":true}`，或设置页接口 `POST /api/setup/agent`。

## 3. 设备 HTTP 接口

全部只在可信局域网使用，未做公网加固。除标注外均需 `Authorization: Bearer <control_token>`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/status` | 连接、会话、语音与跟随状态；也接受设置 PIN |
| `GET /api/capabilities` | 能力目录：表情、动作、素材、特性开关、限制值 |
| `POST /api/control` | 表达与停止（见 3.1） |
| `POST /api/notify` | Studio 任务提醒推送（`task_done`/`task_failed`/`reminder`/`praise`，限速 20 次/分钟） |
| `POST`/`GET /api/face/sample` | 当前锁定人脸 112×112 JPEG 与五点，供宿主侧表情估计 |
| `POST`/`GET /api/camera/frame` | 按需单帧 320×240 JPEG（POST 取 requestId，GET 带 `Accept: image/jpeg` 取图，最长 5 秒） |
| `POST /api/voice/wake`、`/api/voice/stop` | 开始/停止监听（需设置 PIN，不接受控制令牌） |
| `POST /api/setup/wifi`、`/studio`、`/authorize`、`/agent` | 设置页使用，需设置 PIN |

### 3.1 `/api/control`

停止：

```json
{ "method": "stop" }
```

表达（`method` 省略时即 `express`）：

```json
{
  "commandId": "唯一ID，≤64字节",
  "bootId": "来自 /api/status，设备重启后旧命令被拒绝(409)",
  "emotionId": "02",
  "actionId": "nod",
  "soundId": "home_joy",
  "intensity": 0.9,
  "durationMs": 3000,
  "ttlMs": 5000,
  "actionTiming": "now | speech_start",
  "soundTiming": "after_speech | when_quiet",
  "soundGain": 0.3,
  "visualOnlyWhenListening": false
}
```

- `emotionId`/`actionId`/`soundId` 至少一个，取值必须在 `/api/capabilities` 中；当前 32 种表情、40 余个动作（含 `look_left`/`look_right`/`look_up`/`look_down`）、37 个素材，确切列表以设备返回为准。
- `ttlMs` 1–30000；`durationMs` 上限 30000；`soundGain` 上限 0.6。
- 录音进行中拒绝新的表情/动作（409 `recording_window_changed`），保证不打断用户说话。
- 返回 `accepted` 只表示设备接受排程，不代表动作已完成或声音已响。

## 4. MCP 工具（`bridge/pulse_mcp.py`）

`PULSE_MCP_TOOLSET=voice`（默认）暴露 7 个工具，`notify` 另有 1 个：

| 工具 | 说明 |
| --- | --- |
| `capabilities` | 读取能力目录 |
| `status` | 读取设备状态（只读，不采图） |
| `set_emotion` | 显式表情，默认 intensity 0.9 / 15 秒 |
| `play_action` | 显式动作或素材音效（含四方向看） |
| `respond_to_emotion` | 传入 LLM 对用户情绪的语义判断（6 类 + intent），由编排器选表情/动作/音效，带冷却与去重 |
| `look_at_camera` | 按需看一帧并返回文字观察；仅在所有者另行授权 `PULSE_SCENE_*` 后才把图片发给视觉服务 |
| `stop` | 停止当前交互与监听 |
| `notify_user`（notify 工具集） | 向设备推送任务提醒 |

配套人设 `bridge/stackchan-persona.md` 约束了工具使用方式（例如普通聊天每轮最多一次 `respond_to_emotion`、不把接收回执说成已完成）。Profile 应只开放这组工具，其他 Hermes 工具集保持禁用。

## 5. 设备端交互（voice.3）

- **开机自动开始听**：开机 3 分钟内 Studio 就绪且已授权时自动进入监听。
- **摸头唤醒**：未在听时轻拍头顶开始监听；屏幕右上角隐形区域可手动开/关。
- **自动结束**：说“再见”类短句、长时间不说话、连续 3 次没听清会停止监听。
- **断句**：能量门限 + 浊音（低过零率）检测；有效发声 < 300 ms 或浊音 < 100 ms 的片段本地丢弃，不上传。
- **半双工**：播放回复时不收音，没有 AEC、语音打断和唤醒词。
- **串口诊断**：`voice status`、`voice wake`、`voice stop`、`help`；每 10 秒输出 `[pulse]` 帧率/内存与 `[render]` 分段耗时。

## 6. 与规划的差距

| 规划项 | 当前固件 |
| --- | --- |
| ESP-IDF + LVGL | Arduino（PlatformIO espressif32 6.9.0）+ M5Unified，自绘表情引擎 |
| 持续监听 + AEC/VAD + 语音打断 | 半双工能量/浊音门限，无 AEC，不能语音打断 |
| Opus 流式上传 | 整段 16 kHz PCM WAV 上传；回复为 HADP/IMA ADPCM 整段下载 |
| 统一方法目录与能力协商 | `/api/capabilities` + `/api/control`，字段为 camelCase，未按 DEVICE-CONTROL 的方法名统一 |
| 执行回执与取消 | `commandId`/`bootId`/`ttlMs` 防重放与过期；`stop` 使用代次屏障取消；没有逐命令完成回执 |
| BLE 配网 | 设备 AP 热点 + 设置页 |
| 板型独立 OTA 与回滚 | 未实现，仅 USB 手动刷写 |
