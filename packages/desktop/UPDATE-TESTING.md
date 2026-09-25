# 桌面端真机更新测试

使用独立的 HTTPS 更新目录和两份测试安装包，完整验证 A → B 的下载、取消、校验、安装和重启。测试工作流只生成 Actions 附件，不创建 GitHub Release，不修改正式下载源或 latest。

## 1. 准备测试更新目录

准备一个可以公开读取文件的 HTTPS 目录，例如 `https://updates-test.example.com/macos-arm64/`（示例地址需要替换）。填目录地址，不是 `latest-mac.yml` 文件地址。不能使用需要网页登录、带临时签名参数的下载链接。

每个 OS/架构使用独立目录，避免两个 macOS 架构的单架构清单互相覆盖。地址、重定向和清单内的文件必须指向测试文件；不要把测试目录映射到正式下载目录。服务器需要保留正确的 Content-Length，支持 HTTP Range 才能验证差分下载。对更新清单关闭缓存或在替换时刷新缓存。

这个目录需要自行部署；工作流不会自动上传文件到服务器。更新目录中包含：

| 目标 | 清单 | 安装文件 |
| --- | --- | --- |
| macOS arm64 / x64 | `latest-mac.yml` | `.zip`、`.dmg` 及其 `.blockmap` |
| Windows x64 | `latest.yml` | `.exe` 及其 `.blockmap` |

## 2. 构建 A 和 B

在 GitHub Actions 运行 **Desktop Update Test Build**（`desktop-update-test.yml`），选择包含新更新逻辑的分支，填写：

- `target`：测试机器的系统和架构。
- `version`：纯数字 `X.Y.Z`，例如 A=`0.7.900`、B=`0.7.901`。必须 B > A，不使用 `-beta` 等预发布后缀。
- `update_feed_url`：上一步的 HTTPS 目录。A 和 B 必须一致。
- `runtime_release_tag`：可选的现有运行时版本，A 和 B 保持一致，以便只测试桌面更新。

分别运行两次。版本会通过打包配置写进应用和安装器，不修改仓库的 package.json / lockfile。应用名称、appId 和安装身份保持一致，A 和 B 均固定使用测试源；不会提供用户切换正式/测试源的设置。

macOS 必须配置现有的 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`（证书需要密码时）、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` secrets，并使用相同签名身份构建 A/B。缺少签名或公证配置会失败，不会退成 unsigned 测试包。Windows 延用现有 NSIS 签名配置，需在目标机器实际验证安装权限和安全软件行为。

下载两次运行的 `update-test-<target>-<version>` 附件，使用里面 `feed` 目录的内容。构建会检查包内 package.json 与 app-update.yml 的测试地址、清单版本、安装文件的 SHA-512/大小和 blockmap 是否齐全。`update-test-build.json` 记录本次版本、地址和文件列表。

## 3. 在测试机器完成 A → B

测试包保留正式应用身份，可能覆盖同机正式安装、共用本地数据和命令入口。使用专用测试机、虚拟机快照或独立系统用户，不要在日常工作的正式安装上试升级。

1. 将 A 的安装文件和 blockmap 上传到测试目录，最后上传 A 的清单；用 A 的 DMG/EXE 正常安装应用。
2. 启动 A，确认“检查更新”显示当前版本，并建立一条测试会话，作为升级后的数据检查。
3. 将 B 的安装文件和 blockmap 上传到同一目录，最后替换成 B 的清单。保留 A 的文件和 blockmap，供差分下载读取。
4. 在 A 中“检查更新”并同意下载。核对新建会话上方的版本、百分比和速度。
5. 下载中停止：网络传输应结束，不进入安装状态；退出再打开后仍是 A。再次检查/下载应成功。
6. 下载完成选“稍后”：应用继续可用。单独验证“重启更新”和下载完成后普通退出这两条安装路径。
7. 安装后确认已启动 B，测试会话和设置仍在，B 再次检查更新显示最新版本。macOS 要验证 Finder 正常打开、公证和系统签名校验均通过。

失败用例分别从 A 快照重新开始：限速/断网后重试、测试源返回 404/503、篡改测试文件造成哈希失败、安装目录权限不足。测试源失败应报错且不访问正式源；失败下载不能显示“重启更新”；取消后不能悄悄安装。保留应用更新日志、服务器访问日志和最终版本作为结果证据。

测试结束可删除测试目录；安装过测试包的应用仍绑定该测试源。恢复正式版需要手动安装正式安装器，不会自动切回正式更新源。

## 本地构建和自动验证

完成桌面 README / CI 中的 Web UI 构建、生产依赖裁剪、运行时元数据准备后，在目标 OS 上运行（macOS 还需签名身份和公证环境）：

```sh
DESKTOP_UPDATE_TEST_TARGET=darwin-arm64 \
DESKTOP_UPDATE_TEST_VERSION=0.7.900 \
DESKTOP_UPDATE_TEST_URL=https://updates-test.example.com/macos-arm64/ \
npm --prefix packages/desktop run dist:update-test
```

输出位于 `packages/desktop/release-update-test/<target>/<version>/feed/`。已存在的非空版本目录会拒绝覆盖，避免混入旧清单；需要重建时先移走该目录。命令固定 `--publish never`，不接受额外打包/发布参数。

```sh
npm ci --prefix packages/desktop --include=dev
npm --prefix packages/desktop run test:updater
npm run test -- tests/desktop/updater-source.test.ts tests/desktop/updater-download.test.ts
```

自动化验证覆盖配置隔离、真实 HTTP 下载/取消/重试和包内容校验；不能代替签名安装包在 macOS/Windows 上的实际覆盖安装和重启。
