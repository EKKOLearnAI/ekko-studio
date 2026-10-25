# 剩余 Agent 插件并行迁移

用户在 2026-10-25 要求每个剩余 Agent 由一个专属子 agent 实施。主线程负责共享 SDK/driver、构建与随包注册、UI/CI、集成验证和提交。并发额度为主线程加三个子 agent，按空闲槽位滚动启动；不把排队任务记为已启动。

| Agent | 专属子 agent | 当前交付状态 |
| --- | --- | --- |
| Pi | `/root/pi` | 28 项 worker、真实 compact/Skill/私有 CLI 安装已交付，主线程已集成提交 `0d93d39c3` |
| Claude Code | `/root/claude_code` | 25 项含清理故障的 worker、真实 10 轮/12 请求/2 MCP 随 `969ce5f09` 集成 |
| DSH | `/root/dsh` | 随 `969ce5f09` 集成；真实扩大矩阵 14 轮/19 请求/5 Studio MCP；CRLF 修复后固定 CLI 17 项和 `517912311` 三平台 worker CI 通过；专属管理与占用事件仍开放 |
| ZCode | `/root/zcode` | 随 `969ce5f09` 集成；目录别名修复后 63 项含实际 CLI 和 `517912311` 三平台 worker CI 通过；原生 MCP 限制保留 |
| Antigravity | `/root/antigravity` | 随 `969ce5f09` 集成；双版本运行/图片/恢复已有证据，路径/ACL 修复 39 项通过；`517912311` 实际 Windows ACL 与三平台 worker CI 通过，无账户 MCP 仍开放 |
| Grok | `/root/grok` | 随 `969ce5f09` 集成；实际安装、原生图片/MCP/资源/恢复通过，扩大矩阵最终重跑出现 cancelled/unknown 用量，仍开放 |
| Cursor | `/root/cursor` | 22 项 worker/46 项含旧回归及官方 CLI 认证失败边界随 `969ce5f09` 集成；真实账号推理未验收 |

子 agent 独占各自 `plugins/<agent>/`、专属 worker 测试、fixture/验证脚本及证据文件；共享文件由主线程修改，避免覆盖。子 agent 不提交、不推送、不调用 Studio 会话或交互工具，也不继续转派。

每项交付必须包含原生能力清单、global/scoped 配置与账号边界、成功/失败/取消和恢复、图片/MCP/Skills/命令的实际支持、管理/资源语义以及验证日志。插件只使用公共 SDK/driver，不调用旧宿主厂商 runner。模拟 worker、本地模型、真实 CLI 和真实账号验收分别记录；已有独立包和通过测试不能替代完整迁移验收，当前仍为 **0/14**。
