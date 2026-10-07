# 桌面截图跨平台适配方案

日期：2026-10-07

状态：实施方案，Windows 和 Linux 尚未完成实机验收。

建议先完成 Windows 和 Linux X11 的桌面浮层路径，再接入 Wayland 的系统截图路径。三个平台复用同一套框选、标注、裁剪和附件提交代码，分别处理画面采集、窗口展示和隐藏时序。

## 1. 用户体验与支持范围

保持已经确定的操作：

- 仅桌面端提供截图入口。
- 点击截图默认保留 Studio 窗口；旁边小箭头提供一次性的“隐藏窗口截屏”。
- 框选后使用矩形、圆形、箭头、画笔、文字、马赛克、撤销和重做工具。
- 完成按钮只显示一个勾，确认后图片加入当前输入框附件，不直接发送消息。
- Esc、右键和取消按钮结束截图；完成、取消和异常均恢复窗口。
- 第一阶段每次选择一个屏幕内的区域，支持在不同屏幕开始截图；跨屏拼接作为后续能力。

| 环境 | 计划采集方式 | 框选和编辑方式 | 验收后承诺的体验 |
| --- | --- | --- | --- |
| macOS | 现有 Electron 屏幕采集 | 每屏桌面浮层 | 保持现有操作，回归隐藏截图 |
| Windows | Electron `desktopCapturer` | 每屏桌面浮层 | 接近现有微信式框选体验 |
| 原生 Linux X11 | Electron 屏幕采集，确认实际后端 | 每屏桌面浮层 | 在验收过的桌面环境提供同样操作 |
| Linux Wayland | 优先 XDG Screenshot Portal | 系统选择区域或画面，再进入 Studio 图片编辑窗口 | 工具栏和附件流程一致，系统选择步骤可能不同 |
| Wayland 会话中的 Xwayland 应用 | 单独探测采集和窗口能力 | 只有验证通过才使用桌面浮层，否则走 Portal | 不因存在 `DISPLAY` 就宣称完整兼容 |

Wayland 的第一阶段目标是完成可靠的“截图 → 标注 → 附件”流程。系统是否弹出选择界面、是否直接支持区域选择，由 Portal 后端决定。应用内编辑窗口不需要铺在原桌面的准确位置。

## 2. 现状与已确认的问题

当前已有：

| 文件 | 当前职责 |
| --- | --- |
| `packages/client/src/components/hermes/chat/ScreenshotButton.vue` | 桌面入口、隐藏截图下拉项、附件回传 |
| `packages/desktop/src/main/screenshot.ts` | 请求生命周期、隐藏和恢复窗口、采集、可信 IPC 和 PNG 尺寸校验 |
| `packages/desktop/src/main/screenshot-windows.ts` | 按显示器缓存和预热编辑浮层 |
| `packages/desktop/src/main/screenshot-editor.ts` | 框选、标注、撤销重做和 PNG 裁剪 |
| `packages/desktop/src/main/screenshot-bitmap.ts` | 原生位图通道校准、透明度处理和像素尺寸恢复 |
| `packages/desktop/src/preload/screenshot-overlay.ts` | 隔离的编辑器 IPC 桥接 |

macOS 已进行真实 Electron 画面验证：隐藏前先设为透明，可消除原先隐藏动画进入截图的残影。这个结论不能直接推广到 Linux。

项目声明 Electron `^42.3.0`，本次检查实际安装版本为 `42.11.11`。该版本的 `setOpacity()` 在 Linux 上无效，`getOpacity()` 始终返回 1；Windows 和 macOS 支持透明度设置。实施与验收记录应使用 `process.versions.electron` 的实际版本。[Electron 42 版本文档](https://github.com/electron/electron/blob/v42.11.11/docs/api/browser-window.md#winsetopacityopacity)。

还需处理三项平台差异：

- Wayland 通常不允许应用自行定位、移动或聚焦普通窗口，因此不能依靠 `display.bounds` 创建精确覆盖每个屏幕的浮层。[Electron 窗口限制](https://www.electronjs.org/docs/latest/api/browser-window#platform-notices)。
- Electron 使用 PipeWire 采集时只返回一个源，现有“全部显示器各匹配一个源”的流程不能直接复用。[Electron Linux 采集限制](https://www.electronjs.org/docs/latest/api/desktop-capturer#linux)。
- `display_id` 可能为空，返回缩略图的真实尺寸也可能与请求尺寸不同。不能通过数组顺序或屏幕名称猜测显示器，也不能把位图拉伸后当作原始像素。[采集源定义](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source)。

## 3. 共同实现：把采集与编辑解耦

保留现有客户端 `captureRegion` 的请求和 `{ dataUrl, width, height } | null` 返回约定。主进程增加小范围的采集适配层，集中管理一次截图的资源和状态。

建议内部数据模型：

```ts
interface ScreenshotFrame {
  id: string
  bitmap: { width: number; height: number; data: Uint8Array }
  // 只有采集后端提供了可信映射时才填写。
  displayId?: string
  desktopBounds?: { x: number; y: number; width: number; height: number }
  initialSelection?: { x: number; y: number; width: number; height: number }
}

interface ScreenshotCapabilities {
  capture: 'electron' | 'portal-screenshot' | 'unavailable'
  presentation: 'desktop-overlay' | 'image-editor'
  hideWindows: boolean
  regionSelection: 'studio' | 'system-or-studio'
}
```

`initialSelection` 使用图片像素坐标：明确请求并返回区域图片时，初始选区就是整张图片，用户可直接标注和点勾完成；明确请求完整画面时，用户在图片上框选。旧 Portal 不提供图片范围元数据时，默认选中整张图片并提供重新框选，不能通过图片尺寸猜测系统是否已裁剪。

能力判断需要分别考虑操作系统、桌面会话、Electron 实际窗口后端和采集结果。`XDG_SESSION_TYPE`、`WAYLAND_DISPLAY`、`DISPLAY` 仅提供线索；存在 Xwayland 不代表 X11 根窗口能捕获所有 Wayland 应用。后端未确认时使用保守的图片编辑路径，不猜测桌面坐标。

一次请求按以下状态流转：

```text
idle → preparing → [hiding] → capturing / awaiting-system → editing → exporting → cleanup
                                  取消、失败、窗口关闭、应用退出 → cleanup
```

所有阶段共用请求 ID 和取消信号。任何失败进入同一清理流程；迟到的 Portal 结果或采集回调不得重新显示编辑器。系统交互阶段单独计时，不沿用现有编辑器加载的 10 秒超时。建议技术调用超时 10 秒、系统交互超时 120 秒，后者是拟定初值，用户随时可以取消。

编辑器必须支持两种布局：

- 桌面浮层：沿用每屏预热窗口，以该屏局部坐标操作。
- 图片编辑窗口：按比例展示图片，保留空白边距，允许缩放和滚动，不假设图片尺寸等于窗口尺寸。

两种布局均以原始图片像素存储选区和标注。指针通过图片实际显示区域及缩放、滚动偏移转换到图片坐标；空白区域不参与框选。导出保持原始分辨率，窗口缩放不能改变已画出的标注位置。主进程根据受信任的 frame ID 和位图尺寸校验像素选区，继续校验输出 PNG 尺寸。

## 4. Windows 适配

继续使用现有 Electron 采集，不在首版额外引入另一套截屏库。

1. 按 `display_id` 关联屏幕，使用每屏的真实位图尺寸计算裁剪；验证 100%、125%、150%、200% 缩放、负坐标副屏和横竖屏组合。无法可靠关联的源进入图片编辑窗口。
2. 预热无边框浮层，核对任务栏区域、置顶、当前屏幕焦点和取消后的焦点恢复；Windows 不调用只有 macOS 才有效的浮层选项。
3. 普通截图不隐藏、不修改透明度。隐藏截图先停止 Studio 的窗口淡入计时器，保存窗口状态，设透明度为 0，再隐藏和等待合成画面更新；捕获之后才展示编辑器。
4. 对主窗口、独立聊天窗口和宠物窗口统一处理；已隐藏或最小化的窗口不能被清理过程额外显示。保存实际改动过的窗口状态，在 `finally` 中恢复。
5. 用真实画面探针验证现有两帧等待是否足够；若仍有残影，先分析具体阶段。必要时评估原生辅助模块中的 `DwmFlush()`，放在不会阻塞 Electron 主线程的执行路径，重新做像素验收。

`DwmFlush()` 只等待调用应用已经排队的绘制更新，不是全桌面或采集后端刷新完成的保证，不能单独作为“无残影”的依据。[Microsoft DwmFlush 文档](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmflush)。

交付条件：在 Windows 11 实际交互桌面验证普通截图、隐藏截图、取消、确认、连续启动和混合缩放。Windows 10 若仍属于应用支持范围，增加独立验收记录；不以安装包能构建作为截图已验证的证明。

## 5. Linux X11 适配

普通截图使用现有采集和浮层，隐藏截图引入独立的 Linux 时序策略，不依赖 Electron 的透明度接口。

具体实施顺序：

1. 在 GNOME Xorg 和 KDE Plasma X11 分别运行隐藏画面探针，记录窗口撤出画面与采集新帧的耗时。探针测试不同等待时间，例如 50、100、200、350ms；这些是测量点，不是统一硬编码延迟。
2. 将经过画面验收的等待策略封装到 Linux 适配层，停止当前两帧等待在 Linux 上被当作充分条件。隐藏前取消应用自身动画，采集后才显示浮层。
3. 如果目标桌面的窗口动画导致延迟过大或残影不稳定，评估小型 X11 辅助模块对 Studio 窗口设置合成器认可的透明度属性，再隐藏；该属性是否生效仍需逐桌面验证。X11 请求处理完成不能替代合成画面完成。
4. 辅助模块只在 Linux X11 动态加载；保留原始窗口属性并恢复，覆盖 x64、arm64 打包。不能要求用户先关闭桌面动画，也不修改全局桌面设置。
5. 在某个桌面未通过隐藏画面验收时，能力信息返回 `hideWindows: false`，禁用下拉项并说明原因，普通截图继续可用。点击隐藏截图后不能静默退回保留 Studio 窗口的普通截图。

本阶段的交付决策是：先承诺验收过的 GNOME/KDE 组合，再扩大桌面范围。若辅助模块仍无法稳定解决某个合成器的残影，则该组合的隐藏模式暂不交付。重复采到相同图片不等于残影已经消失，不能用“帧哈希连续相同”替代像素验收。

## 6. Linux Wayland 适配

### 6.1 首版采用 Screenshot Portal

优先调用会话 D-Bus 上的 `org.freedesktop.portal.Screenshot`，这是一次性截图接口，适合当前功能。采用主进程内的结构化 D-Bus 客户端，Linux 下动态加载；优先评估无需 Electron ABI 重编译的客户端，锁定依赖并验证打包结果。桌面需有 `xdg-desktop-portal` 及适合当前桌面的后端，启动时探测接口，不要求所有平台加载依赖。

流程：

1. 预热图片编辑窗口，但保持隐藏；先检查 Portal 可用性和版本。
2. 用户选择普通截图时保持 Studio 原样；选择隐藏截图时，先按该桌面经过验收的隐藏策略处理 Studio 窗口，随后调用 Portal。不能自动把普通截图变成隐藏截图。
3. Portal Screenshot v3 若声明支持 Area，则请求 `target: 4`；v3 仅支持 Screen 时请求 `target: 1`，在图片编辑窗口框选。较旧版本请求 `interactive: true`，但这是交互提示，不能保证每个后端都提供区域选择。
4. 等待系统交互完成。系统取消返回空结果；成功后读入其返回的图片 URI，转换为原始位图，再显示 Studio 的图片编辑窗口。
5. Area 结果默认选中整张图片并显示工具栏；Screen 结果在图片内框选。旧接口无法判断范围时，按前述规则默认全选并允许重新框选。保留裁剪、标注和同一个勾完成按钮。
6. 完成后将 PNG 回传当前输入框。取消、错误或所有者关闭都释放请求与编辑器资源，并恢复改动过的窗口。

`target` 和 `AvailableTargets` 是 Screenshot v3 新增能力，必须运行时探测，不能对旧后端无条件发送。区域选择可用性由后端能力决定。[Screenshot Portal 接口](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html)。

接口缺失、Portal 后端不可用或没有可支持的区域/画面能力时，恢复窗口并说明系统截图当前不可用。普通截图和隐藏截图分别给出能力结果；Linux Wayland 的隐藏策略也必须经过该桌面的残影验收，不能因 Portal 调用成功就开放隐藏选项。

### 6.2 请求、取消和文件生命周期

生成独立的 `handle_token`，先订阅预期 Request 对象的 `Response`，再调用 Screenshot，核对实际返回 handle，防止快速响应丢失。`Response=1` 按用户取消处理，其他非零响应按失败处理。[Portal Request 协议](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html)。

本地取消时调用 Request 的 `Close()`，同时结束自己的等待 Promise、移除监听器；不能等待 Close 后再收到 Response。超时、所有者关闭、应用退出执行相同清理。

`parent_window` 使用有效的 Portal 窗口标识。原生 Wayland 需要导出的 `xdg_foreign` handle；Electron 的原生窗口句柄不能直接拼成它。首版拿不到有效标识时按协议传空字符串，并验收系统弹窗是否容易找到。隐藏窗口时不让系统弹窗依附不可见的父窗口。[Portal 窗口标识规范](https://flatpak.github.io/xdg-desktop-portal/docs/window-identifiers.html)。

只读取系统响应返回的本地图片 URI，包括合法的 Documents Portal 文件位置；不让 renderer 传入任意路径。校验图片大小和尺寸后进入内存。若需要本地副本，只创建请求专属临时文件并清理自己的副本；Portal 所有的文件按其生命周期处理，不自行删除系统或用户文件。

### 6.3 多屏与后续增强

首版将 Portal 图片看作独立画面，不假定它对应 `screen.getAllDisplays()` 中哪一项；不把一个 PipeWire 源复制到多个显示器，也不依赖缺失的全局坐标。多屏下使用系统选择结果或返回的完整画面，在图片内编辑。

Screenshot Portal 不可用时，可以在明确提示后提供一次 ScreenCast/PipeWire 采集作为备用路径，使用系统选中的单一画面，读到有效帧后立即关闭流。该备用路径不作为首版发布的必要条件；用户取消或拒绝权限时不自动重试另一种授权方式。

后续若需要优化反复截图的系统选择步骤，再评估直接 ScreenCast 接入及用户授权的 restore token。它支持多流和可选的 compositor 位置、尺寸元数据，但这些坐标不一定是图片像素坐标，也不能解除 Wayland 的窗口定位限制。[ScreenCast Portal 接口](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)。

提供 Xwayland 模式只能作为经过验证的可选兼容方式，切换需要重启应用。不默认强制所有 Linux 用户使用 `--ozone-platform=x11`，也不承诺切换后无需系统截图授权。

## 7. 计划代码改动

以下为拟新增或调整的文件，当前文档不代表这些适配已实现。

| 文件或目录 | 计划改动 |
| --- | --- |
| `packages/desktop/src/main/screenshot.ts` | 保留入口，统一状态、取消、窗口恢复与采集适配器调用 |
| `packages/desktop/src/main/screenshot-platform.ts`（新增） | 环境探测、能力结果、后端选择与隐藏策略 |
| `packages/desktop/src/main/screenshot-portal.ts`（新增） | Screenshot Portal 请求、版本协商、取消和 URI 读取 |
| `packages/desktop/src/main/screenshot-windows.ts` | 分离桌面浮层与普通图片编辑窗口，按平台设置窗口选项 |
| `packages/desktop/src/main/screenshot-editor.ts` | 图片视口、缩放、像素坐标与区域图片的初始选区 |
| `packages/desktop/src/main/screenshot-overlay.ts` | 两种展示模式的布局和输入标签 |
| Desktop preload 与 `packages/client/src/utils/desktop-bridge.ts` | 增加只读截图能力查询，保留现有截图返回结构 |
| `ScreenshotButton.vue` 与全部 locale | 根据能力处理隐藏选项、系统截图等待与失败提示 |
| `tests/desktop`、`tests/e2e` 与桌面验证脚本 | 后端和生命周期测试、图片编辑测试、原生画面探针 |
| Desktop 依赖、lockfile 与打包脚本 | 按实际选型接入 Linux D-Bus 客户端；仅必要时增加平台辅助模块 |

建议用户文案仅说明当前操作，例如“请在系统界面选择截图区域”“当前桌面暂不支持隐藏窗口截屏”，不在输入框展示 D-Bus、PipeWire 或 Ozone 等实现名称。新增文字覆盖全部 locale。

## 8. 验收标准

### 8.1 行为和画面

- 普通截图实际包含可见的 Studio 窗口；隐藏截图实际不包含窗口、阴影或淡出残影。
- “普通 → 隐藏 → 普通”连续操作，隐藏选项不能影响下一次普通截图。
- 勾完成、Esc、右键、系统取消、超时、采集失败、编辑器崩溃和所有者关闭均能清理资源；窗口原始可见性、透明度和状态得到恢复。
- 原始裁剪尺寸、颜色通道和透明度正确；混合 DPI、竖屏、负坐标、多屏和图片编辑窗口缩放均无框选偏移。
- 全部标注工具、文字输入法、撤销重做和最终 PNG 内容一致；完成只添加附件。
- 显示器拔插或缩放变化按后端处理：桌面浮层取消并恢复窗口；已经得到静态图片的编辑窗口可以继续，不能继续引用失效的屏幕映射。

### 8.2 残影探针

在测试专用桌面显示纯色背景窗口和独立的高对比 Studio 测试窗口。建立未显示测试窗口时的背景基准，再用生产采集路径截图，对比原窗口及阴影区域的像素。普通模式应采到测试窗口；隐藏模式应与基准一致，允差按平台颜色路径校准，并确保不会掩盖可见残影。

每个原生环境连续运行至少 20 轮，覆盖确认和取消；分别记录首次和预热后的时间。不能只检查 `isVisible()`、不能把 mocked IPC、纯浏览器编辑器测试或 Xvfb 结果作为真实合成器的残影验收。

### 8.3 性能与测试环境

以下是拟定验收目标，尚不是 Windows/Linux 的测量结果：

| 指标 | 初始目标 |
| --- | --- |
| Windows 预热后，点击到浮层可操作 | P95 ≤ 300ms |
| GNOME/KDE X11 预热后普通截图 | P95 ≤ 300ms |
| GNOME/KDE X11 隐藏截图 | P95 ≤ 500ms；超过时需分析隐藏策略 |
| Wayland 返回图片到编辑器可操作 | P95 ≤ 300ms；系统交互等待单独统计 |
| 完成或取消到资源清理与窗口恢复 | P95 ≤ 300ms |

在固定机器上记录屏幕数量、分辨率、缩放、刷新率、桌面环境、GPU 和实际 Electron 版本；统计隐藏、采集、位图转换、编辑器准备、导出各阶段时间，不包含用户手动框选和授权耗时。首次启动单列，不能混入预热结果。

自动化分三层：已有 Vitest 和浏览器编辑器测试验证公共逻辑；真实 Electron 测试验证窗口生命周期和像素；交互桌面验收验证原生合成器、Portal 和多屏行为。

| 必测环境 | 场景 |
| --- | --- |
| Windows 11 | 单屏、混合 DPI 双屏、不同刷新率、普通/隐藏截图 |
| GNOME Xorg、KDE Plasma X11 | 默认桌面动画开启、单/双屏、窗口恢复 |
| GNOME Wayland、KDE Plasma Wayland | Portal 新旧能力、系统选区/整屏结果、取消、拒绝和重复截图 |
| wlroots 桌面 | Portal 后端存在/缺失、区域能力缺失时的图片编辑路径 |
| macOS | 现有去残影修复、全屏空间和多屏回归 |
| Linux x64、arm64 安装包 | D-Bus 客户端及可选辅助模块的装载和截图流程 |

## 9. 实施顺序和交付条件

| 阶段 | 内容 | 完成条件 |
| --- | --- | --- |
| P0 | 建立原生像素探针，完成 Windows 和 GNOME/KDE X11 基线测量 | 有平台、实际后端、耗时和残影结果，确定 Linux 隐藏策略 |
| P1 | 小范围抽取采集适配层，完善 Windows/X11、能力查询与恢复流程 | 原生像素和状态测试通过，macOS 无回归 |
| P2 | 接入 Wayland Screenshot Portal、图片编辑布局与协议版本处理 | GNOME/KDE Wayland 能完成截图、全部标注和附件提交；异常能恢复 |
| P3 | 完成真实桌面矩阵和 x64/arm64 安装包验证 | 验收记录与功能支持范围一致，发布文案不把未验证环境标为稳定支持 |
| P4（后续） | 评估 ScreenCast 权限恢复、多流采集和跨屏区域拼接 | 根据首版实际问题决定，单独定义跨屏坐标和性能验收 |

Windows 和 X11 可以先交付，Wayland 路径单独验收后开启。某环境只有普通截图通过时，明确发布为普通截图支持；只有隐藏截图像素验收也通过，才开放“隐藏窗口截屏”。
